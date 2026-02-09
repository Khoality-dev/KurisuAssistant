import { useRef, useCallback, useEffect } from 'react';

/**
 * Parse WAV file and extract PCM samples as Float32Array.
 * Supports 16-bit and 24-bit PCM WAV. No AudioContext needed.
 */
function parseWavPcm(arrayBuffer: ArrayBuffer): { samples: Float32Array; sampleRate: number } | null {
  const view = new DataView(arrayBuffer);

  // Validate RIFF header
  if (view.byteLength < 44) return null;
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
  if (riff !== 'RIFF' || wave !== 'WAVE') return null;

  // Find fmt and data chunks by scanning
  let sampleRate = 0;
  let numChannels = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataSize = 0;

  let offset = 12; // after "RIFF....WAVE"
  while (offset + 8 <= view.byteLength) {
    const chunkId = String.fromCharCode(
      view.getUint8(offset), view.getUint8(offset + 1),
      view.getUint8(offset + 2), view.getUint8(offset + 3),
    );
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'fmt ') {
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize;
    // Chunks are word-aligned
    if (chunkSize % 2 !== 0) offset++;
  }

  if (sampleRate === 0 || dataOffset === 0 || numChannels === 0 || bitsPerSample === 0) return null;

  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = Math.floor(dataSize / (bytesPerSample * numChannels));
  const samples = new Float32Array(totalSamples);

  // Read first channel only
  for (let i = 0; i < totalSamples; i++) {
    const bytePos = dataOffset + i * bytesPerSample * numChannels;
    if (bytePos + bytesPerSample > view.byteLength) break;

    if (bitsPerSample === 16) {
      samples[i] = view.getInt16(bytePos, true) / 32768;
    } else if (bitsPerSample === 24) {
      // 24-bit little-endian signed
      const b0 = view.getUint8(bytePos);
      const b1 = view.getUint8(bytePos + 1);
      const b2 = view.getUint8(bytePos + 2);
      let val = (b2 << 16) | (b1 << 8) | b0;
      if (val >= 0x800000) val -= 0x1000000;
      samples[i] = val / 8388608;
    } else if (bitsPerSample === 8) {
      // 8-bit unsigned
      samples[i] = (view.getUint8(bytePos) - 128) / 128;
    } else {
      // Unsupported bit depth
      return null;
    }
  }

  return { samples, sampleRate };
}

/**
 * Hook for audio playback with pre-computed amplitude for lip sync.
 *
 * ZERO Web Audio API usage — parses WAV PCM manually to avoid
 * AudioContext/AudioBufferSourceNode crashes in Electron.
 * Playback uses plain Audio element.
 */
export function useAudioAmplitude() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);

  /**
   * Pre-compute RMS amplitude per ~33ms window from raw PCM samples.
   */
  const computeCurve = useCallback((samples: Float32Array, sampleRate: number) => {
    const windowSamples = Math.floor(sampleRate / 30);
    const totalSamples = samples.length;
    const numWindows = Math.ceil(totalSamples / windowSamples);
    const values = new Float32Array(numWindows);

    for (let w = 0; w < numWindows; w++) {
      const start = w * windowSamples;
      const end = Math.min(start + windowSamples, totalSamples);
      let sumSquares = 0;
      for (let i = start; i < end; i++) {
        sumSquares += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sumSquares / (end - start));
      values[w] = Math.min(rms * 4, 1.0);
    }

    return { values, windowDuration: windowSamples / sampleRate };
  }, []);

  /**
   * Play audio blob with amplitude callback.
   * Parses WAV for amplitude curve, plays via Audio element,
   * RAF loop indexes curve by audio.currentTime.
   */
  const playWithAmplitude = useCallback(
    async (blob: Blob, onAmplitude?: (amp: number, playing: boolean) => void): Promise<void> => {
      // Clean up previous
      stop_internal();

      // Parse WAV for amplitude curve (no AudioContext!)
      const arrayBuffer = await blob.arrayBuffer();
      const parsed = parseWavPcm(arrayBuffer);

      let curve: { values: Float32Array; windowDuration: number } | null = null;
      if (parsed) {
        curve = computeCurve(parsed.samples, parsed.sampleRate);
      }

      // Play via plain Audio element
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;

      return new Promise<void>((resolve, reject) => {
        // RAF loop: index into pre-computed curve using audio.currentTime
        if (onAmplitude && curve) {
          const tick = () => {
            if (!audioRef.current) return;
            const t = audioRef.current.currentTime;
            const index = Math.floor(t / curve!.windowDuration);
            const amp = index >= 0 && index < curve!.values.length ? curve!.values[index] : 0;
            onAmplitude(amp, true);
            rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
        }

        audio.onended = () => {
          cleanup();
          if (onAmplitude) onAmplitude(0, false);
          resolve();
        };

        audio.onerror = (e) => {
          cleanup();
          if (onAmplitude) onAmplitude(0, false);
          reject(e);
        };

        audio.play().catch((e) => {
          cleanup();
          if (onAmplitude) onAmplitude(0, false);
          reject(e);
        });
      });
    },
    [computeCurve],
  );

  function cleanup() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    audioRef.current = null;
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }

  function stop_internal() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }

  const stop = useCallback(() => {
    stop_internal();
  }, []);

  useEffect(() => {
    return () => {
      stop_internal();
    };
  }, []);

  return { playWithAmplitude, stop };
}
