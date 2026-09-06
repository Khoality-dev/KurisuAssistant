/**
 * A random identifier that does not need a secure context.
 *
 * `crypto.randomUUID` is `[SecureContext]`-only. In Electron and on
 * `http://localhost` that is invisible, but a page served over plain HTTP from a
 * LAN address does not get one, and `randomUUID` is then `undefined` — on a code
 * path that runs before every message reaches the socket. `getRandomValues`
 * carries no such restriction, so this falls back to it and formats the result
 * as the same v4 UUID shape callers already log and compare.
 */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
