/**
 * What the host this is running in can actually do.
 *
 * The screens used to ask "am I inside Electron?", in around forty spellings of
 * that question. This is the replacement, and the difference is not cosmetic: a
 * component asks whether the *thing it is about to offer* is possible, so when a
 * third host appears the answer is already right, and a control that cannot work
 * is never drawn rather than drawn and dead.
 *
 * The bridge is resolved once for the life of the renderer, so this is a
 * constant — it needs no state and never triggers a re-render.
 */
import { resolveBridge, type Capabilities } from '@kurisu/platform';

export function useCapabilities(): Capabilities {
  return resolveBridge().capabilities;
}
