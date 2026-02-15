import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { wsManager } from './websocket';
import type {
  LoginResponse,
  Conversation,
  ConversationDetail,
  Message,
  MessageRawData,
  UserProfile,
  VoicesResponse,
  BackendsResponse,
  TTSRequest,
  Agent,
  AgentCreate,
  AgentUpdate,
  ToolsResponse,
  MCPServersResponse,
  UploadBaseResponseDTO,
  ComputePatchResponseDTO,
  UploadVideoResponseDTO,
  CharacterConfigDTO,
  FaceIdentity,
  FaceIdentityDetail,
  AvatarCandidate,
} from './types';

class APIClient {
  private client: AxiosInstance;
  private token: string | null = null;

  constructor() {
    this.client = axios.create({
      timeout: 30000,
    });

    // Read baseURL dynamically so it picks up changes from storage
    this.client.interceptors.request.use((reqConfig) => {
      reqConfig.baseURL = config.apiBaseUrl;
      return reqConfig;
    });
  }

  setToken(token: string) {
    this.token = token;
    wsManager.setToken(token);
  }

  clearToken() {
    this.token = null;
    wsManager.clearToken();
    wsManager.disconnect();
  }

  private getHeaders() {
    const headers: Record<string, string> = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }
    return headers;
  }

  async login(username: string, password: string): Promise<LoginResponse> {
    const formData = new FormData();
    formData.append('username', username);
    formData.append('password', password);

    const response = await this.client.post<LoginResponse>('/login', formData);
    this.setToken(response.data.access_token);
    return response.data;
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
    return response.data;
  }

  async getConversations(): Promise<Conversation[]> {
    const response = await this.client.get<Conversation[]>('/conversations', {
      headers: this.getHeaders(),
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

  async updateConversation(id: number, title: string): Promise<void> {
    await this.client.post(
      `/conversations/${id}`,
      { title },
      { headers: this.getHeaders() }
    );
  }

  async deleteMessage(messageId: number): Promise<{ deleted: number }> {
    const response = await this.client.delete<{ deleted: number }>(`/messages/${messageId}`, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async getMessageRaw(messageId: number): Promise<MessageRawData> {
    const response = await this.client.get<MessageRawData>(`/messages/${messageId}/raw`, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async getModels(): Promise<string[]> {
    const response = await this.client.get<{ models: string[] }>('/models', {
      headers: this.getHeaders(),
    });
    return response.data.models;
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

  async updateUserAvatars(userAvatar?: File, agentAvatar?: File): Promise<any> {
    const formData = new FormData();

    if (userAvatar) {
      formData.append('user_avatar', userAvatar);
    }
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

  getImageUrl(uuid: string): string {
    return `${config.apiBaseUrl}/images/${uuid}`;
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
   * List available TTS backends
   */
  async listBackends(): Promise<string[]> {
    const response = await this.client.get<BackendsResponse>('/tts/backends', {
      headers: this.getHeaders(),
    });
    return response.data.backends;
  }

  // ASR Methods

  /**
   * Transcribe raw Int16 PCM audio (16kHz mono) to text
   */
  async transcribe(audio: ArrayBuffer): Promise<string> {
    const response = await this.client.post<{ text: string }>('/asr', audio, {
      headers: { ...this.getHeaders(), 'Content-Type': 'application/octet-stream' },
      timeout: 30000,
    });
    return response.data.text;
  }

  // Agent Methods

  /**
   * List all agents for the current user
   */
  async listAgents(): Promise<Agent[]> {
    const response = await this.client.get<Agent[]>('/agents', {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * Get a specific agent by ID
   */
  async getAgent(id: number): Promise<Agent> {
    const response = await this.client.get<Agent>(`/agents/${id}`, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * Create a new agent
   */
  async createAgent(data: AgentCreate): Promise<Agent> {
    const response = await this.client.post<Agent>('/agents', data, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * Update an existing agent
   */
  async updateAgent(id: number, data: AgentUpdate): Promise<Agent> {
    const response = await this.client.patch<Agent>(`/agents/${id}`, data, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * Update agent avatar
   */
  async updateAgentAvatar(id: number, avatar: File): Promise<Agent> {
    const formData = new FormData();
    formData.append('avatar', avatar);

    const response = await this.client.patch<Agent>(`/agents/${id}/avatar`, formData, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * Update agent voice reference
   */
  async updateAgentVoice(id: number, voice: File): Promise<Agent> {
    const formData = new FormData();
    formData.append('voice', voice);

    const response = await this.client.patch<Agent>(`/agents/${id}/voice`, formData, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  /**
   * Delete an agent
   */
  async deleteAgent(id: number): Promise<void> {
    await this.client.delete(`/agents/${id}`, {
      headers: this.getHeaders(),
    });
  }

  /**
   * Get avatar candidates detected from character pose base images
   */
  async getAvatarCandidates(agentId: number): Promise<AvatarCandidate[]> {
    const response = await this.client.get<AvatarCandidate[]>(`/agents/${agentId}/avatar-candidates`, {
      headers: this.getHeaders(),
      timeout: 60000,
    });
    return response.data;
  }

  /**
   * Set agent avatar from an existing image UUID
   */
  async setAgentAvatarFromUuid(agentId: number, uuid: string): Promise<Agent> {
    const response = await this.client.post<Agent>(`/agents/${agentId}/avatar-from-uuid`, { avatar_uuid: uuid }, {
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
   * List MCP servers and their status
   */
  async listMCPServers(): Promise<MCPServersResponse> {
    const response = await this.client.get<MCPServersResponse>('/mcp-servers', {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  // Character Asset Methods

  /**
   * Upload a base portrait image for character animation
   */
  async uploadCharacterBase(agentId: number, poseId: string, file: File): Promise<UploadBaseResponseDTO> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await this.client.post<UploadBaseResponseDTO>(
      '/character-assets/upload-base',
      formData,
      {
        headers: this.getHeaders(),
        params: { agent_id: agentId, pose_id: poseId },
      }
    );
    return response.data;
  }

  /**
   * Upload a keyframe image and compute diff patch against the pose's base image
   */
  async computeCharacterPatch(
    agentId: number,
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
        params: { agent_id: agentId, pose_id: poseId, part, index },
      }
    );
    return response.data;
  }

  /**
   * Upload a transition video for an animation edge
   */
  async uploadTransitionVideo(agentId: number, edgeId: string, file: File): Promise<UploadVideoResponseDTO> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await this.client.post<UploadVideoResponseDTO>(
      '/character-assets/upload-video',
      formData,
      {
        headers: this.getHeaders(),
        params: { agent_id: agentId, edge_id: edgeId },
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
   * Update an agent's character animation config (pose tree)
   */
  async updateCharacterConfig(agentId: number, characterConfig: CharacterConfigDTO): Promise<any> {
    const response = await this.client.patch(
      `/character-assets/${agentId}/character-config`,
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
}

export const apiClient = new APIClient();
