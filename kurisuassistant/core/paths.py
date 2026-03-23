"""Centralized path constants for the project."""

from pathlib import Path

# Project root: paths.py -> core/ -> kurisuassistant/ -> KurisuAssistant/
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

DATA_DIR = PROJECT_ROOT / "data"
