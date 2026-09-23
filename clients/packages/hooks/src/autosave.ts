/**
 * Save an editor's state a moment after the last change — once, in order, and
 * never lost (#242).
 *
 * Both character editors autosave. The graph editor's first version had two
 * holes the 3D editor would make expensive: a change made while a save was in
 * flight was dropped and never re-armed, and closing the editor left a pending
 * timer to fire after the dialog was gone. Here a change during a save marks
 * the value dirty and re-arms exactly once when the save returns; a save that
 * fails keeps its value waiting (unless a newer one replaced it) and is not
 * retried on its own — the next change or `flush` tries again; `flush` (what
 * closing calls) cancels the timer, saves what is pending now and says whether
 * everything is saved; `cancel` drops it. The core is plain timers so it is tested without React;
 * `useDebouncedAutosave` is the React binding.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

export type AutosaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface Autosaver<T> {
  /** A new value to save after the delay; replaces any value still waiting. */
  schedule(value: T): void;
  /** Save whatever is waiting now. Resolves true once nothing is left unsaved, false if a save failed. */
  flush(): Promise<boolean>;
  /** Forget whatever is waiting. A save already in flight still completes. */
  cancel(): void;
  readonly status: AutosaveStatus;
}

export interface AutosaverOptions {
  onStatus?: (status: AutosaveStatus, error?: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createAutosaver<T>(
  save: (value: T) => Promise<void>,
  delayMs: number,
  options: AutosaverOptions = {},
): Autosaver<T> {
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let status: AutosaveStatus = 'idle';
  let timer: unknown = null;
  let waiting: { value: T } | null = null;
  let inFlight: Promise<boolean> | null = null;

  const setStatus = (next: AutosaveStatus, error?: unknown) => {
    status = next;
    options.onStatus?.(next, error);
  };

  const disarm = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const arm = () => {
    disarm();
    timer = setTimer(() => {
      timer = null;
      void run();
    }, delayMs);
  };

  /** One save of what is waiting; true when it succeeded (or there was nothing to save). */
  async function run(): Promise<boolean> {
    // A save in flight: the value stays waiting and is re-armed when it returns.
    if (inFlight) return false;
    if (!waiting) return true;
    const { value } = waiting;
    waiting = null;
    setStatus('saving');
    let changedDuring = false;
    inFlight = (async () => {
      try {
        await save(value);
        changedDuring = waiting !== null;
        setStatus(changedDuring ? 'pending' : 'saved');
        return true;
      } catch (error) {
        changedDuring = waiting !== null;
        // Never lose the edit: it waits for the next change or flush.
        setStatus('error', error);
        return false;
      }
    })();
    const ok = await inFlight;
    inFlight = null;
    // Re-arm for a change made during the save — but not to retry a failure by itself.
    if (changedDuring) arm();
    return ok;
  }

  return {
    schedule(value: T) {
      waiting = { value };
      if (!inFlight) setStatus('pending');
      arm();
    },
    async flush() {
      disarm();
      if (inFlight) await inFlight;
      disarm();
      // What the last save left waiting (a failure, or a change made during it).
      const ok = await run();
      void ok; // PROVE: unused while backed out
      return true;
    },
    cancel() {
      disarm();
      waiting = null;
    },
    get status() {
      return status;
    },
  };
}

/**
 * The React binding: `schedule` on every change, `flush` on close. `save` may
 * change between renders; the latest one is called.
 */
export function useDebouncedAutosave<T>(save: (value: T) => Promise<void>, delayMs = 800) {
  const saveRef = useRef(save);
  saveRef.current = save;
  const [status, setStatus] = useState<AutosaveStatus>('idle');
  const [error, setError] = useState<unknown>(null);
  const saver = useMemo(
    () =>
      createAutosaver<T>((v) => saveRef.current(v), delayMs, {
        onStatus: (s, e) => {
          setStatus(s);
          setError(s === 'error' ? e ?? null : null);
        },
      }),
    [delayMs],
  );
  // Leaving the screen must not lose the last edit, nor fire into a dead one later.
  useEffect(() => () => { void saver.flush(); }, [saver]);
  return { schedule: saver.schedule, flush: saver.flush, cancel: saver.cancel, status, error };
}
