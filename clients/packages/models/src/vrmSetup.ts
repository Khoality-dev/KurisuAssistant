/**
 * What the 3D setup editor offers, as data (#242).
 *
 * The editor is for people who have never animated anything: presets instead
 * of numbers, reactions as on/off recipes, and every number still reachable
 * under Fine-tune. None of that is stored as such — a preset is only a set of
 * idle values, and a recipe is an ordinary `VrmReaction` with a stable id — so
 * the renderer never learns the words, and a persona edited by hand (or by a
 * future editor) still reads back as "Custom" rather than as a lie.
 *
 * `defaultVrmSettings` is the editor's starting character — the "Natural"
 * movement with its moves, and the wave/think/greet recipes. It is NOT the
 * server's default (`vrm: {}` there has no moves and no reactions, and an
 * absent move list means none): the editor writes this set as soon as it opens
 * on a persona that has no `vrm` member, so what it shows is what is stored.
 */
import type {
  TransitionCondition,
  VrmCamera,
  VrmEmotion,
  VrmEmotionSettings,
  VrmIdleSettings,
  VrmMotion,
  VrmReaction,
  VrmReactionPlay,
  VrmSettings,
} from './character';

export const DEFAULT_IDLE_MOTIONS: readonly VrmMotion[] = ['stretch', 'look_around'];

// ─── How she moves ───

export type MovePresetId = 'still' | 'calm' | 'natural' | 'lively';

export interface MovePreset {
  id: MovePresetId;
  label: string;
  sub: string;
  breath_period_ms: number;
  breath_amplitude_deg: number;
  sway_amplitude_deg: number;
  sway_period_ms: number;
  blink_min_interval: number;
  blink_max_interval: number;
  look_at: VrmIdleSettings['look_at'];
  /** The "now and then" moves this preset plays when that switch is on. */
  idle_motions: readonly VrmMotion[];
  idle_clip_interval_ms: [number, number];
}

export const MOVE_PRESETS: readonly MovePreset[] = [
  {
    id: 'still', label: 'Still', sub: 'Only blinks and talks. Good for a quiet desk.',
    breath_period_ms: 4000, breath_amplitude_deg: 0, sway_amplitude_deg: 0, sway_period_ms: 7000,
    blink_min_interval: 2500, blink_max_interval: 6000, look_at: 'camera', idle_motions: [], idle_clip_interval_ms: [8000, 20000],
  },
  {
    id: 'calm', label: 'Calm', sub: 'Slow breathing. Rarely moves.',
    breath_period_ms: 5200, breath_amplitude_deg: 1.5, sway_amplitude_deg: 0.8, sway_period_ms: 9000,
    blink_min_interval: 3000, blink_max_interval: 7000, look_at: 'camera', idle_motions: ['look_around'], idle_clip_interval_ms: [15000, 30000],
  },
  {
    id: 'natural', label: 'Natural', sub: 'Breathes, sways a little, looks at you.',
    breath_period_ms: 4000, breath_amplitude_deg: 2, sway_amplitude_deg: 1.5, sway_period_ms: 7000,
    blink_min_interval: 2000, blink_max_interval: 6000, look_at: 'camera', idle_motions: ['stretch', 'look_around'], idle_clip_interval_ms: [8000, 20000],
  },
  {
    id: 'lively', label: 'Lively', sub: 'Looks around and moves more often.',
    breath_period_ms: 3200, breath_amplitude_deg: 2.5, sway_amplitude_deg: 2.5, sway_period_ms: 5000,
    blink_min_interval: 1500, blink_max_interval: 4500, look_at: 'drift', idle_motions: ['stretch', 'look_around', 'nod'], idle_clip_interval_ms: [5000, 12000],
  },
];

export function movePreset(id: MovePresetId): MovePreset {
  return MOVE_PRESETS.find((p) => p.id === id)!;
}

/** The idle moves in force. Absent (a config older than the field) means none, as the renderer reads it. */
export function idleMotionsOf(idle: VrmIdleSettings): VrmMotion[] {
  return Array.isArray(idle.idle_motions) ? [...idle.idle_motions] : [];
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Which preset these idle values are, or `'custom'` once a number was changed
 * under Fine-tune. The "now and then" moves count only as on (the preset's own
 * list) or off (none): anything else is custom too.
 */
export function derivePreset(idle: VrmIdleSettings): MovePresetId | 'custom' {
  const motions = idleMotionsOf(idle);
  const interval = idle.idle_clip_interval_ms ?? [8000, 20000];
  for (const p of MOVE_PRESETS) {
    if (
      idle.breath_period_ms === p.breath_period_ms &&
      idle.breath_amplitude_deg === p.breath_amplitude_deg &&
      idle.sway_amplitude_deg === p.sway_amplitude_deg &&
      idle.sway_period_ms === p.sway_period_ms &&
      idle.blink?.blink_min_interval === p.blink_min_interval &&
      idle.blink?.blink_max_interval === p.blink_max_interval &&
      idle.look_at === p.look_at &&
      interval[0] === p.idle_clip_interval_ms[0] &&
      interval[1] === p.idle_clip_interval_ms[1] &&
      (motions.length === 0 || sameList(motions, p.idle_motions))
    ) {
      return p.id;
    }
  }
  return 'custom';
}

/** Whether she "stretches and looks around now and then". */
export function extrasOn(idle: VrmIdleSettings): boolean {
  return idleMotionsOf(idle).length > 0;
}

/** Idle values for a preset; the extras switch keeps its position, the idle clips stay. */
export function applyMovePreset(idle: VrmIdleSettings, id: MovePresetId, extras = extrasOn(idle)): VrmIdleSettings {
  const p = movePreset(id);
  return {
    ...idle,
    procedural: true,
    breath_period_ms: p.breath_period_ms,
    breath_amplitude_deg: p.breath_amplitude_deg,
    sway_amplitude_deg: p.sway_amplitude_deg,
    sway_period_ms: p.sway_period_ms,
    blink: { ...idle.blink, blink_min_interval: p.blink_min_interval, blink_max_interval: p.blink_max_interval },
    look_at: p.look_at,
    idle_motions: extras ? [...p.idle_motions] : [],
    idle_clip_interval_ms: [...p.idle_clip_interval_ms] as [number, number],
  };
}

/** Flip the "now and then" moves: back to the current preset's list, or the default one when custom. */
export function setExtras(idle: VrmIdleSettings, on: boolean): VrmIdleSettings {
  if (!on) return { ...idle, idle_motions: [] };
  const preset = derivePreset(idle);
  const motions = preset === 'custom' ? DEFAULT_IDLE_MOTIONS : movePreset(preset).idle_motions;
  return { ...idle, idle_motions: [...(motions.length ? motions : DEFAULT_IDLE_MOTIONS)] };
}

// ─── Feelings ───

export type StrengthId = 'subtle' | 'normal' | 'strong';
export const STRENGTHS: readonly { id: StrengthId; label: string; intensity: number }[] = [
  { id: 'subtle', label: 'Subtle', intensity: 0.5 },
  { id: 'normal', label: 'Normal', intensity: 0.8 },
  { id: 'strong', label: 'Strong', intensity: 1 },
];

/** The strength an intensity reads as: the nearest of the three. */
export function strengthOf(intensity: number): StrengthId {
  let best = STRENGTHS[0];
  for (const s of STRENGTHS) {
    if (Math.abs(s.intensity - intensity) < Math.abs(best.intensity - intensity)) best = s;
  }
  return best.id;
}

// ─── Reactions ───

export type RecipeId = 'wave' | 'think' | 'greet' | 'thumbs' | 'peace';

export interface ReactionRecipe {
  id: RecipeId;
  label: string;
  /** Whether it needs the camera on to ever fire. */
  usesCamera: boolean;
  reaction: VrmReaction;
}

function recipe(id: RecipeId, label: string, when: TransitionCondition[], play: VrmReactionPlay): ReactionRecipe {
  const usesCamera = when.some((c) => c.type === 'gesture' || c.type === 'face');
  return { id, label, usesCamera, reaction: { id, name: label, when, play, cooldown_ms: 4000 } };
}

const HAPPY: VrmReactionPlay = { type: 'expression', expression: 'happy', weight: 1, hold_ms: 2200 };

/** "Little things she does on her own." A recipe is on when a reaction with its id is in the list. */
export const REACTION_RECIPES: readonly ReactionRecipe[] = [
  recipe('wave', 'Waves back when you wave', [{ type: 'gesture', value: 'wave' }], { type: 'motion', motion: 'wave' }),
  recipe('think', 'Puts a hand to her chin while thinking', [{ type: 'thinking', value: true }], { type: 'motion', motion: 'think' }),
  recipe('greet', 'Smiles when you sit down', [{ type: 'face', value: '*', visible: true }], HAPPY),
  recipe('thumbs', 'Nods at a thumbs up', [{ type: 'gesture', value: 'thumbs_up' }], { type: 'motion', motion: 'nod' }),
  recipe('peace', 'Brightens up at a peace sign', [{ type: 'gesture', value: 'peace_sign' }], HAPPY),
];

export const DEFAULT_RECIPES: readonly RecipeId[] = ['wave', 'think', 'greet'];

export function recipeOn(reactions: readonly VrmReaction[], id: RecipeId): boolean {
  return reactions.some((r) => r.id === id);
}

/**
 * Switch a recipe on or off. Reactions that are not recipes — written by hand
 * or by another editor — are never touched; switched-on recipes keep the
 * recipe order ahead of them, so the first-match rule prefers the recipes.
 */
export function setRecipe(reactions: readonly VrmReaction[], id: RecipeId, on: boolean): VrmReaction[] {
  const others = reactions.filter((r) => !REACTION_RECIPES.some((x) => x.id === r.id));
  const onIds = new Set(REACTION_RECIPES.filter((x) => recipeOn(reactions, x.id)).map((x) => x.id));
  if (on) onIds.add(id);
  else onIds.delete(id);
  const recipes = REACTION_RECIPES.filter((x) => onIds.has(x.id)).map(
    (x) => reactions.find((r) => r.id === x.id) ?? structuredCloneReaction(x.reaction),
  );
  return [...recipes, ...others];
}

function structuredCloneReaction(r: VrmReaction): VrmReaction {
  return JSON.parse(JSON.stringify(r)) as VrmReaction;
}

// ─── Framing ───

export const FRAMINGS: readonly { target: VrmCamera['target']; label: string }[] = [
  { target: 'head', label: 'Face' },
  { target: 'upper_body', label: 'Waist up' },
  { target: 'full_body', label: 'Full body' },
];

export const BACKGROUNDS: readonly { hex: string; name: string }[] = [
  { hex: '#ffffff', name: 'White' },
  { hex: '#f0f2f5', name: 'Light grey' },
  { hex: '#e8e1d6', name: 'Warm' },
  { hex: '#1e2230', name: 'Dark' },
];

export function backgroundName(hex: string): string {
  const found = BACKGROUNDS.find((b) => b.hex === (hex || '').toLowerCase());
  return found ? found.name : hex;
}

// ─── Defaults ───

const DEFAULT_EMOTION: VrmEmotionSettings = {
  enabled: true, default_expression: 'neutral', intensity: 1, attack_ms: 180, release_ms: 400, thinking: null,
};
const DEFAULT_CAMERA: VrmCamera = { target: 'upper_body', fov: 24, offset_y: 0, background: '#ffffff' };

function defaultIdle(): VrmIdleSettings {
  return {
    procedural: true,
    arms_lowered: true,
    breath_period_ms: 4000,
    breath_amplitude_deg: 2,
    sway_amplitude_deg: 1.5,
    sway_period_ms: 7000,
    blink: { blink_min_interval: 2000, blink_max_interval: 6000, blink_close_duration: 100, blink_hold_duration: 50, blink_open_duration: 100 },
    look_at: 'camera',
    idle_clip_ids: [],
    idle_motions: [...DEFAULT_IDLE_MOTIONS],
    idle_clip_interval_ms: [8000, 20000],
  };
}

/** The editor's starting character: the "Natural" preset with its moves, three recipes on. */
export function defaultVrmSettings(): VrmSettings {
  return {
    model: null,
    clips: [],
    idle: defaultIdle(),
    emotion: { ...DEFAULT_EMOTION },
    reactions: REACTION_RECIPES.filter((r) => DEFAULT_RECIPES.includes(r.id)).map((r) => structuredCloneReaction(r.reaction)),
    camera: { ...DEFAULT_CAMERA },
  };
}

/** A stored `vrm` member with every field the editor reads filled in; null gives the defaults. */
export function completeVrmSettings(stored: Partial<VrmSettings> | null | undefined): VrmSettings {
  const d = defaultVrmSettings();
  if (!stored) return d;
  const idle = { ...d.idle, ...(stored.idle ?? {}) } as VrmIdleSettings;
  idle.blink = { ...d.idle.blink, ...(stored.idle?.blink ?? {}) };
  // Absent means none — a config from before the field existed — never the new default.
  return {
    model: stored.model ?? null,
    clips: Array.isArray(stored.clips) ? stored.clips : [],
    idle,
    emotion: { ...d.emotion, ...(stored.emotion ?? {}) },
    reactions: Array.isArray(stored.reactions) ? stored.reactions : d.reactions,
    camera: { ...d.camera, ...(stored.camera ?? {}) },
  };
}

/**
 * "Put everything back to the defaults": movement, feelings, reactions and
 * framing. The model and her own animations — and whether each plays while
 * idle — are kept.
 */
export function resetVrmChoices(settings: VrmSettings): VrmSettings {
  const d = defaultVrmSettings();
  return {
    ...d,
    model: settings.model,
    clips: settings.clips,
    idle: { ...d.idle, idle_clip_ids: [...settings.idle.idle_clip_ids] },
  };
}

/** The settings with every reference to one clip removed, so the clip can be deleted (the server 409s otherwise). */
export function withoutClip(settings: VrmSettings, clipId: string): VrmSettings {
  return {
    ...settings,
    idle: { ...settings.idle, idle_clip_ids: settings.idle.idle_clip_ids.filter((id) => id !== clipId) },
    reactions: settings.reactions.filter((r) => !(r.play.type === 'clip' && r.play.clip_id === clipId)),
  };
}

/** Whether a clip plays while idle, flipped. */
export function toggleIdleClip(settings: VrmSettings, clipId: string): VrmSettings {
  const ids = settings.idle.idle_clip_ids;
  const next = ids.includes(clipId) ? ids.filter((id) => id !== clipId) : [...ids, clipId];
  return { ...settings, idle: { ...settings.idle, idle_clip_ids: next } };
}

/** The six faces, with whether this model has each. An unknown model (no list) has all six. */
export function emotionAvailability(expressions: readonly VrmEmotion[] | null | undefined): Record<VrmEmotion, boolean> {
  const all: VrmEmotion[] = ['neutral', 'happy', 'angry', 'sad', 'relaxed', 'surprised'];
  const has = expressions && expressions.length ? new Set(expressions) : null;
  return Object.fromEntries(all.map((e) => [e, e === 'neutral' || !has || has.has(e)])) as Record<VrmEmotion, boolean>;
}
