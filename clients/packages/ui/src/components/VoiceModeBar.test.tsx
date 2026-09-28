/**
 * The voice bar (#345): where the message box was, it says what voice mode is
 * doing on its first line and what was last said on its second, and when
 * something is wrong, what is wrong and the action that fixes it. End voice
 * mode is in every state. Drawn from the Claude Design mockup "Kurisu - Voice
 * Mode v1", section 1.
 */
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceBarPhase } from '@kurisu/hooks';
import { VoiceModeBar } from './VoiceModeBar';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const onEnd = vi.fn();
const onRetry = vi.fn();
const onOpenAssistantSettings = vi.fn();
const onOpenVoiceSettings = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderBar(phase: VoiceBarPhase, over: Partial<React.ComponentProps<typeof VoiceModeBar>> = {}) {
  act(() => {
    root.render(
      <VoiceModeBar
        phase={phase}
        wakeWord="kurisu"
        answerer={{ name: 'Kurisu', avatarUrl: null, isAssistant: false }}
        lastTranscript="And for a firm one?"
        windowStartedAt={null}
        narrow={false}
        onEnd={onEnd}
        onRetry={onRetry}
        onOpenAssistantSettings={onOpenAssistantSettings}
        onOpenVoiceSettings={onOpenVoiceSettings}
        {...over}
      />,
    );
  });
}

const text = () => container.textContent ?? '';
const buttons = () => [...container.querySelectorAll('button')] as HTMLButtonElement[];
const button = (name: string) =>
  buttons().find((b) => b.getAttribute('aria-label') === name || b.textContent?.trim() === name);
const click = (name: string) => act(() => { button(name)!.click(); });

describe('while voice mode waits for the wake word', () => {
  it('says which word starts it, and that nothing is sent until then', () => {
    renderBar('waiting');

    expect(text()).toContain('Say “Kurisu” to start');
    expect(text()).toContain('Nothing is sent until you say it.');
    expect(text()).not.toContain('You said');
  });
});

describe('in an interaction', () => {
  it('listening: the label, and the last thing said under it', () => {
    renderBar('listening');

    expect(text()).toContain('Listening');
    expect(text()).toContain('You said “And for a firm one?”');
  });

  it('transcribing: the words are on their way, so the quote line holds their place', () => {
    renderBar('transcribing');

    expect(text()).toContain('Transcribing');
    expect(text()).not.toContain('You said');
  });

  it('names who is answering while it thinks and speaks', () => {
    renderBar('thinking');
    expect(text()).toContain('Kurisu is thinking');

    renderBar('speaking');
    expect(text()).toContain('Kurisu is speaking');

    renderBar('thinking', { answerer: { name: 'Assistant', avatarUrl: null, isAssistant: true } });
    expect(text()).toContain('Assistant is thinking');
  });

  it('the 30-second window: one quiet line, and the top line drains from where it is', () => {
    renderBar('window', { windowStartedAt: Date.now() - 11_000 });

    expect(text()).toContain('Listening');
    expect(text()).toContain('Ends soon unless you say something');
    const drain = container.querySelector('[data-testid="voice-window-drain"]') as HTMLElement;
    expect(drain).not.toBeNull();
    const delay = parseFloat(drain.style.animationDelay);
    expect(delay).toBeLessThanOrEqual(-10.5);
    expect(delay).toBeGreaterThanOrEqual(-12);
    expect(text()).not.toMatch(/\d+ ?s(econds)? left/);
  });
});

describe('a problem says what is wrong and offers the fix', () => {
  it('no wake word set: a way to Assistant settings', () => {
    renderBar('no-wake-word');

    expect(text()).toContain('No wake word set');
    expect(text()).toContain("Voice mode can't start anything until you set one in Assistant settings.");
    click('Open Assistant settings');
    expect(onOpenAssistantSettings).toHaveBeenCalledTimes(1);
  });

  it('no microphone found: try again, or pick another in Voice settings', () => {
    renderBar('no-microphone');

    expect(text()).toContain('No microphone found');
    expect(text()).toContain('Connect one, or choose another in Voice settings.');
    click('Try again');
    expect(onRetry).toHaveBeenCalledTimes(1);
    click('Voice settings');
    expect(onOpenVoiceSettings).toHaveBeenCalledTimes(1);
  });

  it('access blocked: the fix is outside the app, so the copy says where', () => {
    renderBar('mic-blocked');

    expect(text()).toContain('Microphone access is blocked');
    expect(text()).toContain("Allow it in your system's privacy settings, then try again.");
    click('Try again');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("speech recognition didn't load: retry reloads it", () => {
    renderBar('asr-unavailable');

    expect(text()).toContain("Speech recognition didn't load");
    expect(text()).toContain("Voice mode can't hear anything until it does.");
    click('Retry');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows no quote and no status line of its own', () => {
    renderBar('mic-blocked');

    expect(text()).not.toContain('You said');
    expect(text()).not.toContain('Listening');
  });
});

describe('End voice mode', () => {
  const phases: VoiceBarPhase[] = [
    'waiting', 'listening', 'transcribing', 'thinking', 'speaking', 'window',
    'no-wake-word', 'no-microphone', 'mic-blocked', 'asr-unavailable',
  ];

  it.each(phases)('is a labelled button in the %s state, and ends voice mode', (phase) => {
    renderBar(phase);

    const end = button('End voice mode');
    expect(end).toBeDefined();
    expect(end!.textContent).toContain('End voice mode');
    // Its name is its label; the tooltip describes it, it does not rename it.
    expect(end!.getAttribute('aria-label') ?? 'End voice mode').toBe('End voice mode');
    click('End voice mode');
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('has the headset-off icon, not a hang-up one', () => {
    renderBar('listening');

    expect(container.querySelector('[data-testid="HeadsetOffIcon"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="CallEndIcon"]')).toBeNull();
  });

  it('is there in a narrow column too', () => {
    renderBar('listening', { narrow: true });

    expect(button('End voice mode')).toBeDefined();
  });
});
