import type { PoseTree } from '../videocall/types';

export interface AgentData {
  id: number;
  name: string;
  poseTree: PoseTree | null;
}

export interface CharacterWindowAPI {
  open: () => Promise<void>;
  close: () => Promise<void>;
  sendAmplitude: (data: { amplitude: number; isPlaying: boolean; isThinking: boolean }) => void;
  sendAgentsUpdate: (data: { agents: AgentData[]; activeAgentId: number | null }) => void;
  sendGestureUpdate: (data: { gestures: string[] }) => void;
  sendFaceUpdate: (data: { faces: string[] }) => void;
  sendSubtitle: (data: { text: string; isUser: boolean; duration?: number }) => void;
  onAmplitude: (cb: (data: { amplitude: number; isPlaying: boolean; isThinking: boolean }) => void) => () => void;
  onAgentsUpdate: (cb: (data: { agents: AgentData[]; activeAgentId: number | null }) => void) => () => void;
  onGestureUpdate: (cb: (data: { gestures: string[] }) => void) => () => void;
  onFaceUpdate: (cb: (data: { faces: string[] }) => void) => () => void;
  onSubtitle: (cb: (data: { text: string; isUser: boolean; duration?: number }) => void) => () => void;
  onWindowClosed: (cb: () => void) => () => void;
  signalReady: () => void;
  onCharacterReady: (cb: () => void) => () => void;
}

export interface MCPServerConfig {
  name: string;
  transport_type: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AppToolsAPI {
  listTools: () => Promise<Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>;
  isAppTool: (name: string) => Promise<boolean>;
  onExecute: (cb: (data: { callId: number; name: string; args: Record<string, unknown> }) => void) => () => void;
  sendResult: (callId: number, result: { content: string; isError: boolean }) => void;
}

export interface HostToolsAPI {
  listTools: () => Promise<Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>>;
  callTool: (toolName: string, args: Record<string, unknown>, agentId: number) => Promise<{ content: string; isError: boolean }>;
  isHostTool: (name: string) => Promise<boolean>;
  getAllowedPaths: (agentId: number) => Promise<string[]>;
  setAllowedPaths: (agentId: number, paths: string[]) => Promise<void>;
}

export interface MCPAPI {
  startServers: (configs: MCPServerConfig[]) => Promise<Array<{ name: string; ok: boolean; error?: string }>>;
  stopServers: () => Promise<void>;
  listTools: () => Promise<Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>>;
  listToolsByServer: () => Promise<Record<string, Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>>>;
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>;
}

export interface ExtensionsAPI {
  checkHealth: (url: string) => Promise<Record<string, any> | null>;
  checkInstalled: (appName: string) => Promise<{ installed: boolean; path: string }>;
  launchApp: (appName: string) => Promise<void>;
  downloadAndInstall: (url: string) => Promise<void>;
  downloadPortable: (url: string, appName: string) => Promise<void>;
  uninstall: (appName: string) => Promise<void>;
  onDownloadProgress: (cb: (progress: { percent: number }) => void) => () => void;
}

export interface ElectronAPI {
  platform: string;
  onMCPToolsChanged: (cb: () => void) => () => void;
  appTools: AppToolsAPI;
  hostTools: HostToolsAPI;
  mcp: MCPAPI;
  characterWindow: CharacterWindowAPI;
  extensions: ExtensionsAPI;
}

declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

export {};
