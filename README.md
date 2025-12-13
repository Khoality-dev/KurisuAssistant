# Kurisu Assistant

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
  * Exposes a REST API for chat, ASR, and TTS

---

## Features

* 🎤 **Real-time transcription** of spoken input
* 🤖 **Contextual dialogue** powered by a 12-billion-parameter LLM
* 🔊 **High-quality speech synthesis** for responses
* 🔌 **Tool-calling interface** for basic home automation tasks

---

## Installation

### Client

```bash
python -m venv venv
source venv/bin/activate      # On Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env_template .env         # Create configuration
python main.py                # Launch the client UI/CLI
```

The Android app located in `clients/KurisuAssistant` also uses this REST API.
When you run it for the first time it opens a **Getting Started** page where
you supply the LLM and optional TTS hub URLs. The app checks the URLs and then
lets you register an admin account. If the account already exists the request
succeeds silently, so you can simply log in with the default credentials.
Afterwards subsequent launches go straight to a login screen. A "Remember me"
checkbox lets your token persist so you don't have to log in again. The settings
screen fetches the available models from the LLM hub's `/models` endpoint so you
can choose which one to use and edit the hub URLs.

### Server

```bash
docker-compose up -d          # Start STT, LLM, and TTS services in containers
```

Ensure you have Docker Engine and Docker Compose installed.
The `llm-hub-container` automatically connects to the bundled PostgreSQL
service using the hostname `postgres`. Override `DATABASE_URL` if you need a
different connection string.

**Database Migrations**: The llm-hub container automatically runs database
migrations on startup via `migrate.py`. For local development without Docker:

```bash
python migrate.py             # Run migrations manually
```

The database is seeded with a default **admin/admin** account during the
first migration.

---

## Usage

1. **Start the server** (`docker-compose up -d`).
2. **Run the client** (`python main.py`).
3. **Speak** into your microphone and watch KurisuAssistant transcribe and respond.
4. **Edit** `.env` if the API URL differs from the default.

---

## Configuration

Configure your environment by editing the `.env` file:

* **LLM_HUB_URL** – URL of the LLM hub REST service
* **TTS_HUB_URL** – URL of the TTS hub REST service
* **DATABASE_URL** – Connection string for the PostgreSQL database
* **JWT_SECRET_KEY** – Secret key used to sign authentication tokens

LLM and TTS URLs for the core can be adjusted in `docker-compose.yml`.

### Database schema

The database uses **Alembic** for migrations. Schema is managed via migration
files in `db/alembic/versions/`. The main tables are:

* **users** – User accounts with authentication and preferences
* **conversations** – Conversation metadata (title, timestamps)
* **messages** – Individual messages linked to conversations

Migrations are run automatically in Docker or manually via `python migrate.py`.

The `/models` endpoint returns the list of available LLMs for client selection.
New accounts can be created by sending credentials to the `/register` endpoint.
The `/conversations` endpoint provides access to conversation history.

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
