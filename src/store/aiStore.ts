import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AiModelConfig,
  AiChatMessage,
  AiChatContext,
  AiConversationMessage,
  AiSession,
} from '../types/ai';
import { useHostStore } from './hostStore';
import { useFileStore } from './fileStore';
import { useUIStore } from './uiStore';
import { logInfo, logError } from '../utils/log';

interface AiState {
  // 模型
  models: AiModelConfig[];
  defaultModelId: string | null;
  selectedModelId: string | null;

  // 多会话
  sessions: AiSession[];
  currentSessionId: string | null;
  messages: AiConversationMessage[];
  isLoading: boolean;
  isPanelOpen: boolean;
  activeTab: 'chat' | 'history';

  // 事件监听（全局，仅注册一次）
  _tokenUnlisten: UnlistenFn | null;
  _doneUnlisten: UnlistenFn | null;
  _errorUnlisten: UnlistenFn | null;
  _pendingStreamId: string | null;

  // actions
  loadModels: () => Promise<void>;
  saveModel: (config: AiModelConfig) => Promise<void>;
  deleteModel: (id: string) => Promise<void>;
  setDefaultModel: (id: string) => Promise<void>;
  testModel: (id: string) => Promise<{ ok: boolean; msg: string }>;
  selectModel: (id: string) => void;

  // 会话管理
  createSession: () => string;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  setActiveTab: (tab: 'chat' | 'history') => void;
  _persistSessions: () => void;
  _persistTimer: ReturnType<typeof setTimeout> | null;
  _updateCurrentSession: (updater: (s: AiSession) => AiSession) => void;

  sendMessage: (text: string) => Promise<void>;
  stopChat: () => Promise<void>;
  retryLastMessage: () => Promise<void>;
  executeCommand: (messageId: string, commandIndex: number, command: string) => Promise<void>;
  clearMessages: () => void;
  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;

  initEventListeners: () => void;
}

const genId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 从 assistant 消息文本中提取 ```bash ... ``` 代码块 */
export function extractCommands(content: string): string[] {
  const commands: string[] = [];
  const regex = /```(?:bash|shell|sh)?\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const cmd = match[1].trim();
    if (cmd) commands.push(cmd);
  }
  return commands;
}

/** 危险命令检测（需二次确认） */
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\/\s*$/,
  /\brm\s+-rf\s+\/\s/,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\b:\(\)\s*\{.*\};:\b/, // fork bomb
  /\bshutdown\b/,
  /\breboot\b/,
  /\bhalt\b/,
  /\bchmod\s+-R\s+777\s+\//,
  /\bchown\s+-R\s+/,
];

export function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some((p) => p.test(cmd));
}

const STORAGE_KEY = 'rd_ai_sessions';

function loadSessions(): AiSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as AiSession[];
  } catch {
    return [];
  }
}

export const useAiStore = create<AiState>((set, get) => ({
  models: [],
  defaultModelId: null,
  selectedModelId: null,
  sessions: loadSessions(),
  currentSessionId: null,
  messages: [],
  isLoading: false,
  isPanelOpen: false,
  activeTab: 'chat',
  _persistTimer: null,
  _tokenUnlisten: null,
  _doneUnlisten: null,
  _errorUnlisten: null,
  _pendingStreamId: null,

  loadModels: async () => {
    try {
      const models = await invoke<AiModelConfig[]>('ai_list_models');
      const def = models.find((m) => m.isDefault) || null;
      set({
        models,
        defaultModelId: def?.id ?? null,
        selectedModelId:
          get().selectedModelId || def?.id || models[0]?.id || null,
      });
    } catch (e) {
      logError(`ai loadModels 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  },

  saveModel: async (config) => {
    await invoke('ai_save_model', { config });
    await get().loadModels();
  },

  deleteModel: async (id) => {
    await invoke('ai_delete_model', { id });
    await get().loadModels();
  },

  setDefaultModel: async (id) => {
    await invoke('ai_set_default_model', { id });
    await get().loadModels();
  },

  testModel: async (id) => {
    try {
      const reply = await invoke<string>('ai_test_model', { id });
      return { ok: true, msg: reply };
    } catch (e) {
      return { ok: false, msg: e instanceof Error ? e.message : String(e) };
    }
  },

  selectModel: (id) => set({ selectedModelId: id }),

  // ===== 会话管理 =====

  _persistSessions: () => {
    // 防抖：500ms 内只写一次 localStorage，避免流式输出时频繁写入
    if (get()._persistTimer) clearTimeout(get()._persistTimer!);
    set({
      _persistTimer: setTimeout(() => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(get().sessions));
        } catch {
          // localStorage 满或不可用，忽略
        }
        set({ _persistTimer: null });
      }, 500),
    });
  },

  _updateCurrentSession: (updater) => {
    const sid = get().currentSessionId;
    if (!sid) return;
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === sid ? updater(s) : s,
      ),
    }));
    get()._persistSessions();
  },

  createSession: () => {
    const id = genId();
    const now = Date.now();
    const session: AiSession = {
      id,
      title: '',
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({
      sessions: [session, ...state.sessions],
      currentSessionId: id,
      messages: [],
      activeTab: 'chat',
    }));
    get()._persistSessions();
    return id;
  },

  switchSession: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session) return;
    set({
      currentSessionId: id,
      messages: session.messages.map((m) => ({ ...m, streaming: false })),
      activeTab: 'chat',
    });
  },

  deleteSession: (id) => {
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const wasCurrent = state.currentSessionId === id;
      if (wasCurrent) {
        const next = sessions[0] || null;
        return {
          sessions,
          currentSessionId: next?.id ?? null,
          messages: next?.messages.map((m) => ({ ...m, streaming: false })) ?? [],
        };
      }
      return { sessions };
    });
    get()._persistSessions();
  },

  setActiveTab: (tab) => set({ activeTab: tab }),

  initEventListeners: () => {
    const s = get();
    if (s._tokenUnlisten) return; // 已注册

    // token 事件：追加到最后一条 assistant 消息
    const tokenUnlisten = listen<{ streamId: string; delta: string }>(
      'ai:token',
      (event) => {
        const { streamId, delta } = event.payload;
        if (streamId !== get()._pendingStreamId) return;
        set((state) => {
          const msgs = [...state.messages];
          const last = msgs[msgs.length - 1];
          if (last && last.role === 'assistant' && last.streaming) {
            last.content += delta;
            last.commands = extractCommands(last.content);
          }
          // 同步到 session
          const sid = state.currentSessionId;
          const sessions = sid
            ? state.sessions.map((s) =>
                s.id === sid
                  ? { ...s, messages: msgs, updatedAt: Date.now() }
                  : s,
              )
            : state.sessions;
          return { messages: msgs, sessions };
        });
        get()._persistSessions();
      },
    );

    // done 事件：标记流式结束
    const doneUnlisten = listen<{ streamId: string }>('ai:done', (event) => {
      if (event.payload.streamId !== get()._pendingStreamId) return;
      set((state) => {
        const msgs = state.messages.map((m, i) =>
          i === state.messages.length - 1 && m.role === 'assistant'
            ? { ...m, streaming: false }
            : m,
        );
        const sid = state.currentSessionId;
        const sessions = sid
          ? state.sessions.map((s) =>
              s.id === sid
                ? { ...s, messages: msgs, updatedAt: Date.now() }
                : s,
            )
          : state.sessions;
        return {
          isLoading: false,
          _pendingStreamId: null,
          messages: msgs,
          sessions,
        };
      });
      get()._persistSessions();
    });

    // error 事件：显示错误
    const errorUnlisten = listen<{ streamId: string; error: string }>(
      'ai:error',
      (event) => {
        if (event.payload.streamId !== get()._pendingStreamId) return;
        const err = event.payload.error;
        set((state) => {
          const msgs = state.messages.map((m, i) =>
            i === state.messages.length - 1 && m.role === 'assistant'
              ? { ...m, streaming: false, content: m.content || err }
              : m,
          );
          const sid = state.currentSessionId;
          const sessions = sid
            ? state.sessions.map((s) =>
                s.id === sid
                  ? { ...s, messages: msgs, updatedAt: Date.now() }
                  : s,
              )
            : state.sessions;
          return {
            isLoading: false,
            _pendingStreamId: null,
            messages: msgs,
            sessions,
          };
        });
        get()._persistSessions();
        logError(`ai chat error: ${err}`);
      },
    );

    Promise.all([tokenUnlisten, doneUnlisten, errorUnlisten]).then(
      ([t, d, e]) => {
        set({ _tokenUnlisten: t, _doneUnlisten: d, _errorUnlisten: e });
      },
    );
  },

  sendMessage: async (text) => {
    const s = get();
    if (!text.trim() || s.isLoading) return;

    // 选择模型
    const modelId = s.selectedModelId || s.defaultModelId;
    if (!modelId) {
      logError('ai: 无可用模型');
      return;
    }

    // 确保事件监听已注册
    s.initEventListeners();

    // 自动创建会话
    let sessionId = s.currentSessionId;
    if (!sessionId) {
      sessionId = get().createSession();
    }

    // 构造历史消息（不含 system，由后端拼接）
    const history: AiChatMessage[] = s.messages
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }));
    history.push({ role: 'user', content: text });

    // 构造上下文
    const hostStore = useHostStore.getState();
    const fileStore = useFileStore.getState();
    const hostId = hostStore.selectedHostId;
    const host = hostId ? hostStore.hosts.find((h) => h.id === hostId) : null;
    const cwd =
      fileStore.currentPath ||
      (hostId && hostStore.homeDirs[hostId]) ||
      '~';
    const context: AiChatContext = {
      hostName: host?.name || 'unknown',
      os: 'linux',
      shell: 'bash',
      cwd,
    };

    // 添加用户消息 + 空 assistant 消息（流式填充）
    const userMsg: AiConversationMessage = {
      id: genId(),
      role: 'user',
      content: text,
    };
    const assistantMsg: AiConversationMessage = {
      id: genId(),
      role: 'assistant',
      content: '',
      streaming: true,
    };

    const newMsgs = [...s.messages, userMsg, assistantMsg];
    // 自动生成标题：第一条消息取前 30 字符
    const title = s.sessions.find((sv) => sv.id === sessionId)?.title || '';
    const newTitle = !title ? text.slice(0, 30) : title;

    set((state) => ({
      messages: newMsgs,
      isLoading: true,
      sessions: state.sessions.map((sv) =>
        sv.id === sessionId
          ? { ...sv, messages: newMsgs, title: newTitle, updatedAt: Date.now() }
          : sv,
      ),
    }));
    get()._persistSessions();

    try {
      const streamId = await invoke<string>('ai_chat_stream', {
        modelId,
        messages: history,
        context,
      });
      set({ _pendingStreamId: streamId });
      logInfo(`ai chat stream started: ${streamId}`);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      set((state) => ({
        isLoading: false,
        _pendingStreamId: null,
        messages: state.messages.map((m, i) =>
          i === state.messages.length - 1 && m.role === 'assistant'
            ? { ...m, streaming: false, content: err }
            : m,
        ),
      }));
      get()._updateCurrentSession((sv) => ({
        ...sv,
        messages: get().messages,
        updatedAt: Date.now(),
      }));
      logError(`ai chat failed: ${err}`);
    }
  },

  executeCommand: async (messageId, commandIndex, command) => {
    const hostStore = useHostStore.getState();
    const uiStore = useUIStore.getState();
    const hostId = hostStore.selectedHostId;
    if (!hostId) {
      logError('ai executeCommand: 未选择主机');
      return;
    }
    const connState = hostStore.connectionStates[hostId];
    if (connState !== 'connected') {
      logError('ai executeCommand: 主机未连接');
      return;
    }

    // 获取激活的终端 tab
    const tabId = uiStore.activeTerminalTab[hostId];
    if (!tabId) {
      logError('ai executeCommand: 无激活终端');
      return;
    }

    // 标记为已发送到终端
    set((state) => {
      const msgs = state.messages.map((m) => {
        if (m.id !== messageId) return m;
        const results = { ...(m.executionResults || {}) };
        results[commandIndex] = {
          command,
          output: '',
          success: true,
        };
        return { ...m, executionResults: results };
      });
      const sid = state.currentSessionId;
      const sessions = sid
        ? state.sessions.map((s) =>
            s.id === sid ? { ...s, messages: msgs, updatedAt: Date.now() } : s,
          )
        : state.sessions;
      return { messages: msgs, sessions };
    });
    get()._persistSessions();

    // 向激活终端发送命令 + 回车
    try {
      const data = `${command}\n`;
      const bytes = Array.from(new TextEncoder().encode(data));
      await invoke('pty_write', { hostId, tabId, data: bytes });
      logInfo(`ai executeCommand: 已发送到终端 ${tabId}`);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      logError(`ai executeCommand: 发送失败 ${err}`);
      set((state) => {
        const msgs = state.messages.map((m) => {
          if (m.id !== messageId) return m;
          const results = { ...(m.executionResults || {}) };
          results[commandIndex] = { command, output: err, success: false };
          return { ...m, executionResults: results };
        });
        const sid = state.currentSessionId;
        const sessions = sid
          ? state.sessions.map((s) =>
              s.id === sid ? { ...s, messages: msgs, updatedAt: Date.now() } : s,
            )
          : state.sessions;
        return { messages: msgs, sessions };
      });
      get()._persistSessions();
    }
  },

  stopChat: async () => {
    const s = get();
    const streamId = s._pendingStreamId;
    if (!streamId) return;
    try {
      await invoke('ai_chat_stop', { streamId });
    } catch {
      // 忽略
    }
    set((state) => ({
      isLoading: false,
      _pendingStreamId: null,
      messages: state.messages.map((m, i) =>
        i === state.messages.length - 1 && m.role === 'assistant' && m.streaming
          ? { ...m, streaming: false }
          : m,
      ),
    }));
    get()._updateCurrentSession((sv) => ({
      ...sv,
      messages: get().messages,
      updatedAt: Date.now(),
    }));
    logInfo('ai chat stopped by user');
  },

  retryLastMessage: async () => {
    const s = get();
    if (s.isLoading) return;
    const msgs = s.messages;
    if (msgs.length < 2) return;

    // 确保事件监听已注册
    s.initEventListeners();

    // 如果有未清理的旧 stream，先停止
    if (s._pendingStreamId) {
      try {
        await invoke('ai_chat_stop', { streamId: s._pendingStreamId });
      } catch {
        // 忽略
      }
    }

    // 找到最后一条 user 消息
    let lastUserText = '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'user') {
        lastUserText = msgs[i].content;
        break;
      }
    }
    if (!lastUserText) return;

    // 移除最后一条 assistant 消息
    const lastIdx = msgs.length - 1;
    const newMsgs = msgs.filter((_, i) => i !== lastIdx);

    // 添加新的空 assistant 消息
    const assistantMsg: AiConversationMessage = {
      id: genId(),
      role: 'assistant',
      content: '',
      streaming: true,
    };
    const updatedMsgs = [...newMsgs, assistantMsg];

    set((state) => ({
      messages: updatedMsgs,
      isLoading: true,
      sessions: state.sessions.map((sv) =>
        sv.id === state.currentSessionId
          ? { ...sv, messages: updatedMsgs, updatedAt: Date.now() }
          : sv,
      ),
    }));
    get()._persistSessions();

    // 构造历史消息
    const history: AiChatMessage[] = newMsgs
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }));

    // 构造上下文
    const hostStore = useHostStore.getState();
    const fileStore = useFileStore.getState();
    const hostId = hostStore.selectedHostId;
    const host = hostId ? hostStore.hosts.find((h) => h.id === hostId) : null;
    const cwd =
      fileStore.currentPath ||
      (hostId && hostStore.homeDirs[hostId]) ||
      '~';
    const context: AiChatContext = {
      hostName: host?.name || 'unknown',
      os: 'linux',
      shell: 'bash',
      cwd,
    };

    const modelId = s.selectedModelId || s.defaultModelId;
    if (!modelId) {
      logError('ai retry: 无可用模型');
      return;
    }

    try {
      const streamId = await invoke<string>('ai_chat_stream', {
        modelId,
        messages: history,
        context,
      });
      set({ _pendingStreamId: streamId });
      logInfo(`ai chat retry started: ${streamId}`);
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e);
      set((state) => ({
        isLoading: false,
        _pendingStreamId: null,
        messages: state.messages.map((m, i) =>
          i === state.messages.length - 1 && m.role === 'assistant'
            ? { ...m, streaming: false, content: err }
            : m,
        ),
      }));
      get()._updateCurrentSession((sv) => ({
        ...sv,
        messages: get().messages,
        updatedAt: Date.now(),
      }));
      logError(`ai retry failed: ${err}`);
    }
  },

  clearMessages: () => {
    // 新建会话而非清空
    get().createSession();
  },
  togglePanel: () => set((s) => ({ isPanelOpen: !s.isPanelOpen })),
  setPanelOpen: (open) => set({ isPanelOpen: open }),
}));
