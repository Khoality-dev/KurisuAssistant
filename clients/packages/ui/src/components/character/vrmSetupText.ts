/**
 * The 3D setup editor's words (#242), kept out of the component so they can
 * be read and tested as a list: the upload failures by the code the server
 * (or the client-side check) gave, the model's status line, and the one-line
 * summaries each step shows while it is closed.
 */
import {
  FRAMINGS,
  MOVE_PRESETS,
  REACTION_RECIPES,
  backgroundName,
  derivePreset,
  emotionAvailability,
  extrasOn,
  recipeOn,
  strengthOf,
  type VrmAssetRef,
  type VrmEmotion,
  type VrmSettings,
} from '@kurisu/models';

/** Megabytes the way the file manager shows them: one decimal, powers of ten. */
export function mb(bytes: number): string {
  return `${(Math.max(0, bytes) / 1e6).toFixed(1)} MB`;
}

export function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export type UploadErrorCode =
  | 'not_glb' | 'not_vrm' | 'no_humanoid' | 'not_vrma' | 'bad_json' | 'too_large' | 'quota'
  | 'digest_mismatch' | 'clip_in_use' | 'network' | 'cancelled' | 'unknown';

const KNOWN: ReadonlySet<string> = new Set([
  'not_glb', 'not_vrm', 'no_humanoid', 'not_vrma', 'bad_json', 'too_large', 'quota', 'digest_mismatch', 'clip_in_use', 'network', 'cancelled', 'unknown',
]);

export function asUploadCode(code: unknown): UploadErrorCode {
  return typeof code === 'string' && KNOWN.has(code) ? (code as UploadErrorCode) : 'unknown';
}

/** An upload the user stopped (or the editor closed on) is not a failure: no card, no toast. */
export function isCancelled(code: UploadErrorCode): boolean {
  return code === 'cancelled';
}

/** Title and body of the card shown when an upload is refused. `maxBytes` fills in "too big". */
export function uploadErrorText(code: UploadErrorCode, filename: string, opts: { maxBytes?: number; size?: number } = {}): [string, string] {
  switch (code) {
    case 'not_vrm':
      return ['That file isn’t a VRM model', `${filename} is a plain 3D file. In VRoid Studio, use Export → Export as VRM and upload that file instead.`];
    case 'no_humanoid':
      return ['This model can’t move', `${filename} has no skeleton set up, so she couldn’t breathe, wave or react. Export it again from VRoid Studio without changing the bones.`];
    case 'not_glb':
      return ['That file isn’t a 3D model', `${filename} isn’t a .vrm file. In VRoid Studio, use Export → Export as VRM and upload that file.`];
    case 'not_vrma':
      return ['That file isn’t a VRM animation', `${filename} isn’t a .vrma file. Upload an animation exported as VRMA.`];
    case 'bad_json':
      return ['That file is damaged', `${filename} could not be read. Export it again from VRoid Studio and upload the new file.`];
    case 'too_large': {
      const limit = opts.maxBytes ? ` Files up to ${mb(opts.maxBytes)} can be uploaded.` : '';
      const size = opts.size ? ` is ${mb(opts.size)}.` : ' is too big.';
      return ['That file is too big', `${filename}${size}${limit} In VRoid Studio, pick a smaller texture size when you export.`];
    }
    case 'quota':
      return ['No room left for 3D files', 'Your characters already use all the space this server gives you. Remove a model or an animation you no longer use, then try again.'];
    case 'digest_mismatch':
    case 'network':
      return ['The upload didn’t finish', 'The connection dropped before the whole file arrived. Try again.'];
    case 'clip_in_use':
      return ['That animation is still in use', 'Turn it off under “Plays while idle” first, then delete it.'];
    default:
      return ['The upload failed', 'Something went wrong on the server. Try again in a moment.'];
  }
}

/** Faces the model has no expression for (from the upload's check). */
export function missingFaces(model: VrmAssetRef | null): VrmEmotion[] {
  const avail = emotionAvailability(model?.expressions);
  return (Object.keys(avail) as VrmEmotion[]).filter((e) => !avail[e]);
}

/** The model card's status: ready, or which faces it will stand in for. */
export function modelStatus(model: VrmAssetRef): { ok: boolean; text: string } {
  const missing = missingFaces(model);
  if (!missing.length) return { ok: true, text: 'Ready. She can talk, blink, move and show every feeling.' };
  const names = missing.map((e) => `“${e}”`).join(missing.length === 2 ? ' and ' : ', ');
  const older = model.spec_version === '0.x' ? 'this older file' : 'this file';
  const face = missing.length === 1 ? 'face' : 'faces';
  return {
    ok: false,
    text: `Works, but ${older} has no ${names} ${face}. She’ll look neutral instead. Export again from a newer VRoid Studio to fix it.`,
  };
}

export function modelMeta(model: VrmAssetRef): string {
  const version = model.spec_version ? `VRM ${model.spec_version}` : 'VRM';
  const when = new Date(model.uploaded_at);
  const date = Number.isNaN(when.getTime()) ? '' : ` · uploaded ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  return `${version} · ${mb(model.bytes)}${date}`;
}

export function modelFilename(model: VrmAssetRef): string {
  return model.filename || 'model.vrm';
}

/** The line under each step's title. */
export function stepSummaries(s: VrmSettings): Record<'model' | 'move' | 'feel' | 'react' | 'frame' | 'fine', string> {
  const preset = derivePreset(s.idle);
  const presetLabel = preset === 'custom' ? null : MOVE_PRESETS.find((p) => p.id === preset)!.label;
  const move = presetLabel === null
    ? 'Custom (set in Fine-tune)'
    : presetLabel + (preset !== 'still' && extrasOn(s.idle) ? ' · stretches now and then' : '');
  const strength = capitalise(strengthOf(s.emotion.intensity));
  const usual = capitalise(s.emotion.default_expression);
  const on = REACTION_RECIPES.filter((r) => recipeOn(s.reactions, r.id)).length;
  const framing = FRAMINGS.find((f) => f.target === s.camera.target)?.label ?? 'Waist up';
  const missing = missingFaces(s.model);
  const model = s.model
    ? `${modelFilename(s.model)} · ${missing.length ? (missing.length === 1 ? 'one face missing' : `${missing.length} faces missing`) : 'ready'}`
    : 'No model yet';
  return {
    model,
    move,
    feel: s.emotion.enabled ? `On · usual face ${usual} · ${strength}` : `Off · always ${usual}`,
    react: `${on} of ${REACTION_RECIPES.length} on`,
    frame: `${framing} · ${backgroundName(s.camera.background)} background`,
    fine: s.clips.length ? `${s.clips.length} of your own animation${s.clips.length === 1 ? '' : 's'}` : 'Not needed for most people',
  };
}
