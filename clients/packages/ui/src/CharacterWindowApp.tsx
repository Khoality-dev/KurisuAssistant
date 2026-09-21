import React, { useState, useEffect, useRef } from 'react';
import { CharacterSurface } from './character/CharacterSurface';
import { SubtitleQueue, type SubtitleView } from './character/subtitleQueue';
import { clearImageCache } from './videocall/engine/ImageCache';
import { configureAuthedFetch, storage } from '@kurisu/api';
import { resolveBridge } from '@kurisu/platform';
import {
  publishSpeech,
  publishSpeechSync,
  pushGestures,
  resetCharacterFeed,
  setFaces,
  setThinking,
  useCharacterStore,
} from '@kurisu/state';

/**
 * Where this window stands with the session (#237). It never logs in: the main
 * renderer pushes the access token over IPC, and nothing is fetched before the
 * first push has arrived — even one saying there is no session — because the
 * asset routes are header-authenticated and a fetch without the token reads as
 * a missing file, not a refusal.
 */
type SessionState = 'pending' | 'signed-out' | 'ready';

/** How long to wait for the main renderer to answer a session request. */
const SESSION_REQUEST_TIMEOUT_MS = 10_000;

/**
 * The second window: a renderer with no login and no producers of its own.
 * Every IPC message is written into this renderer's copy of the character
 * feed store, and the surfaces below read the store exactly as an inline
 * panel in the main window would (#238).
 */
export const CharacterWindowApp: React.FC = () => {
  const [session, setSession] = useState<SessionState>('pending');
  // Counts sessions that carried a token; a surface whose load failed retries on the next one.
  const [sessionVersion, setSessionVersion] = useState(0);
  const sessionWaitersRef = useRef<Array<(token: string | null) => void>>([]);
  const personas = useCharacterStore((s) => s.personas);
  const activePersonaId = useCharacterStore((s) => s.activePersonaId);
  const [subtitle, setSubtitle] = useState<SubtitleView>({ text: '', isUser: false, visible: false });

  useEffect(() => {
    const api = resolveBridge().characterWindow;
    if (!api) return;

    // The session, pushed by the main window. Adopted, never `setToken`-ed:
    // this window holds no refresh token and must not touch the keychain.
    const cleanupSession = api.onSession(({ accessToken }) => {
      storage.adoptToken(accessToken);
      const waiters = sessionWaitersRef.current;
      sessionWaitersRef.current = [];
      for (const resolve of waiters) resolve(accessToken);
      if (accessToken) {
        setSession('ready');
        setSessionVersion((v) => v + 1);
      } else {
        clearImageCache();
        resetCharacterFeed();
        setSession('signed-out');
      }
    });

    // A refused token: ask the main window for a fresh one and wait for the
    // next push. `fetchAuthedBlob` retries once with whatever comes back.
    configureAuthedFetch({
      refreshAccessToken: () => new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          sessionWaitersRef.current = sessionWaitersRef.current.filter((w) => w !== waiter);
          resolve(null);
        }, SESSION_REQUEST_TIMEOUT_MS);
        const waiter = (token: string | null) => { clearTimeout(timer); resolve(token); };
        sessionWaitersRef.current.push(waiter);
        api.requestSession();
      }),
    });

    // The feed, into this renderer's store.
    const cleanupSpeech = api.onSpeech((segment) => publishSpeech(segment));
    const cleanupSync = api.onSpeechSync((sync) => publishSpeechSync(sync));
    const cleanupFeed = api.onFeed(({ isThinking }) => setThinking(isThinking));
    const cleanupGestures = api.onGestureUpdate(({ gestures }) => pushGestures(gestures));
    const cleanupFaces = api.onFaceUpdate(({ faces }) => setFaces(faces));

    const cleanupPersonas = api.onPersonasUpdate((data) => {
      const store = useCharacterStore.getState();
      const seen = new Set<number>();
      for (const persona of data.personas) {
        seen.add(persona.id);
        store.setPersona(persona.id, { name: persona.name, avatarUuid: persona.avatarUuid, character: persona.character });
      }
      for (const id of store.personas.keys()) {
        if (!seen.has(id)) store.removePersona(id);
      }
      store.setActivePersonaId(data.activePersonaId);
    });

    const subtitles = new SubtitleQueue(setSubtitle);
    const cleanupSubtitle = api.onSubtitle((data) => subtitles.handle(data));

    // Signal to main renderer that listeners are ready — triggers initial data push
    api.signalReady();

    return () => {
      configureAuthedFetch({ refreshAccessToken: null });
      cleanupSession();
      cleanupSpeech();
      cleanupSync();
      cleanupFeed();
      cleanupPersonas();
      cleanupGestures();
      cleanupFaces();
      cleanupSubtitle();
      subtitles.dispose();
    };
  }, []);

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: '#ffffff',
        // @ts-expect-error Electron CSS property for frameless window dragging
        WebkitAppRegion: 'drag',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Subtitle overlay */}
      <div
        style={{
          position: 'absolute',
          bottom: 28,
          left: 0,
          right: 0,
          zIndex: 10,
          display: 'flex',
          justifyContent: 'center',
          pointerEvents: 'none',
          // @ts-expect-error Electron CSS property
          WebkitAppRegion: 'no-drag',
        }}
      >
        <div
          style={{
            maxWidth: '90%',
            padding: subtitle.text ? '6px 16px' : 0,
            backgroundColor: 'rgba(0, 0, 0, 0.65)',
            borderRadius: 8,
            color: '#fff',
            fontSize: 15,
            lineHeight: 1.4,
            textAlign: 'center',
            fontStyle: subtitle.isUser ? 'italic' : 'normal',
            opacity: subtitle.visible ? (subtitle.isUser ? 0.7 : 1) : 0,
            transition: 'opacity 0.4s ease',
            wordBreak: 'break-word',
          }}
        >
          {subtitle.text}
        </div>
      </div>

      {session !== 'ready' ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span style={{ color: 'rgba(0,0,0,0.4)', fontSize: 14 }}>
            {session === 'signed-out' ? 'Signed out' : 'Connecting…'}
          </span>
        </div>
      ) : personas.size === 0 ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span style={{ color: 'rgba(0,0,0,0.4)', fontSize: 14 }}>
            Send a message to see personas here
          </span>
        </div>
      ) : (
        Array.from(personas.entries()).map(([id, entry]) => (
          <div
            key={id}
            style={{
              flex: 1,
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              overflow: 'hidden',
              borderBottom: '1px solid rgba(0,0,0,0.1)',
              ...(activePersonaId === id
                ? { boxShadow: 'inset 0 0 20px rgba(37, 99, 235, 0.3)' }
                : {}),
            }}
          >
            <CharacterSurface
              character={entry.character}
              active={activePersonaId === id}
              receivesStimuli={activePersonaId === id || activePersonaId === null}
              retryToken={sessionVersion}
            />
            <span
              style={{
                position: 'absolute',
                bottom: 4,
                left: 0,
                right: 0,
                textAlign: 'center',
                color: activePersonaId === id ? '#2563eb' : 'rgba(0,0,0,0.5)',
                fontWeight: activePersonaId === id ? 600 : 400,
                fontSize: 18,
                textShadow: '0 1px 4px rgba(255,255,255,0.5)',
              }}
            >
              {entry.name}
            </span>
          </div>
        ))
      )}
    </div>
  );
};
