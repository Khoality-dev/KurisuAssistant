import type { UserProfile } from '@kurisu/models';

/**
 * The account's time zone (#352): schedules are read in it, and the server has
 * no clock to look at. The first client to find it empty fills it from its own
 * device — once, without asking — and nothing here ever overwrites one that is
 * set: the user may have chosen it, on this device or another.
 */

/** This device's IANA zone, or null when the runtime will not say. */
export function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Fill `user.timezone` from `zone` when it is empty, through `patch`. Answers
 * the profile as it now stands; a refusal leaves it as it was.
 */
export async function fillTimezoneIfUnset(
  user: UserProfile,
  zone: string | null,
  patch: (fields: { timezone: string }) => Promise<unknown>,
): Promise<UserProfile> {
  if (user.timezone || !zone) return user;
  try {
    await patch({ timezone: zone });
    return { ...user, timezone: zone };
  } catch {
    return user;
  }
}

/** Every IANA zone the runtime knows, for a picker; empty when it will not say. */
export function knownTimezones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    return supported ? supported('timeZone') : [];
  } catch {
    return [];
  }
}
