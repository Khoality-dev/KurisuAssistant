/**
 * The words around exporting a persona with its character, and importing one (#248).
 *
 * The export dialog asks the server what the character weighs before anyone
 * downloads it (`GET /personas/{id}/export/size`), and says what an import of
 * the bundle will count against: the 3D model and its clips are metered on the
 * receiving account, pose art is not.
 */
import { CharacterUploadError, describeRequestFailure } from '@kurisu/api';
import type { PersonaExportSize } from '@kurisu/models';
import { mb } from '../character/vrmSetupText';

type Size = PersonaExportSize['character'];

/** The checkbox line: which character goes, how many files and how big. */
export function includeLine(size: Size): string {
  if (!size) return 'This persona has no character to include.';
  const system = size.kind === 'vrm' ? '3D' : '2D';
  return `Its ${system} character · ${size.files} file${size.files === 1 ? '' : 's'} · ${mb(size.bytes)}`;
}

/** What importing the bundle will use of the receiving account's 3D storage; `null` when nothing is metered. */
export function meteredLine(size: Size): string | null {
  if (!size || size.vrm_bytes <= 0) return null;
  return `Importing it uses ${mb(size.vrm_bytes)} of the 3D character storage of the account it goes into.`;
}

/** The download's name: the bundle is a zip, the plain export JSON. */
export function exportedFilename(name: string, withCharacter: boolean): string {
  return `${name.replace(/\s+/g, '_')}.${withCharacter ? 'zip' : 'json'}`;
}

/** Whether a picked file is a bundle (the streamed zip import) rather than a JSON export. */
export function isBundle(file: File): boolean {
  return /\.zip$/i.test(file.name) || file.type === 'application/zip';
}

/** What a failed import says. A full 3D store gets its figures and the way out; the rest keep the server's sentence. */
export function importFailure(error: unknown): string {
  if (error instanceof CharacterUploadError) {
    if (error.code === 'quota' && error.usedBytes !== undefined && error.quotaBytes !== undefined) {
      return `That persona's 3D character does not fit: ${mb(error.usedBytes)} of ${mb(error.quotaBytes)} is used. `
        + 'Remove a model or an animation first, or export it without its character.';
    }
    return error.message;
  }
  return describeRequestFailure(error, 'Failed to import the persona');
}
