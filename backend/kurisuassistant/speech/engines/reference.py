"""The reference clip a synthesis clones, as each engine wants it.

One file in ``data/voice_storage/``, chosen by a persona's ``voice_reference``.
viXTTS takes the bytes as an upload; GPT-SoVITS takes a path it opens itself.
Both come from this one object so the router does not have to know which.
"""

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class VoiceReference:
    path: Path
    #: What the clip says, where it is known. GPT-SoVITS uses it as the prompt
    #: text; nothing records one today, so it is normally empty.
    transcript: str | None = None

    @property
    def filename(self) -> str:
        return self.path.name

    def read(self) -> bytes:
        return self.path.read_bytes()

    def engine_path(self, directory: str) -> str:
        """Where an engine that mounts ``data/voice_storage/`` sees this clip."""
        return f"{directory.rstrip('/')}/{self.path.name}"
