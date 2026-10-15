import { describe, expect, it, vi } from 'vitest';
import { fillTimezoneIfUnset } from './timezone';

/**
 * The account's time zone (#352) is filled from this device the first time it
 * is empty — once, without asking — and never overwritten afterwards: the user
 * may have set it on purpose from another device.
 */
describe('fillTimezoneIfUnset', () => {
  it('fills an empty account from the device', async () => {
    const patch = vi.fn(async () => undefined);
    const user = await fillTimezoneIfUnset({ username: 'a', timezone: null }, 'Europe/Paris', patch);
    expect(patch).toHaveBeenCalledWith({ timezone: 'Europe/Paris' });
    expect(user.timezone).toBe('Europe/Paris');
  });

  it('leaves an account that has one alone', async () => {
    const patch = vi.fn(async () => undefined);
    const user = await fillTimezoneIfUnset({ username: 'a', timezone: 'Asia/Tokyo' }, 'Europe/Paris', patch);
    expect(patch).not.toHaveBeenCalled();
    expect(user.timezone).toBe('Asia/Tokyo');
  });

  it('does nothing when the device does not know its zone, or the server says no', async () => {
    const none = vi.fn(async () => undefined);
    expect((await fillTimezoneIfUnset({ username: 'a', timezone: null }, null, none)).timezone).toBeNull();
    expect(none).not.toHaveBeenCalled();

    const refused = vi.fn(async () => { throw new Error('422'); });
    expect((await fillTimezoneIfUnset({ username: 'a', timezone: null }, 'Mars/Olympus', refused)).timezone).toBeNull();
  });
});
