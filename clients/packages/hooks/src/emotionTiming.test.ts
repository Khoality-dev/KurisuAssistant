/**
 * Feelings ride the sentence that carries them (#244).
 *
 * Text streams seconds ahead of speech, so a cue must reach the face when its
 * sentence is spoken, not when its token arrives. The planner is what the
 * streaming hook hands every chunk to: it groups sentences for the TTS queue
 * as the hook always did and gives each group the cues that fall inside it,
 * placed as a fraction of the way through. Pinned here: a cue mid-sentence
 * rides that sentence; a cue inside a ten-word group lands at its fraction; a
 * tool call between two rounds does not shift the second round's cues onto
 * the first round's text (the backend restarts its offsets per round); a
 * sentence narration swallowed passes its feeling on; with speech off a cue
 * shows as its text arrives, debounced, with a hold sized to its sentence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmotionCue, Message } from '@kurisu/models';
import {
  restingCueOf,
  selectCuesForSegment,
  StreamSpeechPlanner,
  TEXT_CUE_DEBOUNCE_MS,
  textCueHoldMs,
  type SegmentCue,
} from './emotionTiming';

describe('selectCuesForSegment', () => {
  const cues = [{ emotion: 'happy' as const, at: 0 }, { emotion: 'sad' as const, at: 50 }];

  it('takes every cue inside the segment, at its fraction of the way through', () => {
    expect(selectCuesForSegment(cues, 0, 100, null)).toEqual([
      { emotion: 'happy', atFraction: 0 },
      { emotion: 'sad', atFraction: 0.5 },
    ]);
  });

  it('a cue on a boundary belongs to the segment it opens', () => {
    expect(selectCuesForSegment(cues, 0, 50, null)).toEqual([{ emotion: 'happy', atFraction: 0 }]);
    expect(selectCuesForSegment(cues, 50, 80, 'happy')).toEqual([{ emotion: 'sad', atFraction: 0 }]);
  });

  it('a cue past the segment is left for a later one', () => {
    expect(selectCuesForSegment([{ emotion: 'sad', at: 120 }], 0, 100, null)).toEqual([]);
  });

  it('carries the feeling in force into a segment that opens without one, unless it already shows', () => {
    expect(selectCuesForSegment(cues, 60, 90, null)).toEqual([{ emotion: 'sad', atFraction: 0 }]);
    expect(selectCuesForSegment(cues, 60, 90, 'sad')).toEqual([]);
  });

  it('an empty segment carries nothing', () => {
    expect(selectCuesForSegment(cues, 10, 10, null)).toEqual([]);
  });
});

describe('textCueHoldMs', () => {
  it('holds a short sentence for a second and a half, a long one for 350 ms a word', () => {
    expect(textCueHoldMs('Oh.')).toBe(1500);
    expect(textCueHoldMs('I am so happy to see you again after all this time. And more.')).toBe(12 * 350);
  });
});

describe('restingCueOf', () => {
  const msg = (m: Partial<Message>): Message => ({ role: 'assistant', content: '', ...m });

  it('is the last feeling of the last assistant message, and whose it was', () => {
    expect(restingCueOf([
      msg({ persona_id: 1, emotion_cues: [{ emotion: 'sad', at: 0 }] }),
      msg({ role: 'user', content: 'hi' }),
      msg({ persona_id: 2, emotion_cues: [{ emotion: 'happy', at: 0 }, { emotion: 'surprised', at: 9 }] }),
      msg({ role: 'tool', content: 'done' }),
    ])).toEqual({ emotion: 'surprised', personaId: 2 });
  });

  it('is nothing when the last assistant message carries no feeling, or has no persona', () => {
    expect(restingCueOf([msg({ persona_id: 1, emotion_cues: [{ emotion: 'sad', at: 0 }] }), msg({ persona_id: 1 })])).toBeNull();
    expect(restingCueOf([msg({ emotion_cues: [{ emotion: 'sad', at: 0 }] })])).toBeNull();
    expect(restingCueOf([])).toBeNull();
  });
});

describe('StreamSpeechPlanner', () => {
  let spoken: Array<{ text: string; voice: string | undefined; cues: SegmentCue[] }>;
  let shown: Array<{ cue: EmotionCue; personaId: number | null }>;
  let autoplay: boolean;
  let planner: StreamSpeechPlanner;
  let runText: string;

  beforeEach(() => {
    vi.useFakeTimers();
    spoken = [];
    shown = [];
    autoplay = true;
    runText = '';
    planner = new StreamSpeechPlanner({
      autoplay: () => autoplay,
      speak: (text, voice, cues) => spoken.push({ text, voice, cues }),
      show: (cue, personaId) => shown.push({ cue, personaId }),
    });
  });
  afterEach(() => vi.useRealTimers());

  /** One assistant chunk, the way the streaming hook hands it over. */
  const chunk = (content: string, cue?: { emotion: EmotionCue['emotion']; at: number }, personaId = 7, voice = 'kurisu') => {
    runText += content;
    planner.chunk({ content, emotion: cue?.emotion ?? null, emotionAt: cue?.at ?? null, personaId, voice, runText });
  };
  const newRun = (voice?: string) => { planner.newRun(voice); runText = ''; };

  it('groups sentences for the queue as before, and a cue mid-sentence rides the sentence that carries it', () => {
    chunk('Welcome back to the lab, it has been a quiet day. ');
    expect(spoken).toEqual([{ text: 'Welcome back to the lab, it has been a quiet day.', voice: 'kurisu', cues: [] }]);
    const at = runText.length;
    chunk('Sadly the experiment failed again today and I', { emotion: 'sad', at });
    expect(spoken).toHaveLength(1);
    chunk(' do not know why. Next');
    expect(spoken[1]).toEqual({
      text: 'Sadly the experiment failed again today and I do not know why.',
      voice: 'kurisu',
      cues: [{ emotion: 'sad', atFraction: 0 }],
    });
  });

  it('a cue inside a ten-word group lands at its fraction of the group', () => {
    chunk('I am fine. ');
    const at = runText.length;
    chunk('This is great news for all of us here. ', { emotion: 'happy', at });
    expect(spoken).toHaveLength(1);
    const group = 'I am fine. This is great news for all of us here. ';
    expect(spoken[0].cues).toEqual([{ emotion: 'happy', atFraction: at / group.length }]);
  });

  it("across a tool call, the first round's tail is spoken on its own and the second round's cues keep their place", () => {
    chunk('Let me check. ', { emotion: 'happy', at: 0 });
    expect(spoken).toEqual([]);
    // The tool's bubble, then the persona again: two boundaries, one flush.
    newRun();
    newRun('kurisu');
    expect(spoken).toEqual([{ text: 'Let me check.', voice: 'kurisu', cues: [{ emotion: 'happy', atFraction: 0 }] }]);
    chunk('It is ');
    chunk('raining in Tokyo today and all of tomorrow too. ', { emotion: 'sad', at: 6 });
    const text = 'It is raining in Tokyo today and all of tomorrow too. ';
    expect(spoken[1]).toEqual({
      text: text.trim(),
      voice: 'kurisu',
      cues: [{ emotion: 'sad', atFraction: 6 / text.length }],
    });
  });

  it('a group narration swallows is not spoken, and its feeling carries into the next one', () => {
    chunk('*She sighs and looks down at the floor for a long moment*\n', { emotion: 'happy', at: 0 });
    expect(spoken).toEqual([]);
    chunk('Anyway, the results came back and they look really promising to me. ');
    expect(spoken).toEqual([{
      text: 'Anyway, the results came back and they look really promising to me.',
      voice: 'kurisu',
      cues: [{ emotion: 'happy', atFraction: 0 }],
    }]);
  });

  it('the end of the turn speaks whatever is left, with its cues', () => {
    chunk('Goodbye', { emotion: 'relaxed', at: 0 });
    planner.done();
    expect(spoken).toEqual([{ text: 'Goodbye', voice: 'kurisu', cues: [{ emotion: 'relaxed', atFraction: 0 }] }]);
  });

  it('with speech on, nothing is shown on text arrival', () => {
    chunk('Oh! ', { emotion: 'surprised', at: 0 });
    vi.advanceTimersByTime(TEXT_CUE_DEBOUNCE_MS * 2);
    planner.done();
    expect(shown).toEqual([]);
  });

  describe('with speech off', () => {
    beforeEach(() => { autoplay = false; });

    it('shows the feeling as its text arrives, the last of a quick run winning, held for its sentence', () => {
      chunk('Oh! ', { emotion: 'surprised', at: 0 });
      const at = runText.length;
      chunk('I am so happy to see you again after all this time. ', { emotion: 'happy', at });
      expect(shown).toEqual([]);
      vi.advanceTimersByTime(TEXT_CUE_DEBOUNCE_MS);
      expect(shown).toEqual([{ cue: { emotion: 'happy', hold_ms: 12 * 350 }, personaId: 7 }]);
      expect(spoken).toEqual([]);
    });

    it('a boundary or the end of the turn shows a pending feeling at once', () => {
      chunk('Hm. ', { emotion: 'sad', at: 0 });
      newRun();
      expect(shown).toEqual([{ cue: { emotion: 'sad', hold_ms: 1500 }, personaId: 7 }]);
      chunk('Ha. ', { emotion: 'happy', at: 0 });
      planner.done();
      expect(shown.map((s) => s.cue.emotion)).toEqual(['sad', 'happy']);
    });
  });

  it('a reset drops what was not yet said or shown', () => {
    chunk('Half a sentence', { emotion: 'angry', at: 0 });
    autoplay = false;
    chunk(' and more', { emotion: 'sad', at: 15 });
    planner.reset();
    vi.advanceTimersByTime(TEXT_CUE_DEBOUNCE_MS * 2);
    planner.done();
    expect(spoken).toEqual([]);
    expect(shown).toEqual([]);
  });
});
