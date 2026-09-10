package com.kurisu.assistant.domain.tts

/**
 * The TTS model to ask the server for, from the stored Speech setting.
 *
 * Null when nothing is chosen, so the request names no `provider` and the
 * server's default TTS model answers. The client used to fill the gap with
 * `gpt-sovits`, a backend that needs a reference clip and is not normally
 * running, so a fresh install could not speak at all (#200).
 */
fun resolveTtsBackend(stored: String?): String? = stored?.trim()?.ifBlank { null }
