/**
 * The two rules that keep remote content from driving this renderer (#90).
 *
 * Both are pure functions for exactly this reason: the policy is a security
 * decision, and a decision worth making is worth asserting on without booting
 * Electron. `mcpServerAuth.test.ts` covers the third one the same way.
 */

import { describe, it, expect } from 'vitest';
import {
  buildContentSecurityPolicy,
  isAllowedNavigation,
  isExternallyOpenable,
} from '../electron/webSecurity';

function directive(name: string): string {
  const found = buildContentSecurityPolicy()
    .split('; ')
    .find((d) => d.startsWith(`${name} `) || d === name);
  if (!found) throw new Error(`no ${name} directive in the policy`);
  return found;
}

describe('content security policy', () => {
  it('denies by default', () => {
    expect(directive('default-src')).toBe("default-src 'self'");
  });

  it('never allows arbitrary script evaluation', () => {
    // 'wasm-unsafe-eval' compiles WebAssembly and nothing else; 'unsafe-eval'
    // would hand any injected string to the JS engine.
    expect(directive('script-src')).toContain("'wasm-unsafe-eval'");
    expect(directive('script-src')).not.toContain("'unsafe-eval'");
    expect(directive('script-src')).not.toContain("'unsafe-inline'");
  });

  it('allows the backend over both schemes, because its address is the user\'s to choose', () => {
    // A LAN backend on plain http is the documented normal case, so the policy
    // cannot name a host and cannot require TLS.
    for (const scheme of ['http:', 'https:', 'ws:', 'wss:']) {
      expect(directive('connect-src')).toContain(scheme);
    }
  });

  it('allows the object URLs the app builds for images, audio and video', () => {
    expect(directive('img-src')).toContain('blob:');
    expect(directive('media-src')).toContain('blob:');
    // Images and character videos are also read from disk through this scheme.
    expect(directive('img-src')).toContain('local-file:');
    expect(directive('media-src')).toContain('local-file:');
  });

  it('shuts the directives nothing here uses', () => {
    expect(directive('object-src')).toBe("object-src 'none'");
    expect(directive('frame-src')).toBe("frame-src 'none'");
    expect(directive('form-action')).toBe("form-action 'none'");
    expect(directive('base-uri')).toBe("base-uri 'self'");
  });
});

describe('navigation', () => {
  const DEV = 'http://localhost:5173';

  it('allows the packaged app to load its own documents', () => {
    expect(isAllowedNavigation('file:///opt/kurisu/dist/index.html')).toBe(true);
    expect(isAllowedNavigation('local-file:///home/u/pictures/a.png')).toBe(true);
  });

  it('allows the dev server only when one is running', () => {
    expect(isAllowedNavigation(`${DEV}/index.html`, DEV)).toBe(true);
    expect(isAllowedNavigation(`${DEV}/index.html`)).toBe(false);
  });

  it('refuses anywhere else, including a lookalike of the dev server', () => {
    expect(isAllowedNavigation('https://example.com/', DEV)).toBe(false);
    expect(isAllowedNavigation('http://localhost:5174/', DEV)).toBe(false);
    expect(isAllowedNavigation('http://evil.test/#localhost:5173', DEV)).toBe(false);
  });

  it('refuses what is not a URL at all', () => {
    expect(isAllowedNavigation('')).toBe(false);
    expect(isAllowedNavigation('javascript:alert(1)')).toBe(false);
  });

  it('hands only web URLs to the system browser', () => {
    expect(isExternallyOpenable('https://example.com')).toBe(true);
    expect(isExternallyOpenable('http://192.168.1.10:15597')).toBe(true);
    // Handing these to the OS is how a refused navigation becomes a launched
    // program or an opened file instead.
    expect(isExternallyOpenable('file:///etc/passwd')).toBe(false);
    expect(isExternallyOpenable('javascript:alert(1)')).toBe(false);
    expect(isExternallyOpenable('smb://share/x')).toBe(false);
  });
});
