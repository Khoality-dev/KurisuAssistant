import { describe, expect, it, vi } from 'vitest';
import { createAutosaver, type AutosaveStatus } from './autosave';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('createAutosaver', () => {
  it('saves the last value once after the delay', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_v: number) => {});
    const a = createAutosaver(save, 800);
    a.schedule(1);
    a.schedule(2);
    await vi.advanceTimersByTimeAsync(799);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save.mock.calls).toEqual([[2]]);
    expect(a.status).toBe('saved');
    vi.useRealTimers();
  });

  it('re-arms exactly once for a change made while a save is in flight', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const save = vi.fn((v: number) => (v === 1 ? first.promise : Promise.resolve()));
    const a = createAutosaver(save, 800);
    a.schedule(1);
    await vi.advanceTimersByTimeAsync(800);
    a.schedule(2);
    a.schedule(3);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save.mock.calls).toEqual([[1]]); // nothing overlaps the save in flight
    first.resolve();
    await vi.advanceTimersByTimeAsync(800);
    expect(save.mock.calls).toEqual([[1], [3]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('flush saves what is waiting now, and no timer fires afterwards', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_v: string) => {});
    const a = createAutosaver(save, 800);
    a.schedule('closing');
    await a.flush();
    expect(save.mock.calls).toEqual([['closing']]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('cancel drops what is waiting', async () => {
    vi.useFakeTimers();
    const save = vi.fn(async (_v: number) => {});
    const a = createAutosaver(save, 800);
    a.schedule(1);
    a.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('keeps a failed value, does not retry it alone, and flush reports the failure', async () => {
    vi.useFakeTimers();
    let online = false;
    const save = vi.fn(async (_v: string) => { if (!online) throw new Error('offline'); });
    const a = createAutosaver(save, 100);
    a.schedule('edit');
    await vi.advanceTimersByTimeAsync(100);
    expect(a.status).toBe('error');
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1); // no retry loop
    expect(await a.flush()).toBe(false); // closing now would lose the edit
    expect(save.mock.calls.map((c) => c[0])).toEqual(['edit', 'edit']);
    online = true;
    expect(await a.flush()).toBe(true);
    expect(save.mock.calls.map((c) => c[0])).toEqual(['edit', 'edit', 'edit']);
    expect(await a.flush()).toBe(true); // nothing left
    expect(save).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('a newer change replaces a failed value', async () => {
    vi.useFakeTimers();
    const first = deferred();
    const save = vi.fn((v: number) => (v === 1 ? first.promise : Promise.resolve()));
    const a = createAutosaver(save, 100);
    a.schedule(1);
    await vi.advanceTimersByTimeAsync(100);
    a.schedule(2);
    first.reject(new Error('offline'));
    await vi.advanceTimersByTimeAsync(100);
    expect(save.mock.calls).toEqual([[1], [2]]);
    expect(a.status).toBe('saved');
    vi.useRealTimers();
  });

  it('reports a failed save and saves the next change', async () => {
    vi.useFakeTimers();
    const statuses: AutosaveStatus[] = [];
    const save = vi.fn(async (v: number) => { if (v === 1) throw new Error('offline'); });
    const a = createAutosaver(save, 100, { onStatus: (s) => statuses.push(s) });
    a.schedule(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(a.status).toBe('error');
    a.schedule(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(a.status).toBe('saved');
    expect(statuses).toEqual(['pending', 'saving', 'error', 'pending', 'saving', 'saved']);
    vi.useRealTimers();
  });
});
