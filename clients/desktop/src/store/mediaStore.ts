import { create } from 'zustand';
import { wsManager, MediaStateEvent, MediaChunkEvent, MediaErrorEvent, ConnectedEvent } from '../api/websocket';
import type { MediaTrack } from '../api/types';

const VOLUME_STORAGE_KEY = 'kurisu_media_volume';

interface MediaState {
  playbackState: 'stopped' | 'playing' | 'paused';
  currentTrack: MediaTrack | null;
  queue: MediaTrack[];
  volume: number;
  isBuffering: boolean;
  error: string | null;

  play: (query: string) => void;
  pause: () => void;
  resume: () => void;
  skip: () => void;
  stop: () => void;
  setVolume: (v: number) => void;
  clearError: () => void;
}

// Module-level audio state (not in Zustand to avoid re-renders on chunk accumulation)
let _chunks: string[] = [];
let _chunkFormat: string = 'webm';
let _audio: HTMLAudioElement | null = null;
let _audioUrl: string | null = null;

function _cleanupAudio() {
  if (_audio) {
    _audio.pause();
    _audio.src = '';
    _audio = null;
  }
  if (_audioUrl) {
    URL.revokeObjectURL(_audioUrl);
    _audioUrl = null;
  }
}

function _base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function _playBuffer() {
  // Concatenate all chunks into a single ArrayBuffer
  const buffers = _chunks.map(_base64ToArrayBuffer);
  const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    combined.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }

  _cleanupAudio();

  const mimeType = _chunkFormat === 'webm' ? 'audio/webm; codecs=opus'
    : _chunkFormat === 'm4a' ? 'audio/mp4'
    : `audio/${_chunkFormat}`;
  console.log(`[media] Playing buffer: ${_chunks.length} chunks, ${totalLength} bytes, format=${_chunkFormat}, mime=${mimeType}`);
  const blob = new Blob([combined], { type: mimeType });
  _audioUrl = URL.createObjectURL(blob);
  _audio = new Audio(_audioUrl);
  _audio.volume = useMediaStore.getState().volume;

  _audio.onended = () => {
    _cleanupAudio();
    useMediaStore.setState({ playbackState: 'stopped', currentTrack: null, isBuffering: false });
  };

  _audio.onerror = () => {
    const err = _audio?.error;
    const msg = err ? `code=${err.code} ${err.message}` : 'unknown';
    console.error(`[media] Audio element error: ${msg}`);
    useMediaStore.setState({ error: `Playback failed: ${msg}`, isBuffering: false });
  };

  _audio.play().catch((err) => {
    console.error('[media] Audio.play() rejected:', err);
    useMediaStore.setState({ error: `Playback failed: ${err.message}`, isBuffering: false });
  });

  _chunks = [];
  useMediaStore.setState({ isBuffering: false });
}

export const useMediaStore = create<MediaState>((set) => ({
  playbackState: 'stopped',
  currentTrack: null,
  queue: [],
  volume: (() => {
    const saved = localStorage.getItem(VOLUME_STORAGE_KEY);
    return saved !== null ? parseFloat(saved) : 1.0;
  })(),
  isBuffering: false,
  error: null,

  play: (query: string) => {
    wsManager.sendMediaPlay(query);
  },

  pause: () => {
    if (_audio) {
      _audio.pause();
      set({ playbackState: 'paused' });
    }
  },

  resume: () => {
    if (_audio) {
      _audio.play();
      set({ playbackState: 'playing' });
    }
  },

  skip: () => {
    _cleanupAudio();
    _chunks = [];
    wsManager.sendMediaSkip();
  },

  stop: () => {
    _cleanupAudio();
    _chunks = [];
    wsManager.sendMediaStop();
    set({ playbackState: 'stopped', currentTrack: null, queue: [], isBuffering: false });
  },

  setVolume: (v: number) => {
    set({ volume: v });
    localStorage.setItem(VOLUME_STORAGE_KEY, String(v));
    if (_audio) _audio.volume = v;
    wsManager.sendMediaVolume(v);
  },

  clearError: () => set({ error: null }),
}));

// Module-level WebSocket listeners — singleton, runs for app lifetime
wsManager.on<MediaStateEvent>('media_state', (event) => {
  console.log(`[media] media_state received: state=${event.state}, track=${event.current_track?.title ?? 'none'}`);

  // Ignore backend 'stopped' if client-side is still buffering or playing
  if (event.state === 'stopped' && (_audio || _chunks.length > 0 || useMediaStore.getState().isBuffering)) {
    return;
  }

  const update: Partial<MediaState> = {
    playbackState: event.state,
    currentTrack: event.current_track,
    queue: event.queue,
  };

  // When a new track starts playing, prepare to buffer chunks
  const currentTrack = useMediaStore.getState().currentTrack;
  const isNewTrack = event.current_track?.url !== currentTrack?.url;
  if (event.state === 'playing' && isNewTrack) {
    _chunks = [];
    update.isBuffering = true;
  }

  useMediaStore.setState(update);
});

wsManager.on<MediaChunkEvent>('media_chunk', (event) => {
  _chunks.push(event.data);
  _chunkFormat = event.format;

  // Show player bar as soon as first chunk arrives (don't wait for media_state)
  if (event.chunk_index === 0) {
    console.log(`[media] First chunk received, format=${event.format}`);
    const state = useMediaStore.getState();
    if (state.playbackState === 'stopped') {
      useMediaStore.setState({ playbackState: 'playing', isBuffering: true });
    }
  }
  if (event.chunk_index > 0 && event.chunk_index % 50 === 0) {
    console.log(`[media] ${event.chunk_index} chunks received so far`);
  }
  if (event.is_last) {
    console.log(`[media] Last chunk received, total=${_chunks.length} chunks`);
    _playBuffer();
  }
});

wsManager.on<MediaErrorEvent>('media_error', (event) => {
  console.log(`[media] media_error received: ${event.error}`);
  useMediaStore.setState({ error: event.error, isBuffering: false });
});

// Sync media state on WebSocket reconnect
wsManager.on<ConnectedEvent>('connected', (event) => {
  if (event.media_state) {
    useMediaStore.setState({
      playbackState: event.media_state.state as 'stopped' | 'playing' | 'paused',
      currentTrack: event.media_state.current_track,
      queue: event.media_state.queue,
    });
  }
});
