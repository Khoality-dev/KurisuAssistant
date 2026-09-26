/**
 * The committed page, as Android ships it (#245).
 *
 * `npm run build:page` writes it; CI rebuilds it and fails on any difference,
 * so these assertions are about what the file must be, whoever built it.
 */
import { createHash } from 'crypto';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(new URL(import.meta.url).pathname);
const ASSET_DIR = join(HERE, '../../../../android/app/src/main/assets/character');
const PAGE = join(ASSET_DIR, 'index.html');

function page(): string {
  return readFileSync(PAGE, 'utf8');
}

function csp(html: string): Map<string, string[]> {
  const meta = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/);
  if (!meta) throw new Error('no Content-Security-Policy meta tag');
  return new Map(
    meta[1].split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
      const [name, ...values] = d.split(/\s+/);
      return [name, values] as [string, string[]];
    }),
  );
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

describe('the committed character page', () => {
  it('is exactly one file, index.html', () => {
    expect(existsSync(ASSET_DIR)).toBe(true);
    expect(readdirSync(ASSET_DIR)).toEqual(['index.html']);
  });

  it('carries its own content security policy before anything that runs', () => {
    const html = page();
    const metaAt = html.indexOf('<meta http-equiv="Content-Security-Policy"');
    const firstScript = html.indexOf('<script');
    expect(metaAt).toBeGreaterThan(-1);
    expect(firstScript).toBeGreaterThan(metaAt);
    const policy = csp(html);
    expect(policy.get('default-src')).toEqual(["'none'"]);
    expect(policy.get('base-uri')).toEqual(["'none'"]);
    expect(policy.get('form-action')).toEqual(["'none'"]);
    expect(policy.get('frame-src')).toEqual(["'none'"]);
    expect(policy.get('worker-src')).toEqual(["'none'"]);
    // Same origin for the model and clips; blob: and data: for the textures
    // GLTFLoader unpacks from the model's own buffers — and fetches, which is
    // why they are in connect-src and not only img-src.
    expect(policy.get('connect-src')).toEqual(["'self'", 'blob:', 'data:']);
    expect(policy.get('img-src')).toEqual(['blob:', 'data:']);
  });

  it('allows exactly the scripts it inlines, by hash, and nothing by origin', () => {
    const html = page();
    const scripts = inlineScripts(html);
    expect(scripts.length).toBeGreaterThan(0);
    const hashes = scripts.map((s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`);
    expect(csp(html).get('script-src')).toEqual(hashes);
  });

  it('is self-contained: no script or stylesheet comes from anywhere else', () => {
    const html = page();
    expect(html).not.toMatch(/<script\b[^>]*\bsrc=/);
    expect(html).not.toMatch(/<link\b/);
  });
});
