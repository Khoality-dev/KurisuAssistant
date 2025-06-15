# Kurisu Assistant

An intelligent AI assistant that helps with everything from simple daily tasks to complex workflows using state-of-the-art speech and language models.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Features](#features)
4. [Installation](#installation)

   * [Python Client](#python-client)
   * [Backend](#backend)
5. [Usage](#usage)
6. [Configuration](#configuration)
7. [Contributing](#contributing)
8. [License](#license)
9. [Acknowledgments](#acknowledgments)

---

## Overview

Kuri Assistant combines:

* **Speech-to-Text** powered by OpenAI Whisper for high-accuracy transcription
* **Text-to-Speech** via GPT-SoVITS for natural voice output
* **Large Language Model** (Gemma3-12B) to drive intelligent, context-aware conversations

This fusion enables seamless voice interactions and automated task execution across diverse domains.

---

## Architecture

The repository is organized into two parts:

1. **Backend** (`backend/`)

   * Hosts Whisper for STT, Gemma3-12B for dialogue, and GPT-SoVITS for TTS
   * Exposes a WebSocket API for real-time interaction
2. **Clients** (`clients/`)

   * `python/` – command‑line client
   * `android/` – Android application

---

## Features

* 🎤 **Real-time transcription** of spoken input
* 🤖 **Contextual dialogue** powered by a 12-billion-parameter LLM
* 🔊 **High-quality speech synthesis** for responses
* 🔌 **Tool-calling interface** for basic home automation tasks

---

## Installation

### Python Client

```bash
python -m venv venv
source venv/bin/activate      # On Windows: venv\Scripts\activate
pip install -r clients/python/requirements.txt
cp clients/python/.env_template .env   # Create configuration
python clients/python/main.py         # Launch the client UI/CLI
```

### Backend

```bash
docker-compose up -d          # Start STT, LLM, and TTS services in containers
```

Ensure you have Docker Engine and Docker Compose installed.

---

## Usage

1. **Start the backend** (`docker-compose up -d`).
2. **Run the client** (`python clients/python/main.py`).
3. **Speak** into your microphone and watch KurisuAssistant transcribe and respond.
4. **Edit** `.env` if the WebSocket endpoint or token differ from the defaults.

---

## Configuration

Configure your environment by editing the `.env` file:

* **WS_API_URL** – WebSocket endpoint of the backend service
* **AUTHENTICATION_TOKEN** – Token used when connecting (optional)

LLM and TTS URLs for the backend can be adjusted in `docker-compose.yml`.

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for:

* Code style and linting rules
* Branching and pull-request guidelines
* How to run tests and CI pipelines

---

## License

This project is licensed under the **MIT License**. See the [LICENSE](LICENSE) file for details.

---

## Acknowledgments

* Inspired by **Make a README** template
* Guided by GitHub’s community health files and best practices
* Thanks to the maintainers of Whisper, Gemma3, and GPT-SoVITS for open-sourcing their models.
