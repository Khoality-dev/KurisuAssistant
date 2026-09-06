/**
 * What the renderer is allowed to load, and where it is allowed to go (#90).
 *
 * The decisions live here, free of electron imports, so they can be unit-tested
 * directly — the same shape as `mcpServerAuth.ts` and `hostToolPolicy.ts`. The
 * wiring into sessions and windows is in `main.ts`.
 *
 * This client renders whatever a remote server sends — assistant text, markdown,
 * images, tool output — in front of a privileged IPC surface. `contextIsolation`
 * and `nodeIntegration: false` close the direct route to that surface; these two
 * rules close the indirect ones: loading code from somewhere else, and being
 * navigated somewhere else.
 */

/** Where the packaged app's own documents come from. */
const APP_FILE_SCHEMES = ['file:', 'local-file:'];

/**
 * The policy, one directive per line of reasoning.
 *
 * It is applied to the packaged app only. A dev run loads from the Vite server,
 * which needs `unsafe-eval` for its HMR client and rewrites modules on the fly;
 * pinning a policy there would describe the dev server rather than the product,
 * and the developer's own machine is not the threat model. What ships, and what
 * the e2e suite exercises, is the packaged path.
 */
export function buildContentSecurityPolicy(): string {
  return [
    // Deny by default; every allowance below is something the app demonstrably does.
    "default-src 'self'",

    // Own bundle, plus:
    //   'wasm-unsafe-eval' — Silero VAD runs through onnxruntime-web, which
    //     compiles WebAssembly; without it voice interaction stops working.
    //   jsdelivr — @monaco-editor/react fetches the Monaco bundle from the CDN
    //     at runtime because nothing calls `loader.config()`. This is the one
    //     genuine hole in the policy and wants its own issue: bundling Monaco
    //     locally would remove the entry and make the file editor work offline.
    "script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net",

    // MUI and Emotion inject <style> elements as components render, so this
    // cannot be tightened without replacing the styling engine.
    "style-src 'self' 'unsafe-inline'",

    // The bundled Plus Jakarta Sans faces, and data: for anything inlined.
    "font-src 'self' data:",

    // Avatars and face photos come from the user's own backend, whose address
    // the user types — so no host can be named here, and http: has to be
    // allowed because a backend on the LAN is the documented normal case.
    // blob: covers `authedAsset`, which fetches with a token and hands the
    // renderer an object URL; local-file: and file: cover images read from disk.
    "img-src 'self' data: blob: local-file: file: http: https:",

    // Synthesized speech arrives as a blob; character transition videos are read
    // from disk through local-file:, and both may also come from the backend.
    "media-src 'self' data: blob: local-file: file: http: https:",

    // REST and the chat socket, to that same user-configured backend.
    "connect-src 'self' data: blob: http: https: ws: wss:",

    // onnxruntime-web and Monaco both start workers, Monaco's from a blob.
    "worker-src 'self' blob:",

    // Nothing here embeds plugins, frames anything, or submits a form, and the
    // document base is never rewritten.
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * Whether the renderer may navigate itself to `target`.
 *
 * Only the app's own documents qualify: the packaged bundle on `file:` (and the
 * `local-file:` scheme `main.ts` serves disk images through), or the Vite dev
 * server when one is running. Everything else — a link in an assistant message,
 * a redirect from a compromised backend — is refused, and the caller sends any
 * http(s) target to the system browser instead, where it has no access to this
 * app's IPC.
 */
export function isAllowedNavigation(target: string, devServerUrl?: string): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }

  if (APP_FILE_SCHEMES.includes(url.protocol)) return true;

  if (devServerUrl) {
    try {
      return url.origin === new URL(devServerUrl).origin;
    } catch {
      return false;
    }
  }

  return false;
}

/** Whether a refused target is worth handing to the system browser. */
export function isExternallyOpenable(target: string): boolean {
  try {
    const { protocol } = new URL(target);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
