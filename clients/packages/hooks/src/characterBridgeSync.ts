/**
 * The one adapter between the in-process character feed and the second
 * window (#238).
 *
 * Producers write the feed store without knowing whether a window exists;
 * this mirrors what they wrote over IPC while the window is open, answers the
 * window's `ready` (the session first, then the personas, then what the feed
 * holds right now, so a window opened mid-sentence catches up) and its
 * session requests. Pure — the hook around it is one `useEffect` — so the
 * gating and the handshake order are tests, not comments.
 */
import type { CharacterWindowAPI, PersonaCharacterData } from '@kurisu/platform';
import {
  characterFeed,
  onCharacterFeed,
  useCharacterStore,
  type CharacterFeedEvent,
} from '@kurisu/state';
import { greetCharacterWindow } from './characterSession';

export interface CharacterBridgeDeps {
  /** The access token this renderer holds, for the handshake and a refused request. */
  getToken: () => string | null;
  /** Try to refresh the session; a refresh re-pushes on its own through `storage.setToken`. */
  refresh: () => Promise<unknown>;
}

function personaPayload(): { personas: PersonaCharacterData[]; activePersonaId: number | null } {
  const { personas, activePersonaId } = useCharacterStore.getState();
  return {
    personas: Array.from(personas.entries()).map(([id, entry]) => ({
      id,
      name: entry.name,
      avatarUuid: entry.avatarUuid,
      character: entry.character,
    })),
    activePersonaId,
  };
}

function forward(api: CharacterWindowAPI, event: CharacterFeedEvent): void {
  switch (event.type) {
    case 'speech': api.sendSpeech(event.segment); break;
    case 'speech-sync': api.sendSpeechSync(event.sync); break;
    case 'thinking': api.sendFeed({ isThinking: event.isThinking }); break;
    case 'gestures': api.sendGestureUpdate({ gestures: event.names, seq: event.seq }); break;
    case 'faces': api.sendFaceUpdate({ faces: event.names }); break;
    case 'subtitle': api.sendSubtitle(event.subtitle); break;
  }
}

/** Everything the feed holds now, for a window that just said `ready`. */
function catchUp(api: CharacterWindowAPI): void {
  api.sendFeed({ isThinking: characterFeed.thinking.current });
  api.sendFaceUpdate({ faces: characterFeed.faces.current });
  api.sendSpeech(characterFeed.speech.current);
  const sync = characterFeed.speechSync.current;
  if (sync) api.sendSpeechSync(sync);
}

/** Start mirroring. Returns the stop. */
export function mirrorCharacterFeed(api: CharacterWindowAPI, deps: CharacterBridgeDeps): () => void {
  const windowOpen = () => useCharacterStore.getState().windowOpen;

  const offFeed = onCharacterFeed((event) => {
    if (windowOpen()) forward(api, event);
  });

  const offStore = useCharacterStore.subscribe((state, previous) => {
    if (!state.windowOpen) return;
    if (state.personas !== previous.personas || state.activePersonaId !== previous.activePersonaId) {
      api.sendPersonasUpdate(personaPayload());
    }
  });

  // The window's `ready`: not gated on `windowOpen` — a `ready` is proof the
  // window exists, and the flag can lag it (the main process focuses an
  // existing window without a second `ready`; a reload of this renderer
  // starts the flag at false while the window is still there).
  const offReady = api.onCharacterReady(() => {
    useCharacterStore.getState().setWindowOpen(true);
    greetCharacterWindow(api, { accessToken: deps.getToken() }, () => api.sendPersonasUpdate(personaPayload()));
    catchUp(api);
  });

  // The window's token was refused. A refresh re-pushes on its own — it ends
  // in `storage.setToken` — and when there is nothing to refresh with, the
  // window is answered with what this one holds so its wait ends rather than
  // times out. Ungated for the same reason as `ready`.
  const offRequest = api.onSessionRequest(() => {
    deps.refresh().catch(() => {
      api.sendSession({ accessToken: deps.getToken() });
    });
  });

  return () => {
    offFeed();
    offStore();
    offReady();
    offRequest();
  };
}
