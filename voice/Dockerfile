FROM pytorch/pytorch:2.7.0-cuda12.8-cudnn9-runtime

WORKDIR /app

# System deps: audio processing, espeak-ng for VieNeu, build tools for Rust/C/CMake extensions
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 espeak-ng libespeak-ng1 \
    build-essential cmake curl \
    && rm -rf /var/lib/apt/lists/*

# Rust toolchain for sea-g2p
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

COPY requirements.txt .
# Unset conda's CC/CXX overrides that point to nonexistent compiler_compat
RUN unset CC CXX && pip install --no-cache-dir -r requirements.txt

COPY universal_voice/ universal_voice/

RUN mkdir -p /app/data/models

EXPOSE 14213

CMD ["python", "-m", "universal_voice.main"]
