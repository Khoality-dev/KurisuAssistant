"""Settings come from UVOICE_* and, for the ASR ones, still from the UASR_* names
the service had before it fronted synthesis too."""

import importlib


def _reload(monkeypatch, **env):
    for name in list(env):
        monkeypatch.setenv(name, env[name])
    import universal_voice.config as config

    return importlib.reload(config)


def test_explicit_device_is_taken_as_is(monkeypatch):
    config = _reload(monkeypatch, UVOICE_DEVICE="cpu", UVOICE_COMPUTE_TYPE="int8")
    assert config.DEVICE == "cpu"
    assert config.COMPUTE_TYPE == "int8"


def test_legacy_uasr_names_still_apply(monkeypatch):
    monkeypatch.delenv("UVOICE_DEFAULT_MODEL", raising=False)
    config = _reload(monkeypatch, UASR_DEFAULT_MODEL="medium")
    assert config.DEFAULT_MODEL == "medium"


def test_uvoice_name_wins_over_legacy(monkeypatch):
    config = _reload(monkeypatch, UVOICE_DEFAULT_MODEL="small", UASR_DEFAULT_MODEL="medium")
    assert config.DEFAULT_MODEL == "small"


def test_models_dir_is_under_the_data_dir(monkeypatch, tmp_path):
    config = _reload(monkeypatch, UVOICE_DATA_DIR=str(tmp_path))
    assert config.MODELS_DIR == str(tmp_path / "models")


def test_tts_default_model(monkeypatch):
    config = _reload(monkeypatch, UVOICE_TTS_DEFAULT_MODEL="gpt-sovits")
    assert config.TTS_DEFAULT_MODEL == "gpt-sovits"
