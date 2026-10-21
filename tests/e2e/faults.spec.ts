import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Browser } from '@playwright/test';
import { expectDirect, pair, selectPeer, type Device } from './fixtures.ts';

const ROOT = join(import.meta.dirname, '../..');

/** A separate server process this test can stop and restart. */
function startServer(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['apps/server/src/main.ts'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', STATIC_DIR: join(ROOT, 'apps/web/dist'), LOG_LEVEL: 'warn' },
    stdio: 'ignore',
  });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const poll = async () => {
      try {
        if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) return resolve(child);
      } catch {
        // not up yet
      }
      if (Date.now() > deadline) return reject(new Error('server did not start'));
      setTimeout(poll, 100);
    };
    void poll();
  });
}

function stopServer(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

async function device(browser: Browser, baseURL: string, name: string): Promise<Device> {
  const context = await browser.newContext({ baseURL });
  await context.addInitScript((n) => localStorage.setItem('landrop.deviceName', n), name);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByText('Server connected').first()).toBeVisible();
  return { context, page, name };
}

test('signaling server restart: clients notice, rooms are gone, and a new room works', async ({ browser }) => {
  test.setTimeout(90_000);
  const port = 8793;
  let server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  const a = await device(browser, base, 'Alice');
  const b = await device(browser, base, 'Bob');
  try {
    await pair(a, b);

    await stopServer(server);
    // Graceful shutdown notice reaches the clients before the socket closes.
    await expect(a.page.getByText('The LanDrop server is restarting')).toBeVisible();
    await expect(a.page.getByText(/Server (reconnecting|disconnected)/).first()).toBeVisible();

    server = await startServer(port);
    await expect(a.page.getByText('Server connected').first()).toBeVisible({ timeout: 20_000 });
    // In-memory rooms do not survive a restart; the automatic rejoin reports that clearly.
    await expect(a.page.getByText('Room not found, or the invitation is invalid.')).toBeVisible({ timeout: 20_000 });
    await expect(b.page.getByText('Server connected').first()).toBeVisible({ timeout: 20_000 });

    // Recovery path: a new room works.
    await b.page.goto('/');
    await pair(a, b);
    await selectPeer(a, 'Bob');
    const input = a.page.getByRole('textbox', { name: 'Message' });
    await input.fill('after restart');
    await input.press('Enter');
    await expect(a.page.getByTestId('chat-status').last()).toHaveText('Delivered');
  } finally {
    await a.context.close();
    await b.context.close();
    await stopServer(server);
  }
});

test('a signaling outage keeps the room and the direct link; the session resumes', async ({ browser }) => {
  test.setTimeout(60_000);
  const port = 8794;
  const server = await startServer(port);
  const base = `http://127.0.0.1:${port}`;
  const a = await device(browser, base, 'Alice');

  // B's signaling WebSocket goes through a controllable proxy.
  const context = await browser.newContext({ baseURL: base });
  await context.addInitScript(() => localStorage.setItem('landrop.deviceName', 'Bob'));
  const page = await context.newPage();
  let outage = false;
  let live: { close: (o?: { code?: number; reason?: string }) => Promise<void> } | null = null;
  let connections = 0;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    connections++;
    if (outage) {
      void ws.close({ code: 4999, reason: 'simulated outage' });
      return;
    }
    ws.connectToServer();
    live = ws;
  });
  await page.goto('/');
  await expect(page.getByText('Server connected').first()).toBeVisible();
  const b: Device = { context, page, name: 'Bob' };
  try {
    await pair(a, b);
    await selectPeer(a, 'Bob');
    await selectPeer(b, 'Alice');

    outage = true;
    await live!.close({ code: 4999, reason: 'simulated drop' });
    await expect(b.page.getByText(/Server reconnecting/).first()).toBeVisible();
    // The server keeps B's membership during the grace period; the direct link is unaffected.
    await expect(a.page.getByRole('button', { name: /^Bob, / })).toContainText('Direct');

    // Chat does not depend on signaling: it still flows over the open data channel.
    const input = a.page.getByRole('textbox', { name: 'Message' });
    await input.fill('during outage');
    await input.press('Enter');
    await expect(b.page.getByTestId('chat-message').filter({ hasText: 'during outage' })).toBeVisible();
    await expect(a.page.getByTestId('chat-status').last()).toHaveText('Delivered');

    await b.page.waitForTimeout(2000);
    outage = false;
    await expect(b.page.getByText('Server connected').first()).toBeVisible({ timeout: 20_000 });
    expect(connections).toBeGreaterThan(2); // at least one refused reconnect attempt happened
    // Same session: still in the room with Alice, no re-pairing needed.
    await expectDirect(b, 'Alice');
    await expectDirect(a, 'Bob');
    await expect(b.page.getByRole('button', { name: 'Create room' })).toHaveCount(0);
    // Same peer identity on A's side: a re-joined Bob would be a new peer with an empty chat.
    await expect(a.page.getByTestId('chat-message').filter({ hasText: 'during outage' })).toBeVisible();
  } finally {
    await a.context.close();
    await b.context.close();
    await stopServer(server);
  }
});
