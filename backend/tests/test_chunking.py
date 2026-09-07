"""The chunker cuts text into verbatim, overlapping, well-placed passages (#6).

Pure functions, no database. What matters for recall: every chunk is an exact
slice of the source (the tools quote it), the chunks together cover everything,
cuts fall at paragraph or sentence boundaries when there are any, and the line
numbers a citation shows point at the right lines.
"""

import pytest

from kurisuassistant.utils.chunking import Chunk, chunk_text


def _covers(text: str, chunks) -> bool:
    covered = set()
    for c in chunks:
        covered.update(range(c.start_offset, c.end_offset))
    return all(i in covered for i, ch in enumerate(text) if not ch.isspace())


class TestShape:
    def test_blank_input_yields_nothing(self):
        assert chunk_text("") == []
        assert chunk_text("   \n\n  ") == []

    def test_short_text_is_one_chunk_verbatim(self):
        text = "Hello there.\nSecond line."
        [chunk] = chunk_text(text)
        assert chunk == Chunk(text=text, start_offset=0, end_offset=len(text), start_line=1, end_line=2)

    def test_every_chunk_is_an_exact_slice_of_the_source(self):
        text = "\n\n".join(f"Paragraph {i}. " + "word " * 80 for i in range(12))
        chunks = chunk_text(text, target=400, overlap=80)
        assert len(chunks) > 3
        for c in chunks:
            assert text[c.start_offset:c.end_offset] == c.text
            assert len(c.text) <= 400

    def test_nothing_is_lost_between_chunks(self):
        text = "\n\n".join(f"Paragraph {i}. " + "word " * 80 for i in range(12))
        assert _covers(text, chunk_text(text, target=400, overlap=80))

    def test_consecutive_chunks_overlap_by_whole_units(self):
        """The next passage re-starts at the last paragraph (or sentence) of this
        one when that fits in the overlap budget — never mid-unit."""
        text = "\n\n".join(f"Para {i}: " + "x " * 15 for i in range(20))  # ~40-char paragraphs
        chunks = chunk_text(text, target=200, overlap=60)
        assert len(chunks) > 2
        for previous, following in zip(chunks, chunks[1:]):
            assert following.start_offset < previous.end_offset, "the next chunk starts before this one ends"
            assert following.start_offset > previous.start_offset, "and still makes progress"
            assert following.text.startswith("Para "), "and starts at a paragraph"

    def test_a_trailing_unit_bigger_than_the_overlap_is_not_repeated(self):
        text = "\n\n".join(f"Para {i}: " + "x " * 60 for i in range(10))  # ~128-char paragraphs
        chunks = chunk_text(text, target=300, overlap=100)
        for previous, following in zip(chunks, chunks[1:]):
            assert following.start_offset >= previous.end_offset
            assert following.text.startswith("Para ")


class TestBoundaries:
    def test_cuts_fall_on_paragraphs_when_paragraphs_fit(self):
        paragraphs = [f"Paragraph {i} is short and self-contained." for i in range(6)]
        text = "\n\n".join(paragraphs)
        chunks = chunk_text(text, target=100, overlap=0)
        for c in chunks:
            assert c.text.startswith("Paragraph")
            assert c.text.endswith("self-contained.")

    def test_an_overlong_paragraph_is_cut_at_sentences(self):
        text = " ".join(f"Sentence number {i} ends here." for i in range(40))
        chunks = chunk_text(text, target=150, overlap=0)
        assert len(chunks) > 1
        for c in chunks:
            assert c.text.endswith("here."), c.text[-30:]

    def test_an_overlong_sentence_is_cut_at_a_space_not_mid_word(self):
        text = " ".join(["longword"] * 200)  # one 1799-character "sentence"
        chunks = chunk_text(text, target=300, overlap=0)
        assert len(chunks) > 1
        for c in chunks:
            assert not c.text.startswith("ongword") and not c.text.endswith("longwor")

    def test_no_spaces_at_all_still_terminates(self):
        text = "x" * 5000
        chunks = chunk_text(text, target=1000, overlap=100)
        assert _covers(text, chunks)


class TestLineNumbers:
    def test_lines_are_one_based_and_point_at_the_slice(self):
        """Line-oriented text with no blank lines and no sentence ends is cut
        between lines, so every chunk is whole lines and the range is exact."""
        lines = [f"line {i}" for i in range(1, 41)]
        text = "\n".join(lines)
        chunks = chunk_text(text, target=80, overlap=0)
        assert len(chunks) > 1
        for c in chunks:
            first = c.text.split("\n")[0]
            last = c.text.split("\n")[-1]
            assert lines[c.start_line - 1] == first
            assert lines[c.end_line - 1] == last

    def test_leading_whitespace_is_not_part_of_a_chunk(self):
        text = "\n\n\n   indented start\nmore"
        [chunk] = chunk_text(text)
        assert chunk.text == "indented start\nmore"
        assert chunk.start_line == 4


class TestArguments:
    def test_target_must_be_positive(self):
        with pytest.raises(ValueError):
            chunk_text("hello", target=0)

    def test_overlap_larger_than_target_is_clamped(self):
        text = "\n\n".join("para " * 20 for _ in range(6))
        chunks = chunk_text(text, target=120, overlap=10_000)
        assert _covers(text, chunks)
