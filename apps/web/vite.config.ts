import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const server = process.env['LANDROP_DEV_SERVER'] ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: server },
      '/ws': { target: server, ws: true },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Keep the CSP strict: no inline scripts or data: modules.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  worker: { format: 'es' },
});
