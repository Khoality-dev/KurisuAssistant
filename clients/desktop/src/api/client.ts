import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import type {
  LoginResponse,
  Conversation,
  ConversationDetail,
  Message,
  StreamChunk,
  UserProfile,
} from './types';

class APIClient {
  private client: AxiosInstance;
  private token: string | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: config.apiBaseUrl,
      timeout: 30000,
    });
  }

  setToken(token: string) {
    this.token = token;
  }

  clearToken() {
    this.token = null;
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

  async *chatStream(
    text: string,
    modelName: string,
    conversationId: number | null = null,
    images: File[] = []
  ): AsyncGenerator<StreamChunk> {
    const formData = new FormData();
    formData.append('text', text);
    formData.append('model_name', modelName);
    if (conversationId !== null) {
      formData.append('conversation_id', conversationId.toString());
    }
    images.forEach((image) => {
      formData.append('images', image);
    });

    console.log('[APIClient] Starting chat stream...');
    console.log('[APIClient] Request params:', { text, modelName, conversationId, imageCount: images.length });

    // Use native fetch for streaming (works better in browser than Axios)
    const headers: Record<string, string> = {};
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const response = await fetch(`${config.apiBaseUrl}/chat`, {
      method: 'POST',
      headers,
      body: formData,
    });

    console.log('[APIClient] Response status:', response.status);
    console.log('[APIClient] Response headers:', Object.fromEntries(response.headers.entries()));

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Response body is not readable');
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let chunkCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          console.log('[APIClient] Stream ended, total chunks received:', chunkCount);
          break;
        }

        const decodedText = decoder.decode(value, { stream: true });
        console.log('[APIClient] Raw received data:', decodedText);

        buffer += decodedText;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.trim()) {
            try {
              const chunk: StreamChunk = JSON.parse(line);
              chunkCount++;
              console.log(`[APIClient] Parsed chunk #${chunkCount}:`, JSON.stringify(chunk));
              yield chunk;
            } catch (e) {
              console.error('[APIClient] Failed to parse chunk:', line, e);
            }
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const chunk: StreamChunk = JSON.parse(buffer);
          chunkCount++;
          console.log(`[APIClient] Parsed final chunk #${chunkCount}:`, JSON.stringify(chunk));
          yield chunk;
        } catch (e) {
          console.error('[APIClient] Failed to parse final chunk:', buffer, e);
        }
      }
    } finally {
      reader.releaseLock();
      console.log('[APIClient] Reader released');
    }
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

  async updateUserProfile(profile: Partial<UserProfile>): Promise<UserProfile> {
    const response = await this.client.put<UserProfile>('/users/me', profile, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  async uploadImage(file: File): Promise<{ uuid: string }> {
    const formData = new FormData();
    formData.append('image', file);

    const response = await this.client.post<{ uuid: string }>('/images', formData, {
      headers: this.getHeaders(),
    });
    return response.data;
  }

  getImageUrl(uuid: string): string {
    return `${config.apiBaseUrl}/images/${uuid}`;
  }
}

export const apiClient = new APIClient();
