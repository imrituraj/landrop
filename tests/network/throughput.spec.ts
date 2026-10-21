import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { openDevice, pair, selectPeer } from '../e2e/fixtures.ts';
import { generateFile } from './gen-file.ts';

const SIZE = Number(process.env['LANDROP_PERF_BYTES'] ?? 200 * 1024 * 1024);
const SINK = process.env['LANDROP_PERF_SINK'] ?? 'streaming';

test('throughput probe', async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const dir = join(process.cwd(), 'tests/.artifacts');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `perf-${SIZE}.bin`);
  const expected = await generateFile(path, SIZE, 3);
  const debug = async (p: import('@playwright/test').Page) => {
    await p.addInitScript(() => localStorage.setItem('landrop.debug', '1'));
    p.on('console', (m) => {
      if (m.text().includes('waits')) console.log(m.text());
    });
  };
  const a = await openDevice(browser, 'Alice', debug);
  const b = await openDevice(browser, 'Bob', async (p) => {
    await debug(p);
    if (SINK === 'memory') {
      await p.addInitScript(() =>
        localStorage.setItem('landrop.settings', JSON.stringify({ disableStreaming: true, memoryLimitMiB: 1024, concurrency: 2 })),
      );
    }
    await p.addInitScript(() => {
      (window as unknown as Record<string, unknown>)['showSaveFilePicker'] = async (o: { suggestedName?: string }) =>
        (await navigator.storage.getDirectory()).getFileHandle(`saved-${o.suggestedName}`, { create: true });
    });
  });
  await pair(a, b);
  await selectPeer(a, 'Bob');
  await selectPeer(b, 'Alice');
  await a.page.getByTestId('file-input').setInputFiles(path);
  await b.page
    .getByRole('dialog', { name: 'Incoming file' })
    .getByRole('button', { name: SINK === 'memory' ? 'Accept' : 'Save as…' })
    .click();
  const t0 = Date.now();
  await expect(b.page.getByTestId('transfer').first()).toHaveAttribute('data-state', 'completed', { timeout: 9 * 60_000 });
  await expect(a.page.getByTestId('transfer').first()).toHaveAttribute('data-state', 'completed');
  const secs = (Date.now() - t0) / 1000;
  console.log(`sink=${SINK} size=${SIZE} seconds=${secs.toFixed(1)} MB/s=${(SIZE / 1e6 / secs).toFixed(1)} expected=${expected}`);
});
