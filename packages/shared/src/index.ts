export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
}

export * from './contracts.js';
export * from './config.js';
