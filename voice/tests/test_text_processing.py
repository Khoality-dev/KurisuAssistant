"""split_text and merge_wav_files: the chunking every synthesis backend goes through."""

import io
import wave

import numpy as np

from universal_voice.tts.text_processing import merge_wav_files, split_text


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


def _wav(samples: np.ndarray, rate: int = 16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.astype(np.int16).tobytes())
    return buf.getvalue()


def test_merge_concatenates_frames():
    a = _wav(np.arange(100))
    b = _wav(np.arange(50))
    merged = merge_wav_files([a, b])
    with wave.open(io.BytesIO(merged), "rb") as w:
        assert w.getnframes() == 150
        assert w.getframerate() == 16000
        assert w.getnchannels() == 1


def test_merge_single_chunk_is_identity():
    a = _wav(np.arange(10))
    assert merge_wav_files([a]) == a
