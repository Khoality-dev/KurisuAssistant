/**
 * The window's `ready` handshake (#237): the session before the personas.
 *
 * The window starts loading art the moment it has a persona; a persona that
 * arrives first makes every fetch a 401 the compositor reads as a missing
 * file. What is pinned here is the pure function's order — the two calls it
 * makes and their sequence — not the hook that wires it to `onCharacterReady`
 * (`useCharacterPanel`). Rendering that hook needs `react-dom`, which the
 * boundary test keeps out of this package, so the wiring is covered end to end
 * by `characterWindow.spec.ts` instead: the window's first asset fetch carries
 * the bearer only if the session arrived before the persona did.
 */

import { fakeCharacterWindow } from '@kurisu/platform/testing';
import { describe, expect, it } from 'vitest';
import { greetCharacterWindow } from './characterSession';

describe('greetCharacterWindow', () => {
  it('sends the session, then the personas', () => {
    const api = fakeCharacterWindow();

    greetCharacterWindow(api, { accessToken: 'tok' }, () => {
      api.sendPersonasUpdate({ personas: [], activePersonaId: null });
    });

    expect(api.calls.map((call) => call.method)).toEqual(['sendSession', 'sendPersonasUpdate']);
    expect(api.calls[0].data).toEqual({ accessToken: 'tok' });
  });

  it('says so even when there is no session, so the window stops waiting', () => {
    const api = fakeCharacterWindow();

    greetCharacterWindow(api, { accessToken: null }, () => {});

    expect(api.calls[0]).toEqual({ method: 'sendSession', data: { accessToken: null } });
  });
});
