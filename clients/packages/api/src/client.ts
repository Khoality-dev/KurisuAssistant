import axios, { AxiosInstance } from 'axios';
import { config } from './config';
import {
  WIRE_PROTOCOL,
  type Assistant,
  type AssistantTask,
  type AssistantUpdate,
  type CalendarEntry,
  type CalendarEntryCreate,
  type CalendarEntryUpdate,
  type CharacterClipUpload,
  type CharacterConfigDTO,
  type CharacterModelUpload,
  type CharacterUsage,
  type ComputePatchResponseDTO,
  type Conversation,
  type ConversationDetail,
  type ConversationUpdate,
  type DriveNode,
  type DriveUsage,
  type FaceIdentity,
  type FaceIdentityDetail,
  type LoginResponse,
  type MCPServer,
  type MCPServerCreate,
  type MCPServerTestResult,
  type MCPServerUpdate,
  type MessageRawData,
  type ModelsResponse,
  type Persona,
  type PersonaCreate,
  type PersonaExportSize,
  type PersonaUpdate,
  type NotificationEvent,
  type PullModelResponse,
  type ServerVersionInfo,
  type Skill,
  type SkillCreate,
  type SkillUpdate,
  type TaskApproval,
  type TaskUpdate,
  type ToolsResponse,
  type TTSModelsResponse,
  type TTSRequest,
  type UnavailableProvider,
  type UploadBaseResponseDTO,
  type UploadVideoResponseDTO,
  type UserProfile,
  type VoiceInfo,
  type VoicesResponse,
} from '@kurisu/models';
import { sha256Hex, throwIfCancelled, toCharacterUploadError } from './characterUploads';
import { wsManager } from './websocket';
import { notificationSocket } from './notificationSocket';

/** An axios error whose Blob body (a `responseType: 'blob'` request) is read back into JSON when it is JSON. */
async function withJsonBody(error: unknown): Promise<unknown> {
  const response = (error as { response?: { data?: unknown } } | null)?.response;
  if (response && typeof Blob !== 'undefined' && response.data instanceof Blob) {
    try {
      response.data = JSON.parse(await response.data.text());
    } catch {
      // Not JSON (a proxy's page): leave it for the status to describe.
    }
  }
  return error;
}

/**
 * What a live server says when it refuses our wire protocol: the body of its
 * HTTP 426. `server_wire_protocol` is null when the refusal reached us with no
 * body to read (the WebSocket close, or a proxy that ate it).
 */
export interface ProtocolMismatch {
  backend_version: string | null;
  server_wire_protocol: number | null;
}

class APIClient {
  private client: AxiosInstance;
  private token: string | null = null;
  private refreshToken: string | null = null;
  private refreshPromise: Promise<string> | null = null;
  private _onAuthFailure: (() => void) | null = null;
  private _onProtocolMismatch: ((info: ProtocolMismatch) => void) | null = null;

  constructor() {
    this.client = axios.create({
      timeout: 30000,
    });

    // Read baseURL dynamically so it picks up changes from storage, and stamp
    // every request with the wire-protocol header so backend can reject
    // incompatible clients with HTTP 426.
    this.client.interceptors.request.use((reqConfig) => {
      reqConfig.baseURL = config.apiBaseUrl;
      reqConfig.headers.set('X-Wire-Protocol', String(WIRE_PROTOCOL));
      return reqConfig;
    });

    // Auto-refresh on 401 responses; a 426 from a live server is the same
    // situation the startup check gates on, so it raises the same screen
    // instead of surfacing as a generic request failure (#150).
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 426) {
          const body = error.response.data ?? {};
          const serverWire = Number(body.server_wire_protocol);
          this._onProtocolMismatch?.({
            backend_version: typeof body.backend_version === 'string' ? body.backend_version : null,
            server_wire_protocol: Number.isFinite(serverWire) ? serverWire : null,
          });
          return Promise.reject(error);
        }
        const original = error.config;
        if (
          error.response?.status === 401 &&
          !original._isRetry &&
          !original.url?.includes('/auth/refresh') &&
          !original.url?.includes('/login')
        ) {
          original._isRetry = true;
          try {
            const newToken = await this.tryRefresh();
            original.headers['Authorization'] = `Bearer ${newToken}`;
            return this.client(original);
          } catch {
            // Refresh failed — force logout
            this._onAuthFailure?.();
          }
        }
        return Promise.reject(error);
      },
    );
  }

  onAuthFailure(callback: () => void) {
    this._onAuthFailure = callback;
  }

  /** Called when any request is refused with HTTP 426 (wire-protocol mismatch). */
  onProtocolMismatch(callback: (info: ProtocolMismatch) => void) {
    this._onProtocolMismatch = callback;
  }

  /**
   * Report a mismatch noticed off the HTTP path — the WebSocket close 4426 —
   * through the same callback. The close carries no version, so this asks
   * `/version` (exempt from the gate) and falls back to "unknown".
   */
  async reportProtocolMismatch(): Promise<void> {
    let info: ProtocolMismatch = { backend_version: null, server_wire_protocol: null };
    try {
      const version = await this.getServerVersion();
      info = { backend_version: version.backend_version, server_wire_protocol: version.wire_protocol };
    } catch {
      // unreachable now — still show the screen, with the numbers unknown
    }
    this._onProtocolMismatch?.(info);
  }

  setToken(token: string) {
    this.token = token;
    wsManager.setToken(token);
    notificationSocket.setToken(token);
  }

  setRefreshToken(token: string) {
    this.refreshToken = token;
  }

  clearToken() {
    this.token = null;
    this.refreshToken = null;
    this.refreshPromise = null;
    wsManager.clearToken();
    wsManager.disconnect();
    notificationSocket.clearToken();
  }

  getToken(): string | null {
    return this.token;
  }

  getRefreshTokenValue(): string | null {
    return this.refreshToken;
  }

  /**
   * Try to refresh the access token. Coalesces concurrent calls.
   */
  async tryRefresh(): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise;

    this.refreshPromise = (async () => {
      if (!this.refreshToken) throw new Error('No refresh token');
      const response = await this.client.post<{ access_token: string; token_type: string }>(
        '/auth/refresh',
        { refresh_token: this.refreshToken },
      );
      const newToken = response.data.access_token;
      this.token = newToken;
      wsManager.setToken(newToken);
      notificationSocket.setToken(newToken);

      // Into memory always, and on to the keychain if remember-me is on —
      // `storage.setToken` makes that call, so the refreshed token no longer
      // goes missing from the authed asset URLs when it is off.
      const { storage } = await import('./storage');
      storage.setToken(newToken);
      return newToken;
    })().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private getHeaders() {
    const headers: Record<string, string> = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  async getServerVersion(): Promise<ServerVersionInfo> {
    const response = await this.client.get<ServerVersionInfo>('/version');
    return response.data;
  }

  async login(username: string, password: string): Promise<LoginResponse> {
    const formData = new FormData();
    formData.append('username', username);
    formData.append('password', password);

    const response = await this.client.post<LoginResponse>('/login', formData);
    this.setToken(response.data.access_token);
    this.setRefreshToken(response.data.refresh_token);
    return response.data;
  }

  // Validate username/password without touching the current session's token.
  // Used by the login-QR generator to confirm the user typed the right password
  // before encoding it into a QR code.
  async verifyCredentials(username: string, password: string): Promise<void> {
    const formData = new FormData();
    formData.append('username', username);
    formData.append('password', password);
    await this.client.post<LoginResponse>('/login', formData, {
      // Skip the bearer header — /login is unauthenticated, and we don't want
      // a stale token to interfere or get refreshed.
      transformRequest: [(data, headers) => {
        delete (headers as any).Authorization;
        return data;
      }],
    });
  }

  async register(username: string, password: string, email?: string): Promise<LoginResponse> {
    const formData = new FormData();
    formData.append('username', username);
    formData.append('password', password);
    if (email) {
      formData.append('email', email);
    }

    const response = await this.client.post<LoginResponse>('/register', formData);
    this.setToken(response.data.access_token);
    this.setRefreshToken(response.data.refresh_token);
    return response.data;
  }

  /**
   * The account's conversations, newest first. A conversation carries no
   * persona (#354), so there is nothing to filter on but the count.
   */
  async getConversations(limit?: number): Promise<Conversation[]> {
    const response = await this.client.get<Conversation[]>('/conversations', {
      headers: this.getHeaders(),
      params: limit ? { limit } : undefined,
    });
    return response.data;
  }

  async getConversation(
    id: number,
    limit: number = 50,
    offset: number = 0
  ): Promise<ConversationDetail> {
    const response = await this.client.get<ConversationDetail>(`/conversations/${id}`, {
      params: { limit, offset },
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async deleteConversation(id: number): Promise<void> {
    await this.client.delete(`/conversations/${id}`, {
      headers: this.getHeaders(),
    });
  }

  /**
   * Rename a conversation. A conversation has no persona to change (#354):
   * switching persona is `updateAssistant({ selected_persona_id })`.
   */
  async patchConversation(
    id: number,
    data: ConversationUpdate,
  ): Promise<{ id: number; title: string }> {
    const response = await this.client.patch<{ id: number; title: string }>(
      `/conversations/${id}`,
      data,
      { headers: this.getHeaders() }
    );
    return response.data;
  }

  async getMessageRaw(messageId: number): Promise<MessageRawData> {
    const response = await this.client.get<MessageRawData>(`/messages/${messageId}/raw`, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * The model list, plus the providers the server could not reach. A 502 means
   * no provider answered at all; a 200 with `unavailable` entries means the
   * list is partial — Gemini answered, say, while Ollama was down (#151).
   */
  async getModelsWithStatus(): Promise<ModelsResponse> {
    const response = await this.client.get<{ models: any[]; unavailable?: UnavailableProvider[] }>('/models', {
      headers: this.getHeaders(),
    });
    // Handle both old format (string[]) and new format ({name, provider}[])
    const models = response.data.models.map((m: any) =>
      typeof m === 'string' ? { name: m, provider: 'ollama' } : m
    );
    return { models, unavailable: response.data.unavailable ?? [] };
  }

  async getModels(): Promise<Array<{ name: string; provider: string }>> {
    return (await this.getModelsWithStatus()).models;
  }

  async validateApiKey(provider: string, apiKey: string): Promise<{ valid: boolean; model_count?: number; error?: string }> {
    const response = await this.client.post<{ valid: boolean; model_count?: number; error?: string }>(
      '/models/validate-key',
      { provider, api_key: apiKey },
      { headers: this.getHeaders() },
    );
    return response.data;
  }

  async pullModel(name: string): Promise<PullModelResponse> {
    const response = await this.client.post<PullModelResponse>(
      '/models/pull',
      { name },
      {
        headers: this.getHeaders(),
        timeout: 1800000, // Model downloads can take a while.
      }
    );
    return response.data;
  }

  async getUserProfile(): Promise<UserProfile> {
    const response = await this.client.get<UserProfile>('/users/me', {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async updateUserProfile(profile: Partial<UserProfile>): Promise<any> {
    const response = await this.client.patch('/users/me', profile, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async updateUserAvatars(agentAvatar?: File): Promise<any> {
    const formData = new FormData();

    if (agentAvatar) {
      formData.append('agent_avatar', agentAvatar);
    }

    const response = await this.client.patch('/users/me/avatars', formData, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async uploadImage(file: File): Promise<{ image_uuid: string; url: string }> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await this.client.post<{ image_uuid: string; url: string }>('/images', formData, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * URL for an avatar or face photo.
   *
   * Carries the token like `getUserImageUrl` below: the route stopped being
   * public in #154, because a UUID is not a secret — it travels in API
   * responses, through proxy logs and into browser history — and the store holds
   * account avatars, persona avatars and face photos. The token rides in the
   * query string for the same reason it does there: these URLs go into
   * `<img src=...>`, which cannot set an Authorization header.
   */
  getImageUrl(uuid: string): string {
    return `${config.apiBaseUrl}/images/${uuid}?token=${this.token}`;
  }

  getUserImageUrl(uuid: string): string {
    return `${config.apiBaseUrl}/images/u/${uuid}?token=${this.token}`;
  }

  // TTS Methods

  /**
   * Synthesize speech from text and return audio blob
   */
  async synthesize(
    text: string,
    voice?: string,
    language?: string,
    backend?: string,
  ): Promise<Blob> {
    const requestData: TTSRequest = {
      text,
      voice,
      language,
      provider: backend, // Map 'backend' to 'provider' for API
    };

    const response = await this.client.post('/tts', requestData, {
      headers: {
        ...this.getHeaders(),
        'Content-Type': 'application/json',
      },
      responseType: 'blob',
      timeout: 300000, // 5 minutes timeout for TTS generation (can take a while for long texts)
    });

    return response.data;
  }

  /**
   * The preset voices the synthesis engines offer, or one model's with `backend`.
   */
  async listVoices(backend?: string): Promise<VoiceInfo[]> {
    const params = backend ? { provider: backend } : {};
    const response = await this.client.get<VoicesResponse>('/tts/voices', {
      headers: this.getHeaders(),
      params,
    });
    return response.data.voices;
  }

  /**
   * Check if a TTS server is reachable
   */
  async checkTTSConnection(provider?: string): Promise<{ ok: boolean; message: string }> {
    const response = await this.client.post<{ ok: boolean; message: string }>(
      '/tts/check',
      { provider },
      { headers: this.getHeaders(), timeout: 10000 }
    );
    return response.data;
  }

  /**
   * List available TTS models
   */
  async listTTSModels(): Promise<string[]> {
    const response = await this.client.get<TTSModelsResponse>('/tts/models', {
      headers: this.getHeaders(),
    });
    return response.data.models.map((m) => (typeof m === 'string' ? m : m.id));
  }

  // ASR Methods

  /**
   * Transcribe raw Int16 PCM audio (16kHz mono) to text
   */
  async transcribe(
    audio: ArrayBuffer,
    options?: { language?: string; model?: string; initial_prompt?: string },
  ): Promise<{ text: string; language: string }> {
    const params: Record<string, string> = {};
    if (options?.language) params.language = options.language;
    if (options?.model) params.model = options.model;
    if (options?.initial_prompt) params.initial_prompt = options.initial_prompt;

    const response = await this.client.post<{ text: string; language: string }>('/asr', audio, {
      headers: { ...this.getHeaders(), 'Content-Type': 'application/octet-stream' },
      params,
      timeout: 30000,
    });
    return response.data;
  }

  async detectLanguage(audio: ArrayBuffer, options?: { languages?: string[] }): Promise<{ language: string }> {
    const params: Record<string, string> = {};
    if (options?.languages?.length) params.languages = options.languages.join(',');

    const response = await this.client.post<{ language: string }>('/asr/detect-language', audio, {
      headers: { ...this.getHeaders(), 'Content-Type': 'application/octet-stream' },
      params,
      timeout: 15000,
    });
    return response.data;
  }

  async getASRModels(): Promise<Array<{ id: string; name: string; size_mb: number | null; loaded: boolean }>> {
    const response = await this.client.get<{ data: Array<{ id: string; name: string; size_mb: number | null; loaded: boolean }> }>(
      '/asr/models',
      { headers: this.getHeaders() },
    );
    return response.data.data || [];
  }

  // Assistant Methods
  //
  // One assistant per user, created at registration: no id in the path, no POST,
  // no DELETE.

  /** Get the user's assistant (capability + who the chat is on). */
  async getAssistant(): Promise<Assistant> {
    const response = await this.client.get<Assistant>('/assistant', {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /** Update the assistant. Omitted fields untouched; explicit null clears. */
  async updateAssistant(data: AssistantUpdate): Promise<Assistant> {
    const response = await this.client.patch<Assistant>('/assistant', data, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  // Persona Methods

  /** List the user's personas, enabled or not, oldest first. */
  async listPersonas(): Promise<Persona[]> {
    const response = await this.client.get<Persona[]>('/personas', {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async getPersona(id: number): Promise<Persona> {
    const response = await this.client.get<Persona>(`/personas/${id}`, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /** Create a persona. It is not put in use: only `updateAssistant` does that (#302, #354). */
  async createPersona(data: PersonaCreate): Promise<Persona> {
    const response = await this.client.post<Persona>('/personas', data, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async updatePersona(id: number, data: PersonaUpdate): Promise<Persona> {
    const response = await this.client.patch<Persona>(`/personas/${id}`, data, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * Delete a persona, the last one included: the assistant answers without one
   * (#302). Deleting the persona in use leaves none in use.
   */
  async deletePersona(id: number): Promise<void> {
    await this.client.delete(`/personas/${id}`, {
      headers: this.getHeaders(),
    });
  }

  /** Enable/disable a persona. Disabling the persona in use leaves none in use (#302). */
  async togglePersonaEnabled(id: number, enabled: boolean): Promise<Persona> {
    const response = await this.client.patch<Persona>(`/personas/${id}/enabled`, { enabled }, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * Export a persona. By default the v3 JSON file, which carries no media:
   * avatar, voice reference and character config are handles to files on this
   * server. `character: true` asks for the v4 bundle (a zip) that carries the
   * character's files too (#248) — tens of megabytes for a 3D model, so no
   * timeout. A refusal's body arrives as a Blob and is read back into JSON, so
   * `describeRequestFailure` can show what the server said.
   */
  async exportPersona(id: number, opts: { character?: boolean } = {}): Promise<Blob> {
    try {
      const response = await this.client.get(`/personas/${id}/export`, {
        headers: this.getHeaders(),
        responseType: 'blob',
        ...(opts.character ? { params: { character: true }, timeout: 0 } : {}),
      });
      return response.data;
    } catch (error) {
      throw await withJsonBody(error);
    }
  }

  /** How big a persona's character is, before exporting it with `character: true`. */
  async exportPersonaSize(id: number): Promise<PersonaExportSize> {
    const response = await this.client.get<PersonaExportSize>(`/personas/${id}/export/size`, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async importPersona(file: File): Promise<Persona> {
    const formData = new FormData();
    formData.append('file', file);
    const response = await this.client.post<Persona>('/personas/import', formData, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * Import a persona bundle (a `.zip` exported with its character, #248). The
   * raw body, streamed — the route is not multipart, for the reason the model
   * upload is not — with no timeout. Every failure is a `CharacterUploadError`:
   * the refusals are the model upload's own (`quota`, `too_large`, `not_vrm`…)
   * plus a plain message for a bundle that does not hold up.
   */
  async importPersonaBundle(
    file: Blob,
    opts: { onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal } = {},
  ): Promise<Persona> {
    try {
      const response = await this.client.post<Persona>('/personas/import/bundle', file, {
        headers: { ...this.getHeaders(), 'Content-Type': 'application/zip' },
        signal: opts.signal,
        timeout: 0,
        onUploadProgress: (event) => opts.onProgress?.(event.loaded, event.total ?? file.size),
      });
      return response.data;
    } catch (error) {
      throw toCharacterUploadError(error);
    }
  }

  // Tools Methods

  /**
   * List all available tools (MCP + built-in)
   */
  async listTools(): Promise<ToolsResponse> {
    const response = await this.client.get<ToolsResponse>('/tools', {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * List MCP servers for the current user
   */
  async listMCPServers(): Promise<MCPServer[]> {
    const response = await this.client.get<MCPServer[]>('/mcp-servers', {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * Create a new MCP server
   */
  async createMCPServer(data: MCPServerCreate): Promise<MCPServer> {
    const response = await this.client.post<MCPServer>('/mcp-servers', data, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * Update an MCP server
   */
  async updateMCPServer(id: number, data: MCPServerUpdate): Promise<MCPServer> {
    const response = await this.client.patch<MCPServer>(`/mcp-servers/${id}`, data, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * Delete an MCP server
   */
  async deleteMCPServer(id: number): Promise<void> {
    await this.client.delete(`/mcp-servers/${id}`, {
      headers: this.getHeaders(),
    });
  }

  /**
   * Test connectivity to an MCP server
   */
  async testMCPServer(id: number): Promise<MCPServerTestResult> {
    const response = await this.client.post<MCPServerTestResult>(`/mcp-servers/${id}/test`, null, {
      headers: this.getHeaders(),
      timeout: 15000,
    });
    return response.data;
  }

  // Character Asset Methods

  /**
   * Upload a base portrait image for character animation
   */
  async uploadCharacterBase(personaId: number, poseId: string, file: File): Promise<UploadBaseResponseDTO> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await this.client.post<UploadBaseResponseDTO>(
      '/character-assets/upload-base',
      formData,
      {
        headers: this.getHeaders(),
        params: { persona_id: personaId, pose_id: poseId },
      }
    );
    return response.data;
  }

  /**
   * Upload a keyframe image and compute diff patch against the pose's base image
   */
  async computeCharacterPatch(
    personaId: number,
    poseId: string,
    keyframeFile: File,
    part: string,
    index: number,
  ): Promise<ComputePatchResponseDTO> {
    const formData = new FormData();
    formData.append('keyframe', keyframeFile);

    const response = await this.client.post<ComputePatchResponseDTO>(
      '/character-assets/compute-patch',
      formData,
      {
        headers: this.getHeaders(),
        params: { persona_id: personaId, pose_id: poseId, part, index },
      }
    );
    return response.data;
  }

  /**
   * Upload a transition video for an animation edge
   */
  async uploadTransitionVideo(personaId: number, edgeId: string, file: File): Promise<UploadVideoResponseDTO> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await this.client.post<UploadVideoResponseDTO>(
      '/character-assets/upload-video',
      formData,
      {
        headers: this.getHeaders(),
        params: { persona_id: personaId, edge_id: edgeId },
        timeout: 60000,
      }
    );
    return response.data;
  }

  /**
   * Get full URL for a character asset image
   */
  getCharacterAssetUrl(assetId: string): string {
    return `${config.apiBaseUrl}/character-assets/${assetId}`;
  }

  /**
   * Migrate character asset IDs (rename pose folders and edge video files on disk)
   */
  async migrateCharacterIds(personaId: number, idMapping: Record<string, string>): Promise<any> {
    const response = await this.client.post(
      `/character-assets/${personaId}/migrate-ids`,
      { id_mapping: idMapping },
      { headers: this.getHeaders() }
    );
    return response.data;
  }

  /**
   * Update a persona's character animation config (pose tree)
   */
  async updateCharacterConfig(personaId: number, characterConfig: CharacterConfigDTO): Promise<any> {
    const response = await this.client.patch(
      `/character-assets/${personaId}/character-config`,
      characterConfig,
      { headers: this.getHeaders() }
    );
    return response.data;
  }

  // VRM models and clips (#236). Raw bodies, not multipart: an `UploadFile`
  // route spools the whole request before it authenticates. The digest rides
  // the query string and the server refuses a body that does not match it.
  // Every failure is a `CharacterUploadError` (`characterUploads.ts`); an
  // aborted upload is one with `code: 'cancelled'`, which a caller drops silently.

  /** Upload (or replace) a persona's VRM model; the server records the ref and returns the stored config. */
  async uploadCharacterModel(
    personaId: number,
    file: Blob,
    opts: { filename?: string; onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal } = {},
  ): Promise<CharacterModelUpload> {
    try {
      throwIfCancelled(opts.signal);
      const sha256 = await sha256Hex(file);
      // Hashing a large model takes a moment; an abort during it must not
      // start the upload.
      throwIfCancelled(opts.signal);
      const name = opts.filename ?? (typeof File !== 'undefined' && file instanceof File ? file.name : undefined);
      const response = await this.client.put<CharacterModelUpload>(
        `/character-assets/${personaId}/vrm/model`,
        file,
        {
          headers: { ...this.getHeaders(), 'Content-Type': 'application/octet-stream' },
          params: { sha256, ...(name ? { filename: name } : {}) },
          signal: opts.signal,
          // A 100 MB model does not finish inside the default 30 s.
          timeout: 0,
          onUploadProgress: (event) => opts.onProgress?.(event.loaded, event.total ?? file.size),
        },
      );
      return response.data;
    } catch (error) {
      throw toCharacterUploadError(error);
    }
  }

  /** Remove a persona's model; its settings stay. */
  async deleteCharacterModel(personaId: number): Promise<void> {
    try {
      await this.client.delete(`/character-assets/${personaId}/vrm/model`, { headers: this.getHeaders() });
    } catch (error) {
      throw toCharacterUploadError(error);
    }
  }

  /** Add a VRMA clip to a persona. */
  async uploadCharacterClip(
    personaId: number,
    file: Blob,
    opts: { name?: string; loop?: boolean; onProgress?: (loaded: number, total: number) => void; signal?: AbortSignal } = {},
  ): Promise<CharacterClipUpload> {
    try {
      throwIfCancelled(opts.signal);
      const sha256 = await sha256Hex(file);
      // Hashing a large model takes a moment; an abort during it must not
      // start the upload.
      throwIfCancelled(opts.signal);
      const name = opts.name ?? (typeof File !== 'undefined' && file instanceof File ? file.name.replace(/\.vrma$/i, '') : undefined);
      const response = await this.client.put<CharacterClipUpload>(
        `/character-assets/${personaId}/vrma`,
        file,
        {
          headers: { ...this.getHeaders(), 'Content-Type': 'application/octet-stream' },
          params: { sha256, ...(name ? { name } : {}), ...(opts.loop ? { loop: true } : {}) },
          signal: opts.signal,
          timeout: 0,
          onUploadProgress: (event) => opts.onProgress?.(event.loaded, event.total ?? file.size),
        },
      );
      return response.data;
    } catch (error) {
      throw toCharacterUploadError(error);
    }
  }

  /** Rename a clip or change whether it loops. */
  async updateCharacterClip(
    personaId: number,
    clipId: string,
    patch: { name?: string; loop?: boolean },
  ): Promise<CharacterClipUpload> {
    try {
      const response = await this.client.patch<CharacterClipUpload>(
        `/character-assets/${personaId}/vrma/${encodeURIComponent(clipId)}`,
        patch,
        { headers: this.getHeaders() },
      );
      return response.data;
    } catch (error) {
      throw toCharacterUploadError(error);
    }
  }

  /** Remove a clip. Refused with `clip_in_use` while the idle rotation or a reaction plays it. */
  async deleteCharacterClip(personaId: number, clipId: string): Promise<void> {
    try {
      await this.client.delete(`/character-assets/${personaId}/vrma/${encodeURIComponent(clipId)}`, {
        headers: this.getHeaders(),
      });
    } catch (error) {
      throw toCharacterUploadError(error);
    }
  }

  /** How much of the account's 3D character storage is used, and the ceilings. */
  async getCharacterUsage(): Promise<CharacterUsage> {
    try {
      const response = await this.client.get<CharacterUsage>('/character-assets/usage', {
        headers: this.getHeaders(),
      });
      return response.data;
    } catch (error) {
      throw toCharacterUploadError(error);
    }
  }

  // Face Recognition Methods

  async listFaces(): Promise<FaceIdentity[]> {
    const response = await this.client.get<FaceIdentity[]>('/faces', {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async createFace(name: string, photo: File): Promise<any> {
    const formData = new FormData();
    formData.append('photo', photo);

    const response = await this.client.post('/faces', formData, {
      headers: this.getHeaders(),
      params: { name },
    });
    return response.data;
  }

  async getFace(id: number): Promise<FaceIdentityDetail> {
    const response = await this.client.get<FaceIdentityDetail>(`/faces/${id}`, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async deleteFace(id: number): Promise<void> {
    await this.client.delete(`/faces/${id}`, {
      headers: this.getHeaders(),
    });
  }

  async addFacePhoto(id: number, photo: File): Promise<any> {
    const formData = new FormData();
    formData.append('photo', photo);

    const response = await this.client.post(`/faces/${id}/photos`, formData, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async deleteFacePhoto(identityId: number, photoId: number): Promise<void> {
    await this.client.delete(`/faces/${identityId}/photos/${photoId}`, {
      headers: this.getHeaders(),
    });
  }

  getFacePhotoUrl(identityId: number, photoId: number): string {
    return `${config.apiBaseUrl}/faces/${identityId}/photos/${photoId}/image`;
  }

  // Skill Methods

  async listSkills(): Promise<Skill[]> {
    const response = await this.client.get<Skill[]>('/skills', {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async createSkill(data: SkillCreate): Promise<Skill> {
    const response = await this.client.post<Skill>('/skills', data, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async updateSkill(id: number, data: SkillUpdate): Promise<Skill> {
    const response = await this.client.patch<Skill>(`/skills/${id}`, data, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async deleteSkill(id: number): Promise<void> {
    await this.client.delete(`/skills/${id}`, {
      headers: this.getHeaders(),
    });
  }

  // Notifications (#353): the server keeps them and their read state; a read
  // here is announced to every device, which takes it down.
  async listNotifications(
    opts: { unread?: boolean; limit?: number; offset?: number } = {},
  ): Promise<{ notifications: NotificationEvent[]; unread_count: number }> {
    const response = await this.client.get<{ notifications: NotificationEvent[]; unread_count: number }>(
      '/notifications',
      { headers: this.getHeaders(), params: opts },
    );
    return response.data;
  }

  async markNotificationRead(id: number): Promise<NotificationEvent> {
    const response = await this.client.post<NotificationEvent>(`/notifications/${id}/read`, null, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async markAllNotificationsRead(): Promise<{ ids: number[]; read_at: string | null }> {
    const response = await this.client.post<{ ids: number[]; read_at: string | null }>('/notifications/read-all', null, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /** Read every unread notification pointing at what the user just opened. */
  async markNotificationsReadFor(
    opened: { conversation_id: number } | { reminder_id: number },
  ): Promise<{ ids: number[]; read_at: string | null }> {
    const response = await this.client.post<{ ids: number[]; read_at: string | null }>('/notifications/read-for', opened, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  // Tasks (#352)
  //
  // The assistant plans tasks with its own tools, so there is no create: the
  // Tasks screen lists them, opens one with its runs, and changes, pauses,
  // stops or deletes it.

  async listTasks(): Promise<AssistantTask[]> {
    const response = await this.client.get<AssistantTask[]>('/tasks', {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /** One task with its ten newest runs. */
  async getTask(id: number): Promise<AssistantTask> {
    const response = await this.client.get<AssistantTask>(`/tasks/${id}`, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /** Change, pause or resume a task; answers with the task and its runs. */
  async updateTask(id: number, data: TaskUpdate): Promise<AssistantTask> {
    const response = await this.client.patch<AssistantTask>(`/tasks/${id}`, data, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /** Tool calls the account's task runs wait on it to approve. */
  async listTaskApprovals(): Promise<TaskApproval[]> {
    const response = await this.client.get<TaskApproval[]>('/tasks/approvals', {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /** Approve or deny a waiting call; the run carries on. 409: it no longer waits. */
  async answerTaskApproval(id: number, approved: boolean, modifiedArgs?: Record<string, unknown>): Promise<TaskApproval> {
    const response = await this.client.post<TaskApproval>(
      `/tasks/approvals/${id}`,
      { approved, ...(modifiedArgs ? { modified_args: modifiedArgs } : {}) },
      { headers: this.getHeaders() },
    );
    return response.data;
  }

  /** Stop the run that is going now. A 409 means nothing was running. */
  async stopTask(id: number): Promise<void> {
    await this.client.post(`/tasks/${id}/stop`, undefined, {
      headers: this.getHeaders(),
    });
  }

  async deleteTask(id: number): Promise<void> {
    await this.client.delete(`/tasks/${id}`, {
      headers: this.getHeaders(),
    });
  }

  // Kurisu Drive (#17)
  //
  // Everything is addressed by node id, not by path: the server builds no
  // filesystem path out of anything sent here. `fileSource.ts` is what turns
  // the explorer's `drive://…` strings into these ids.

  async listDriveNodes(parentId: number | null): Promise<DriveNode[]> {
    const response = await this.client.get<DriveNode[]>('/drive/nodes', {
      headers: this.getHeaders(),
      params: parentId === null ? {} : { parent_id: parentId },
    });
    return response.data;
  }

  async getDriveNode(id: number): Promise<DriveNode> {
    const response = await this.client.get<DriveNode>(`/drive/nodes/${id}`, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /** Resolve `/Reports/Q3.md` to a node. Throws 404 when nothing is there. */
  async resolveDrivePath(path: string): Promise<DriveNode> {
    const response = await this.client.get<DriveNode>('/drive/resolve', {
      headers: this.getHeaders(),
      params: { path },
    });
    return response.data;
  }

  async createDriveFolder(parentId: number | null, name: string): Promise<DriveNode> {
    const response = await this.client.post<DriveNode>(
      '/drive/folders',
      { parent_id: parentId, name },
      { headers: this.getHeaders() },
    );
    return response.data;
  }

  /**
   * Upload one file.
   *
   * The body is the raw bytes and the destination rides the query string —
   * not multipart. A route declaring an `UploadFile` makes the server parse and
   * spool the whole body before it has even authenticated the caller, so the
   * size ceiling and the quota arrive too late to refuse anything.
   *
   * Anything large goes through `electron/driveTransfers.ts` instead, which
   * streams from disk; this is for the small blobs the renderer already holds.
   */
  async uploadDriveFile(
    parentId: number | null,
    name: string,
    body: Blob,
    options: { overwrite?: boolean; signal?: AbortSignal } = {},
  ): Promise<DriveNode> {
    const response = await this.client.post<DriveNode>('/drive/files', body, {
      headers: { ...this.getHeaders(), 'Content-Type': 'application/octet-stream' },
      params: {
        name,
        ...(parentId !== null ? { parent_id: parentId } : {}),
        ...(options.overwrite ? { overwrite: true } : {}),
      },
      signal: options.signal,
      timeout: 0,
    });
    return response.data;
  }

  /** Replace an existing file's bytes — what the editor's Save calls. */
  async writeDriveFile(id: number, content: string): Promise<DriveNode> {
    const response = await this.client.put<DriveNode>(
      `/drive/files/${id}/content`,
      content,
      {
        headers: { ...this.getHeaders(), 'Content-Type': 'application/octet-stream' },
        timeout: 0,
      },
    );
    return response.data;
  }

  /**
   * The first `bytes` of a drive file.
   *
   * A `Range` request, which the drive answers with a 206 — that is what makes
   * "is this text?" answerable without downloading the whole file. A server
   * that ignored the range would return everything, which is still correct,
   * only wasteful.
   */
  async readDriveFileHead(id: number, bytes: number): Promise<ArrayBuffer> {
    const response = await this.client.get<ArrayBuffer>(`/drive/files/${id}/content`, {
      headers: { ...this.getHeaders(), Range: `bytes=0-${bytes - 1}` },
      responseType: 'arraybuffer',
    });
    return response.data;
  }

  async readDriveFile(id: number): Promise<Blob> {
    const response = await this.client.get<Blob>(`/drive/files/${id}/content`, {
      headers: this.getHeaders(),
      responseType: 'blob',
      timeout: 0,
    });
    return response.data;
  }

  async updateDriveNode(
    id: number,
    changes: { name?: string; parent_id?: number | null },
  ): Promise<DriveNode> {
    const response = await this.client.patch<DriveNode>(`/drive/nodes/${id}`, changes, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async deleteDriveNode(id: number): Promise<void> {
    await this.client.delete(`/drive/nodes/${id}`, { headers: this.getHeaders() });
  }

  async getDriveUsage(): Promise<DriveUsage> {
    const response = await this.client.get<DriveUsage>('/drive/usage', {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  // Calendar (#282)
  //
  // The user's own events and reminders. Instants travel as ISO 8601 UTC; an
  // all-day event is a pair of dates. An entry of another account is 404.

  async listCalendarEntries(start: string, end: string): Promise<CalendarEntry[]> {
    const response = await this.client.get<CalendarEntry[]>('/calendar/entries', {
      headers: this.getHeaders(),
      params: { start, end },
    });
    return response.data;
  }

  async getUpcomingCalendar(limit = 20): Promise<CalendarEntry[]> {
    const response = await this.client.get<CalendarEntry[]>('/calendar/upcoming', {
      headers: this.getHeaders(),
      params: { limit },
    });
    return response.data;
  }

  async getCalendarEntry(id: number): Promise<CalendarEntry> {
    const response = await this.client.get<CalendarEntry>(`/calendar/entries/${id}`, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async createCalendarEntry(body: CalendarEntryCreate): Promise<CalendarEntry> {
    const response = await this.client.post<CalendarEntry>('/calendar/entries', body, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async updateCalendarEntry(id: number, changes: CalendarEntryUpdate): Promise<CalendarEntry> {
    const response = await this.client.patch<CalendarEntry>(`/calendar/entries/${id}`, changes, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async deleteCalendarEntry(id: number): Promise<void> {
    await this.client.delete(`/calendar/entries/${id}`, { headers: this.getHeaders() });
  }

  /**
   * A URL the Electron main process can stream from.
   *
   * The token rides the query string because the download runs outside the
   * renderer and cannot set an Authorization header — the same reason the
   * images routes accept one.
   */
  driveDownloadUrl(id: number): string {
    const token = this.token ?? '';
    return `${config.apiBaseUrl}/drive/files/${id}/content?token=${encodeURIComponent(token)}`;
  }
}

export const apiClient = new APIClient();
