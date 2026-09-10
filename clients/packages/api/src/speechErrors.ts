/**
 * One sentence a person can act on, for a speech request that failed (#200).
 *
 * The API answers speech failures with a JSON `detail` written for the user
 * ("The speech service is unavailable."); that is what to show when it is
 * there. Synthesis is requested with `responseType: 'blob'`, so on that route
 * the body arrives as a Blob and has to be read before it can be parsed.
 * Anything else is reduced to the kind of failure — never a stack trace, never
 * an axios message with a URL in it.
 */
export async function describeSpeechFailure(what: string, error: unknown): Promise<string> {
  const reason = (await failureReason(error)) ?? 'something went wrong';
  return `${what} failed: ${reason.replace(/\.+$/, '')}.`;
}

async function failureReason(error: unknown): Promise<string | null> {
  if (!error || typeof error !== 'object') return null;
  const err = error as { response?: { status?: number; data?: unknown }; request?: unknown; message?: string; code?: string };

  if (err.response) {
    const detail = await apiDetail(err.response.data);
    if (detail) return detail;
    return err.response.status ? `the server answered ${err.response.status}` : null;
  }
  if (err.request || err.code === 'ERR_NETWORK' || err.code === 'ECONNABORTED') {
    return 'the server could not be reached';
  }
  return err.message && err.message.trim() ? err.message.trim() : null;
}

async function apiDetail(data: unknown): Promise<string | null> {
  let body: unknown = data;
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    try {
      body = JSON.parse(await body.text());
    } catch {
      return null;
    }
  } else if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (body && typeof body === 'object' && 'detail' in body) {
    const detail = (body as { detail?: unknown }).detail;
    if (typeof detail === 'string' && detail.trim()) return detail.trim();
  }
  return null;
}
