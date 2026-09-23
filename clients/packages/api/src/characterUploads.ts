/**
 * What a refused character-asset request means, and the digest an upload carries (#236).
 *
 * The server refuses a model or clip with `detail: {code, message, ...}` — a
 * code the editor turns into its own wording ("That file isn't a VRM model"),
 * and a message for a code it does not know. Everything else (a dead server, a
 * proxy's HTML error page, a 500) collapses into `network` or `unknown`, so a
 * caller switches on one field and never parses axios.
 */
import {
  CHARACTER_UPLOAD_ERROR_CODES,
  type CharacterUploadErrorCode,
} from '@kurisu/models';

export class CharacterUploadError extends Error {
  readonly code: CharacterUploadErrorCode | 'network' | 'unknown';
  readonly status?: number;
  /** 413: the ceiling the file crossed. */
  readonly maxBytes?: number;
  /** 507: what the account has used, and may use. */
  readonly usedBytes?: number;
  readonly quotaBytes?: number;

  constructor(
    code: CharacterUploadError['code'],
    message: string,
    extra: { status?: number; maxBytes?: number; usedBytes?: number; quotaBytes?: number } = {},
  ) {
    super(message);
    this.name = 'CharacterUploadError';
    this.code = code;
    this.status = extra.status;
    this.maxBytes = extra.maxBytes;
    this.usedBytes = extra.usedBytes;
    this.quotaBytes = extra.quotaBytes;
  }
}

const KNOWN = new Set<string>(CHARACTER_UPLOAD_ERROR_CODES);

function numberOr(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Any failure from a character-asset call, as a `CharacterUploadError`. */
export function toCharacterUploadError(error: unknown): CharacterUploadError {
  if (error instanceof CharacterUploadError) return error;
  const err = (error ?? {}) as {
    response?: { status?: number; data?: unknown };
    request?: unknown;
    code?: string;
    message?: string;
    name?: string;
  };
  if (err.response) {
    const status = err.response.status;
    const body = err.response.data as { detail?: unknown } | undefined;
    const detail = body && typeof body === 'object' ? body.detail : undefined;
    if (detail && typeof detail === 'object') {
      const d = detail as Record<string, unknown>;
      const message = typeof d.message === 'string' && d.message.trim() ? d.message.trim() : `The server answered ${status}.`;
      const code = typeof d.code === 'string' && KNOWN.has(d.code) ? (d.code as CharacterUploadErrorCode) : 'unknown';
      return new CharacterUploadError(code, message, {
        status,
        maxBytes: numberOr(d.max_bytes),
        usedBytes: numberOr(d.used_bytes),
        quotaBytes: numberOr(d.quota_bytes),
      });
    }
    // nginx's own 413 (a body over its ceiling) has no JSON to read.
    if (status === 413) return new CharacterUploadError('too_large', 'That file is too large.', { status });
    const message = typeof detail === 'string' && detail.trim() ? detail.trim() : `The server answered ${status}.`;
    return new CharacterUploadError('unknown', message, { status });
  }
  if (err.name === 'CanceledError' || err.code === 'ERR_CANCELED' || err.name === 'AbortError') {
    return cancelled();
  }
  if (err.request || err.code === 'ERR_NETWORK' || err.code === 'ECONNABORTED') {
    return new CharacterUploadError('network', 'The server could not be reached.');
  }
  return new CharacterUploadError('unknown', err.message?.trim() || 'Something went wrong.');
}

/** The error for an upload its caller aborted — `code: 'cancelled'`, to be dropped silently. */
export function cancelled(): CharacterUploadError {
  return new CharacterUploadError('cancelled', 'The upload was cancelled.');
}

/** Throws `cancelled()` once `signal` has aborted — between the hash and the request, say. */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

/** The lowercase hex sha256 of a blob — the `?sha256=` the upload routes require. */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
