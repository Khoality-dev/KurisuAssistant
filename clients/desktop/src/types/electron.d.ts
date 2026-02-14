import type { PoseTree } from '../videocall/types';

export interface AgentData {
  id: number;
  name: string;
  poseTree: PoseTree | null;
}

export interface VisionAPI {
  start: (webcamName: string, rtspUrl: string) => Promise<{ status: string }>;
  stop: () => Promise<{ status: string }>;
  listWebcams: () => Promise<string[]>;
}

export interface CharacterWindowAPI {
  open: () => Promise<void>;
  close: () => Promise<void>;
  sendAmplitude: (data: { amplitude: number; isPlaying: boolean; isThinking: boolean }) => void;
  sendAgentsUpdate: (data: { agents: AgentData[]; activeAgentId: number | null }) => void;
  sendGestureUpdate: (data: { gestures: string[] }) => void;
  onAmplitude: (cb: (data: { amplitude: number; isPlaying: boolean; isThinking: boolean }) => void) => () => void;
  onAgentsUpdate: (cb: (data: { agents: AgentData[]; activeAgentId: number | null }) => void) => () => void;
  onGestureUpdate: (cb: (data: { gestures: string[] }) => void) => () => void;
  onWindowClosed: (cb: () => void) => () => void;
  signalReady: () => void;
  onCharacterReady: (cb: () => void) => () => void;
}

export interface ElectronAPI {
  platform: string;
  vision: VisionAPI;
  characterWindow: CharacterWindowAPI;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
