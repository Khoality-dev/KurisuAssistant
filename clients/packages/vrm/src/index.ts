/**
 * `@kurisu/vrm` — the VRM character driver.
 *
 * Import this lazily (`await import('@kurisu/vrm')`) after `supportsWebGL`
 * from `@kurisu/vrm/probe` says the display can draw: this entry carries
 * three.js, and a 2D-only user's bundle should not. The probe deliberately
 * lives behind its own subpath so that asking the question never loads the
 * engine.
 */
export { createVrmDriver, ARM_DROP_RAD, FOREARM_BEND_RAD, type VrmDriver, type VrmDriverOptions, type VrmDriverInfo, type VrmFrameSnapshot } from './driver/VrmDriver';
export {
  VrmLoadError,
  checkVrmHeader,
  readGlbHeader,
  readExpressionModel,
  summariseMeta,
  loadVrmModel,
  loadVrmClip,
  modelCacheKey,
  acquireModel,
  releaseModel,
  hasCachedModel,
  cachedInstanceCount,
  evictModel,
  clearModelCache,
  LOOK_AT_PROXY_NAME,
  type LoadedModel,
  type ModelLoader,
  type ModelOwner,
  type ClipLoader,
  type VrmMetaSummary,
} from './driver/loader';
export { defaultRendererFactory, type RendererFactory, type StageRenderer } from './driver/scene';
export { stepMouth, INITIAL_MOUTH, type MouthState, type LipSyncOptions } from './driver/lipSync';
export {
  createIdleState,
  stepIdle,
  blinkTimingOf,
  MAX_IDLE_STEP_MS,
  type IdleState,
  type IdleFrame,
  type IdleInputs,
  type BlinkState,
  type BlinkPhase,
} from './driver/idle';
export {
  createExpressionState,
  stepExpressions,
  appliedWeights,
  overrideCeiling,
  degrade,
  everyEmotion,
  FULL_MODEL,
  OVERRIDE_CAP,
  type ExpressionModel,
  type ExpressionState,
  type ExpressionInputs,
  type OverrideMode,
} from './driver/expressions';
export {
  createReactionTimers,
  matchReactions,
  DEFAULT_COOLDOWN_MS,
  type ReactionInputs,
  type ReactionTimers,
  type ReactionOptions,
} from './driver/reactionTable';
export { describeClip, EXPRESSION_PREFIX, type LoadedClip } from './driver/vrmaPlayer';
export {
  parseHostMessage,
  HostMessageError,
  HOST_MESSAGE_TYPES,
  type HostMessage,
  type HostMessageType,
  type PageEvent,
} from './page/host';
