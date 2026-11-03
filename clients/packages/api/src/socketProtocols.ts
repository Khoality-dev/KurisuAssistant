import {
  LEGACY_WS_AUTH_SUBPROTOCOL,
  LEGACY_WS_WIRE_SUBPROTOCOL_PREFIX,
  WIRE_PROTOCOL,
  WS_AUTH_SUBPROTOCOL,
  WS_WIRE_SUBPROTOCOL_PREFIX,
} from '@amadeus/models';

/**
 * The subprotocol entries a renderer opens a socket with: the auth marker, the
 * token, and the wire protocol (#378). A server from before the rename reads
 * only `kurisu.auth.bearer` in first place, and a browser refuses an offer that
 * names the token twice, so one offer cannot speak to both: the new spelling is
 * tried first and the sockets retry once with `legacyOnly` when it is refused.
 */
export function webSocketProtocols(token: string, legacyOnly = false): string[] {
  return legacyOnly
    ? [LEGACY_WS_AUTH_SUBPROTOCOL, token, `${LEGACY_WS_WIRE_SUBPROTOCOL_PREFIX}${WIRE_PROTOCOL}`]
    : [WS_AUTH_SUBPROTOCOL, token, `${WS_WIRE_SUBPROTOCOL_PREFIX}${WIRE_PROTOCOL}`];
}
