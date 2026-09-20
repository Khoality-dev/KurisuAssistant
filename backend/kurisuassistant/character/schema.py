"""The shape of ``character_config``: which system a persona uses, and each system's settings.

A persona's character is either the 2D pose graph or a 3D VRM model, and
``kind`` says which one shows. The two are not exclusive: a persona keeps both
members so that switching back does not mean uploading again. The pose-tree
side stays a permissive ``dict`` — it carries React Flow positions and keys
that older migrations tolerate, and ``references.referenced_paths`` is what
reads it. The VRM side is typed here, with ``extra='forbid'``, because nothing
else ever inspects it and a misspelt key would otherwise be stored forever.

``vrm.model`` and ``vrm.clips`` are **server-owned**: the upload routes write
them in the transaction that accepts the bytes, and ``config_write`` replaces
whatever a body says with the stored values. They are declared here so that a
body may echo what ``GET /personas`` returned, not so a client can set them.
"""

from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator

CharacterKind = Literal["pose_graph", "vrm"]
KINDS: frozenset[str] = frozenset({"pose_graph", "vrm"})

# The VRM 1.0 preset expressions plus neutral. A VRM 0.x model has no `surprised`;
# the renderer degrades a missing preset, the wire set does not shrink.
VrmEmotion = Literal["neutral", "happy", "angry", "sad", "relaxed", "surprised"]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class VrmAssetRef(_Strict):
    url: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    bytes: int = Field(ge=0)
    uploaded_at: str


class VrmClipRef(_Strict):
    id: str = Field(pattern=r"^[0-9a-f]{8}$")
    name: str
    url: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    bytes: int = Field(ge=0)
    loop: bool = False


class VrmReactionClip(_Strict):
    type: Literal["clip"]
    clip_id: str
    crossfade_ms: Optional[int] = None


class VrmReactionExpression(_Strict):
    type: Literal["expression"]
    expression: VrmEmotion
    weight: float = Field(ge=0, le=1)
    hold_ms: int = Field(ge=0)


class VrmReaction(_Strict):
    id: str
    name: str = ""
    # The 2D graph's own condition objects (random / thinking / gesture / face),
    # AND-ed. Left as dicts: the two clients evaluate them and treat an unknown
    # ``type`` as false, which is the right failure for a condition this server
    # has never heard of.
    when: list[dict] = Field(default_factory=list)
    play: Union[VrmReactionClip, VrmReactionExpression] = Field(discriminator="type")
    cooldown_ms: int = Field(default=4000, ge=0)


class BlinkTiming(_Strict):
    """The five blink fields of the 2D ``AnimationSettings``, same keys, same defaults."""

    blink_min_interval: int = Field(default=2000, ge=0)
    blink_max_interval: int = Field(default=6000, ge=0)
    blink_close_duration: int = Field(default=100, ge=0)
    blink_hold_duration: int = Field(default=50, ge=0)
    blink_open_duration: int = Field(default=100, ge=0)


class VrmIdleSettings(_Strict):
    procedural: bool = True
    arms_lowered: bool = True
    breath_period_ms: int = Field(default=4000, ge=1)
    # Degrees of pitch on the chest, not pixels and not a scale: the VRM rig only
    # carries rotations (and the hips position) to the mesh.
    breath_amplitude_deg: float = Field(default=2.0, ge=0)
    sway_amplitude_deg: float = Field(default=1.5, ge=0)
    sway_period_ms: int = Field(default=7000, ge=1)
    blink: BlinkTiming = Field(default_factory=BlinkTiming)
    look_at: Literal["camera", "drift", "off"] = "camera"
    idle_clip_ids: list[str] = Field(default_factory=list)
    # ``[min, max]`` of the pause between idle clips; the renderer draws a random
    # wait from it, so the two are bounded like every other timing here.
    idle_clip_interval_ms: tuple[Annotated[int, Field(ge=0)], Annotated[int, Field(ge=0)]] = (8000, 20000)

    @model_validator(mode="after")
    def _interval_is_a_range(self):
        lo, hi = self.idle_clip_interval_ms
        if lo > hi:
            raise ValueError("idle_clip_interval_ms must be [min, max] with min <= max")
        return self


class VrmEmotionSettings(_Strict):
    enabled: bool = True
    default_expression: VrmEmotion = "neutral"
    intensity: float = Field(default=1.0, ge=0, le=1)
    attack_ms: int = Field(default=180, ge=0)
    release_ms: int = Field(default=400, ge=0)
    thinking: Optional[VrmEmotion] = None


class VrmCamera(_Strict):
    target: Literal["head", "upper_body", "full_body"] = "upper_body"
    fov: float = Field(default=24, gt=0, lt=180)
    offset_y: float = 0.0
    background: str = "#ffffff"


class VrmSettings(_Strict):
    model: Optional[VrmAssetRef] = None
    clips: list[VrmClipRef] = Field(default_factory=list)
    idle: VrmIdleSettings = Field(default_factory=VrmIdleSettings)
    emotion: VrmEmotionSettings = Field(default_factory=VrmEmotionSettings)
    reactions: list[VrmReaction] = Field(default_factory=list)
    camera: VrmCamera = Field(default_factory=VrmCamera)


class CharacterConfigBody(_Strict):
    """What a client may send. A member left out is kept; ``null`` clears it."""

    kind: CharacterKind
    pose_tree: Optional[dict] = None
    vrm: Optional[VrmSettings] = None


def clip_ids_named(vrm: VrmSettings) -> set[str]:
    """Every clip id the settings refer to: the idle rotation and each clip reaction."""
    named = set(vrm.idle.idle_clip_ids)
    for reaction in vrm.reactions:
        if isinstance(reaction.play, VrmReactionClip):
            named.add(reaction.play.clip_id)
    return named
