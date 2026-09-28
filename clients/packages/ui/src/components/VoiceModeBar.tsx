import React, { useEffect, useMemo, useRef } from 'react';
import { Avatar, Box, Button, Tooltip } from '@mui/material';
import { alpha, useTheme, type Theme } from '@mui/material/styles';
import AccountCircleIcon from '@mui/icons-material/AccountCircle';
import HeadsetMicIcon from '@mui/icons-material/HeadsetMic';
import HeadsetOffIcon from '@mui/icons-material/HeadsetOff';
import HearingDisabledIcon from '@mui/icons-material/HearingDisabled';
import LockIcon from '@mui/icons-material/Lock';
import MicIcon from '@mui/icons-material/Mic';
import MicOffIcon from '@mui/icons-material/MicOff';
import RecordVoiceOverIcon from '@mui/icons-material/RecordVoiceOver';
import SmartToyIcon from '@mui/icons-material/SmartToy';
import type { VoiceBarPhase } from '@kurisu/hooks';
import { getMicAmplitude } from '@kurisu/state';

/** The window before an interaction ends (#253); the top line drains over it. */
const WINDOW_MS = 30_000;

/**
 * The voice mode colours of the Claude Design mockup "Kurisu - Voice Mode v1",
 * over the app theme: blue is the only saturated colour in the chat column, so
 * voice mode reads from a distance; a setup step is amber, a fault red.
 */
export function voiceColors(theme: Theme) {
  const light = theme.palette.mode === 'light';
  const info = theme.palette.info.main;
  const err = light ? '#DC2626' : '#F87171';
  return {
    info,
    infoFg: light ? '#1D4ED8' : '#60A5FA',
    infoBg: alpha(info, light ? 0.08 : 0.14),
    infoRing: alpha(light ? info : '#3B82F6', light ? 0.22 : 0.32),
    line2: light ? 'rgba(0,0,0,0.12)' : 'rgba(255,255,255,0.13)',
    sub: light ? '#4B5563' : '#A3A3A3',
    faint: light ? '#9CA3AF' : '#6B6B6B',
    skel: light ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.06)',
    skel2: light ? 'rgba(0,0,0,0.13)' : 'rgba(255,255,255,0.13)',
    elevation: light ? '0 -4px 12px rgba(0,0,0,0.04)' : '0 -4px 12px rgba(0,0,0,0.3)',
    err,
    errBg: light ? '#FEF2F2' : alpha('#EF4444', 0.14),
    errLine: alpha(err, 0.5),
    errHover: alpha(err, light ? 0.06 : 0.08),
    errRing: alpha(err, light ? 0.15 : 0.18),
    warn: light ? '#B45309' : '#FBBF24',
    warnBg: light ? '#FFFBEB' : alpha('#F59E0B', 0.14),
    warnDot: '#F59E0B',
    snack: light ? '#323232' : '#F5F5F5',
    onSnack: light ? '#FFFFFF' : '#171717',
  };
}

/** A wake word as the bar quotes it: "kurisu" reads as “Kurisu”. */
export function displayWakeWord(word: string | null): string {
  const w = word?.trim() ?? '';
  return w ? w[0].toUpperCase() + w.slice(1) : '';
}

/** Who is answering, as the bar shows them while they think and speak. */
export interface VoiceAnswerer {
  name: string;
  avatarUrl?: string | null;
  /** The assistant itself, with no persona: its own icon, not a person's. */
  isAssistant: boolean;
}

interface VoiceModeBarProps {
  phase: VoiceBarPhase;
  wakeWord: string | null;
  answerer: VoiceAnswerer;
  /** What was last said in this interaction. */
  lastTranscript: string;
  /** When the 30-second window opened, while it is open. */
  windowStartedAt: number | null;
  /** A narrow chat column: End voice mode goes on its own row. */
  narrow: boolean;
  onEnd: () => void;
  onRetry: () => void;
  onOpenAssistantSettings: () => void;
  onOpenVoiceSettings: () => void;
}

interface ProblemCopy {
  title: string;
  detail: string;
  icon: React.ReactElement;
  /** A setup step is amber; a fault is red. */
  tone: 'warn' | 'error';
  actions: Array<{ label: string; primary: boolean; run: keyof Pick<VoiceModeBarProps, 'onRetry' | 'onOpenAssistantSettings' | 'onOpenVoiceSettings'> }>;
}

const PROBLEMS: Partial<Record<VoiceBarPhase, ProblemCopy>> = {
  'no-wake-word': {
    title: 'No wake word set',
    detail: "Voice mode can't start anything until you set one in Assistant settings.",
    icon: <RecordVoiceOverIcon />,
    tone: 'warn',
    actions: [{ label: 'Open Assistant settings', primary: true, run: 'onOpenAssistantSettings' }],
  },
  'no-microphone': {
    title: 'No microphone found',
    detail: 'Connect one, or choose another in Voice settings.',
    icon: <MicOffIcon />,
    tone: 'error',
    actions: [
      { label: 'Try again', primary: true, run: 'onRetry' },
      { label: 'Voice settings', primary: false, run: 'onOpenVoiceSettings' },
    ],
  },
  'mic-blocked': {
    title: 'Microphone access is blocked',
    detail: "Allow it in your system's privacy settings, then try again.",
    icon: <LockIcon />,
    tone: 'error',
    actions: [{ label: 'Try again', primary: true, run: 'onRetry' }],
  },
  'asr-unavailable': {
    title: "Speech recognition didn't load",
    detail: "Voice mode can't hear anything until it does.",
    icon: <HearingDisabledIcon />,
    tone: 'error',
    actions: [{ label: 'Retry', primary: true, run: 'onRetry' }],
  },
};

const KEYFRAMES = {
  '@keyframes kvBar': { '0%': { transform: 'scaleY(.25)' }, '100%': { transform: 'scaleY(1)' } },
  '@keyframes kvBarLow': { '0%': { transform: 'scaleY(.12)' }, '100%': { transform: 'scaleY(.35)' } },
  '@keyframes kvHalo': { '0%': { transform: 'scale(1)', opacity: 0.55 }, '100%': { transform: 'scale(1.6)', opacity: 0 } },
  '@keyframes kvBreathe': { '0%, 100%': { transform: 'scale(1)', opacity: 0.25 }, '50%': { transform: 'scale(1.1)', opacity: 0.6 } },
  '@keyframes kvSpin': { to: { transform: 'rotate(360deg)' } },
  '@keyframes kvDot': { '0%, 80%, 100%': { transform: 'translateY(0)', opacity: 0.35 }, '40%': { transform: 'translateY(-3px)', opacity: 1 } },
  '@keyframes kvDrain': { from: { transform: 'scaleX(1)' }, to: { transform: 'scaleX(0)' } },
  '@keyframes kvShimmer': { '0%': { backgroundPosition: '-400px 0' }, '100%': { backgroundPosition: '400px 0' } },
};

/** Bars that move on their own: the reply being spoken, or a quiet mic in the window. */
const AnimatedBars: React.FC<{ durations: number[]; color: string; height: number; keyframe: 'kvBar' | 'kvBarLow' }> = ({
  durations, color, height, keyframe,
}) => (
  <Box aria-hidden sx={{ display: 'flex', alignItems: 'center', gap: '2px', height }}>
    {durations.map((d, i) => (
      <Box
        key={i}
        component="span"
        sx={{
          width: 3, height, borderRadius: '2px', bgcolor: color, transformOrigin: '50% 50%',
          animation: `${keyframe} ${d}s ease-in-out ${-(i * 0.17).toFixed(2)}s infinite alternate`,
        }}
      />
    ))}
  </Box>
);

const LEVEL_SHAPE = [0.6, 0.9, 0.5, 1, 0.8, 0.55, 0.75];

/** The live mic level beside "Listening": seven bars that follow the mic. */
const MicLevelMeter: React.FC<{ color: string }> = ({ color }) => {
  const bars = useRef<Array<HTMLSpanElement | null>>([]);
  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return;
    let raf = 0;
    const tick = (t: number) => {
      const level = getMicAmplitude();
      bars.current.forEach((el, i) => {
        if (!el) return;
        const wobble = 0.8 + 0.4 * Math.sin(t / (140 + i * 37));
        const scale = Math.max(0.2, Math.min(1, level * LEVEL_SHAPE[i] * wobble * 1.6));
        el.style.transform = `scaleY(${scale.toFixed(3)})`;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return (
    <Box aria-hidden sx={{ display: 'flex', alignItems: 'center', gap: '2px', height: 16 }}>
      {LEVEL_SHAPE.map((_, i) => (
        <Box
          key={i}
          component="span"
          ref={(el: HTMLSpanElement | null) => { bars.current[i] = el; }}
          sx={{ width: 3, height: 16, borderRadius: '2px', bgcolor: color, transform: 'scaleY(0.2)', transition: 'transform 80ms linear' }}
        />
      ))}
    </Box>
  );
};

const ThinkingDots: React.FC<{ color: string }> = ({ color }) => (
  <Box aria-hidden sx={{ display: 'flex', gap: '4px', alignItems: 'center', height: 14 }}>
    {[0, 1, 2].map((i) => (
      <Box key={i} component="span" sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: color, animation: `kvDot 1.2s ease-in-out ${i * 0.16}s infinite` }} />
    ))}
  </Box>
);

const Ring: React.FC<{ color: string; duration: number; delay: number }> = ({ color, duration, delay }) => (
  <Box component="span" sx={{ position: 'absolute', inset: 0, borderRadius: '50%', border: `2px solid ${color}`, animation: `kvHalo ${duration}s ease-out ${delay}s infinite` }} />
);

const Disc: React.FC<{ bg: string; children: React.ReactNode; shadow?: string }> = ({ bg, children, shadow }) => (
  <Box sx={{ position: 'absolute', inset: 0, borderRadius: '50%', bgcolor: bg, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: shadow, '& svg': { fontSize: 22 } }}>
    {children}
  </Box>
);

/**
 * The voice bar: what stands in for the message box in voice mode (#253),
 * drawn from the Claude Design mockup "Kurisu - Voice Mode v1" (#345). The
 * first line says what is happening and the second what was last said; a
 * problem replaces them with what is wrong and the action that fixes it. A
 * line along the top edge is faint while voice mode waits, solid through an
 * interaction, and drains over the 30-second window. End voice mode stays in
 * the same place in every state.
 */
export const VoiceModeBar: React.FC<VoiceModeBarProps> = (props) => {
  const { phase, wakeWord, answerer, lastTranscript, windowStartedAt, narrow, onEnd } = props;
  const theme = useTheme();
  const c = voiceColors(theme);
  const problem = PROBLEMS[phase];

  const label: string | null = problem
    ? problem.title
    : phase === 'listening' || phase === 'window'
      ? 'Listening'
      : phase === 'transcribing'
        ? 'Transcribing'
        : phase === 'thinking'
          ? `${answerer.name} is thinking`
          : phase === 'speaking'
            ? `${answerer.name} is speaking`
            : null;
  const showQuote = !!lastTranscript && ['listening', 'thinking', 'speaking', 'window'].includes(phase);
  const sub = problem ? problem.detail : phase === 'waiting' ? 'Nothing is sent until you say it.' : null;
  const running = ['listening', 'transcribing', 'thinking', 'speaking'].includes(phase);

  // How far into the window the line starts, fixed per window: re-rendering
  // must not move a running animation's delay, or the line would jump.
  const drainDelay = useMemo(
    () => (windowStartedAt === null ? 0 : Math.min(WINDOW_MS, Math.max(0, Date.now() - windowStartedAt)) / 1000),
    [windowStartedAt],
  );

  const answererDisc = (
    <Disc bg={theme.palette.primary.main}>
      {answerer.avatarUrl ? (
        <Avatar src={answerer.avatarUrl} alt="" sx={{ width: 44, height: 44 }} />
      ) : answerer.isAssistant ? (
        <SmartToyIcon sx={{ color: theme.palette.primary.contrastText }} />
      ) : (
        <AccountCircleIcon sx={{ color: theme.palette.primary.contrastText }} />
      )}
    </Disc>
  );

  const endButton = (
    <Tooltip title="Turns the mic off" describeChild>
      <Button
        variant="outlined"
        onClick={onEnd}
        startIcon={<HeadsetOffIcon />}
        sx={{
          flex: 'none', height: 32, px: 1.5, whiteSpace: 'nowrap', color: c.err, borderColor: c.errLine,
          '&:hover': { borderColor: c.err, bgcolor: c.errHover, boxShadow: `0 0 0 3px ${c.errRing}` },
          '&:focus-visible': { boxShadow: `0 0 0 3px ${c.errRing}` },
        }}
      >
        End voice mode
      </Button>
    </Tooltip>
  );

  return (
    <Box
      role="region"
      aria-label="Voice mode"
      sx={{
        ...KEYFRAMES,
        flex: 'none',
        position: 'relative',
        bgcolor: 'background.paper',
        borderTop: 1,
        borderColor: 'divider',
        boxShadow: c.elevation,
        p: 2,
      }}
    >
      {/* The top line: faint while waiting, solid through an interaction, draining in the window. */}
      {phase === 'waiting' && <Box sx={{ position: 'absolute', left: 0, right: 0, top: -1, height: 2, bgcolor: c.infoRing }} />}
      {running && <Box sx={{ position: 'absolute', left: 0, right: 0, top: -1, height: 2, bgcolor: c.info }} />}
      {phase === 'window' && (
        <Box sx={{ position: 'absolute', left: 0, right: 0, top: -1, height: 2, bgcolor: c.line2, overflow: 'hidden' }}>
          <Box
            data-testid="voice-window-drain"
            key={windowStartedAt ?? 0}
            sx={{ position: 'absolute', inset: 0, bgcolor: c.info, transformOrigin: '0 50%', animation: `kvDrain ${WINDOW_MS / 1000}s linear forwards` }}
            style={{ animationDelay: `${-drainDelay.toFixed(2)}s` }}
          />
        </Box>
      )}

      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
        <Box aria-hidden sx={{ width: 44, height: 44, flex: 'none', position: 'relative' }}>
          {phase === 'waiting' && (
            <>
              <Box component="span" sx={{ position: 'absolute', inset: -5, borderRadius: '50%', border: `1.5px solid ${c.info}`, animation: 'kvBreathe 3.2s ease-in-out infinite' }} />
              <Disc bg={c.infoBg}><HeadsetMicIcon sx={{ color: c.infoFg }} /></Disc>
            </>
          )}
          {(phase === 'listening' || phase === 'window') && (
            <>
              <Ring color={c.info} duration={1.8} delay={0} />
              <Ring color={c.info} duration={1.8} delay={-0.9} />
              <Disc bg={c.info} shadow={`0 2px 8px ${alpha(c.info, 0.35)}`}><MicIcon sx={{ color: '#FFFFFF' }} /></Disc>
            </>
          )}
          {phase === 'transcribing' && (
            <>
              <Disc bg={c.infoBg}><MicIcon sx={{ color: c.infoFg }} /></Disc>
              <Box component="span" sx={{ position: 'absolute', inset: -4, borderRadius: '50%', border: '2.5px solid transparent', borderTopColor: c.info, borderRightColor: c.info, animation: 'kvSpin 0.9s linear infinite' }} />
            </>
          )}
          {(phase === 'thinking' || phase === 'speaking') && (
            <>
              {phase === 'speaking' && (
                <>
                  <Ring color={c.faint} duration={1.4} delay={0} />
                  <Ring color={c.faint} duration={1.4} delay={-0.7} />
                </>
              )}
              {answererDisc}
            </>
          )}
          {problem && (
            <Disc bg={problem.tone === 'warn' ? c.warnBg : c.errBg}>
              {React.cloneElement(problem.icon, { sx: { color: problem.tone === 'warn' ? c.warn : c.err } })}
            </Disc>
          )}
        </Box>

        <Box aria-live="polite" sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '3px', pt: '1px' }}>
          {phase === 'waiting' && (
            <Box sx={{ fontSize: 15, fontWeight: 600, lineHeight: 1.45 }}>
              Say <Box component="span" sx={{ color: c.infoFg }}>“{displayWakeWord(wakeWord)}”</Box> to start
            </Box>
          )}
          {label && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: '10px', minHeight: 22 }}>
              <Box sx={{ fontSize: 15, fontWeight: 600, lineHeight: 1.45 }}>{label}</Box>
              {phase === 'listening' && <MicLevelMeter color={c.info} />}
              {phase === 'window' && <AnimatedBars durations={[0.9, 1.1, 0.8, 1.2, 1.0, 0.85, 1.05]} color={c.faint} height={16} keyframe="kvBarLow" />}
              {phase === 'thinking' && <ThinkingDots color={theme.palette.text.secondary} />}
              {phase === 'speaking' && <AnimatedBars durations={[0.52, 0.4, 0.66, 0.47, 0.6]} color={theme.palette.text.secondary} height={14} keyframe="kvBar" />}
            </Box>
          )}
          {showQuote && (
            <Box sx={{ fontSize: 13, lineHeight: 1.5, color: c.sub, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              <Box component="span" sx={{ color: 'text.secondary' }}>You said </Box>“{lastTranscript}”
            </Box>
          )}
          {phase === 'transcribing' && (
            <Box aria-hidden sx={{ display: 'flex', flexDirection: 'column', gap: '7px', pt: '6px' }}>
              {['88%', '56%'].map((w) => (
                <Box key={w} sx={{ height: 9, width: w, borderRadius: '5px', background: `linear-gradient(90deg, ${c.skel} 0%, ${c.skel2} 50%, ${c.skel} 100%)`, backgroundSize: '400px 100%', animation: 'kvShimmer 1.4s linear infinite' }} />
              ))}
            </Box>
          )}
          {sub && <Box sx={{ fontSize: 13, lineHeight: 1.5, color: c.sub }}>{sub}</Box>}
          {phase === 'window' && (
            <Box sx={{ fontSize: 12, lineHeight: 1.5, color: 'text.secondary', mt: '1px' }}>Ends soon unless you say something</Box>
          )}
          {problem && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: '9px' }}>
              {problem.actions.map((a) => (
                <Button
                  key={a.label}
                  variant={a.primary ? 'contained' : 'outlined'}
                  color={a.primary ? 'primary' : 'inherit'}
                  disableElevation
                  onClick={props[a.run]}
                  sx={{ height: 30, px: 1.5, whiteSpace: 'nowrap', ...(a.primary ? {} : { borderColor: c.line2 }) }}
                >
                  {a.label}
                </Button>
              ))}
            </Box>
          )}
        </Box>

        {!narrow && <Box sx={{ mt: '6px', flex: 'none' }}>{endButton}</Box>}
      </Box>

      {narrow && <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1.5 }}>{endButton}</Box>}
    </Box>
  );
};
