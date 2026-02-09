import type { PoseConfig } from '../videocall/types';

export interface AgentData {
  id: number;
  name: string;
  poseConfig: PoseConfig | null;
}

export interface CharacterWindowAPI {
  open: () => Promise<void>;
  close: () => Promise<void>;
  sendAmplitude: (data: { amplitude: number; isPlaying: boolean }) => void;
  sendAgentsUpdate: (data: { agents: AgentData[]; activeAgentId: number | null }) => void;
  onAmplitude: (cb: (data: { amplitude: number; isPlaying: boolean }) => void) => () => void;
  onAgentsUpdate: (cb: (data: { agents: AgentData[]; activeAgentId: number | null }) => void) => () => void;
  onWindowClosed: (cb: () => void) => () => void;
  signalReady: () => void;
  onCharacterReady: (cb: () => void) => () => void;
}

export interface ElectronAPI {
  platform: string;
  characterWindow: CharacterWindowAPI;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
