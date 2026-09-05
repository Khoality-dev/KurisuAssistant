export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface ServerVersionInfo {
  backend_version: string;
  wire_protocol: number;
}

// Embedded persona stamp on a stored message (subset of Persona) — who said it.
// The backend attaches it to assistant messages that carry a persona_id; tool
// messages have neither, and use `name` for the tool label instead.
export interface MessagePersona {
  id: number;
  name: string;
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
  persona_id?: number; // Which persona spoke this message (assistant messages only)
  name?: string; // Speaker identity (persona name, tool name, etc.)
  persona_name?: string; // Persona display name (from streaming chunks)
  persona?: MessagePersona; // Embedded persona stamp (name, avatar, voice)
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
  persona_id: number | null;  // null until the first message binds a persona
  message_count: number;
  created_at: string;
  updated_at: string;
  last_message?: ConversationLastMessage;
}

export interface ConversationDetail {
  id: number;
  title: string;
  persona_id: number | null;
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
  // Provider keys are write-only. GET reports only whether one is set; a key
  // is sent on PATCH and never read back, so omit it unless the user typed one.
  has_gemini_key?: boolean;
  has_nvidia_key?: boolean;
  gemini_api_key?: string; // PATCH only
  nvidia_api_key?: string; // PATCH only
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

/**
 * The user's single assistant: what it can do. Exactly one per user, created at
 * registration, addressed with no id (`GET|PATCH /assistant`). It owns capability —
 * model, provider, tools, reasoning, memory — plus the voice wake word and the
 * persona new conversations bind to. Personas change who answers; none of this
 * changes with them.
 */
export interface Assistant {
  id: number;
  model_name: string | null;
  provider_type: string;
  available_tools: string[] | null;  // null = every tool
  think: boolean;
  use_deferred_tools: boolean;
  memory: string | null;
  memory_enabled: boolean;
  // Voice wake word. Saying it wakes the assistant; the conversation's bound
  // persona answers. It selects nothing.
  trigger_word: string | null;
  // Persona a new conversation silently adopts. There is no picker on new-chat
  // and no random fallback.
  default_persona_id: number | null;
}

/**
 * How the assistant sounds: a name, a prompt, a voice, a face. Presentation only —
 * a persona owns no model, no tools, no memory and no trigger word.
 */
export interface Persona {
  id: number;
  name: string;
  description: string;
  system_prompt: string;
  preferred_name: string | null;   // what this persona calls the *user*
  voice_reference: string | null;
  avatar_uuid: string | null;
  character_config: CharacterConfigDTO | null;
  enabled: boolean;
}

/**
 * A task-only worker the assistant delegates to mid-answer. Runs its own LLM loop,
 * so it carries its own model and tools — but it has no identity: no avatar, no
 * voice, no memory, never bound to a conversation, never shown as the speaker.
 */
export interface SubAgent {
  id: number;
  name: string;
  description: string;
  system_prompt: string;
  model_name: string | null;
  provider_type: string;
  available_tools: string[] | null;  // null = every tool
  think: boolean;
  use_deferred_tools: boolean;
  enabled: boolean;
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

export interface PersonaCreate {
  name: string;
  description?: string;
  system_prompt?: string;
  preferred_name?: string;
  voice_reference?: string;
  avatar_uuid?: string;
  character_config?: CharacterConfigDTO;
  enabled?: boolean;
}

/**
 * PATCH /personas/{id}. Omit a field to leave it alone; send an explicit `null` to
 * clear it. `name`, `description` and `enabled` may not be null.
 */
export interface PersonaUpdate {
  name?: string;
  description?: string;
  system_prompt?: string;
  preferred_name?: string | null;
  voice_reference?: string | null;
  avatar_uuid?: string | null;
  character_config?: CharacterConfigDTO | null;
  enabled?: boolean;
}

/**
 * PATCH /assistant. Omit a field to leave it alone; send an explicit `null` to
 * clear it — `available_tools: null` is the only way to say "every tool" again.
 * `provider_type`, `think`, `use_deferred_tools` and `memory_enabled` may not be null.
 */
export interface AssistantUpdate {
  model_name?: string | null;
  provider_type?: string;
  available_tools?: string[] | null;
  think?: boolean;
  use_deferred_tools?: boolean;
  memory?: string | null;
  memory_enabled?: boolean;
  trigger_word?: string | null;
  default_persona_id?: number | null;
}

export interface SubAgentCreate {
  name: string;
  description?: string;
  system_prompt?: string;
  model_name?: string;
  provider_type?: string;
  available_tools?: string[];
  think?: boolean;
  use_deferred_tools?: boolean;
  enabled?: boolean;
}

/**
 * PATCH /sub-agents/{id}. Same null semantics as the others: `model_name: null`
 * means "the assistant's model", `available_tools: null` means "every tool".
 */
export interface SubAgentUpdate {
  name?: string;
  description?: string;
  system_prompt?: string;
  model_name?: string | null;
  provider_type?: string;
  available_tools?: string[] | null;
  think?: boolean;
  use_deferred_tools?: boolean;
  enabled?: boolean;
}

/**
 * PATCH /conversations/{id}. Replaces the old POST, which only ever renamed.
 * `persona_id: null` unbinds the conversation, so the next message falls back to
 * the assistant's default persona.
 */
export interface ConversationUpdate {
  title?: string;
  persona_id?: number | null;
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
