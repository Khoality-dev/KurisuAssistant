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

/** The RMS curve of a sentence, and what the curve was computed with. */
export interface AmplitudeCurve {
  /** RMS per window, 0..1. */
  values: number[];
  /** The window's own length in milliseconds — `floor(sampleRate / 30) / sampleRate` seconds, not a constant. */
  windowMs: number;
  durationMs: number;
}

/**
 * Pre-compute RMS amplitude per ~33ms window from raw PCM samples.
 */
export function computeAmplitudeCurve(samples: Float32Array, sampleRate: number): AmplitudeCurve {
  const windowSamples = Math.floor(sampleRate / 30);
  const totalSamples = samples.length;
  const numWindows = Math.ceil(totalSamples / windowSamples);
  const values = new Array<number>(numWindows);

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

  return { values, windowMs: (windowSamples / sampleRate) * 1000, durationMs: (totalSamples / sampleRate) * 1000 };
}

/** The curve of a WAV blob, or null when it is not PCM WAV this parser reads. */
export async function curveOfWav(blob: Blob): Promise<AmplitudeCurve | null> {
  const parsed = parseWavPcm(await blob.arrayBuffer());
  return parsed ? computeAmplitudeCurve(parsed.samples, parsed.sampleRate) : null;
}

/** What playback tells whoever is drawing the mouth (#238). */
export interface PlaybackListeners {
  /**
   * The element's `playing` event — the audio is actually coming out. This,
   * not the call to `play()`, is when a sentence's clock starts: the decode
   * and output latency between the two would otherwise lead the mouth.
   */
  onPlaying?: (curve: AmplitudeCurve | null, startedAt: number) => void;
  /** The element's position while it plays, every `PROGRESS_INTERVAL_MS`. */
  onProgress?: (positionMs: number, at: number) => void;
}

/** How to make and time an audio element; a test injects fakes. */
export interface PlaybackDeps {
  createAudio: (url: string) => HTMLAudioElement;
  now: () => number;
}

export const PROGRESS_INTERVAL_MS = 500;

export interface PlaybackHandle {
  /** Resolves when the audio ends; rejects when it cannot play. */
  done: Promise<void>;
  /** Stop now and release the element and its URL. */
  stop: () => void;
}

const defaultDeps: PlaybackDeps = {
  createAudio: (url) => new Audio(url),
  now: () => Date.now(),
};

/**
 * Play one blob through a plain audio element and report what a mouth needs:
 * the curve on `playing`, the position while playing. No amplitude per frame
 * leaves here — a surface derives that from the curve on its own clock.
 *
 * ZERO Web Audio API usage — the WAV is parsed by hand for the curve, which
 * avoids the AudioContext crashes seen in Electron; playback is an `Audio`.
 */
export function playSegment(
  blob: Blob,
  curve: AmplitudeCurve | null,
  listeners: PlaybackListeners,
  deps: PlaybackDeps = defaultDeps,
): PlaybackHandle {
  const url = URL.createObjectURL(blob);
  const audio = deps.createAudio(url);
  let progress: ReturnType<typeof setInterval> | null = null;
  let finished = false;

  const release = () => {
    if (progress !== null) { clearInterval(progress); progress = null; }
    URL.revokeObjectURL(url);
  };

  // `stop()` settles the promise too: a caller awaiting a sentence that was
  // cut short must not wait forever (the old queue loop did).
  let settle: (ok: boolean, error?: unknown) => void = () => {};
  const done = new Promise<void>((resolve, reject) => {
    settle = (ok, error) => {
      if (finished) return;
      finished = true;
      release();
      if (ok) resolve(); else reject(error);
    };

    audio.addEventListener('playing', () => {
      if (finished) return;
      listeners.onPlaying?.(curve, deps.now());
      if (listeners.onProgress && progress === null) {
        progress = setInterval(() => {
          if (finished) return;
          listeners.onProgress!(audio.currentTime * 1000, deps.now());
        }, PROGRESS_INTERVAL_MS);
      }
    });
    audio.addEventListener('ended', () => settle(true));
    audio.addEventListener('error', (e) => settle(false, e));
    audio.play().catch((e) => settle(false, e));
  });

  return {
    done,
    stop: () => {
      if (finished) return;
      audio.pause();
      settle(true);
    },
  };
}

/**
 * Hook for audio playback with pre-computed amplitude for lip sync.
 *
 * One playback at a time: starting a new one stops the last.
 */
export function useAudioAmplitude() {
  const handleRef = useRef<PlaybackHandle | null>(null);

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
  }, []);

  /**
   * Play an audio blob. Parses the WAV for the curve (unless one is handed
   * in), plays via an Audio element, and reports the curve on `playing` and
   * the position while playing.
   */
  const playWithAmplitude = useCallback(
    async (blob: Blob, listeners: PlaybackListeners, curve?: AmplitudeCurve | null): Promise<void> => {
      stop();
      if (curve === undefined) curve = await curveOfWav(blob);
      const handle = playSegment(blob, curve, listeners);
      handleRef.current = handle;
      try {
        await handle.done;
      } finally {
        if (handleRef.current === handle) handleRef.current = null;
      }
    },
    [stop],
  );

  useEffect(() => stop, [stop]);

  return { playWithAmplitude, stop };
}
