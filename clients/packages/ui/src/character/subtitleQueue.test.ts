import { describe, expect, it } from 'vitest';
import { FADE_AFTER_LAST_MS, SubtitleQueue, splitSentences, userHoldMs, type SubtitleView } from './subtitleQueue';

/** Timers a test steps by hand. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    timers: {
      set: (callback: () => void, ms: number) => { const id = nextId++; pending.set(id, { at: now + ms, callback }); return id; },
      clear: (handle: unknown) => { pending.delete(handle as number); },
    },
    advance(ms: number) {
      const until = now + ms;
      // Fire in order, one at a time, since a callback may arm the next.
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
    get pendingCount() { return pending.size; },
  };
}

function harness() {
  const t = fakeTimers();
  const views: SubtitleView[] = [];
  const queue = new SubtitleQueue((v) => views.push(v), t.timers);
  return { queue, views, advance: t.advance.bind(t), t };
}

describe('splitSentences and userHoldMs', () => {
  it('splits on sentence ends in either script and keeps the punctuation', () => {
    expect(splitSentences('One. Two! Three? 四。五！\nSix')).toEqual(['One.', 'Two!', 'Three?', '四。', '五！', 'Six']);
    expect(splitSentences('   ')).toEqual([]);
  });

  it('holds a user line 1.5 s at least, 350 ms a word beyond', () => {
    expect(userHoldMs('hi')).toBe(1500);
    expect(userHoldMs('one two three four five six')).toBe(2100);
  });
});

describe('SubtitleQueue', () => {
  it('shows a spoken chunk one sentence at a time, each for its share of the audio, then fades', () => {
    const { queue, views, advance } = harness();
    queue.handle({ text: 'Hello there. How are you?', isUser: false, duration: 2 });
    expect(views).toEqual([{ text: 'Hello there.', isUser: false, visible: true }]);
    advance(999);
    expect(views).toHaveLength(1);
    advance(1);
    expect(views[1]).toEqual({ text: 'How are you?', isUser: false, visible: true });
    advance(1000);
    // The last sentence's time is up; the fade waits a second more.
    expect(views).toHaveLength(2);
    advance(FADE_AFTER_LAST_MS);
    expect(views[2]).toEqual({ text: 'How are you?', isUser: false, visible: false });
  });

  it('chains a chunk that arrives while another is showing, without a fade between', () => {
    const { queue, views, advance } = harness();
    queue.handle({ text: 'First.', isUser: false, duration: 1 });
    advance(500);
    queue.handle({ text: 'Second.', isUser: false, duration: 1 });
    advance(500);
    expect(views.map((v) => [v.text, v.visible])).toEqual([['First.', true], ['Second.', true]]);
  });

  it('assumes four seconds for a chunk with no audio', () => {
    const { queue, views, advance } = harness();
    queue.handle({ text: 'A. B.', isUser: false });
    advance(1999);
    expect(views).toHaveLength(1);
    advance(1);
    expect(views[1].text).toBe('B.');
  });

  it("the user's line interrupts, shows at once, and holds by word count", () => {
    const { queue, views, advance } = harness();
    queue.handle({ text: 'A long sentence. Another one.', isUser: false, duration: 10 });
    queue.handle({ text: 'wait', isUser: true });
    expect(views.at(-1)).toEqual({ text: 'wait', isUser: true, visible: true });
    advance(1499);
    expect(views.at(-1)?.visible).toBe(true);
    advance(1);
    expect(views.at(-1)).toEqual({ text: 'wait', isUser: true, visible: false });
    // The interrupted queue is gone: nothing else shows.
    advance(20000);
    expect(views.filter((v) => v.text === 'Another one.')).toEqual([]);
  });

  it('an empty text cancels everything and hides', () => {
    const { queue, views, advance, t } = harness();
    queue.handle({ text: 'A. B. C.', isUser: false, duration: 3 });
    queue.handle({ text: '', isUser: false });
    expect(views.at(-1)).toEqual({ text: 'A.', isUser: false, visible: false });
    expect(t.pendingCount).toBe(0);
    advance(5000);
    expect(views).toHaveLength(2);
  });

  it('dispose drops the timers', () => {
    const { queue, t } = harness();
    queue.handle({ text: 'A.', isUser: false, duration: 1 });
    queue.dispose();
    expect(t.pendingCount).toBe(0);
  });
});
