"""INDEX-TTS provider implementation."""

import os
import io
import re
import wave
import logging
from pathlib import Path
from typing import Optional, List

import requests

from .base import BaseTTSProvider

logger = logging.getLogger(__name__)


class IndexTTSProvider(BaseTTSProvider):
    """INDEX-TTS provider for emotionally expressive zero-shot TTS."""

    def __init__(self, api_url: Optional[str] = None):
        """Initialize INDEX-TTS provider.

        Args:
            api_url: API endpoint URL (defaults to env var INDEX_TTS_API_URL)
        """
        self.api_url = api_url or os.getenv(
            "INDEX_TTS_API_URL",
            "http://10.0.0.122:19770"
        )
        logger.info(f"INDEX-TTS provider initialized with URL: {self.api_url}")

    def _find_voice_file(self, voice_name: str) -> str:
        """Find the full path to a voice file by its stem name.

        Args:
            voice_name: Voice name without extension (e.g., "ayaka_ref")

        Returns:
            Full absolute path to the voice file (normalized for local filesystem access)

        Raises:
            FileNotFoundError: If voice file not found
        """
        reference_dir = Path("data") / "voice_storage"
        audio_extensions = {'.wav', '.mp3', '.flac', '.ogg'}

        # Try to find the file with any supported extension
        for ext in audio_extensions:
            voice_path = reference_dir / f"{voice_name}{ext}"
            if voice_path.exists():
                # Return absolute path for file opening
                # Path object handles OS-specific separators automatically
                return str(voice_path.absolute())

        raise FileNotFoundError(
            f"Voice file not found: {voice_name} "
            f"(searched in {reference_dir.absolute()} with extensions {audio_extensions})"
        )

    def _split_text(self, text: str, max_length: int = 200) -> List[str]:
        """Split text into smaller chunks to prevent OOM during inference.

        Args:
            text: Text to split
            max_length: Maximum length per chunk (characters)

        Returns:
            List of text chunks
        """
        # Split by paragraphs first (double newline)
        paragraphs = text.split('\n\n')
        chunks = []

        for para in paragraphs:
            para = para.strip()
            if not para:
                continue

            # If paragraph is short enough, use it as-is
            if len(para) <= max_length:
                chunks.append(para)
                continue

            # Split long paragraphs by sentences
            sentences = re.split(r'([。.!?！？\n])', para)
            current_chunk = ""

            for i in range(0, len(sentences), 2):
                sentence = sentences[i]
                delimiter = sentences[i + 1] if i + 1 < len(sentences) else ""
                segment = sentence + delimiter

                # If adding this sentence exceeds limit, save current chunk
                if current_chunk and len(current_chunk) + len(segment) > max_length:
                    chunks.append(current_chunk.strip())
                    current_chunk = segment
                else:
                    current_chunk += segment

            # Add remaining text
            if current_chunk.strip():
                chunks.append(current_chunk.strip())

        return chunks if chunks else [text]

    def _merge_wav_files(self, wav_chunks: List[bytes]) -> bytes:
        """Merge multiple WAV audio chunks into a single WAV file.

        Args:
            wav_chunks: List of WAV file data as bytes

        Returns:
            Merged WAV file as bytes
        """
        if not wav_chunks:
            raise ValueError("No audio chunks to merge")

        if len(wav_chunks) == 1:
            return wav_chunks[0]

        # Read first WAV to get parameters
        first_wav = io.BytesIO(wav_chunks[0])
        with wave.open(first_wav, 'rb') as wav:
            params = wav.getparams()
            audio_data = [wav.readframes(wav.getnframes())]

        # Read remaining WAVs (skip headers, extract audio data only)
        for chunk in wav_chunks[1:]:
            chunk_wav = io.BytesIO(chunk)
            with wave.open(chunk_wav, 'rb') as wav:
                # Verify same format
                if wav.getparams()[:4] != params[:4]:
                    logger.warning("WAV format mismatch, attempting to merge anyway")
                audio_data.append(wav.readframes(wav.getnframes()))

        # Create merged WAV
        merged = io.BytesIO()
        with wave.open(merged, 'wb') as wav:
            wav.setparams(params)
            wav.writeframes(b''.join(audio_data))

        return merged.getvalue()

    def synthesize(
        self,
        text: str,
        voice: Optional[str] = None,
        language: Optional[str] = None,
        **kwargs
    ) -> bytes:
        """Synthesize speech using INDEX-TTS.

        Automatically splits long text into chunks to prevent OOM during inference,
        then merges the audio chunks into a single WAV file.

        Args:
            text: Text to synthesize
            voice: Voice name without extension (e.g., "ayaka_ref")
            language: Language code (not used by INDEX-TTS, kept for interface compatibility)
            **kwargs: Additional parameters:
                - emo_audio: Voice name for emotion reference audio file
                - emo_vector: Emotion vector [happy, angry, sad, afraid, disgusted, melancholic, surprised, calm]
                - emo_text: Text description for emotion control
                - use_emo_text: Use emotion from text (default: False)
                - emo_alpha: Emotion strength 0.0-1.0 (default: 1.0)
                - use_random: Enable random sampling (default: False)
                - max_chunk_length: Max characters per chunk (default: 200)

        Returns:
            Audio data as bytes (WAV format)

        Raises:
            RuntimeError: If synthesis fails
        """
        # Find speaker reference audio file by voice name
        # Frontend MUST send only voice names (not paths) from /tts/voices endpoint
        voice_name = voice or "ayaka_ref"
        spk_audio_path = self._find_voice_file(voice_name).replace("\\", "/")

        # Find emotion reference audio (optional)
        emo_audio_path = None
        emo_audio_name = kwargs.get('emo_audio')
        if emo_audio_name:
            try:
                emo_audio_path = self._find_voice_file(emo_audio_name)
            except FileNotFoundError as e:
                logger.warning(f"Emotion reference audio not found: {e}")

        max_chunk_length = kwargs.get("max_chunk_length", 200)

        # Split text into chunks
        text_chunks = self._split_text(text, max_length=max_chunk_length)
        logger.info(f"Split text into {len(text_chunks)} chunks for synthesis")

        # Synthesize each chunk
        audio_chunks = []
        for i, chunk in enumerate(text_chunks):
            logger.debug(f"Synthesizing chunk {i+1}/{len(text_chunks)}: {chunk[:50]}...")

            # Prepare form data for this chunk
            data = {
                'text': chunk,
                'emo_alpha': kwargs.get('emo_alpha', 1.0),
                'use_emo_text': kwargs.get('use_emo_text', False),
                'use_random': kwargs.get('use_random', False),
            }

            # Add optional emotion text if provided
            if 'emo_text' in kwargs:
                data['emo_text'] = kwargs['emo_text']

            # Prepare files for this chunk
            files = {}
            try:
                # Speaker audio (required)
                files['spk_audio'] = open(spk_audio_path, 'rb')

                # Emotion reference audio (optional)
                if emo_audio_path:
                    files['emo_audio'] = open(emo_audio_path, 'rb')

                # Make TTS request using /tts/file endpoint
                endpoint = f"{self.api_url}/tts/file"

                response = requests.post(
                    endpoint,
                    files=files,
                    data=data,
                    timeout=120  # INDEX-TTS can take longer for complex synthesis
                )
                response.raise_for_status()
                audio_chunks.append(response.content)

            except requests.exceptions.RequestException as e:
                logger.error(f"INDEX-TTS API request failed for chunk {i+1}: {e}", exc_info=True)
                raise RuntimeError(f"TTS synthesis failed for chunk {i+1}: {e}") from e
            finally:
                # Close all opened files for this chunk
                for file in files.values():
                    if hasattr(file, 'close'):
                        file.close()

        # Merge all audio chunks into single WAV
        try:
            merged_audio = self._merge_wav_files(audio_chunks)
            logger.info(f"Successfully merged {len(audio_chunks)} audio chunks")
            return merged_audio
        except Exception as e:
            logger.error(f"Failed to merge audio chunks: {e}", exc_info=True)
            raise RuntimeError(f"Audio merging failed: {e}") from e

    def list_voices(self) -> list[str]:
        """List available voices by scanning the reference directory.

        Note: INDEX-TTS uses reference audio files for zero-shot voice cloning.
        This scans the reference folder and returns all audio file names.

        Returns:
            List of voice names (audio filenames without extension)
        """
        reference_dir = Path("data") / "voice_storage"

        if not reference_dir.exists():
            logger.warning(f"Reference directory not found: {reference_dir}")
            return []

        voices = []
        audio_extensions = {'.wav', '.mp3', '.flac', '.ogg'}

        try:
            for file in reference_dir.iterdir():
                if file.is_file() and file.suffix.lower() in audio_extensions:
                    # Return filename without extension
                    voices.append(file.stem)

            return sorted(voices)
        except Exception as e:
            logger.error(f"Error listing voices from reference directory: {e}", exc_info=True)
            return []
