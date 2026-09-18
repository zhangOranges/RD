// AI 终端智能体相关类型定义

/** AI 模型配置（前端可见，不含 apiKey 明文） */
export interface AiModelConfig {
  id: string;
  name: string;
  provider: 'openai-compatible';
  baseUrl: string;
  /** apiKey 前端不持有明文，仅在保存时由前端传入后端 */
  apiKey?: string;
  model: string;
  temperature: number;
  maxTokens: number;
  isDefault: boolean;
}

/** 聊天消息角色 */
export type AiChatRole = 'system' | 'user' | 'assistant';

/** 聊天消息（发送给后端的历史消息） */
export interface AiChatMessage {
  role: AiChatRole;
  content: string;
}

/** 当前主机上下文（注入 system prompt） */
export interface AiChatContext {
  hostName: string;
  os: string;
  shell: string;
  cwd: string;
}

/** 对话流中的消息（含解析出的命令与执行结果） */
export interface AiConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 从 assistant 消息中解析出的 bash 命令块 */
  commands?: string[];
  /** 用户点击执行后的结果 */
  executionResults?: Record<number, AiExecutionResult>;
  /** 是否正在流式输出中 */
  streaming?: boolean;
}

/** 命令执行结果 */
export interface AiExecutionResult {
  command: string;
  output: string;
  success: boolean;
}

/** AI 对话会话 */
export interface AiSession {
  id: string;
  title: string;
  messages: AiConversationMessage[];
  createdAt: number;
  updatedAt: number;
}

/** 流式事件类型（Rust → 前端 Tauri 事件） */
export type AiStreamEvent = 'token' | 'done' | 'error';

/** 流式事件 payload */
export interface AiStreamPayload {
  streamId: string;
  event: AiStreamEvent;
  delta?: string;
  error?: string;
}
