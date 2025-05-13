# Kuri Assistant
&#x20;

An intelligent AI assistant that helps with everything from simple daily tasks to complex workflows using state-of-the-art speech and language models.

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Features](#features)
4. [Installation](#installation)

   * [Client](#client)
   * [Server](#server)
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

The system is composed of two main components:

1. **Client**

   * Captures audio, streams to the server, and plays back TTS responses
2. **Server**

   * Hosts Whisper for STT, Gemma3-12B for dialogue, and GPT-SoVITS for TTS
   * Exposes a JSON REST API for easy integration

---

## Features

* 🎤 **Real-time transcription** of spoken input
* 🤖 **Contextual dialogue** powered by a 12-billion-parameter LLM
* 🔊 **High-quality speech synthesis** for responses
* ⚙️ **Extensible plugin system** for custom skills and integrations

---

## Installation

### Client

```bash
python -m venv venv
source venv/bin/activate      # On Windows: venv\Scripts\activate
pip install -r requirements.txt
python main.py                # Launch the client UI/CLI
```

### Server

```bash
docker-compose up -d          # Start STT, LLM, and TTS services in containers
```

Ensure you have Docker Engine and Docker Compose installed.

---

## Usage

1. **Start the server** (`docker-compose up -d`).
2. **Run the client** (`python main.py`).
3. **Speak** into your microphone and watch KurisuAssistant transcribe and respond.
4. **Customize** your settings in the `.env` file to point to your own Whisper or LLM endpoints. to point to your own Whisper or LLM endpoints.

---

## Configuration

Configure your environment by editing the `.env` file:

* **STT\_API\_URL**: URL for the Whisper speech-to-text service (Not yet implemented in this version)
* **LLM\_API\_URL**: URL for the Gemma3-12B large language model service
* **TTS\_API\_URL**: URL for the GPT-SoVITS text-to-speech service

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
