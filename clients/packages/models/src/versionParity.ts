/**
 * Whether the app and the backend are the same release.
 *
 * One number is meant to cover the backend and both clients (#256), so the
 * settings screen can say plainly when they have drifted instead of leaving
 * two strings side by side to compare (#257). Only the release core counts:
 * `v0.7.0`, `0.7.0-dev-a1b2c3d` and `0.7.0+42` are all the 0.7.0 release, so a
 * dev build against its own backend does not warn about its own stamp.
 * Android's `VersionParity.kt` makes the same call with the same rules.
 */

/** `major.minor.patch` of a version string, or `null` when it has no such core. */
export function releaseCore(version: string | null | undefined): string | null {
  if (!version) return null;
  const match = /^\s*v?(\d+\.\d+\.\d+)/i.exec(version);
  return match ? match[1] : null;
}

/**
 * The sentence to show when the two are different releases, or `null` when they
 * agree or when either side is unknown — an unreachable backend is its own
 * message, not a mismatch.
 */
export function versionMismatchSentence(
  appVersion: string | null | undefined,
  backendVersion: string | null | undefined,
): string | null {
  const app = releaseCore(appVersion);
  const backend = releaseCore(backendVersion);
  if (!app || !backend || app === backend) return null;
  return `This app is v${app}; the backend is v${backend} — update whichever is behind.`;
}
