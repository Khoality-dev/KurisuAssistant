"""viXTTS, as the owner's server speaks it.

``POST /tts/file``: a multipart form with the text and, optionally, the
reference clip uploaded with it — so this engine needs no shared filesystem.
The language table lives in the engine, which refuses an unsupported one with a
400; that refusal reaches the user as its own sentence, so it is not duplicated
here.
"""

from .base import Engine
from .reference import VoiceReference


class ViXTTS(Engine):
    model_id = "vixtts"
    kind = "tts"

    async def synthesize(
        self,
        text: str,
        *,
        reference: VoiceReference | None = None,
        voice_id: str | None = None,
        language: str | None = None,
        timeout: float = 120,
    ) -> bytes:
        """One chunk of ``text`` as WAV bytes.

        With no reference clip the engine uses ``voice_id`` — one of the
        built-in XTTS speakers — and with neither, its configured default.
        """
        data: dict[str, str] = {"text": text}
        if language:
            data["language"] = language
        if voice_id:
            data["speaker_id"] = voice_id
        files = {"spk_audio": (reference.filename, reference.read())} if reference else None
        response = await self.call(
            "POST", "/tts/file", context="TTS synthesis", data=data, files=files, timeout=timeout,
        )
        return response.content

    def voices(self) -> list[dict]:
        """The built-in speakers are not listed over the wire by this server, and
        a persona's voice is a clip in ``data/voice_storage/`` either way."""
        return []
