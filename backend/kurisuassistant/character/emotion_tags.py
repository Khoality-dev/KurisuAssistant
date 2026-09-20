"""The first emotion source: tags the model was asked to write, stripped as they stream.

The persona's prompt (``agents/main.py``) asks the model to open a sentence with
``[[emotion:happy]]`` when its feeling changes. Nobody should ever see that:
this stripper removes every complete, known tag from the streamed text and
reports where it stood, so the client can change the face when that sentence
is *spoken*, seconds after it streamed.

Three rules make it safe to run on every chunk:

* A tag can be split across chunks (``[[emo`` … ``tion:sa`` … ``d]] Bye``). The
  stripper holds back only a trailing piece that could still become a tag — a
  proper prefix of ``[[emotion:`` plus at most :data:`MAX_LABEL` label
  characters — so ordinary text is never delayed by more than 22 characters,
  and a partial tag is never shown.
* An unknown label (``[[emotion:excited]]``) passes through verbatim. Visible is
  better than silent: it is how a prompt-compliance problem gets noticed.
* Offsets are counted in UTF-16 code units of the *clean* text of this round
  (:func:`~kurisuassistant.character.emotion_source.utf16_length`), because
  that is how both clients measure the text they accumulate.

The double-bracket, namespaced form is deliberate: ``[1]``, ``[TODO]``,
markdown footnotes and "I am [happy] to help" cannot collide with it.
"""

from kurisuassistant.character.emotion_source import EMOTION_LABELS, Cue, utf16_length

TAG_OPEN = "[[emotion:"
TAG_CLOSE = "]]"
# Longest known label is 9 ("surprised"); a little slack so a near-miss is
# still recognised as an attempted tag and passed through whole.
MAX_LABEL = 12


def split_at_utf16(text: str, units: int) -> tuple[str, str]:
    """Split ``text`` at a UTF-16 code-unit offset without cutting a character.

    Python indexes code points; the wire counts code units. Walking the string
    once is cheap next to the model that produced it.
    """
    if units <= 0:
        return "", text
    count = 0
    for i, ch in enumerate(text):
        if count >= units:
            return text[:i], text[i:]
        count += 2 if ord(ch) > 0xFFFF else 1
    return text, ""


class EmotionTagStripper:
    """One LLM round's emotion tags, removed as they stream. See the module docstring."""

    def __init__(self) -> None:
        self._held = ""
        self._clean_units = 0
        self._known = 0
        self._unknown = 0

    @property
    def stats(self) -> dict[str, int]:
        return {"known": self._known, "unknown": self._unknown}

    def feed(self, delta: str) -> tuple[str, list[Cue]]:
        buf = self._held + delta
        out: list[str] = []
        cues: list[Cue] = []

        def emit(text: str) -> None:
            if text:
                out.append(text)
                self._clean_units += utf16_length(text)

        pos = 0
        while True:
            start = buf.find(TAG_OPEN, pos)
            if start < 0:
                break
            emit(buf[pos:start])
            body_start = start + len(TAG_OPEN)
            close = buf.find(TAG_CLOSE, body_start)
            if close < 0:
                # No closing marker yet. Either it may still arrive (hold the
                # tail back) or this is not a tag at all (too long: pass it on).
                if len(buf) - body_start <= MAX_LABEL:
                    self._held = buf[start:]
                    return "".join(out), cues
                emit(TAG_OPEN)
                pos = body_start
                continue
            label = buf[body_start:close]
            if label in EMOTION_LABELS:
                self._known += 1
                cues.append((self._clean_units, label))
            else:
                # Not one of ours: shown, so a wrong label is not a silent one.
                self._unknown += 1
                emit(buf[start:close + len(TAG_CLOSE)])
            pos = close + len(TAG_CLOSE)

        rest = buf[pos:]
        # The tail may be the beginning of a tag that the next chunk completes.
        hold = 0
        for k in range(min(len(TAG_OPEN) - 1, len(rest)), 0, -1):
            if rest.endswith(TAG_OPEN[:k]):
                hold = k
                break
        if hold:
            emit(rest[:-hold])
            self._held = rest[-hold:]
        else:
            emit(rest)
            self._held = ""
        return "".join(out), cues

    def flush(self) -> str:
        """The round ended: whatever was held back was not a tag after all."""
        tail, self._held = self._held, ""
        self._clean_units += utf16_length(tail)
        return tail
