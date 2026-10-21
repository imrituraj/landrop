import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { openDevice, pair, selectPeer, type Device } from './fixtures.ts';

function bytes(size: number, seed: number): Buffer {
  const b = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    b[i] = x & 0xff;
  }
  return b;
}
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Replaces the save/directory pickers with Origin Private File System handles.
 * The real pickers need a human; everything after the picker (createWritable,
 * positional writes, close/abort) is the browser's real File System Access code.
 */
async function useOpfsPickers(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w['showSaveFilePicker'] = async (opts: { suggestedName?: string }) => {
      const root = await navigator.storage.getDirectory();
      return root.getFileHandle(`saved-${opts.suggestedName ?? 'file'}`, { create: true });
    };
    w['showDirectoryPicker'] = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle('batch', { create: true });
    };
  });
}

async function memoryOnly(page: Page, limitMiB = 64): Promise<void> {
  await page.addInitScript((l) => {
    localStorage.setItem('landrop.settings', JSON.stringify({ disableStreaming: true, memoryLimitMiB: l, concurrency: 2 }));
  }, limitMiB);
}

async function opfsDigest(page: Page, path: string[]): Promise<{ size: number; sha256: string } | null> {
  return page.evaluate(async (parts) => {
    let dir = await navigator.storage.getDirectory();
    for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
    let handle: FileSystemFileHandle;
    try {
      handle = await dir.getFileHandle(parts[parts.length - 1]!);
    } catch {
      return null;
    }
    const file = await handle.getFile();
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return { size: file.size, sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') };
  }, path);
}

async function sendFiles(d: Device, files: Array<{ name: string; buffer: Buffer }>): Promise<void> {
  await d.page.getByTestId('file-input').setInputFiles(files.map((f) => ({ name: f.name, mimeType: 'application/octet-stream', buffer: f.buffer })));
}

function transferRow(d: Device, name: string) {
  return d.page.getByTestId('transfer').filter({ has: d.page.getByTestId('transfer-name').getByText(name, { exact: true }) });
}

async function setup(browser: Parameters<typeof openDevice>[0], receiverInit?: (p: Page) => Promise<void>) {
  const a = await openDevice(browser, 'Alice');
  const b = await openDevice(browser, 'Bob', receiverInit);
  await pair(a, b);
  await selectPeer(a, 'Bob');
  await selectPeer(b, 'Alice');
  return { a, b };
}

test('streams a file to disk with the File System Access sink and verifies the bytes', async ({ browser }) => {
  const { a, b } = await setup(browser, useOpfsPickers);
  const data = bytes(12 * 1024 * 1024 + 123, 1);
  await sendFiles(a, [{ name: 'video.bin', buffer: data }]);

  const offer = b.page.getByRole('dialog', { name: 'Incoming file' });
  await expect(offer).toContainText('video.bin');
  await expect(transferRow(a, 'video.bin')).toHaveAttribute('data-state', 'awaiting_acceptance');
  await offer.getByRole('button', { name: 'Save as…' }).click();

  await expect(transferRow(b, 'video.bin')).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
  await expect(transferRow(a, 'video.bin')).toHaveAttribute('data-state', 'completed');
  await expect(transferRow(a, 'video.bin')).toContainText('Delivered — receiver verified the file');
  await expect(transferRow(b, 'video.bin')).toContainText('Saved to disk and verified');

  const out = await opfsDigest(b.page, ['saved-video.bin']);
  expect(out).toEqual({ size: data.length, sha256: sha(data) });
});

test('falls back to the bounded memory sink and saves via download', async ({ browser }) => {
  const { a, b } = await setup(browser, (p) => memoryOnly(p, 64));
  const data = bytes(3 * 1024 * 1024 + 7, 2);
  await sendFiles(a, [{ name: 'photo.jpg', buffer: data }]);
  const offer = b.page.getByRole('dialog', { name: 'Incoming file' });
  await expect(offer).toContainText('received into memory first');
  await offer.getByRole('button', { name: 'Accept' }).click();
  await expect(transferRow(b, 'photo.jpg')).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
  await expect(transferRow(a, 'photo.jpg')).toHaveAttribute('data-state', 'completed');

  const download = b.page.waitForEvent('download');
  await transferRow(b, 'photo.jpg').getByRole('button', { name: 'Save photo.jpg' }).click();
  const dl = await download;
  expect(dl.suggestedFilename()).toBe('photo.jpg');
  const saved = await readFile((await dl.path())!);
  expect(sha(saved)).toBe(sha(data));
});

test('a zero-byte file and a hostile file name are handled safely', async ({ browser }) => {
  const { a, b } = await setup(browser, useOpfsPickers);
  await sendFiles(a, [{ name: 'empty.txt', buffer: Buffer.alloc(0) }]);
  await b.page.getByRole('dialog', { name: 'Incoming file' }).getByRole('button', { name: 'Save as…' }).click();
  await expect(transferRow(b, 'empty.txt')).toHaveAttribute('data-state', 'completed');
  expect(await opfsDigest(b.page, ['saved-empty.txt'])).toEqual({ size: 0, sha256: sha(Buffer.alloc(0)) });

  // The browser strips path components from File names; our sanitizer also
  // handles control characters and bidi overrides before suggesting a name.
  await sendFiles(a, [{ name: 'invoice\u202efdp.exe', buffer: Buffer.from('x') }]);
  await b.page.getByRole('dialog', { name: 'Incoming file' }).getByRole('button', { name: 'Save as…' }).click();
  await expect(b.page.getByTestId('transfer').first()).toHaveAttribute('data-state', 'completed');
  expect(await opfsDigest(b.page, ['saved-invoicefdp.exe'])).not.toBeNull();
});

test('receiver rejection ends the transfer on both sides without data', async ({ browser }) => {
  const { a, b } = await setup(browser, useOpfsPickers);
  await sendFiles(a, [{ name: 'nope.zip', buffer: bytes(100_000, 3) }]);
  await b.page.getByRole('dialog', { name: 'Incoming file' }).getByRole('button', { name: 'Decline' }).click();
  await expect(transferRow(a, 'nope.zip')).toHaveAttribute('data-state', 'rejected');
  await expect(transferRow(a, 'nope.zip')).toContainText('The receiver declined the file.');
  await expect(transferRow(b, 'nope.zip')).toHaveAttribute('data-state', 'rejected');
});

test('files over the receiver memory limit are refused before any payload', async ({ browser }) => {
  const { a, b } = await setup(browser, (p) => memoryOnly(p, 1));
  // Wait until A knows B's capabilities.
  await expect(a.page.getByText(/files over 1 MiB will be refused before sending/)).toBeVisible();
  await sendFiles(a, [{ name: 'big.iso', buffer: bytes(2 * 1024 * 1024, 4) }]);
  await expect(transferRow(a, 'big.iso')).toHaveAttribute('data-state', 'failed');
  await expect(transferRow(a, 'big.iso')).toContainText('larger than the receiving browser can safely store');
  await expect(b.page.getByTestId('transfer')).toHaveCount(0);
});

test('sender cancel stops the transfer and discards the partial file', async ({ browser }) => {
  const { a, b } = await setup(browser, useOpfsPickers);
  await sendFiles(a, [{ name: 'large.bin', buffer: bytes(48 * 1024 * 1024, 5) }]);
  await b.page.getByRole('dialog', { name: 'Incoming file' }).getByRole('button', { name: 'Save as…' }).click();
  await expect(transferRow(a, 'large.bin')).toHaveAttribute('data-state', 'transferring');
  await transferRow(a, 'large.bin').getByRole('button', { name: 'Cancel large.bin' }).click();
  await expect(transferRow(a, 'large.bin')).toHaveAttribute('data-state', 'cancelled');
  await expect(transferRow(b, 'large.bin')).toHaveAttribute('data-state', 'cancelled');
  await expect(transferRow(b, 'large.bin')).toContainText('Cancelled by the sender.');
  await expect(transferRow(b, 'large.bin')).toContainText('partial file was discarded');
  // No partial data: the placeholder created when the destination was chosen stays empty.
  const left = await opfsDigest(b.page, ['saved-large.bin']);
  expect(left === null || left.size === 0).toBe(true);
});

test('pause and resume keep the bytes intact; chat works during a transfer', async ({ browser }) => {
  const { a, b } = await setup(browser, useOpfsPickers);
  const data = bytes(40 * 1024 * 1024, 6);
  await sendFiles(a, [{ name: 'pause.bin', buffer: data }]);
  await b.page.getByRole('dialog', { name: 'Incoming file' }).getByRole('button', { name: 'Save as…' }).click();
  await expect(transferRow(b, 'pause.bin')).toHaveAttribute('data-state', 'transferring');

  await transferRow(b, 'pause.bin').getByRole('button', { name: 'Pause pause.bin' }).click();
  await expect(transferRow(a, 'pause.bin')).toHaveAttribute('data-state', 'paused');

  // Chat still works.
  const input = a.page.getByRole('textbox', { name: 'Message' });
  await input.fill('still there?');
  await input.press('Enter');
  await expect(b.page.getByTestId('chat-message').filter({ hasText: 'still there?' })).toBeVisible();
  await expect(a.page.getByTestId('chat-status').last()).toHaveText('Delivered');

  await transferRow(a, 'pause.bin').getByRole('button', { name: 'Resume pause.bin' }).click();
  await expect(transferRow(b, 'pause.bin')).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
  await expect(transferRow(a, 'pause.bin')).toHaveAttribute('data-state', 'completed');
  expect(await opfsDigest(b.page, ['saved-pause.bin'])).toEqual({ size: data.length, sha256: sha(data) });
});

test('multiple files: batch accept into a folder, names de-duplicated, all verified', async ({ browser }) => {
  const { a, b } = await setup(browser, useOpfsPickers);
  const files = [
    { name: 'one.txt', buffer: bytes(10_000, 7) },
    { name: 'two.bin', buffer: bytes(2_000_000, 8) },
    { name: 'three.dat', buffer: bytes(500_000, 9) },
  ];
  await sendFiles(a, files);
  const dialog = b.page.getByRole('dialog', { name: '3 incoming files' });
  await expect(dialog.getByTestId('incoming-offer')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Save all to folder…' }).click();
  for (const f of files) await expect(transferRow(a, f.name)).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
  for (const f of files) expect(await opfsDigest(b.page, ['batch', f.name])).toEqual({ size: f.buffer.length, sha256: sha(f.buffer) });

  // Same name again: never overwrites.
  await sendFiles(a, [{ name: 'one.txt', buffer: bytes(10, 10) }]);
  await sendFiles(a, [{ name: 'four.txt', buffer: bytes(10, 11) }]);
  await expect(b.page.getByRole('dialog', { name: '2 incoming files' })).toBeVisible();
  await b.page.getByRole('button', { name: 'Save all to folder…' }).click();
  await expect(b.page.getByTestId('transfer').filter({ hasText: 'four.txt' })).toHaveAttribute('data-state', 'completed');
  expect(await opfsDigest(b.page, ['batch', 'one (1).txt'])).toEqual({ size: 10, sha256: sha(bytes(10, 10)) });
  expect(await opfsDigest(b.page, ['batch', 'one.txt'])).toEqual({ size: 10_000, sha256: sha(files[0]!.buffer) });
});

test('a peer disappearing fails the transfer clearly', async ({ browser }) => {
  const { a, b } = await setup(browser, useOpfsPickers);
  await sendFiles(a, [{ name: 'gone.bin', buffer: bytes(48 * 1024 * 1024, 12) }]);
  await b.page.getByRole('dialog', { name: 'Incoming file' }).getByRole('button', { name: 'Save as…' }).click();
  await expect(transferRow(a, 'gone.bin')).toHaveAttribute('data-state', 'transferring');
  await b.context.close();
  await expect(transferRow(a, 'gone.bin')).toHaveAttribute('data-state', 'failed', { timeout: 30_000 });
  await expect(transferRow(a, 'gone.bin')).toContainText(/The other device left|could not be re-established/);
  await expect(a.page.getByText('No other devices yet')).toBeVisible({ timeout: 30_000 });
});

for (const side of ['sender', 'receiver'] as const) {
  test(`a WebRTC reconnect initiated by the ${side} resumes the transfer from the written offset`, async ({ browser }) => {
    const { a, b } = await setup(browser, useOpfsPickers);
    const data = bytes(40 * 1024 * 1024, 20);
    const name = `resume-${side}.bin`;
    await sendFiles(a, [{ name, buffer: data }]);
    await b.page.getByRole('dialog', { name: 'Incoming file' }).getByRole('button', { name: 'Save as…' }).click();
    await expect(transferRow(b, name)).toHaveAttribute('data-state', 'transferring');
    // Wait for real progress so the resume offset is non-zero.
    await expect(transferRow(b, name)).toContainText(/[1-9][0-9.]* MB of/);

    const actor = side === 'sender' ? a : b;
    await actor.page.getByRole('button', { name: 'Reconnect' }).click();
    // Both sides drop the data channels and recover on a new connection generation.
    await expect(transferRow(a, name)).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
    await expect(transferRow(b, name)).toHaveAttribute('data-state', 'completed');

    // A second attempt was used, and the bytes are intact.
    await transferRow(b, name).getByText('Details').click();
    await expect(transferRow(b, name).locator('dd').nth(2)).toHaveText('2');
    expect(await opfsDigest(b.page, [`saved-${name}`])).toEqual({ size: data.length, sha256: sha(data) });
  });
}
