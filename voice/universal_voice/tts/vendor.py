"""The vendored GPT-SoVITS inference code (``voice/vendor/gpt_sovits``).

Upstream is a script tree, not a package: its modules import each other by
top-level name (``from AR.models ...``, ``from module import commons``,
``from tools.my_utils import load_audio``) and expect both the repository root
and ``GPT_SoVITS/`` on ``sys.path``. This puts them there, once, when the
GPT-SoVITS model first loads — never at import of this package, so the names
it introduces (``text``, ``module``, ``utils``, ``tools``, ``AR`` …) only exist
in a process that actually runs that model. ``PATCHES.md`` beside the vendored
tree lists every line changed from upstream.
"""

import os
import sys
from pathlib import Path

VENDOR_ROOT = Path(__file__).resolve().parents[2] / "vendor" / "gpt_sovits"
GPT_SOVITS_ROOT = VENDOR_ROOT / "GPT_SoVITS"


def ensure_gpt_sovits_importable(bert_path: str, g2pw_model_dir: str) -> None:
    """Make the vendored tree importable and tell its text frontends where the
    weights are.

    ``bert_path`` — the Chinese RoBERTa directory; ``text/chinese2.py`` reads it
    from the ``bert_path`` environment variable for the g2pW pinyin model.
    ``g2pw_model_dir`` — where g2pW's own model is downloaded on first Chinese
    input (``…/G2PWModel``, under the data volume so it survives the container).
    """
    if not GPT_SOVITS_ROOT.is_dir():
        raise RuntimeError(f"vendored GPT-SoVITS not found at {GPT_SOVITS_ROOT}")
    for path in (GPT_SOVITS_ROOT, VENDOR_ROOT):
        entry = str(path)
        if entry not in sys.path:
            sys.path.insert(0, entry)
    os.environ.setdefault("bert_path", bert_path)
    os.environ.setdefault("g2pw_model_dir", g2pw_model_dir)
    os.environ.setdefault("version", "v2")
