import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openPersistentDevice, pair, selectPeer } from '../e2e/fixtures.ts';
import { generateFile } from './gen-file.ts';

/**
 * Large-file verification (manual / opt-in; not part of the default E2E run).
 *
 *   LANDROP_LARGE_BYTES=4294967296 E2E_CHANNEL=chrome pnpm test:large
 *
 * - Generates a deterministic file on disk (bounded memory), SHA-256 computed in Node.
 * - Sends it between two browser contexts; the receiver streams to an OPFS file
 *   through the real FileSystemWritableFileStream (only the picker is substituted).
 * - Integrity: the app's receiver verifies SHA-256 end to end; the test also checks
 *   the sender-side digest equals Node's digest of the source, and spot-checks
 *   random 64 KiB windows of the written file against the generator.
 * - Each device is a separate browser process with an on-disk profile, so OPFS
 *   data goes to disk (default Playwright contexts are off-the-record and keep
 *   OPFS in memory with a small quota, which would distort both memory and quota).
 * - Memory: samples the RSS of every process belonging to the two browsers and
 *   the JS heap of both pages. RSS includes the browser's own caches and is an
 *   upper bound; it is NOT a precise measurement of LanDrop's buffers.
 * - Writes a JSON record to tests/.artifacts/large-file-results.json.
 *
 * Disk use: about 2x the file size (source + destination) plus the browser's
 * temporary swap file during writing.
 */

const SIZE = Number(process.env['LANDROP_LARGE_BYTES'] ?? 1024 * 1024 * 1024);
const SAMPLE_MS = 2000;

function rssByProcess(profileMarker: string): Record<string, number> {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,rss=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const res: Record<string, number> = {};
  for (const line of out.split('\n')) {
    if (!line.includes(profileMarker)) continue;
    const [pid, kb] = line.trim().split(/\s+/, 2);
    const type = /--type=(\S+)/.exec(line)?.[1] ?? 'browser';
    const sub = /--utility-sub-type=(\S+)/.exec(line)?.[1] ?? '';
    res[`${type}${sub ? `:${sub}` : ''}:${pid}`] = Math.round(Number(kb) / 1024);
  }
  return res;
}

function browserRssBytes(profileMarker: string): number {
  // `ps` RSS is in KiB. We sum processes whose command line names the test profile.
  const out = execFileSync('ps', ['-A', '-o', 'rss=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let total = 0;
  for (const line of out.split('\n')) {
    if (!line.includes(profileMarker)) continue;
    const kb = Number(line.trim().split(/\s+/, 1)[0]);
    if (Number.isFinite(kb)) total += kb * 1024;
  }
  return total;
}

async function jsHeap(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const { metrics } = await cdp.send('Performance.getMetrics');
  await cdp.detach();
  return metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
}

function generatorBytes(seed: number, offset: number, length: number): Buffer {
  // Mirror of gen-file.ts: xorshift32 over 4 MiB blocks, state continues across blocks.
  // Recompute by streaming from the start of the 4-byte word stream (cheap enough for spot checks
  // because we replay only up to `offset + length`).
  let x = seed >>> 0 || 1;
  const out = Buffer.alloc(length);
  const word = Buffer.alloc(4);
  const firstWord = Math.floor(offset / 4);
  const lastWord = Math.floor((offset + length - 1) / 4);
  for (let w = 0; w <= lastWord; w++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    if (w < firstWord) continue;
    word.writeUInt32LE(x >>> 0, 0);
    for (let k = 0; k < 4; k++) {
      const pos = w * 4 + k;
      if (pos >= offset && pos < offset + length) out[pos - offset] = word[k]!;
    }
  }
  return out;
}

test('large file streams with bounded memory and verified integrity', async ({ baseURL, browserName }, testInfo) => {
  test.setTimeout(6 * 60 * 60_000);
  const dir = join(process.cwd(), 'tests/.artifacts');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `large-${SIZE}.bin`);
  const seed = 11;
  const shaPath = `${path}.sha256`;
  let expected: string;
  if (existsSync(path) && existsSync(shaPath) && statSync(path).size === SIZE) {
    expected = (await import('node:fs')).readFileSync(shaPath, 'utf8').trim();
  } else {
    expected = await generateFile(path, SIZE, seed);
    writeFileSync(shaPath, expected);
  }

  const name = `large-${SIZE}.bin`;
  const project = testInfo.project.use as { channel?: string; launchOptions?: { args?: string[] } };
  const launch = { baseURL: baseURL!, ...(project.channel ? { channel: project.channel } : {}), args: project.launchOptions?.args ?? [] };
  const profileA = mkdtempSync(join(tmpdir(), 'landrop-large-a-'));
  const profileB = mkdtempSync(join(tmpdir(), 'landrop-large-b-'));
  const a = await openPersistentDevice(profileA, 'Sender', launch);
  const b = await openPersistentDevice(profileB, 'Receiver', launch, async (p) => {
    await p.addInitScript(() => {
      (window as unknown as Record<string, unknown>)['showSaveFilePicker'] = async (o: { suggestedName?: string }) =>
        (await navigator.storage.getDirectory()).getFileHandle(`saved-${o.suggestedName}`, { create: true });
    });
  });
  await pair(a, b);
  await selectPeer(a, 'Receiver');
  await selectPeer(b, 'Sender');

  // Both browsers' processes carry their profile directory on the command line.
  const marker = 'landrop-large-';
  const baselineRss = browserRssBytes(marker);
  if (process.env['LANDROP_RSS_BREAKDOWN']) console.log('per-process RSS MiB at start:', rssByProcess(marker));
  const samples: Array<{ t: number; rss: number; heapA: number; heapB: number; written: number }> = [];
  await a.page.getByTestId('file-input').setInputFiles(path);
  await b.page.getByRole('dialog', { name: 'Incoming file' }).getByRole('button', { name: 'Save as…' }).click();
  const t0 = Date.now();
  const rowB = b.page.getByTestId('transfer').first();
  const rowA = a.page.getByTestId('transfer').first();

  for (;;) {
    const state = await rowB.getAttribute('data-state');
    if (state === 'completed' || state === 'failed' || state === 'cancelled') break;
    const written = await b.page.evaluate(async (n) => {
      try {
        return (await (await (await navigator.storage.getDirectory()).getFileHandle(`saved-${n}`)).getFile()).size;
      } catch {
        return 0;
      }
    }, name);
    samples.push({ t: Date.now() - t0, rss: browserRssBytes(marker), heapA: await jsHeap(a.page), heapB: await jsHeap(b.page), written });
    await a.page.waitForTimeout(SAMPLE_MS);
  }
  const seconds = (Date.now() - t0) / 1000;
  if (process.env['LANDROP_RSS_BREAKDOWN']) console.log('per-process RSS MiB at end:', rssByProcess(marker));
  await expect(rowB).toHaveAttribute('data-state', 'completed');
  await expect(rowA).toHaveAttribute('data-state', 'completed', { timeout: 120_000 });

  // Sender digest (over the bytes it read) must equal Node's digest of the source file.
  await rowA.getByText('Details').click();
  await expect(rowA.getByTestId('transfer-sha256')).toHaveText(expected);
  await rowB.getByText('Details').click();
  await expect(rowB.getByTestId('transfer-sha256')).toHaveText(expected);

  // Independent spot checks of the written file.
  const size = await b.page.evaluate(
    async (n) => (await (await (await navigator.storage.getDirectory()).getFileHandle(`saved-${n}`)).getFile()).size,
    name,
  );
  expect(size).toBe(SIZE);
  const windows = Array.from({ length: 24 }, (_, i) => Math.floor(((i + 0.5) / 24) * Math.max(0, SIZE - 65536)) & ~3);
  for (const off of windows.slice(0, SIZE > 2 ** 31 ? 6 : 24)) {
    const len = Math.min(65536, SIZE - off);
    if (len <= 0) continue;
    const got = await b.page.evaluate(
      async ({ n, off, len }) => {
        const f = await (await (await navigator.storage.getDirectory()).getFileHandle(`saved-${n}`)).getFile();
        return [...new Uint8Array(await f.slice(off, off + len).arrayBuffer())];
      },
      { n: name, off, len },
    );
    expect(Buffer.from(got).equals(generatorBytes(seed, off, len))).toBe(true);
  }

  const peakRss = Math.max(baselineRss, ...samples.map((s) => s.rss));
  const peakHeap = Math.max(0, ...samples.map((s) => Math.max(s.heapA, s.heapB)));
  const record = {
    date: new Date().toISOString(),
    browser: `${browserName} (${project.channel ?? 'chromium'}) ${a.context.browser()?.version() ?? ''}`.trim(),
    os: `${process.platform} ${process.arch}`,
    sink: 'streaming (FileSystemWritableFileStream on OPFS handle)',
    bytes: SIZE,
    seconds: Number(seconds.toFixed(1)),
    mbPerSecond: Number((SIZE / 1e6 / seconds).toFixed(2)),
    outcome: 'completed, SHA-256 verified',
    sha256: expected,
    memory: {
      note: 'RSS = sum over all test-browser processes (includes browser caches); heap = V8 JSHeapUsedSize per page',
      baselineRssMiB: Math.round(baselineRss / 1048576),
      peakRssMiB: Math.round(peakRss / 1048576),
      rssGrowthMiB: Math.round((peakRss - baselineRss) / 1048576),
      peakJsHeapMiB: Math.round(peakHeap / 1048576),
      samples: samples.length,
    },
  };
  console.log(JSON.stringify(record, null, 2));
  const resultsPath = join(dir, 'large-file-results.json');
  const previous: unknown[] = existsSync(resultsPath) ? JSON.parse((await import('node:fs')).readFileSync(resultsPath, 'utf8')) : [];
  writeFileSync(resultsPath, JSON.stringify([...previous, { ...record, samplesDetail: samples }], null, 2));

  // Bounded memory: growth must be far below the file size (no whole-file buffering).
  expect(peakHeap).toBeLessThan(256 * 1024 * 1024);
  if (!process.env["LANDROP_SKIP_RSS_ASSERT"]) expect(peakRss - baselineRss).toBeLessThan(Math.min(SIZE / 2, 1024 * 1024 * 1024));

  // Clean up the large OPFS file and both profiles.
  await b.page.evaluate(async (n) => (await navigator.storage.getDirectory()).removeEntry(`saved-${n}`), name);
  await a.context.close();
  await b.context.close();
  rmSync(profileA, { recursive: true, force: true });
  rmSync(profileB, { recursive: true, force: true });
});
