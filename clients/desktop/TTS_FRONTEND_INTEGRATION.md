# TTS Frontend Integration Guide

This guide explains how to integrate TTS (Text-to-Speech) functionality into the frontend application.

## Backend API

The backend provides two TTS endpoints:

1. `POST /tts` - Synthesize speech from text
2. `GET /tts/voices` - List available voice names (dynamically scans `reference/` folder)

## Frontend Implementation Examples

### React/TypeScript Example

#### 1. Create TTS Service

```typescript
// services/ttsService.ts
import axios from 'axios';

const API_BASE_URL = 'http://localhost:15597';

export class TTSService {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  /**
   * Synthesize speech from text and return audio blob
   *
   * @param text - Text to synthesize
   * @param voice - Voice name from GET /tts/voices (e.g., "ayaka_ref")
   * @param language - Language code (e.g., "ja", "en")
   */
  async synthesize(
    text: string,
    voice?: string,
    language?: string
  ): Promise<Blob> {
    const response = await axios.post(
      `${API_BASE_URL}/tts`,
      {
        text,
        voice,
        language
      },
      {
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json'
        },
        responseType: 'blob'
      }
    );

    return response.data;
  }

  /**
   * List available voices
   */
  async listVoices(): Promise<string[]> {
    const response = await axios.get(`${API_BASE_URL}/tts/voices`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    return response.data.voices;
  }

}
```

#### 2. Create TTS Hook

```typescript
// hooks/useTTS.ts
import { useState, useCallback } from 'react';
import { TTSService } from '../services/ttsService';

export function useTTS(token: string) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentAudio, setCurrentAudio] = useState<HTMLAudioElement | null>(null);
  const [voices, setVoices] = useState<string[]>([]);

  const ttsService = new TTSService(token);

  /**
   * Load available voices
   */
  const loadVoices = useCallback(async () => {
    try {
      const voiceList = await ttsService.listVoices();
      setVoices(voiceList);
    } catch (error) {
      console.error('Failed to load voices:', error);
    }
  }, [ttsService]);

  /**
   * Play text as speech
   */
  const speak = useCallback(
    async (text: string, voice?: string, language?: string) => {
      try {
        // Stop current audio if playing
        if (currentAudio) {
          currentAudio.pause();
          currentAudio.currentTime = 0;
        }

        setIsPlaying(true);

        // Synthesize speech
        const audioBlob = await ttsService.synthesize(text, voice, language);

        // Create audio element
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);

        // Set up event listeners
        audio.onended = () => {
          setIsPlaying(false);
          URL.revokeObjectURL(audioUrl);
        };

        audio.onerror = () => {
          setIsPlaying(false);
          URL.revokeObjectURL(audioUrl);
          console.error('Audio playback error');
        };

        // Play audio
        setCurrentAudio(audio);
        await audio.play();
      } catch (error) {
        setIsPlaying(false);
        console.error('TTS error:', error);
        throw error;
      }
    },
    [ttsService, currentAudio]
  );

  /**
   * Stop current speech
   */
  const stop = useCallback(() => {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio.currentTime = 0;
      setIsPlaying(false);
    }
  }, [currentAudio]);

  return {
    speak,
    stop,
    isPlaying,
    voices,
    loadVoices
  };
}
```

#### 3. Use in Component

```typescript
// components/ChatMessage.tsx
import React, { useEffect } from 'react';
import { useTTS } from '../hooks/useTTS';

interface ChatMessageProps {
  message: string;
  role: 'user' | 'assistant';
  token: string;
}

export function ChatMessage({ message, role, token }: ChatMessageProps) {
  const { speak, stop, isPlaying, voices, loadVoices } = useTTS(token);

  useEffect(() => {
    loadVoices();
  }, [loadVoices]);

  const handleSpeak = async () => {
    if (isPlaying) {
      stop();
    } else {
      try {
        // Use default voice or select from voices list
        const voice = voices[0];
        await speak(message, voice);
      } catch (error) {
        console.error('Failed to speak:', error);
      }
    }
  };

  return (
    <div className={`message ${role}`}>
      <div className="message-content">{message}</div>
      {role === 'assistant' && (
        <button onClick={handleSpeak} className="tts-button">
          {isPlaying ? '⏸️ Stop' : '🔊 Play'}
        </button>
      )}
    </div>
  );
}
```

### Vanilla JavaScript Example

```javascript
// tts.js

class TTSPlayer {
  constructor(apiBaseUrl, token) {
    this.apiBaseUrl = apiBaseUrl;
    this.token = token;
    this.currentAudio = null;
    this.isPlaying = false;
  }

  /**
   * Synthesize speech from text
   * @param {string} text - Text to synthesize
   * @param {string} voice - Voice name (e.g., "ayaka_ref")
   * @param {string} language - Language code (e.g., "ja")
   * @returns {Promise<Blob>} Audio blob
   */
  async synthesize(text, voice = null, language = null) {
    const response = await fetch(`${this.apiBaseUrl}/tts`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text, voice, language })
    });

    if (!response.ok) {
      throw new Error('TTS synthesis failed');
    }

    return await response.blob();
  }

  /**
   * Speak text using TTS
   * @param {string} text - Text to speak
   * @param {string} voice - Voice name from listVoices() (e.g., "ayaka_ref")
   * @param {string} language - Language code (e.g., "ja")
   */
  async speak(text, voice = null, language = null) {
    // Stop current audio if playing
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.currentTime = 0;
    }

    this.isPlaying = true;

    // Synthesize speech
    const audioBlob = await this.synthesize(text, voice, language);

    // Create and play audio
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);

    audio.onended = () => {
      this.isPlaying = false;
      URL.revokeObjectURL(audioUrl);
    };

    audio.onerror = () => {
      this.isPlaying = false;
      URL.revokeObjectURL(audioUrl);
      console.error('Audio playback error');
    };

    this.currentAudio = audio;
    await audio.play();
  }

  /**
   * Stop current playback
   */
  stop() {
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio.currentTime = 0;
      this.isPlaying = false;
    }
  }

  /**
   * List available voices (scans reference/ folder)
   * @returns {Promise<string[]>} Array of voice names
   */
  async listVoices() {
    const response = await fetch(`${this.apiBaseUrl}/tts/voices`, {
      headers: {
        'Authorization': `Bearer ${this.token}`
      }
    });

    if (!response.ok) {
      throw new Error('Failed to list voices');
    }

    const data = await response.json();
    return data.voices; // ["ayaka_ref", "kurisu_ref", ...]
  }
}

// Usage example
const ttsPlayer = new TTSPlayer('http://localhost:15597', 'your-token');

// List available voices
const voices = await ttsPlayer.listVoices();
console.log('Available voices:', voices); // ["ayaka_ref", "kurisu_ref"]

// Speak some text with a specific voice
await ttsPlayer.speak('Hello world', 'ayaka_ref', 'ja');

// Stop speaking
ttsPlayer.stop();
```

## Auto-Play on Message Receive

For automatically playing TTS when receiving assistant messages:

```typescript
// In your chat component
useEffect(() => {
  const handleNewMessage = async (message: Message) => {
    if (message.role === 'assistant' && autoPlayTTS) {
      try {
        await speak(message.content);
      } catch (error) {
        console.error('Auto-play TTS failed:', error);
      }
    }
  };

  // Listen for new messages
  messageStream.on('message', handleNewMessage);

  return () => {
    messageStream.off('message', handleNewMessage);
  };
}, [speak, autoPlayTTS]);
```

## Voice Selection UI

```typescript
// components/VoiceSelector.tsx
import React, { useEffect, useState } from 'react';
import { useTTS } from '../hooks/useTTS';

interface VoiceSelectorProps {
  token: string;
  selectedVoice: string | null;
  onVoiceSelect: (voiceId: string) => void;
}

export function VoiceSelector({ token, selectedVoice, onVoiceSelect }: VoiceSelectorProps) {
  const [voices, setVoices] = useState<string[]>([]);
  const { loadVoices } = useTTS(token);

  useEffect(() => {
    const fetchVoices = async () => {
      const voiceList = await loadVoices();
      setVoices(voiceList);
    };
    fetchVoices();
  }, [loadVoices]);

  return (
    <select
      value={selectedVoice || ''}
      onChange={(e) => onVoiceSelect(e.target.value)}
      className="voice-selector"
    >
      <option value="">Default Voice</option>
      {voices.map((voice) => (
        <option key={voice} value={voice}>
          {voice}
        </option>
      ))}
    </select>
  );
}
```

## Error Handling

Always handle TTS errors gracefully:

```typescript
try {
  await speak(text, voice, language);
} catch (error) {
  if (error.response?.status === 500) {
    console.error('TTS synthesis failed on server');
    // Show user-friendly error message
  } else if (error.response?.status === 401) {
    console.error('Authentication required');
    // Redirect to login
  } else {
    console.error('Unexpected TTS error:', error);
  }
}
```

## Adding New Voices

To add new voices to your application:

1. **Server Side**: Place reference audio files in the `reference/` directory
   ```bash
   # Supported formats: .wav, .mp3, .flac, .ogg
   cp my_new_voice.wav reference/
   ```

2. **Frontend**: The new voice will automatically appear in `GET /tts/voices`
   ```javascript
   const voices = await ttsPlayer.listVoices();
   // ["ayaka_ref", "kurisu_ref", "my_new_voice"]
   ```

3. **No Restart Required**: Voices are scanned dynamically on each API call

## Best Practices

1. **Memory Management**: Always revoke object URLs after audio playback completes
2. **User Interaction**: Auto-play may require user interaction first due to browser policies
3. **Loading States**: Show loading indicators while synthesizing speech
4. **Cancellation**: Allow users to stop TTS playback
5. **Voice Caching**: Cache voice list to avoid repeated API calls (voices are loaded from filesystem on each request)
6. **Error Recovery**: Implement retry logic for transient failures
7. **Accessibility**: Provide visual feedback for TTS state (playing/stopped)
8. **Voice Names**: Voice parameter should be the filename without extension (e.g., `"ayaka_ref"` not `"reference/ayaka_ref.wav"`)

## API Reference Summary

### `POST /tts`
Synthesize speech from text.

**Request Body:**
```json
{
  "text": "Hello world",
  "voice": "ayaka_ref",  // Optional - voice name from GET /tts/voices
  "language": "ja"        // Optional - language code
}
```

**Response:** `audio/wav` binary data

### `GET /tts/voices`
List available voices.

**Response:**
```json
{
  "voices": ["ayaka_ref", "kurisu_ref", "another_voice"]
}
```

**Note:** Returns filenames (without extension) from the `reference/` directory

## Browser Compatibility

The TTS playback uses standard Web Audio APIs supported by:
- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)

Note: Auto-play policies vary by browser and may require user interaction.
