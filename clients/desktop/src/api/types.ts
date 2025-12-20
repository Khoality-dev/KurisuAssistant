export interface LoginResponse {
  access_token: string;
  token_type: string;
}

export interface Message {
  id?: number;
  role: string; // Can be 'user', 'assistant', 'tool', or any custom agent role
  content: string;
  images?: string[];
  chunk_id?: number;
  created_at?: string;
}

export interface Conversation {
  id: number;
  title: string;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export interface ConversationDetail {
  id: number;
  title: string;
  created_at: string;
  messages: Message[];
  total_messages: number;
  offset: number;
  limit: number;
  has_more: boolean;
}

export interface StreamChunk {
  message?: Message;
  conversation_id?: number;
  chunk_id?: number;
  done?: boolean;
}

export interface UserProfile {
  username: string;
  email?: string;
  system_prompt?: string;
  user_avatar?: string;
  assistant_avatar?: string;
}
