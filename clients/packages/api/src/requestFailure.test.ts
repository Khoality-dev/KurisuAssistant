/**
 * The sentence shown when a request fails for a reason the API did not write
 * (#263). Each branch is what a person sees; none of them may be axios's own
 * "Request failed with status code N".
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WIRE_PROTOCOL } from '@kurisu/models';
import { installBridge, resetBridge } from '@kurisu/platform/testing';
import { describeRequestFailure } from './requestFailure';
import { storage } from './storage';

describe('describeRequestFailure', () => {
  let savedUrl: string;

  beforeEach(() => {
    // The desktop host: the address is the user's, so the sentence can name it.
    installBridge({ capabilities: { configurableServer: true } });
    savedUrl = storage.getBackendUrl();
    storage.setBackendUrl('https://kurisu.example:15597');
  });

  afterEach(() => {
    storage.setBackendUrl(savedUrl);
    resetBridge();
  });

  it("uses the API's own detail whatever the status", () => {
    const err = { response: { status: 403, data: { detail: 'This account is not activated yet.' } } };
    expect(describeRequestFailure(err)).toBe('This account is not activated yet.');
  });

  it('parses a JSON detail that arrived as a string', () => {
    const err = { response: { status: 400, data: '{"detail":"User already exists"}' } };
    expect(describeRequestFailure(err)).toBe('User already exists');
  });

  it('ignores a validation-error list under detail', () => {
    const err = { response: { status: 422, data: { detail: [{ msg: 'field required' }] } } };
    expect(describeRequestFailure(err)).toBe('The server answered HTTP 422.');
  });

  it("names a proxy's 403 as something in front of the server", () => {
    const err = { response: { status: 403, data: '<html><h1>403 Forbidden</h1></html>' }, message: 'Request failed with status code 403' };
    expect(describeRequestFailure(err)).toBe(
      "Something in front of the server refused this device (HTTP 403). Check the server address, and whether the operator's proxy allows your network.",
    );
  });

  it('says the credentials were refused on a bare 401', () => {
    const err = { response: { status: 401, data: '' } };
    expect(describeRequestFailure(err)).toBe('The server refused the credentials.');
  });

  it('says no server answers on a 404', () => {
    const err = { response: { status: 404, data: '<html>nginx</html>' } };
    expect(describeRequestFailure(err)).toBe('No KurisuAssistant server answers at this address (HTTP 404).');
  });

  it.each([502, 503, 504])('blames the proxy on a %d', (status) => {
    const err = { response: { status, data: '<html>bad gateway</html>' } };
    expect(describeRequestFailure(err)).toBe(`The server is not reachable behind its proxy (HTTP ${status}).`);
  });

  it('says the server failed on another 5xx', () => {
    const err = { response: { status: 500, data: 'Internal Server Error' } };
    expect(describeRequestFailure(err)).toBe('The server failed (HTTP 500).');
  });

  it('keeps the wire-protocol sentence on a 426', () => {
    const err = { response: { status: 426, data: { backend_version: '0.6.0', server_wire_protocol: WIRE_PROTOCOL - 1 } } };
    expect(describeRequestFailure(err)).toBe(
      `This app speaks wire protocol ${WIRE_PROTOCOL} but the server speaks ${WIRE_PROTOCOL - 1}. Ask the operator to update the server.`,
    );
  });

  it('names the origin when nothing answered', () => {
    const err = { request: {}, code: 'ERR_NETWORK', message: 'Network Error' };
    expect(describeRequestFailure(err)).toBe(
      'Nothing answered at https://kurisu.example:15597. Check the address and that the server is running.',
    );
  });

  it('treats a refused connection the same way', () => {
    const err = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:15597' };
    expect(describeRequestFailure(err)).toBe(
      'Nothing answered at https://kurisu.example:15597. Check the address and that the server is running.',
    );
  });

  it.each([
    { code: 'ERR_CERT_AUTHORITY_INVALID', message: 'net::ERR_CERT_AUTHORITY_INVALID' },
    { code: 'DEPTH_ZERO_SELF_SIGNED_CERT', message: 'self signed certificate' },
    { code: 'ERR_NETWORK', message: 'net::ERR_CERT_DATE_INVALID' },
  ])('recognises a certificate failure ($code)', (err) => {
    expect(describeRequestFailure({ request: {}, ...err })).toBe("The server's certificate is not trusted by this app.");
  });

  it('says the server did not answer in time on a timeout', () => {
    const err = { request: {}, code: 'ECONNABORTED', message: 'timeout of 30000ms exceeded' };
    expect(describeRequestFailure(err)).toBe('The server did not answer in time.');
  });

  it("falls back to the error's own message for anything else", () => {
    expect(describeRequestFailure(new Error('QR code is not a Kurisu login code'))).toBe('QR code is not a Kurisu login code');
  });

  it("uses the caller's fallback when there is no message at all", () => {
    expect(describeRequestFailure({}, 'Could not verify password')).toBe('Could not verify password');
    expect(describeRequestFailure(undefined, 'Could not verify password')).toBe('Could not verify password');
  });
});
