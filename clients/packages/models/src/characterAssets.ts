/**
 * The character store's upload and usage shapes (#236).
 *
 * A persona's VRM model and its VRMA clips are uploaded as raw bodies to
 * `/character-assets/{persona_id}/vrm/model` and `/character-assets/{persona_id}/vrma`;
 * the server writes their refs into `character_config` (they are server-owned —
 * a config body cannot set them) and answers with the stored config, so a
 * client adopts it rather than patching its own copy.
 */
import type { VrmClipRef } from './character';
import type { CharacterConfigDTO } from './types';

/** The model's own description, read from its JSON chunk. Every string is cut to 256 characters. */
export interface VrmUploadMeta {
  spec_version: '0.x' | '1.0';
  title?: string | null;
  authors?: string[];
  license_name?: string | null;
  /** From an untrusted file: render as text, link only an http(s) URL. */
  license_url?: string | null;
  avatar_permission?: string | null;
  commercial_usage?: string | null;
}

/** `PUT /character-assets/{persona_id}/vrm/model`. */
export interface CharacterModelUpload {
  model_url: string;
  sha256: string;
  bytes: number;
  uploaded_at: string;
  meta: VrmUploadMeta;
  character_config: CharacterConfigDTO;
}

/** `PUT /character-assets/{persona_id}/vrma` and `PATCH …/vrma/{clip_id}`. */
export interface CharacterClipUpload {
  clip: VrmClipRef;
  character_config: CharacterConfigDTO;
}

/** `GET /character-assets/usage` — computed from the stored refs; pose art is not metered. */
export interface CharacterUsage {
  used_bytes: number;
  quota_bytes: number;
  max_model_bytes: number;
  max_clip_bytes: number;
  per_persona: { persona_id: number; bytes: number }[];
}

/**
 * The `code` of a refused upload or delete (`detail: {code, message}`):
 * 415 `not_glb` (not a glTF 2.0 binary), `not_vrm` (a 3D file without a VRM
 * extension, e.g. a Blender .glb), `no_humanoid` (a VRM with no skeleton to
 * move), `not_vrma`, `bad_json` (the description is damaged or too large);
 * 413 `too_large`; 507 `quota`; 400 `digest_mismatch`; 409 `clip_in_use`.
 * `cancelled` is the client's own: the caller aborted the upload, which is not
 * a failure to show — nothing the server said.
 */
export type CharacterUploadErrorCode =
  | 'not_glb'
  | 'not_vrm'
  | 'no_humanoid'
  | 'not_vrma'
  | 'bad_json'
  | 'too_large'
  | 'quota'
  | 'digest_mismatch'
  | 'clip_in_use'
  | 'cancelled';

export const CHARACTER_UPLOAD_ERROR_CODES: readonly CharacterUploadErrorCode[] = [
  'not_glb', 'not_vrm', 'no_humanoid', 'not_vrma', 'bad_json', 'too_large', 'quota', 'digest_mismatch', 'clip_in_use', 'cancelled',
];
