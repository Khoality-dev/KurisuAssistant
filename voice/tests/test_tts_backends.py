"""The in-process synthesis backends (#203), everything short of loading weights:
language handling, the Vietnamese tokenizer patch, the reference-clip cache, and
that importing them loads nothing."""

import sys
import types

import pytest


# --- registry --------------------------------------------------------------

def test_registry_names_the_three_backends_and_loads_none_of_them():
    from universal_voice.tts.registry import TTSRegistry

    registry = TTSRegistry()
    listed = {m["id"]: m["loaded"] for m in registry.list_models()}
    assert set(listed) == {"vixtts", "gpt-sovits", "vieneu:turbo"}
    assert all(loaded is False for loaded in listed.values())


def test_heavy_libraries_are_not_imported_by_the_package():
    import universal_voice.tts.gpt_sovits_model  # noqa: F401
    import universal_voice.tts.vixtts_model  # noqa: F401

    for name in ("TTS", "torch", "TTS_infer_pack", "vieneu", "faster_whisper"):
        assert name not in sys.modules, f"{name} was imported at module level"


# --- viXTTS ----------------------------------------------------------------

def test_vixtts_language_normalisation():
    from universal_voice.tts.vixtts_model import normalize_language

    assert normalize_language(None) == "vi"
    assert normalize_language("VI") == "vi"
    assert normalize_language(" en ") == "en"
    assert normalize_language("zh-cn") == "zh"
    assert normalize_language("jp") == "ja"
    with pytest.raises(ValueError, match="does not support language 'xx'"):
        normalize_language("xx")


def test_vietnamese_cleaner_is_lowercase_and_single_spaced():
    from universal_voice.tts.vixtts_model import vietnamese_cleaner

    assert vietnamese_cleaner("Xin  Chào\n\tThế giới") == "xin chào thế giới"


def test_tokenizer_patch_adds_vietnamese_and_nothing_else(monkeypatch):
    """Stand in for coqui-tts's tokenizer module: the patch must add `vi` to the
    limits, route `vi` to the Vietnamese cleaner, leave other languages to the
    original, and apply once."""
    from universal_voice.tts import vixtts_model

    calls = []

    class VoiceBpeTokenizer:
        def __init__(self, vocab_file=None):
            self.char_limits = {"en": 250, "ja": 71}

        def preprocess_text(self, txt, lang):
            calls.append(lang)
            if lang == "en":
                return txt.upper()
            raise NotImplementedError(lang)

    fake = types.ModuleType("TTS.tts.layers.xtts.tokenizer")
    fake.VoiceBpeTokenizer = VoiceBpeTokenizer
    for name in ("TTS", "TTS.tts", "TTS.tts.layers", "TTS.tts.layers.xtts"):
        monkeypatch.setitem(sys.modules, name, types.ModuleType(name))
    monkeypatch.setitem(sys.modules, "TTS.tts.layers.xtts.tokenizer", fake)
    sys.modules["TTS.tts.layers.xtts"].tokenizer = fake

    vixtts_model._teach_tokenizer_vietnamese()
    vixtts_model._teach_tokenizer_vietnamese()  # idempotent
    tok = VoiceBpeTokenizer()
    assert tok.char_limits["vi"] == 250
    assert tok.char_limits["ja"] == 71
    assert tok.preprocess_text("Xin  chào", "vi") == "xin chào"
    assert tok.preprocess_text("hello", "en") == "HELLO"
    assert calls == ["en"], "only the non-Vietnamese call reached the original"
    with pytest.raises(NotImplementedError):
        tok.preprocess_text("x", "xx")


def test_vixtts_wav_bytes_are_16_bit_mono_at_the_given_rate():
    import io
    import wave

    import numpy as np

    from universal_voice.tts.vixtts_model import _wav_bytes

    data = _wav_bytes(np.zeros(2400, dtype=np.float32), 24000)
    with wave.open(io.BytesIO(data), "rb") as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()) == (1, 2, 24000, 2400)


# --- GPT-SoVITS -------------------------------------------------------------

def test_gpt_sovits_language_normalisation():
    from universal_voice.tts.gpt_sovits_model import normalize_language

    assert normalize_language(None) == "ja"  # the configured default
    assert normalize_language("jp") == "ja"
    assert normalize_language("EN-US") == "en"
    assert normalize_language("all_ja") == "all_ja"
    with pytest.raises(ValueError, match="does not support language 'vi'"):
        normalize_language("vi")


def test_gpt_sovits_needs_a_reference_clip():
    from universal_voice.tts.gpt_sovits_model import GPTSoVITSModel

    with pytest.raises(RuntimeError, match="requires a voice reference"):
        GPTSoVITSModel().synthesize("こんにちは")


def test_reference_clips_get_one_path_per_content_and_the_oldest_is_evicted(monkeypatch, tmp_path):
    from universal_voice.tts import gpt_sovits_model

    monkeypatch.setattr(gpt_sovits_model.tempfile, "gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr(gpt_sovits_model, "REF_CACHE_SIZE", 2)
    model = gpt_sovits_model.GPTSoVITSModel()

    first = model._ref_path(b"clip-one", "kurisu.wav")
    again = model._ref_path(b"clip-one", "other-name.wav")
    assert first == again, "same bytes, same path — that is what lets upstream reuse its encoded prompt"
    assert first.suffix == ".wav" and first.read_bytes() == b"clip-one"

    second = model._ref_path(b"clip-two", "ref.mp3")
    assert second.suffix == ".mp3"
    third = model._ref_path(b"clip-three", None)
    assert third.suffix == ".wav"
    assert not first.exists(), "the least recently used clip is deleted"
    assert second.exists() and third.exists()


def test_vendor_helper_puts_both_roots_first_on_sys_path(monkeypatch):
    from universal_voice.tts import vendor

    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.delenv("bert_path", raising=False)
    monkeypatch.delenv("g2pw_model_dir", raising=False)
    vendor.ensure_gpt_sovits_importable(bert_path="/w/bert", g2pw_model_dir="/w/G2PWModel")
    assert sys.path[0] == str(vendor.VENDOR_ROOT)
    assert sys.path[1] == str(vendor.GPT_SOVITS_ROOT)
    import os

    assert os.environ["bert_path"] == "/w/bert"
    assert os.environ["g2pw_model_dir"] == "/w/G2PWModel"
    assert (vendor.VENDOR_ROOT / "PATCHES.md").exists()


# --- config ----------------------------------------------------------------

def test_tts_preload_defaults_to_the_default_model_and_parses_a_list(monkeypatch):
    import importlib

    import universal_voice.config as config

    monkeypatch.setenv("UVOICE_TTS_DEFAULT_MODEL", "gpt-sovits")
    monkeypatch.delenv("UVOICE_TTS_PRELOAD", raising=False)
    config = importlib.reload(config)
    assert config.TTS_PRELOAD == ["gpt-sovits"]

    monkeypatch.setenv("UVOICE_TTS_PRELOAD", " vixtts, vieneu:turbo ,")
    config = importlib.reload(config)
    assert config.TTS_PRELOAD == ["vixtts", "vieneu:turbo"]
    assert config.TTS_MODELS_DIR.endswith("/tts")
