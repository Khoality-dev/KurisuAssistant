import type { CharacterConfig, EmotionCueRecord } from './character';

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
}

export interface ServerVersionInfo {
  backend_version: string;
  wire_protocol: number;
}

/** A provider `GET /models` could not reach; `detail` is what the server says about it. */
export interface UnavailableProvider {
  provider: string;
  detail: string;
}

export interface ModelsResponse {
  models: Array<{ name: string; provider: string }>;
  unavailable: UnavailableProvider[];
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
  /** Image ids the server stores; a message just sent holds `data:` URLs until it is reloaded. */
  images?: string[];
  created_at?: string;
  persona_id?: number; // Which persona spoke this message (assistant messages only)
  name?: string; // Speaker identity (persona name, tool name, etc.)
  persona_name?: string; // Persona display name (from streaming chunks)
  persona?: MessagePersona; // Embedded persona stamp (name, avatar, voice)
  voice_reference?: string; // Voice reference for TTS (from streaming chunks)
  has_raw_data?: boolean; // Whether raw LLM input/output is available
  model_name?: string; // LLM model that generated this message
  provider_type?: string; // LLM provider (ollama, gemini, nvidia, poe)
  tool_args?: Record<string, unknown>; // Tool input arguments (for tool role messages)
  tool_status?: string; // "success" | "error" | "denied" (from backend)
  // A tool message's kind and how long it ran — on the live chunk and, since
  // #327, in the history too, so the sub-agent tag survives a reload. A
  // `sub_agent` row is the assistant's own `delegate_task` call (#354).
  tool_kind?: 'tool' | 'sub_agent' | null;
  duration_ms?: number | null;
  context_files?: Array<{ path: string; fileName: string; startLine?: number; endLine?: number; startColumn?: number; endColumn?: number }>;
  emotion_cues?: EmotionCueRecord[]; // Where the persona's feeling changed (assistant messages of a VRM persona, #243)
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

/**
 * A conversation carries no persona: one persona, or none, is in use for the
 * whole account and answers in every conversation (#354). Who spoke each
 * message is on the message.
 */
export interface Conversation {
  id: number;
  title: string;
  // Written by a task run (#352) rather than by the user in a chat. `task_id`
  // is null once the task is deleted; the conversation stays a task run.
  task_run?: boolean;
  task_id?: number | null;
  message_count: number;
  created_at: string;
  updated_at: string;
  last_message?: ConversationLastMessage;
}

export interface ConversationDetail {
  id: number;
  title: string;
  task_run?: boolean;
  task_id?: number | null;
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
  has_poe_key?: boolean;
  gemini_api_key?: string; // PATCH only
  nvidia_api_key?: string; // PATCH only
  poe_api_key?: string; // PATCH only
  summary_model?: string; // Model for frame summarization (null = use chat model)
  context_size?: number; // Ollama num_ctx override (null = default 8192)
  /**
   * The account's IANA time zone (#352). Null until a client fills it from its
   * device; task schedules are read in it. PATCH "" clears it.
   */
  timezone?: string | null;
  /**
   * Whether a client should walk this account through its onboarding (#342):
   * true until a client reports it finished or skipped, never with a persona.
   */
  onboarding_pending?: boolean;
  /** PATCH only, and only `true`: the onboarding was finished or skipped. */
  onboarded?: true;
}

/**
 * A preset voice a synthesis engine offers (#214): the engine's own id, which
 * is what a persona stores and a synthesis names, its name for a person to
 * pick by, and the model that offers it.
 */
export interface VoiceInfo {
  id: string;
  name: string;
  model: string;
}

export interface VoicesResponse {
  voices: VoiceInfo[];
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
  // The account's permission mode (#360): what happens when the assistant calls
  // a tool. Every tool is always offered; this is the whole of tool permission.
  permission_mode: PermissionMode;
  think: boolean;
  use_deferred_tools: boolean;
  memory: string | null;
  memory_enabled: boolean;
  // Voice wake word. Saying it wakes the assistant; the persona in use answers.
  // It selects nothing.
  trigger_word: string | null;
  // The persona in use for the whole account (#334, #354): every turn, in every
  // conversation and on every device, answers as it. Null is the assistant
  // itself. A chat request never names a persona; switching is a PATCH here.
  selected_persona_id: number | null;
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
 * What exporting a persona with its character would carry (#248):
 * `GET /personas/{id}/export/size`. `bytes` is every file; `vrm_bytes` is the
 * part an import meters against the 3D character quota (pose art is not).
 */
export interface PersonaExportSize {
  character: { kind: 'pose_graph' | 'vrm'; files: number; bytes: number; vrm_bytes: number } | null;
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

/** `personas.character_config` on the wire: `{ kind, pose_tree?, vrm? }` (character.ts). */
export type CharacterConfigDTO = CharacterConfig;

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
 * clear it. `provider_type`, `permission_mode`, `think`, `use_deferred_tools` and
 * `memory_enabled` may not be null, and an unknown field is a 422.
 */
export interface AssistantUpdate {
  model_name?: string | null;
  provider_type?: string;
  permission_mode?: PermissionMode;
  think?: boolean;
  use_deferred_tools?: boolean;
  memory?: string | null;
  memory_enabled?: boolean;
  trigger_word?: string | null;
  selected_persona_id?: number | null;
}

/**
 * PATCH /conversations/{id}: a rename, and nothing else. A conversation has no
 * persona to change (#354); the backend refuses any other field with a 422.
 */
export interface ConversationUpdate {
  title?: string;
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
  /**
   * The tool only looks — it reads, lists or searches and changes nothing — so
   * Read only runs it (#360). Absent counts as changing something. A client
   * sends it with `client_tools_register`; the server reports it on `GET /tools`.
   */
  read_only?: boolean;
}

export interface ToolsResponse {
  /** The server's own tools. */
  server_tools: Tool[];
  mcp_tools: Tool[];
  mcp_servers?: Record<string, Tool[]>;
}

/**
 * What happens when the assistant calls a tool (#360):
 * - `ask` — every call waits for approval, reads included (the default);
 * - `read_only` — a tool that only looks runs; anything else is refused;
 * - `full` — everything runs without asking.
 * "Auto" is shown as coming soon and is not a value the server accepts yet.
 */
export type PermissionMode = 'ask' | 'read_only' | 'full';

export const PERMISSION_MODES: readonly PermissionMode[] = ['ask', 'read_only', 'full'];

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


// Kurisu Drive — account-scoped storage on the server (#17)

export interface DriveNode {
  id: number;
  parent_id: number | null;
  name: string;
  is_dir: boolean;
  size: number;
  mime: string | null;
  checksum: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface DriveUsage {
  used_bytes: number;
  quota_bytes: number;
  file_count: number;
  max_file_bytes: number;
}

// ---------------------------------------------------------------------------
// Tasks (#352): work the assistant does on its own, now or on a schedule.
// ---------------------------------------------------------------------------

/**
 * How the Tasks screen groups a task. A run waiting on the user's approval wins
 * over the rest. `GET /tasks` leaves `finished` one-offs out unless asked for.
 */
export type TaskStatus = 'waiting_for_approval' | 'running' | 'scheduled' | 'paused' | 'finished';
export type TaskRepeat = 'now' | 'once' | 'daily' | 'weekdays' | 'weekly' | 'hourly';
export type TaskDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type TaskRunStatus = 'running' | 'waiting_for_approval' | 'done' | 'failed' | 'stopped';

/** A tool call a task run waits on the user to approve (#352). */
export interface TaskApproval {
  id: number;
  run_id: number;
  task_id: number | null;
  task_title: string;
  /** The run's conversation, where the approval is answered too. */
  conversation_id: number | null;
  tool_name: string;
  tool_args: Record<string, unknown>;
  description: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';
  requested_at: string | null;
  /** Nobody answering by then denies the call. */
  expires_at: string | null;
}

export interface TaskRun {
  id: number;
  status: TaskRunStatus;
  /** Why a run failed, in words to show as they are. */
  error: string | null;
  /** The conversation the run wrote; open it to see what the assistant did. */
  conversation_id: number | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface AssistantTask {
  id: number;
  title: string;
  /** What the assistant does each run: the opening message of every run. */
  instructions: string;
  status: TaskStatus;
  repeat: TaskRepeat;
  timezone: string;
  run_at: string | null;
  time: string | null;
  days: TaskDay[];
  every_hours: number | null;
  /** The schedule in a few words, made by the server ("Weekdays at 07:30"). */
  schedule_label: string;
  next_run_at: string | null;
  last_run_at: string | null;
  planned_in_conversation_id: number | null;
  created_at: string | null;
  updated_at: string | null;
  /** The call the running task waits on the user to approve, when it waits. */
  pending_approval?: TaskApproval | null;
  /** Present on `GET /tasks/{id}` and `PATCH`: the ten newest runs, newest first. */
  runs?: TaskRun[];
}

export interface TaskScheduleUpdate {
  repeat: Exclude<TaskRepeat, 'now'>;
  timezone?: string;
  at?: string;
  time?: string;
  days?: TaskDay[];
  every_hours?: number;
}

export interface TaskUpdate {
  title?: string;
  instructions?: string;
  paused?: boolean;
  schedule?: TaskScheduleUpdate;
}

/** What a task tool returns, as the chat shows it in a card. */
export interface TaskToolResult {
  action: 'started' | 'scheduled' | 'updated' | 'stopped' | 'not_running' | 'deleted';
  task: AssistantTask;
}
