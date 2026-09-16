"""Configuration — all settings from environment variables."""

import os


def _auto_device() -> str:
    # torch is imported here and not at module level: this module is imported
    # by every router, and the unit tests run on machines without it.
    import torch

    return "cuda" if torch.cuda.is_available() else "cpu"


def _auto_compute_type(device: str) -> str:
    return "float16" if device == "cuda" else "int8"


# --- Server ---
HOST: str = os.environ.get("UVOICE_HOST", os.environ.get("UASR_HOST", "0.0.0.0"))
PORT: int = int(os.environ.get("UVOICE_PORT", os.environ.get("UASR_PORT", "14213")))

# --- ASR ---
_device_env = os.environ.get("UVOICE_DEVICE", os.environ.get("UASR_DEVICE", "auto"))
DEVICE: str = _auto_device() if _device_env == "auto" else _device_env

_compute_env = os.environ.get("UVOICE_COMPUTE_TYPE", os.environ.get("UASR_COMPUTE_TYPE", "auto"))
COMPUTE_TYPE: str = _auto_compute_type(DEVICE) if _compute_env == "auto" else _compute_env

DEFAULT_MODEL: str = os.environ.get("UVOICE_DEFAULT_MODEL", os.environ.get("UASR_DEFAULT_MODEL", "base"))
DATA_DIR: str = os.environ.get("UVOICE_DATA_DIR", os.environ.get("UASR_DATA_DIR", os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")))
MODELS_DIR: str = os.path.join(DATA_DIR, "models")

# --- TTS ---
TTS_DEFAULT_MODEL: str = os.environ.get("UVOICE_TTS_DEFAULT_MODEL", "vixtts")
TTS_MODE: str = os.environ.get("UVOICE_TTS_MODE", "turbo")  # VieNeu engine mode

# TTS backend URLs (remote containers)
GPTSOVITS_URL: str = os.environ.get("UVOICE_GPTSOVITS_URL", "http://gpt-sovits-container:9880")
VIXTTS_URL: str = os.environ.get("UVOICE_VIXTTS_URL", "http://vixtts-container:19770")

# Shared temp dir for GPT-SoVITS ref audio (must be mounted in both containers)
GPTSOVITS_REF_AUDIO_DIR: str = os.environ.get("UVOICE_GPTSOVITS_REF_AUDIO_DIR", "/shared-ref-audio")
GPTSOVITS_REF_AUDIO_PREFIX: str = os.environ.get("UVOICE_GPTSOVITS_REF_AUDIO_PREFIX", "/shared-ref-audio")
