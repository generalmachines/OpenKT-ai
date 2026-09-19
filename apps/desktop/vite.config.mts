/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * Production builds get a strict CSP. It is injected at build time only,
 * because the dev server needs inline scripts and a websocket for HMR.
 * connect-src stays open to http(s) so the HTTP adapter can reach whatever
 * server URL the user configures.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' http: https:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'openkt-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace('<!-- csp -->', `<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    },
  };
}

export default defineConfig({
  // Relative asset URLs: the packaged renderer is loaded from file://.
  base: './',
  plugins: [react(), cspPlugin()],
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome130' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}'],
  },
});
