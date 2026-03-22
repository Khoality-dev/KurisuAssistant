import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import fs from 'fs';
import path from 'path';

/**
 * Vite plugin to serve ONNX Runtime .mjs files directly,
 * bypassing Vite's module transform which breaks Emscripten-generated code.
 */
function serveOnnxWasm(): Plugin {
  return {
    name: 'serve-onnx-wasm',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.includes('ort-wasm') && (req.url.includes('.mjs') || req.url.includes('.wasm'))) {
          // Extract the filename (strip query params like ?import)
          const filename = req.url.split('/').pop()?.split('?')[0];
          if (filename) {
            const filePath = path.join(process.cwd(), 'public', 'vad', filename);
            if (fs.existsSync(filePath)) {
              const isWasm = filename.endsWith('.wasm');
              const content = fs.readFileSync(filePath);
              res.setHeader('Content-Type', isWasm ? 'application/wasm' : 'application/javascript');
              res.end(content);
              return;
            }
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    serveOnnxWasm(),
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        onstart(options) {
          options.startup();
        },
        vite: {
          build: {
            rollupOptions: {
              external: (id) => id === 'playwright' || id.startsWith('playwright/') || id.startsWith('chromium-bidi'),
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload();
        },
      },
    ]),
    renderer(),
  ],
  server: {
    port: 5173,
  },
});
