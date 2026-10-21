import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { chromium, expect, firefox, test } from '@playwright/test';
import { pair, selectPeer, type Device } from './fixtures.ts';

/**
 * Chromium (sender) -> Firefox (receiver). Firefox has no showSaveFilePicker, so
 * this exercises the capability-advertised memory-sink fallback across engines.
 */
test('chromium sends to firefox via the memory-sink fallback', async ({ baseURL }) => {
  test.setTimeout(120_000);
  const chrome = await chromium.launch({ channel: process.env['E2E_CHANNEL'] ?? (process.platform === 'darwin' ? 'chrome' : 'chromium') });
  const fox = await firefox.launch({
    firefoxUserPrefs: {
      // Same reasoning as the Chromium mDNS flag: expose plain host candidates for a single-machine test.
      'media.peerconnection.ice.obfuscate_host_addresses': false,
    },
  });
  const open = async (b: typeof chrome, name: string): Promise<Device> => {
    const context = await b.newContext({ baseURL: baseURL! });
    await context.addInitScript((n) => localStorage.setItem('landrop.deviceName', n), name);
    const page = await context.newPage();
    await page.goto('/');
    await expect(page.getByText('Server connected').first()).toBeVisible();
    return { context, page, name };
  };
  try {
    const a = await open(chrome, 'Chrome');
    const b = await open(fox, 'Firefox');
    await pair(a, b);
    await selectPeer(a, 'Firefox');
    await expect(a.page.getByText(/Their browser keeps incoming files in memory/)).toBeVisible();
    const data = Buffer.alloc(5 * 1024 * 1024 + 3, 7);
    await a.page.getByTestId('file-input').setInputFiles({ name: 'cross.bin', mimeType: 'application/octet-stream', buffer: data });
    await b.page.getByRole('dialog', { name: 'Incoming file' }).getByRole('button', { name: 'Accept' }).click();
    await expect(b.page.getByTestId('transfer').first()).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
    await expect(a.page.getByTestId('transfer').first()).toHaveAttribute('data-state', 'completed');
    const dl = b.page.waitForEvent('download');
    await b.page.getByRole('button', { name: 'Save cross.bin' }).click();
    const saved = await readFile((await (await dl).path())!);
    expect(createHash('sha256').update(saved).digest('hex')).toBe(createHash('sha256').update(data).digest('hex'));
  } finally {
    await chrome.close();
    await fox.close();
  }
});
