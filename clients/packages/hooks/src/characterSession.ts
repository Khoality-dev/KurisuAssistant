/**
 * The handshake with the character window, on its `ready`.
 *
 * Order is the contract: the session first, then the personas. The window
 * starts loading art the moment it has a persona, and a persona that arrives
 * before the token would make every fetch a 401 that the compositor reads as
 * a missing file (#237). Pure, so the order is a test rather than a comment.
 */
import type { CharacterSession, CharacterWindowAPI } from '@kurisu/platform';

export function greetCharacterWindow(
  api: Pick<CharacterWindowAPI, 'sendSession'>,
  session: CharacterSession,
  sendPersonaState: () => void,
): void {
  api.sendSession(session);
  sendPersonaState();
}
