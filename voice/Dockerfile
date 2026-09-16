FROM pytorch/pytorch:2.7.0-cuda12.8-cudnn9-runtime

WORKDIR /app

# ffmpeg: audio decoding (GPT-SoVITS loads reference clips through it, PyAV
# decodes uploads). espeak-ng: VieNeu. build-essential/cmake: the C extensions
# without wheels (jieba_fast, pyopenjtalk's fallbacks). curl: the Rust toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 espeak-ng libespeak-ng1 \
    build-essential cmake curl \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain for sea-g2p (a VieNeu dependency with no wheel).
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

COPY requirements.txt .
# Unset conda's CC/CXX overrides that point to nonexistent compiler_compat
RUN unset CC CXX && pip install --no-cache-dir -r requirements.txt

# The vendored GPT-SoVITS inference code, its large data files, and everything
# its text frontends would otherwise fetch or compile on first use — into the
# image, so a fresh container speaks without reaching out (see
# vendor/gpt_sovits/PATCHES.md). Before the package, so a code change does not
# redo it.
COPY vendor/ vendor/
COPY scripts/ scripts/
RUN python scripts/fetch_gpt_sovits_assets.py && python scripts/prewarm.py

COPY universal_voice/ universal_voice/

# The model cache: Whisper models under models/, synthesis weights under tts/.
# A volume in the stack; downloaded on first use.
RUN mkdir -p /app/data/models /app/data/tts

EXPOSE 14213

CMD ["python", "-m", "universal_voice.main"]
