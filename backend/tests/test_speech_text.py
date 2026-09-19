"""split_text and merge_wav_files: the chunking every synthesis engine is handed.

The same tests run against universal-voice's copy (voice/tests/test_text_processing.py)
until that copy goes (#212).
"""

import io
import wave

import pytest

from kurisuassistant.speech.text import merge_wav_files, split_text
from tests.speech_fakes import frames_in, wav


def test_short_text_is_one_chunk():
    assert split_text("Hello there.", max_length=200) == ["Hello there."]


def test_paragraphs_split_first():
    text = "First paragraph.\n\nSecond paragraph."
    assert split_text(text, max_length=200) == ["First paragraph.", "Second paragraph."]


def test_long_paragraph_splits_on_sentence_boundaries_under_the_limit():
    sentences = [f"Sentence number {i} is here." for i in range(20)]
    text = " ".join(sentences)
    chunks = split_text(text, max_length=80)
    assert len(chunks) > 1
    assert all(len(c) <= 80 for c in chunks)
    # Nothing is lost: every sentence appears in exactly one chunk.
    joined = " ".join(chunks)
    for s in sentences:
        assert s in joined


def test_cjk_punctuation_is_a_boundary_too():
    text = "これは一文です。" * 30
    chunks = split_text(text, max_length=40)
    assert len(chunks) > 1
    assert all(c.endswith("。") for c in chunks)


def test_empty_text_yields_the_text_itself():
    assert split_text("", max_length=10) == [""]


def test_merge_concatenates_frames():
    merged = merge_wav_files([wav(100), wav(50)])
    assert frames_in(merged) == 150
    with wave.open(io.BytesIO(merged), "rb") as w:
        assert w.getframerate() == 16000
        assert w.getnchannels() == 1


def test_merge_parses_even_a_single_chunk():
    """A lone chunk is re-encoded rather than passed through, so what comes back
    is known to be audio: an engine that answers 200 with a proxy's HTML error
    page must not reach the client as an unplayable "WAV"."""
    one = wav(10)
    merged = merge_wav_files([one])
    assert frames_in(merged) == 10


def test_merge_refuses_something_that_is_not_audio():
    import wave as wave_module

    with pytest.raises((wave_module.Error, EOFError)):
        merge_wav_files([b"<html>502 Bad Gateway</html>"])


def test_merge_does_not_warn_when_only_the_lengths_differ(caplog):
    """The guard compares channels, width and rate — not the frame count,
    which differs on every merge and made the original warn each time."""
    with caplog.at_level("WARNING", logger="kurisuassistant.speech.text"):
        merge_wav_files([wav(100), wav(50)])
    assert not caplog.records


def test_merge_warns_on_a_rate_mismatch(caplog):
    with caplog.at_level("WARNING", logger="kurisuassistant.speech.text"):
        merge_wav_files([wav(100, rate=16000), wav(50, rate=24000)])
    assert any("mismatch" in r.getMessage() for r in caplog.records)
