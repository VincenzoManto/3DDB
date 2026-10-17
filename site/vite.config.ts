import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const here = fileURLToPath(new URL('.', import.meta.url));
const localClient = resolve(here, '../client/src/ws/local.ts');

/**
 * Static build for GitHub Pages: the landing page plus the real client, wired to the in-browser demo
 * (client/src/ws/local.ts) instead of a WebSocket server.
 */
function staticDemo(): Plugin {
  return {
    name: '3d-db-static-demo',
    enforce: 'pre',
    async resolveId(source, importer) {
      // The client talks to the in-page demo instead of the server.
      if (importer?.replace(/\\/g, '/').endsWith('client/src/main.ts') && source === './ws/client') return localClient;
      // microdb.ts imports SQL constants from postgres.ts, which imports the Node driver. Never called here.
      if (source === 'pg') return '\0pg-stub';
      return null;
    },
    load(id) {
      if (id === '\0pg-stub') return 'export default {};';
      return null;
    },
  };
}

export default defineConfig({
  root: here,
  base: './',
  plugins: [staticDemo()],
  define: {
    'process.env.POLL_MS': 'undefined',
  },
  optimizeDeps: {
    exclude: ['@electric-sql/pglite'],
  },
  server: {
    port: 5180,
    fs: { allow: [resolve(here, '..')] },
  },
  build: {
    outDir: resolve(here, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      input: {
        index: resolve(here, 'index.html'),
        demo: resolve(here, 'demo/index.html'),
      },
    },
  },
});
