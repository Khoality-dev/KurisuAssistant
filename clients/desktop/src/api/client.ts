import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { WIRE_PROTOCOL } from '../constants';
import { wsManager } from './websocket';
import type {
  LoginResponse,
  ServerVersionInfo,
  Conversation,
  ConversationDetail,
  MessageRawData,
  UserProfile,
  VoicesResponse,
  TTSModelsResponse,
  PullModelResponse,
  TTSRequest,
  Assistant,
  AssistantUpdate,
  Persona,
  PersonaCreate,
  PersonaUpdate,
  SubAgent,
  SubAgentCreate,
  SubAgentUpdate,
  ConversationUpdate,
  ToolsResponse,
  MCPServer,
  MCPServerCreate,
  MCPServerUpdate,
  MCPServerTestResult,
  UploadBaseResponseDTO,
  ComputePatchResponseDTO,
  UploadVideoResponseDTO,
  CharacterConfigDTO,
  FaceIdentity,
  FaceIdentityDetail,
  Skill,
  SkillCreate,
  SkillUpdate,
} from './types';

class APIClient {
  private client: AxiosInstance;
  private token: string | null = null;
  private refreshToken: string | null = null;
  private refreshPromise: Promise<string> | null = null;
  private _onAuthFailure: (() => void) | null = null;

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

    // Auto-refresh on 401 responses
    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
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

  setToken(token: string) {
    this.token = token;
    wsManager.setToken(token);
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

      // Persist if remember-me is on
      const { storage } = await import('../utils/storage');
      if (storage.getRememberMe()) {
        storage.setToken(newToken);
      }
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

  async getConversations(personaId?: number): Promise<Conversation[]> {
    const response = await this.client.get<Conversation[]>('/conversations', {
      headers: this.getHeaders(),
      params: personaId ? { persona_id: personaId } : undefined,
    });
    return response.data;
  }

  /**
   * The latest conversation bound to a persona, or null. `?persona_id=` returns a
   * one-element list with no message_count and no last_message, so only the id is
   * dependable here.
   */
  async getLatestConversationForPersona(personaId: number): Promise<Conversation | null> {
    const response = await this.client.get<Conversation[]>('/conversations', {
      headers: this.getHeaders(),
      params: { persona_id: personaId },
    });
    return response.data.length > 0 ? response.data[0] : null;
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
   * Rename a conversation, rebind it to a persona, or both. Replaces the old
   * POST /conversations/{id}. Omitted fields are untouched; `persona_id: null`
   * unbinds, so the next message falls back to the assistant's default persona.
   */
  async patchConversation(
    id: number,
    data: ConversationUpdate,
  ): Promise<{ id: number; title: string; persona_id: number | null }> {
    const response = await this.client.patch<{ id: number; title: string; persona_id: number | null }>(
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

  async getModels(): Promise<Array<{ name: string; provider: string }>> {
    const response = await this.client.get<{ models: any[] }>('/models', {
      headers: this.getHeaders(),
    });
    // Handle both old format (string[]) and new format ({name, provider}[])
    return response.data.models.map((m: any) =>
      typeof m === 'string' ? { name: m, provider: 'ollama' } : m
    );
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

  // Tool Policies Methods

  async getToolPolicies(): Promise<{ tools: Record<string, 'allow' | 'deny'> }> {
    const response = await this.client.get('/users/me/tool-policies', {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async updateToolPolicies(policies: { tools: Record<string, 'allow' | 'deny'> }): Promise<void> {
    await this.client.put('/users/me/tool-policies', policies, {
      headers: this.getHeaders(),
    });
  }

  async patchToolPolicy(toolName: string, policy: 'allow' | 'deny' | null): Promise<void> {
    await this.client.patch('/users/me/tool-policies', {
      tool_name: toolName,
      policy: policy,
    }, {
      headers: this.getHeaders(),
    });
  }

  async uploadImage(file: File): Promise<{ image_uuid: string; url: string }> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await this.client.post<{ image_uuid: string; url: string }>('/images', formData, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  getImageUrl(uuid: string): string {
    return `${config.apiBaseUrl}/images/${uuid}`;
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
    emotionParams?: {
      emo_audio?: string;
      emo_alpha?: number;
      use_emo_text?: boolean;
    },
  ): Promise<Blob> {
    const requestData: TTSRequest = {
      text,
      voice,
      language,
      provider: backend, // Map 'backend' to 'provider' for API
      ...emotionParams, // Spread emotion parameters if provided
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
   * List available TTS voices (scans reference/ folder)
   */
  async listVoices(backend?: string): Promise<string[]> {
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

  /** Get the user's assistant (capability + default persona). */
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

  /** Create a persona. The user's first persona also becomes their default. */
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
   * Delete a persona. The backend refuses (400) to delete the last one — a user
   * with no persona cannot start a conversation.
   */
  async deletePersona(id: number): Promise<void> {
    await this.client.delete(`/personas/${id}`, {
      headers: this.getHeaders(),
    });
  }

  /** Enable/disable a persona. Disabling the default is refused (400). */
  async togglePersonaEnabled(id: number, enabled: boolean): Promise<Persona> {
    const response = await this.client.patch<Persona>(`/personas/${id}/enabled`, { enabled }, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * Export a persona as JSON. Media does not travel: avatar, voice reference and
   * character config are handles to files on this server and are left out.
   */
  async exportPersona(id: number): Promise<Blob> {
    const response = await this.client.get(`/personas/${id}/export`, {
      headers: this.getHeaders(),
      responseType: 'blob',
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

  // Sub-Agent Methods

  /** List the user's sub-agents, enabled or not, oldest first. */
  async listSubAgents(): Promise<SubAgent[]> {
    const response = await this.client.get<SubAgent[]>('/sub-agents', {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async getSubAgent(id: number): Promise<SubAgent> {
    const response = await this.client.get<SubAgent>(`/sub-agents/${id}`, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async createSubAgent(data: SubAgentCreate): Promise<SubAgent> {
    const response = await this.client.post<SubAgent>('/sub-agents', data, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async updateSubAgent(id: number, data: SubAgentUpdate): Promise<SubAgent> {
    const response = await this.client.patch<SubAgent>(`/sub-agents/${id}`, data, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async deleteSubAgent(id: number): Promise<void> {
    await this.client.delete(`/sub-agents/${id}`, {
      headers: this.getHeaders(),
    });
  }

  async toggleSubAgentEnabled(id: number, enabled: boolean): Promise<SubAgent> {
    const response = await this.client.patch<SubAgent>(`/sub-agents/${id}/enabled`, { enabled }, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async exportSubAgent(id: number): Promise<Blob> {
    const response = await this.client.get(`/sub-agents/${id}/export`, {
      headers: this.getHeaders(),
      responseType: 'blob',
    });
    return response.data;
  }

  async importSubAgent(file: File): Promise<SubAgent> {
    const formData = new FormData();
    formData.append('file', file);
    const response = await this.client.post<SubAgent>('/sub-agents/import', formData, {
      headers: this.getHeaders(),
    });
    return response.data;
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
}

export const apiClient = new APIClient();
