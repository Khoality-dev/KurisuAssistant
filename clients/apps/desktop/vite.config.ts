import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';
import renderer from 'vite-plugin-electron-renderer';
import fs from 'fs';
import path from 'path';

/**
 * The app's version, baked in at build time from this package.json.
 *
 * `app.getVersion()` reads the packaged app's package.json — right for an
 * installed build (electron-builder writes the release number there first) but
 * under Playwright, which runs the unpackaged `dist-electron/main.js`, it falls
 * back to the Electron binary's own version and Settings read "v43.6.0" (#257).
 * A define is the same number in every build: what `package.json` says.
 */
const APP_VERSION = JSON.stringify(
  (JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8')) as { version: string }).version,
);
const defineAppVersion = { define: { __APP_VERSION__: APP_VERSION } };

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
        vite: defineAppVersion,
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          options.reload();
        },
        vite: defineAppVersion,
      },
    ]),
    renderer(),
  ],
  ...defineAppVersion,
  server: {
    port: 5173,
  },
});
