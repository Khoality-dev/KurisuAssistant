# GPT-SoVITS, vendored

The inference half of [RVC-Boss/GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS)
at commit `ad7df5298bea51273c86c05b5b13f28ed7d9fe16` ("Colab Infer Fix (#2322)"),
MIT (see `LICENSE`; BigVGAN and AP-BWE carry their own under their directories).
It runs inside the voice service (#203) instead of as the third-party container
the stack used to pull.

Upstream is a script tree, not a package: modules import each other by
top-level name and expect both the repository root and `GPT_SoVITS/` on
`sys.path`. `universal_voice/tts/vendor.py` puts them there when the model first
loads. Nothing here is imported by the service at startup.

## What was taken

Only what `GPT_SoVITS/TTS_infer_pack/TTS.py` reaches, transitively:

- `GPT_SoVITS/TTS_infer_pack/`, `AR/models` + `AR/modules` (the non-ONNX files),
  `module/` (the non-ONNX files, no `losses`/`data_utils`), `feature_extractor/`
  (whole; its `__init__` imports both extractors),
  `BigVGAN/` (the PyTorch path only; no CUDA kernels, training, or tests),
  `f5_tts/model/` (`dit` backbone only), `text/` whole, `process_ckpt.py`,
  `utils.py`.
- `tools/i18n` with the English locale only, `tools/my_utils.py`, `tools/audio_sr.py`
  and `tools/AP_BWE_main/` (needed at import; used by v3 super-sampling only).

Not taken: training, dataset preparation, the WebUIs, the ONNX exports, the
API servers, `configs/` (the service builds its config as a dict).

## Files fetched at image build

Upstream data files over about a megabyte are not committed. `scripts/fetch_gpt_sovits_assets.py`
downloads them from the pinned commit and checks their SHA-256:

- `GPT_SoVITS/text/ja_userdic/userdict.csv` (17 MB) — the Japanese user dictionary
- `GPT_SoVITS/text/cmudict.rep`, `cmudict-fast.rep` — the English pronunciation dictionaries
- `GPT_SoVITS/text/g2pw/polyphonic-fix.rep` — Chinese polyphone corrections

`engdict_cache.pickle` and `g2pw/polyphonic.pickle` are caches upstream rebuilds
from those files when absent; `scripts/prewarm.py` triggers that at build. The
Open JTalk dictionary, NLTK data and the fast_langdetect model are fetched at
build the same way. g2pW's own model (Chinese only) is fetched on first Chinese
input, into the data volume.

## Changes from upstream

Every changed line is marked `PATCHED` in place.

1. `GPT_SoVITS/text/chinese2.py` — the g2pW model directory comes from the
   `g2pw_model_dir` environment variable (set by `tts/vendor.py` to a path under
   the data volume) instead of `GPT_SoVITS/text/G2PWModel` relative to the working
   directory.
2. `GPT_SoVITS/TTS_infer_pack/TTS.py` — `TTS_Config` keeps its `tts_infer.yaml`
   under the vendored tree's own `GPT_SoVITS/configs/` (created on demand, and
   ignored by git) instead of `GPT_SoVITS/configs/` under the working directory.
   It is written to: `init_vits_weights` saves the chosen weights there.
3. `tools/i18n/i18n.py` — the locale directory is resolved with `abspath`, not
   `relpath`, so it does not depend on the working directory at import.
4. `tools/my_utils.py` — reduced to `load_audio` and `clean_path`; upstream
   imports gradio and pandas at module level for its training WebUI.

Known limitation: the v3/v4 vocoders in `TTS.py` still load their weights from
paths relative to the working directory (`now_dir`), so only v2 is supported by
`tts/gpt_sovits_model.py`.

## Updating

Check out the new upstream commit, copy the same file list, re-apply the four
patches, update the commit hash and the checksums in
`scripts/fetch_gpt_sovits_assets.py`, and rebuild the image.
