/**
 * The character page's DOM half (#245): the canvas, the frame loop, and the
 * two ways a native host talks to the page.
 *
 * In: `window.__kurisu.push(message)` (what `evaluateJavascript` calls), or a
 * `MessagePort` handed over once with `postMessage('kurisu:port', [port])`
 * after which every message arrives on the port as a JSON string.
 * Out: the `KurisuNative` JavaScript interface's `ready()`, `firstFrame()` and
 * `error(code, message)` when the host installed it, else the port.
 *
 * `document.documentElement.dataset.status` mirrors the runtime's status and
 * `window.__kurisu.events` records what was sent, so a test can watch the page
 * without being a native host.
 */
import { supportsWebGL } from '../probe';
import { createVrmDriver } from '../driver/VrmDriver';
import type { PageEvent } from './host';
import { createPageRuntime, type PageStatus, type PageSubtitle } from './runtime';

interface KurisuNativeBridge {
  ready(): void;
  firstFrame(): void;
  error(code: string, message: string): void;
}

interface KurisuPageApi {
  push(message: unknown): void;
  readonly events: PageEvent[];
}

declare global {
  interface Window {
    KurisuNative?: KurisuNativeBridge;
    __kurisu?: KurisuPageApi;
  }
}

const SENTENCES: Partial<Record<PageStatus, string>> = {
  nogl: 'This device cannot show a 3D character.',
  failed: 'The character could not be loaded.',
};

const root = document.documentElement;
const stage = document.getElementById('stage') as HTMLDivElement;
const messageEl = document.getElementById('message') as HTMLParagraphElement;
const subtitleEl = document.getElementById('subtitle') as HTMLParagraphElement;

const events: PageEvent[] = [];
let port: MessagePort | null = null;

function emit(event: PageEvent): void {
  events.push(event);
  const native = window.KurisuNative;
  try {
    if (native) {
      if (event.t === 'ready') native.ready();
      else if (event.t === 'first-frame') native.firstFrame();
      else native.error(event.code, event.message);
    } else {
      port?.postMessage(JSON.stringify(event));
    }
  } catch {
    // A host that went away mid-call has nothing to tell.
  }
}

function showStatus(status: PageStatus, detail: string | null): void {
  root.dataset.status = status;
  const sentence = SENTENCES[status] ?? (status === 'no-model' ? detail : null);
  messageEl.textContent = sentence ?? '';
  messageEl.hidden = !sentence;
}

let subtitleTimer = 0;
function showSubtitle(subtitle: PageSubtitle | null): void {
  window.clearTimeout(subtitleTimer);
  subtitleEl.textContent = subtitle?.text ?? '';
  subtitleEl.hidden = !subtitle;
  subtitleEl.classList.toggle('user', !!subtitle?.isUser);
  if (subtitle) subtitleTimer = window.setTimeout(() => showSubtitle(null), subtitle.holdMs);
}

if (!supportsWebGL()) {
  showStatus('nogl', null);
  emit({ t: 'error', code: 'nogl', message: SENTENCES.nogl! });
  window.__kurisu = { push() {}, events };
} else {
  const runtime = createPageRuntime({
    createDriver: () => {
      // A fresh canvas per driver: a driver that leaves takes its context with it.
      const canvas = document.createElement('canvas');
      stage.replaceChildren(canvas);
      return createVrmDriver(canvas, { releaseContextOnDispose: true });
    },
    fetchAsset: async (url, signal) => {
      const response = await fetch(url, { signal, credentials: 'omit' });
      if (!response.ok) throw new Error(`The character's file answered ${response.status}.`);
      return response.arrayBuffer();
    },
    emit,
    onStatus: showStatus,
    onSubtitle: showSubtitle,
  });

  new ResizeObserver((entries) => {
    const rect = entries[0]?.contentRect;
    if (rect) runtime.resize(rect.width, rect.height, window.devicePixelRatio || 1);
  }).observe(stage);

  const tick = () => {
    runtime.frame(Date.now());
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  window.addEventListener('message', (event) => {
    // One port, once: the host's channel is the only one this page listens on.
    if (port || event.data !== 'kurisu:port' || !event.ports?.[0]) return;
    port = event.ports[0];
    port.onmessage = (m) => runtime.receive(m.data);
  });
  window.addEventListener('pagehide', () => runtime.dispose());

  window.__kurisu = { push: (message) => runtime.receive(message), events };
  showStatus('idle', null);
  emit({ t: 'ready' });
}
