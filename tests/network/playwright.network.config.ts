import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
import base from '../../playwright.config.ts';

/** Long-running throughput and large-file tests. Not part of the default E2E run. */
export default defineConfig({ ...base, testDir: dirname(fileURLToPath(import.meta.url)), timeout: 60 * 60_000 });
