import fs from 'fs';
import path from 'path';

/**
 * Copy the pre-rename profile once (#378). The source is deliberately retained.
 *
 * The copy goes to a staging folder and is renamed into place, so a copy that
 * fails part-way — the old app still running and holding its files open, say —
 * leaves no half profile behind. A failure never stops the app from starting:
 * it starts on a fresh profile instead, and the person signs in again.
 */
export function migrateUserDataDirectory(appData: string): string {
  const source = path.join(appData, 'kurisu-assistant');
  const target = path.join(appData, 'amadeus');
  if (!fs.existsSync(source) || fs.existsSync(target)) return target;

  const staging = path.join(appData, 'amadeus.migrating');
  try {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.cpSync(source, staging, { recursive: true, errorOnExist: true });
    fs.renameSync(staging, target);
  } catch (error) {
    console.error('[userData] Could not copy the KurisuAssistant profile; starting on a fresh one.', error);
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return target;
}
