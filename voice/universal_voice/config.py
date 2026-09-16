"""Configuration — every setting, read from the environment once at import."""

import os


def _auto_device() -> str:
    # torch is imported here and not at module level: this module is imported
    # by every router, and the unit tests run on machines without it.
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


def _auto_compute_type(device: str) -> str:
    return "float16" if device == "cuda" else "int8"


def _env(name: str, default: str, legacy: str | None = None) -> str:
    """UVOICE_<name>, falling back to the UASR_<name> the ASR settings had before
    the service fronted synthesis too, so an older environment file still works."""
    if legacy is not None and name not in os.environ:
        return os.environ.get(legacy, default)
    return os.environ.get(name, default)


# --- Server ---
HOST: str = _env("UVOICE_HOST", "0.0.0.0", "UASR_HOST")
PORT: int = int(_env("UVOICE_PORT", "14213", "UASR_PORT"))

# --- Device, shared by recognition and synthesis ---
_device_env = _env("UVOICE_DEVICE", "auto", "UASR_DEVICE")
DEVICE: str = _auto_device() if _device_env == "auto" else _device_env

_compute_env = _env("UVOICE_COMPUTE_TYPE", "auto", "UASR_COMPUTE_TYPE")
COMPUTE_TYPE: str = _auto_compute_type(DEVICE) if _compute_env == "auto" else _compute_env

# --- ASR ---
DEFAULT_MODEL: str = _env("UVOICE_DEFAULT_MODEL", "base", "UASR_DEFAULT_MODEL")
DATA_DIR: str = _env(
    "UVOICE_DATA_DIR",
    os.path.join(os.path.dirname(os.path.dirname(__file__)), "data"),
    "UASR_DATA_DIR",
)
# The Whisper cache. Only directories holding a CTranslate2 model.bin live here;
# the synthesis weights are under TTS_MODELS_DIR so the ASR model list never
# shows them.
MODELS_DIR: str = os.path.join(DATA_DIR, "models")

# --- TTS ---
TTS_DEFAULT_MODEL: str = os.environ.get("UVOICE_TTS_DEFAULT_MODEL", "vixtts")
TTS_MODE: str = os.environ.get("UVOICE_TTS_MODE", "turbo")  # VieNeu engine mode
# Which synthesis models load at startup rather than on their first request.
# The rest load lazily; every model runs in this process (#203).
TTS_PRELOAD: list[str] = [
    m.strip() for m in os.environ.get("UVOICE_TTS_PRELOAD", TTS_DEFAULT_MODEL).split(",") if m.strip()
]
TTS_MODELS_DIR: str = os.path.join(DATA_DIR, "tts")

# viXTTS: XTTS-v2 fine-tuned for Vietnamese. The speaker presets come from the
# base model's speakers file, which the fine-tune does not ship.
VIXTTS_MODEL_ID: str = os.environ.get("UVOICE_VIXTTS_MODEL_ID", "capleaf/viXTTS")
VIXTTS_BASE_MODEL_ID: str = os.environ.get("UVOICE_VIXTTS_BASE_MODEL_ID", "coqui/XTTS-v2")
VIXTTS_SPEAKER_CACHE_SIZE: int = int(os.environ.get("UVOICE_VIXTTS_SPEAKER_CACHE_SIZE", "8"))

# GPT-SoVITS v2. The pretrained weights come from the Hugging Face repository;
# a fine-tuned pair can be pointed at instead (paths inside the container —
# put them under the data volume).
GPTSOVITS_PRETRAINED_REPO: str = os.environ.get("UVOICE_GPTSOVITS_PRETRAINED_REPO", "lj1995/GPT-SoVITS")
GPTSOVITS_GPT_WEIGHTS: str = os.environ.get("UVOICE_GPTSOVITS_GPT_WEIGHTS", "")
GPTSOVITS_SOVITS_WEIGHTS: str = os.environ.get("UVOICE_GPTSOVITS_SOVITS_WEIGHTS", "")
GPTSOVITS_DEFAULT_LANGUAGE: str = os.environ.get("UVOICE_GPTSOVITS_DEFAULT_LANGUAGE", "ja")
