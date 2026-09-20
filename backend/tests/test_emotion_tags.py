"""The emotion tags the model writes are stripped as they stream, and their places kept.

``EmotionTagStripper`` reads one LLM round chunk by chunk. What matters: a tag
split across chunks is never shown, ordinary brackets pass through untouched,
an unknown label is shown rather than swallowed, and every cue offset is in the
unit both clients count in — UTF-16 code units — into the clean text.

The last class shows why a per-chunk ``re.sub`` is not enough: it was the
obvious first implementation, and it leaks partial tags into the text.
"""

import re
from typing import get_args

import pytest

from kurisuassistant.character.emotion_source import (
    EMOTION_LABEL_ORDER,
    EMOTION_LABELS,
    emotion_channel_enabled,
    utf16_length,
)
from kurisuassistant.character.emotion_tags import (
    MAX_LABEL,
    TAG_OPEN,
    EmotionTagStripper,
    split_at_utf16,
)
from kurisuassistant.character.schema import VrmEmotion


def run(chunks):
    """Feed the chunks; return (clean text, cues) as the agent would see them."""
    s = EmotionTagStripper()
    clean, cues = "", []
    for c in chunks:
        piece, new = s.feed(c)
        clean += piece
        cues += new
    clean += s.flush()
    return clean, cues, s


def strip_naively(text):
    """What a per-chunk regex would leave: the reference the stripper is measured against."""
    return re.sub(r"\[\[emotion:(neutral|happy|angry|sad|relaxed|surprised)\]\]", "", text)


class TestWholeTags:
    def test_a_tag_at_offset_zero(self):
        clean, cues, _ = run(["[[emotion:happy]]Hello."])
        assert clean == "Hello."
        assert cues == [(0, "happy")]

    def test_two_tags_in_one_chunk(self):
        clean, cues, _ = run(["[[emotion:sad]]Oh no. [[emotion:happy]]But fine!"])
        assert clean == "Oh no. But fine!"
        assert cues == [(0, "sad"), (7, "happy")]

    def test_a_tag_mid_text_reports_the_clean_offset(self):
        clean, cues, _ = run(["Hello. [[emotion:angry]]No."])
        assert clean == "Hello. No."
        assert cues == [(7, "angry")]

    def test_every_known_label_is_consumed(self):
        for label in sorted(EMOTION_LABELS):
            clean, cues, _ = run([f"[[emotion:{label}]]x"])
            assert (clean, cues) == ("x", [(0, label)])


class TestSplitTags:
    def test_a_tag_split_across_three_chunks_shows_no_partial(self):
        pieces = []
        s = EmotionTagStripper()
        for c in ["Hi. [[emo", "tion:sa", "d]] Bye."]:
            piece, cues = s.feed(c)
            pieces.append((piece, cues))
        assert pieces[0] == ("Hi. ", [])          # the partial is held back
        assert pieces[1] == ("", [])              # still held
        assert pieces[2] == (" Bye.", [(4, "sad")])
        assert s.flush() == ""

    def test_a_split_after_the_colon(self):
        clean, cues, _ = run(["A [[emotion:", "happy]] B"])
        assert (clean, cues) == ("A  B", [(2, "happy")])

    def test_a_split_inside_the_closing_brackets(self):
        clean, cues, _ = run(["A [[emotion:happy]", "] B"])
        assert (clean, cues) == ("A  B", [(2, "happy")])

    def test_a_lone_open_bracket_is_not_delayed_forever(self):
        """One '[' could start a tag; it is held, and released by the next chunk.

        Asserted per feed: the bracket must come out with the chunk that proves
        it was not a tag, not sit in the hold until ``flush``.
        """
        s = EmotionTagStripper()
        assert s.feed("see [") == ("see ", [])
        assert s.feed("1] and more") == ("[1] and more", [])
        assert s.flush() == ""

    def test_a_dangling_partial_is_released_on_flush(self):
        s = EmotionTagStripper()
        assert s.feed("Bye [[emo") == ("Bye ", [])
        assert s.flush() == "[[emo"

    def test_an_unknown_label_with_a_close_is_shown_whole(self):
        clean, cues, _ = run(["[[emotion:thisisnotalabelatall]] x"])
        assert clean == "[[emotion:thisisnotalabelatall]] x"
        assert cues == []

    def test_a_too_long_label_with_no_close_is_released_at_once(self):
        """The MAX_LABEL branch: past the longest label, nothing is held back."""
        s = EmotionTagStripper()
        text = TAG_OPEN + "x" * (MAX_LABEL + 1)
        assert s.feed(text) == (text, [])
        assert s.flush() == ""

    def test_the_hold_never_exceeds_the_opener_plus_max_label(self):
        """Ordinary text is delayed by at most len('[[emotion:') + MAX_LABEL characters."""
        s = EmotionTagStripper()
        text = "hello " + TAG_OPEN + "x" * MAX_LABEL
        piece, cues = s.feed(text)
        assert (piece, cues) == ("hello ", [])
        assert len(text) - len(piece) == len(TAG_OPEN) + MAX_LABEL == 22
        assert s.feed("y") == (TAG_OPEN + "x" * MAX_LABEL + "y", [])


class TestPassThrough:
    @pytest.mark.parametrize("text", [
        "See [1] and [TODO] and [happy] for details.",
        "I am [happy] to help",
        "footnote[^1] here",
        "[[not an emotion]] at all",
        "]]stray[[ brackets",
    ])
    def test_ordinary_brackets_are_untouched(self, text):
        clean, cues, _ = run([text])
        assert (clean, cues) == (text, [])

    def test_an_unknown_label_is_shown_verbatim_and_counted(self):
        clean, cues, s = run(["[[emotion:excited]] Wow. [[emotion:happy]] Yes."])
        assert clean == "[[emotion:excited]] Wow.  Yes."
        assert cues == [(25, "happy")]
        assert s.stats == {"known": 1, "unknown": 1}

    def test_a_long_tagless_chunk_passes_straight_through(self):
        text = "word " * 2000
        clean, cues, _ = run([text])
        assert (clean, cues) == (text, [])

    @pytest.mark.parametrize("text", [
        "[[emotion:happy]]Hi there. [[emotion:sad]]Sad now.",
        "No tags here at all, just [brackets] and [[double]] ones.",
        "Ends with a partial [[emotion:hap",
        "[[emotion:unknownlabel]] then [[emotion:relaxed]] ok",
        "😀 emoji [[emotion:surprised]] wow 🎉",
        "[" * 30 + "]" * 30,
        # An unclosed opener before a real tag: the second tag must be found
        # whether the text arrives whole or a word at a time (the close search
        # is bounded to where a label could end).
        "[[emotion:happy] Hello there! [[emotion:sad]] Bye",
        "[[emotion:blah blah blah blah [[emotion:happy]] X",
        "[[emotion:ab[[emotion:happy]] x",
        "[[emotion:happy]Oops [[emotion:sad]] and [[emotion:angry]] twice",
    ])
    def test_the_invariant_over_a_corpus(self, text):
        """Clean output plus flush is the input minus the known tags — for every chunking.

        Every split size from one character to the whole text, so the answer
        cannot depend on where a provider happened to cut its deltas.
        """
        whole = run([text])
        for split in range(1, len(text) + 1):
            chunks = [text[i:i + split] for i in range(0, len(text), split)]
            clean, cues, _ = run(chunks)
            assert clean == strip_naively(text), (text, split)
            assert (clean, cues) == (whole[0], whole[1]), (text, split)


class TestOffsetsAreUtf16:
    def test_an_astral_character_counts_two(self):
        """The unit is what `'😀 '.length` gives in JavaScript: 3, not 2."""
        clean, cues, _ = run(["😀 [[emotion:happy]]x"])
        assert clean == "😀 x"
        assert cues == [(3, "happy")]
        assert utf16_length("😀 ") == 3
        assert len("😀 ") == 2  # what a plain len() would have said

    def test_split_at_utf16_never_cuts_a_character(self):
        assert split_at_utf16("😀x", 2) == ("😀", "x")
        assert split_at_utf16("😀x", 1) == ("😀", "x")  # inside the pair: rounds to after it
        assert split_at_utf16("abc", 0) == ("", "abc")
        assert split_at_utf16("abc", 9) == ("abc", "")


class TestWhyNotARegex:
    """The naive implementation this replaces, and where it fails."""

    def test_a_per_chunk_regex_leaks_the_partial_tag(self):
        chunks = ["Hi. [[emo", "tion:sad]] Bye."]
        naive = "".join(strip_naively(c) for c in chunks)
        assert naive == "Hi. [[emotion:sad]] Bye.", "the regex never sees the whole tag"
        clean, cues, _ = run(chunks)
        assert clean == "Hi.  Bye."
        assert cues == [(4, "sad")]


class TestTheLabelSet:
    def test_the_three_label_sets_are_one(self):
        """The schema literal, the stripper's set and the prompt's order agree."""
        assert EMOTION_LABELS == frozenset(get_args(VrmEmotion))
        assert frozenset(EMOTION_LABEL_ORDER) == EMOTION_LABELS
        assert len(EMOTION_LABEL_ORDER) == len(EMOTION_LABELS)

    def test_every_label_is_in_the_prompt(self):
        from kurisuassistant.agents.main import EXPRESSION_PROMPT

        for label in EMOTION_LABELS:
            assert f"[[emotion:{label}]]" in EXPRESSION_PROMPT


class TestTheGate:
    def _vrm(self, enabled):
        return {"kind": "vrm", "vrm": {"emotion": {"enabled": enabled}}}

    def test_a_vrm_persona_with_emotion_on(self):
        assert emotion_channel_enabled(self._vrm(True)) is True

    def test_a_vrm_persona_with_emotion_off(self):
        assert emotion_channel_enabled(self._vrm(False)) is False

    def test_a_pose_graph_persona(self):
        assert emotion_channel_enabled({"kind": "pose_graph", "pose_tree": {"nodes": []}}) is False

    def test_a_vrm_kind_with_no_vrm_member(self):
        assert emotion_channel_enabled({"kind": "vrm"}) is False

    @pytest.mark.parametrize("config", [None, {}, {"pose_tree": {}}, "vrm", {"kind": "vrm", "vrm": {"bogus": 1}}])
    def test_nothing_else_answers_yes(self, config):
        assert emotion_channel_enabled(config) is False
