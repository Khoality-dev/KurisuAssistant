/**
 * Copy for the wire-protocol gate.
 *
 * A mismatch has two very different remedies, and the screen used to say only
 * "please update" — which is wrong advice half the time. A newer server means
 * this app is behind; an older server means the operator is (#150).
 */

/** Which side needs updating for the numbers to agree, or `unknown` if the server's is not known. */
export type MismatchSide = 'app' | 'server' | 'unknown';

export function mismatchSide(clientWire: number, serverWire: number | null): MismatchSide {
  if (serverWire === null || !Number.isFinite(serverWire)) return 'unknown';
  return serverWire > clientWire ? 'app' : 'server';
}

/** One sentence naming both numbers and saying who has to act. */
export function describeMismatch(clientWire: number, serverWire: number | null): string {
  switch (mismatchSide(clientWire, serverWire)) {
    case 'app':
      return `This app speaks wire protocol ${clientWire} but the server speaks ${serverWire}. Update the app.`;
    case 'server':
      return `This app speaks wire protocol ${clientWire} but the server speaks ${serverWire}. Ask the operator to update the server.`;
    default:
      return `This app speaks wire protocol ${clientWire}, and the server refused it as incompatible. Update whichever side is behind.`;
  }
}
