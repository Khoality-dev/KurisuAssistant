export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

// Embedded agent info in messages (subset of Agent)
export interface MessageAgent {
  id: number;
  name: string;
  persona_name: string | null;
  avatar_uuid: string | null;
  voice_reference: string | null;
}

export interface Message {
  id?: number;
  role: string; // Can be 'user', 'assistant', 'tool', or any custom agent role
  content: string;
  thinking?: string; // Optional thinking content (for assistant messages)
  images?: string[];
  created_at?: string;
  agent_id?: number; // Which agent sent this message
  name?: string; // Speaker identity (agent name, tool name, etc.)
  persona_name?: string; // Persona display name (from streaming chunks)
  agent?: MessageAgent; // Embedded agent info (name, avatar)
  voice_reference?: string; // Voice reference for TTS (from streaming chunks)
  has_raw_data?: boolean; // Whether raw LLM input/output is available
  model_name?: string; // LLM model that generated this message
  provider_type?: string; // LLM provider (ollama, gemini)
  tool_args?: Record<string, unknown>; // Tool input arguments (for tool role messages)
  tool_status?: string; // "success" | "error" | "denied" (from backend)
  context_files?: Array<{ path: string; fileName: string; startLine?: number; endLine?: number; startColumn?: number; endColumn?: number }>;
  queued?: boolean; // Queued message waiting to be processed
  // Render-only stable key that survives the transition from streaming → store → DB-id'd reload.
  // Without it, React keys flip from "stream-X" → "stream--Y" → "msg-Z" and Framer Motion replays
  // the entry animation on every remount, producing a visible flash when a stream finishes.
  _clientKey?: string;
}

export interface MessageRawData {
  id: number;
  raw_input: Record<string, any>[] | null; // Messages array sent to LLM
  raw_output: string | null; // Full concatenated LLM response
}

export interface ConversationLastMessage {
  content: string;
  role: string;
  created_at: string | null;
}

export interface Conversation {
  id: number;
  title: string;
  main_agent_id: number | null;  // null until first message picks a main agent
  message_count: number;
  created_at: string;
  updated_at: string;
  last_message?: ConversationLastMessage;
}

export interface ConversationDetail {
  id: number;
  title: string;
  main_agent_id: number | null;
  created_at: string;
  messages: Message[];
  total_messages: number;
  offset: number;
  limit: number;
  has_more: boolean;
  compacted_up_to_id: number;
  compacted_context: string;
  system_prompt_token_count: number;
}

export interface UserProfile {
  username: string;
  email?: string;
  system_prompt?: string;
  preferred_name?: string;
  agent_avatar_uuid?: string;
  ollama_url?: string;
  gemini_api_key?: string; // Masked in GET response, full key in PATCH
  nvidia_api_key?: string; // Masked in GET response, full key in PATCH
  summary_model?: string; // Model for frame summarization (null = use chat model)
  context_size?: number; // Ollama num_ctx override (null = default 8192)
}

export interface VoicesResponse {
  voices: string[];
}

export interface TTSModelInfo {
  id: string;
  object?: string;
  type?: string;
  loaded?: boolean | null;
}

export interface TTSModelsResponse {
  models: TTSModelInfo[];
}

export interface PullModelResponse {
  status: string;
  message: string;
}

export interface TTSRequest {
  text: string;
  voice?: string;
  language?: string;
  provider?: string;
  // viXTTS emotion parameters
  emo_audio?: string;
  emo_alpha?: number;
  use_emo_text?: boolean;
}

export interface Agent {
  id: number;
  name: string;
  description: string;
  system_prompt: string;
  model_name: string | null;
  provider_type: string;
  available_tools: string[] | null;
  think: boolean;
  memory: string | null;
  memory_enabled: boolean;
  enabled: boolean;
  is_system: boolean;
  use_deferred_tools: boolean;
  agent_type: string;  // "main" or "sub"
  // Personality fields — MainAgent only
  voice_reference: string | null;
  avatar_uuid: string | null;
  character_config: CharacterConfigDTO | null;
  preferred_name: string | null;
  trigger_word: string | null;  // First-message pick hint
}

// Character asset types (backend responses)

export interface PatchResultDTO {
  image_url: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface UploadBaseResponseDTO {
  asset_id: string;
  image_url: string;
}

export interface ComputePatchResponseDTO {
  patch: PatchResultDTO;
}

export interface CharacterConfigDTO {
  [key: string]: any;
}

export interface UploadVideoResponseDTO {
  asset_id: string;
  video_url: string;
}

export interface AgentCreate {
  name: string;
  description?: string;
  system_prompt?: string;
  model_name: string;
  provider_type?: string;
  available_tools?: string[];
  think?: boolean;
  use_deferred_tools?: boolean;
  agent_type?: string;  // "main" or "sub"
  // Personality fields — MainAgent only
  voice_reference?: string;
  avatar_uuid?: string;
  character_config?: CharacterConfigDTO;
  preferred_name?: string;
  trigger_word?: string;
}

export interface AgentUpdate {
  name?: string;
  description?: string;
  system_prompt?: string;
  model_name?: string;
  provider_type?: string;
  available_tools?: string[];
  think?: boolean;
  memory?: string;
  memory_enabled?: boolean;
  use_deferred_tools?: boolean;
  agent_type?: string;
  // Personality fields — MainAgent only
  voice_reference?: string | null;
  avatar_uuid?: string | null;
  character_config?: CharacterConfigDTO | null;
  preferred_name?: string | null;
  trigger_word?: string | null;
}

// MCP Server types
export interface MCPServer {
  id: number;
  name: string;
  transport_type: 'sse' | 'stdio';
  url: string | null;
  command: string | null;
  args: string[] | null;
  env: Record<string, string> | null;
  enabled: boolean;
  location: 'server' | 'client';
  created_at: string | null;
}

export interface MCPServerCreate {
  name: string;
  transport_type: 'sse' | 'stdio';
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  location?: 'server' | 'client';
}

export interface MCPServerUpdate {
  name?: string;
  transport_type?: string;
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  location?: 'server' | 'client';
}

export interface MCPServerTestResult {
  status: 'available' | 'unavailable';
  tool_count?: number;
  error?: string;
}

// Tool types
export interface ToolFunction {
  name: string;
  description: string;
  parameters: Record<string, any>;
}

export interface Tool {
  type: string;
  function: ToolFunction;
  built_in?: boolean;
}

export interface ToolsResponse {
  mcp_tools: Tool[];
  builtin_tools: Tool[];
  mcp_servers?: Record<string, Tool[]>;
}

// Skill types
export interface Skill {
  id: number;
  name: string;
  instructions: string;
  created_at: string | null;
}

export interface SkillCreate {
  name: string;
  instructions?: string;
}

export interface SkillUpdate {
  name?: string;
  instructions?: string;
}

// Face recognition types

export interface FaceIdentity {
  id: number;
  name: string;
  photo_count: number;
  created_at: string;
}

export interface FaceIdentityDetail {
  id: number;
  name: string;
  created_at: string;
  photos: FacePhoto[];
}

export interface FacePhoto {
  id: number;
  photo_uuid: string;
  url: string;
  created_at?: string;
}

// Vision result types (from WebSocket)

export interface VisionFace {
  identity_id: number | null;
  name: string;
  confidence: number;
  bbox: number[];
}

export interface VisionGesture {
  gesture: string;
  confidence: number;
}

export interface VisionResult {
  faces: VisionFace[];
  gestures: VisionGesture[];
}


// Media player types

export interface MediaTrack {
  title: string;
  url: string;
  duration: number | null;
  thumbnail: string | null;
  artist: string | null;
}
