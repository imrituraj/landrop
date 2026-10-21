import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export interface Device {
  context: BrowserContext;
  page: Page;
  name: string;
}

export async function openDevice(browser: Browser, name: string, init?: (page: Page) => Promise<void>): Promise<Device> {
  const context = await browser.newContext();
  await context.addInitScript((n) => {
    try {
      localStorage.setItem('landrop.deviceName', n);
    } catch {
      /* ignore */
    }
  }, name);
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`[${name}] pageerror: ${err.message}`));
  if (init) await init(page);
  await page.goto('/');
  await expect(page.getByText('Server connected').first()).toBeVisible();
  return { context, page, name };
}

/**
 * A device backed by its own persistent (on-disk) browser profile and browser
 * process. Needed for large files: default contexts are off-the-record, where
 * OPFS lives in memory with a small quota.
 */
export async function openPersistentDevice(
  userDataDir: string,
  name: string,
  opts: { baseURL: string; channel?: string; args?: string[] },
  init?: (page: Page) => Promise<void>,
): Promise<Device> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    baseURL: opts.baseURL,
    ...(opts.channel ? { channel: opts.channel } : {}),
    args: opts.args ?? [],
    headless: true,
  });
  await context.addInitScript((n) => localStorage.setItem('landrop.deviceName', n), name);
  const page = context.pages()[0] ?? (await context.newPage());
  if (init) await init(page);
  await page.goto('/');
  await expect(page.getByText('Server connected').first()).toBeVisible();
  return { context, page, name };
}

/** A creates a room, B joins with the invitation link; both see a direct connection. */
export async function pair(a: Device, b: Device): Promise<string> {
  await a.page.getByRole('button', { name: 'Create room' }).click();
  // An empty room shows the invitation inline.
  const field = a.page.getByRole('textbox', { name: 'Invitation link' });
  await expect(field).toHaveValue(/#join=[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/);
  const link = await field.inputValue();
  await b.page.goto(link);
  // The secret must be removed from the address bar after it is read.
  await expect.poll(() => b.page.url()).not.toContain('#join=');
  await expectDirect(a, b.name);
  await expectDirect(b, a.name);
  return link;
}

export async function expectDirect(d: Device, peerName: string): Promise<void> {
  const card = d.page.getByRole('button', { name: new RegExp(`^${peerName}, `) });
  await expect(card).toContainText('Direct', { timeout: 30_000 });
}

export async function selectPeer(d: Device, peerName: string): Promise<void> {
  await d.page.getByRole('button', { name: new RegExp(`^${peerName}, `) }).click();
}
