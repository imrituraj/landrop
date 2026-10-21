import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const ROOT = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env['E2E_PORT'] ?? 8790);
/**
 * Browser channel. 'chromium' = Playwright's Chrome for Testing (new headless).
 * 'chrome' = the locally installed Google Chrome. On hosts with an application
 * firewall that blocks unsigned apps (e.g. macOS), the default headless shell may
 * be unable to receive WebRTC UDP traffic, so a signed build is used.
 */
const CHANNEL =
  process.env['E2E_CHANNEL'] ??
  (process.platform === 'darwin' && existsSync('/Applications/Google Chrome.app') ? 'chrome' : 'chromium');

/**
 * Browser E2E tests: two independent browser contexts, real WebRTC data
 * channels, real signaling server serving the production build.
 *
 * Note: both contexts run on one machine over loopback. This verifies the
 * protocol and browser APIs, NOT cross-device LAN behavior (see docs/testing.md).
 */
export default defineConfig({
  testDir: join(ROOT, 'tests/e2e'),
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /cross-browser/,
      use: {
        ...devices['Desktop Chrome'],
        channel: CHANNEL,
        launchOptions: {
          // Chromium hides host IPs behind mDNS ".local" names. Resolving those
          // between two headless contexts on one machine is unreliable, so the
          // test browser exposes plain host candidates instead. Real devices keep
          // the default; see docs/troubleshooting.md (mDNS) for the implications.
          args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection'],
        },
      },
    },
    {
      // Chromium sender -> Firefox receiver (memory-sink fallback). Opt-in: needs
      // `pnpm exec playwright install firefox`, and on hosts with an application
      // firewall the unsigned Firefox build may be unable to receive UDP.
      name: 'cross-browser',
      testMatch: /cross-browser/,
    },
  ],
  webServer: {
    command: `pnpm --filter @landrop/web build && node apps/server/src/main.ts`,
    cwd: ROOT,
    url: `http://127.0.0.1:${PORT}/readyz`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      STATIC_DIR: join(ROOT, 'apps/web/dist'),
      LOG_LEVEL: 'warn',
      SESSION_RESUME_GRACE_SECONDS: '5',
      RATE_CONNECT_PER_MIN: '1000',
      RATE_ROOM_CREATE_PER_MIN: '1000',
      RATE_JOIN_PER_MIN: '1000',
      MAX_CLIENTS_PER_IP: '200',
    },
  },
});
