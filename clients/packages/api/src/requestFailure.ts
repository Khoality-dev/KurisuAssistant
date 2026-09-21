/**
 * One sentence a person can act on, for any request that failed (#263).
 *
 * The API writes its refusals for the user: a JSON `detail` is the whole
 * explanation, and it always wins. Everything else that can go wrong is not
 * the API talking — a proxy in front of it refusing this network, nothing
 * listening at the address, a certificate the app does not trust, a timeout —
 * and axios describes each of those as "Request failed with status code 403"
 * or "Network Error", which names nothing a person can check. Each kind is
 * reduced to what answered, with what code, and what to look at.
 *
 * A wire-protocol refusal (426) keeps `describeMismatch`'s sentence (#150).
 * Synchronous on purpose: the login screen and the settings sections call it
 * from a catch, and the bodies that matter there are already parsed JSON. A
 * Blob body (speech) has its own describer.
 */

import { WIRE_PROTOCOL } from '@kurisu/models';
import { config } from './config';
import { describeMismatch } from './wireProtocol';

interface AxiosLike {
  response?: { status?: number; data?: unknown };
  request?: unknown;
  code?: string;
  message?: string;
}

/** The API's own sentence out of a response body, when there is one. */
export function apiDetail(data: unknown): string | null {
  let body: unknown = data;
  if (typeof body === 'string') {
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

function isCertificateFailure(err: AxiosLike): boolean {
  const code = (err.code ?? '').toUpperCase();
  const message = (err.message ?? '').toUpperCase();
  return (
    code.startsWith('ERR_CERT_') ||
    code.startsWith('CERT_') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    message.includes('ERR_CERT_') ||
    message.includes('SELF SIGNED CERTIFICATE') ||
    message.includes('SELF_SIGNED_CERT') ||
    message.includes('CERTIFICATE HAS EXPIRED')
  );
}

function origin(): string {
  const base = config.apiBaseUrl;
  try {
    return new URL(base).origin;
  } catch {
    return base || 'the server address';
  }
}

/**
 * What to show for `err`. `fallback` is the caller's own wording for the case
 * nothing else fits — the error carried no message at all.
 */
export function describeRequestFailure(err: unknown, fallback = 'Something went wrong.'): string {
  if (!err || typeof err !== 'object') {
    return typeof err === 'string' && err.trim() ? err.trim() : fallback;
  }
  const e = err as AxiosLike;

  if (e.response) {
    const detail = apiDetail(e.response.data);
    if (detail) return detail;

    const status = e.response.status ?? 0;
    switch (status) {
      case 401:
        return 'The server refused the credentials.';
      case 403:
        return "Something in front of the server refused this device (HTTP 403). Check the server address, and whether the operator's proxy allows your network.";
      case 404:
        return 'No KurisuAssistant server answers at this address (HTTP 404).';
      case 426: {
        const body = (e.response.data ?? {}) as { server_wire_protocol?: unknown };
        const serverWire = Number(body.server_wire_protocol);
        return describeMismatch(WIRE_PROTOCOL, Number.isFinite(serverWire) ? serverWire : null);
      }
      case 502:
      case 503:
      case 504:
        return `The server is not reachable behind its proxy (HTTP ${status}).`;
      default:
        if (status >= 500) return `The server failed (HTTP ${status}).`;
        if (status > 0) return `The server answered HTTP ${status}.`;
        return fallback;
    }
  }

  if (isCertificateFailure(e)) {
    return "The server's certificate is not trusted by this app.";
  }
  if (e.code === 'ECONNABORTED' || e.code === 'ETIMEDOUT' || /timeout/i.test(e.message ?? '')) {
    return 'The server did not answer in time.';
  }
  if (e.request || e.code === 'ERR_NETWORK' || e.code === 'ECONNREFUSED' || e.code === 'ENOTFOUND') {
    return `Nothing answered at ${origin()}. Check the address and that the server is running.`;
  }

  const message = e.message?.trim();
  return message ? message : fallback;
}
