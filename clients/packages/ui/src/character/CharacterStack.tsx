/**
 * Every persona in the conversation, stacked, with at most one 3D stage live (#240).
 *
 * A 2D pose graph is a canvas and a handful of images; a VRM stage is a WebGL
 * context, a parsed model of tens of megabytes and a spring-bone simulation.
 * Chromium stops handing out contexts at around sixteen, and software GL runs
 * out long before that, so a four-persona conversation that gave every VRM
 * persona its own stage would exhaust them. The rule: the active persona's
 * stage is live if it is a VRM persona; when the active persona is not one
 * (or nobody is speaking) the VRM persona that spoke last keeps the stage,
 * else the first one in the conversation. Every other VRM persona with a
 * model is a card — its name, its avatar, "waiting" — in the same slot, until
 * it speaks. 2D personas render as they always have beside it.
 */
import React, { useRef } from 'react';
import { Avatar, Box, Typography } from '@mui/material';
import type { CharacterPersona } from '@kurisu/state';
import { config } from '@kurisu/api';
import { useAuthedAssetUrl } from '@kurisu/hooks';
import { CharacterSurface, type MakeDriver, type VrmModule } from './CharacterSurface';

/** A persona that would need a WebGL stage: a VRM persona with a model to show. */
export function needsStage(persona: CharacterPersona): boolean {
  return persona.character?.kind === 'vrm' && !!persona.character.vrm?.model;
}

/**
 * Which VRM persona gets the one live stage: the active one, else the last
 * VRM persona to speak, else the first in the conversation. `null` when no
 * persona needs a stage.
 */
export function liveStagePersona(
  personas: ReadonlyMap<number, CharacterPersona>,
  activePersonaId: number | null,
  lastStageSpeakerId: number | null,
): number | null {
  const staged = (id: number | null) => id !== null && !!personas.get(id) && needsStage(personas.get(id)!);
  if (staged(activePersonaId)) return activePersonaId;
  if (staged(lastStageSpeakerId)) return lastStageSpeakerId;
  for (const [id, persona] of personas) if (needsStage(persona)) return id;
  return null;
}

export interface CharacterStackProps {
  personas: ReadonlyMap<number, CharacterPersona>;
  activePersonaId: number | null;
  /** Passed to every surface: a session with a token retries a failed load. */
  retryToken?: number;
  /** Test seams, handed to every surface. */
  makeDriver?: MakeDriver;
  importVrm?: () => Promise<VrmModule>;
  probe?: () => boolean;
  now?: () => number;
}

export const CharacterStack: React.FC<CharacterStackProps> = ({
  personas,
  activePersonaId,
  retryToken = 0,
  makeDriver,
  importVrm,
  probe,
  now,
}) => {
  // The last VRM persona that spoke keeps the stage while a 2D one talks, so
  // the model is not unloaded and reparsed on every turn of a mixed chat.
  const lastStageSpeakerRef = useRef<number | null>(null);
  const active = activePersonaId !== null ? personas.get(activePersonaId) : undefined;
  if (active && needsStage(active)) lastStageSpeakerRef.current = activePersonaId;
  const live = liveStagePersona(personas, activePersonaId, lastStageSpeakerRef.current);

  return (
    <>
      {Array.from(personas.entries()).map(([id, entry]) => {
        const isActive = activePersonaId === id;
        const card = needsStage(entry) && id !== live;
        return (
          <div
            key={id}
            data-testid={`character-slot-${id}`}
            style={{
              flex: 1,
              minHeight: 0,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              overflow: 'hidden',
              borderBottom: '1px solid rgba(0,0,0,0.1)',
              ...(isActive ? { boxShadow: 'inset 0 0 20px rgba(37, 99, 235, 0.3)' } : {}),
            }}
          >
            {card ? (
              <WaitingCard name={entry.name} avatarUuid={entry.avatarUuid} />
            ) : (
              <CharacterSurface
                character={entry.character}
                personaName={entry.name}
                active={isActive}
                receivesStimuli={isActive || activePersonaId === null}
                retryToken={retryToken}
                makeDriver={makeDriver}
                importVrm={importVrm}
                probe={probe}
                now={now}
              />
            )}
            <span
              style={{
                position: 'absolute',
                bottom: 4,
                left: 0,
                right: 0,
                textAlign: 'center',
                color: isActive ? '#2563eb' : 'rgba(0,0,0,0.5)',
                fontWeight: isActive ? 600 : 400,
                fontSize: 18,
                textShadow: '0 1px 4px rgba(255,255,255,0.5)',
                pointerEvents: 'none',
              }}
            >
              {entry.name}
            </span>
          </div>
        );
      })}
    </>
  );
};

/** A VRM persona without the stage: who it is, and that it is waiting its turn. */
const WaitingCard: React.FC<{ name: string; avatarUuid: string | null }> = ({ name, avatarUuid }) => {
  const avatar = useAuthedAssetUrl(avatarUuid ? `${config.apiBaseUrl}/images/${avatarUuid}` : null);
  return (
    <Box data-testid="character-waiting-card" sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
      <Avatar src={avatar ?? undefined} alt={name} sx={{ width: 64, height: 64, fontSize: 26 }}>
        {name.charAt(0).toUpperCase()}
      </Avatar>
      <Typography variant="caption" color="text.secondary">
        waiting
      </Typography>
    </Box>
  );
};
