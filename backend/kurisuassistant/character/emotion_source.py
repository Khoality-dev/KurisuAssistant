"""Where the character's feeling comes from, and whether a persona wants one.

The agent loop asks an :class:`EmotionSource` two things: hand me the text the
user should see, and tell me where in it the feeling changed. Today the only
source is :class:`~kurisuassistant.character.emotion_tags.EmotionTagStripper`,
which reads tags the model was asked to write; a classifier that reads the
sentence instead (#247) is a second implementation of the same two methods, and
``agents/main.py`` will not know the difference.

The six labels are the VRM 1.0 preset expressions plus ``neutral`` — the set
the renderer can show, so nothing between here and the face has to map.
"""

from typing import Optional, Protocol

EMOTION_LABELS: frozenset[str] = frozenset(
    {"neutral", "happy", "angry", "sad", "relaxed", "surprised"}
)

# One cue: where the feeling changed, as an offset into the accumulated *clean*
# text of the LLM round, counted in UTF-16 code units (§ below), and the label.
Cue = tuple[int, str]


class EmotionSource(Protocol):
    """A stateful reader of one LLM round's streamed text."""

    def feed(self, delta: str) -> tuple[str, list[Cue]]:
        """Consume a streamed piece; return the text to show and any cues in it.

        The clean text may lag the input by a few characters while a possible
        tag is still incomplete; ``flush`` releases what is held back.
        """
        ...

    def flush(self) -> str:
        """The stream ended: release anything held back."""
        ...

    @property
    def stats(self) -> dict[str, int]:
        """How the round went, for the log — known and unknown tags seen."""
        ...


def utf16_length(text: str) -> int:
    """``text``'s length the way ``String.length`` (JS) and ``String.length``
    (Kotlin) count it: UTF-16 code units, so an emoji counts as two.

    Both clients slice their accumulated text with that unit, and a Python
    ``len()`` would put every cue after an astral character one short.
    """
    return len(text.encode("utf-16-le")) // 2


def emotion_channel_enabled(character_config: Optional[dict]) -> bool:
    """Whether this persona asked for a feeling: a VRM character with emotion on.

    A pose-graph persona, a persona with no character, and a config the schema
    rejects all answer no — their prompt and their stream stay byte-identical
    to a backend without this channel.
    """
    if not isinstance(character_config, dict):
        return False
    from kurisuassistant.character.schema import CharacterConfigBody

    try:
        body = CharacterConfigBody.model_validate(character_config)
    except Exception:
        return False
    return body.kind == "vrm" and body.vrm is not None and body.vrm.emotion.enabled
