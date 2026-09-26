/**
 * The character page Android ships (#245): `src/page/index.html` built into
 * ONE self-contained file at a fixed name, committed under the app's assets,
 * because Android's build and release have no JavaScript toolchain. CI
 * rebuilds it and fails on any difference (`desktop-test.yml`).
 *
 * `npm run build:page -w @kurisu/vrm` from `clients/`.
 *
 * The inlining is done here rather than by a plugin: after Vite has built one
 * script chunk (`inlineDynamicImports`) and one stylesheet (`cssCodeSplit:
 * false`), the page takes both in place of the tags that load them, and gets a
 * Content-Security-Policy `<meta>` naming its scripts by hash. Nothing in the
 * page loads from anywhere; the Kotlin request interceptor is not the only
 * thing between it and the network, and the same file stays safe in a host
 * with no interceptor at all.
 */
import { createHash } from 'crypto';
import { fileURLToPath } from 'url';
import { defineConfig, type Plugin } from 'vite';

const PAGE_DIR = fileURLToPath(new URL('./src/page', import.meta.url));
const OUT_DIR = fileURLToPath(new URL('../../android/app/src/main/assets/character', import.meta.url));

function policy(scriptHashes: string[]): string {
  return [
    "default-src 'none'",
    `script-src ${scriptHashes.join(' ')}`,
    // The model and clips come from the page's own origin, where the host
    // answers /character-assets/ with the file. GLTFLoader unpacks a model's
    // textures into blob: URLs and FETCHES them (ImageBitmapLoader), so blob:
    // and data: belong in connect-src as well as img-src.
    "connect-src 'self' blob: data:",
    'img-src blob: data:',
    "style-src 'unsafe-inline'",
    "worker-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function inlinePage(): Plugin {
  return {
    name: 'kurisu-character-page',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = bundle['index.html'];
      if (!html || html.type !== 'asset') throw new Error('the page build produced no index.html');
      let source = String(html.source);

      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName === 'index.html') continue;
        if (output.type === 'chunk') {
          const tag = new RegExp(`<script type="module" crossorigin src="[^"]*${escapeRegExp(fileName)}"></script>`);
          if (!tag.test(source)) throw new Error(`index.html does not load ${fileName}`);
          // `</script` cannot appear outside a string or regex literal, and inside one `<\/` is the same text.
          const code = output.code.replace(/<\/script/gi, '<\\/script');
          source = source.replace(tag, () => `<script type="module">${code}</script>`);
        } else if (fileName.endsWith('.css')) {
          const tag = new RegExp(`<link rel="stylesheet" crossorigin href="[^"]*${escapeRegExp(fileName)}">`);
          if (!tag.test(source)) throw new Error(`index.html does not load ${fileName}`);
          source = source.replace(tag, () => `<style>${String(output.source)}</style>`);
        } else {
          throw new Error(`the page would ship a second file, ${fileName}`);
        }
        delete bundle[fileName];
      }

      const hashes = [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(
        (m) => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`,
      );
      const charset = '<meta charset="utf-8">';
      if (!source.includes(charset)) throw new Error('index.html has no <meta charset> to put the policy after');
      source = source.replace(charset, () => `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${policy(hashes)}">`);
      html.source = source;
    },
  };
}

export default defineConfig({
  root: PAGE_DIR,
  base: './',
  logLevel: 'warn',
  build: {
    outDir: OUT_DIR,
    // The folder holds this page and nothing else; the bundle test says so.
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    modulePreload: false,
    reportCompressedSize: false,
    rollupOptions: {
      input: `${PAGE_DIR}/index.html`,
      output: { inlineDynamicImports: true },
    },
  },
  plugins: [inlinePage()],
});
