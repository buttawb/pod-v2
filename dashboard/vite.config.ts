import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const require = createRequire(import.meta.url);

/**
 * MapLibre's worker is the one file we serve verbatim rather than re-bundle.
 *
 * It resolves its own URL from `import.meta.url`, which after bundling points
 * at a file Vite never emitted. Letting Vite rebuild it (`?worker&url`) does
 * emit a file and the worker loads without error, but it never answers the
 * main thread, so no tile ever arrives. Both halves ship as a matched pair and
 * the worker imports its sibling by relative path, so the safe move is to copy
 * both, unhashed, and point `setWorkerUrl` at a stable path.
 */
function maplibreWorker(): Plugin {
  const files = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'].map((name) => ({
    name,
    source: readFileSync(require.resolve(`maplibre-gl/dist/${name}`), 'utf8'),
  }));

  return {
    name: 'maplibre-worker-passthrough',
    // Dev has no emitted assets, so serve the same two files from memory.
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const hit = files.find((f) => req.url?.startsWith(`/maplibre/${f.name}`));
        if (!hit) return next();
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.end(hit.source);
      });
    },
    generateBundle() {
      for (const file of files) {
        this.emitFile({ type: 'asset', fileName: `maplibre/${file.name}`, source: file.source });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), maplibreWorker()],
  base: process.env.VITE_BASE_URL || '/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    chunkSizeWarningLimit: 3000,
  },
});
