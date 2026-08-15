import { create } from 'zustand';
import type { ToolbarButtonOption } from '../types/plugin';

/** 插件注册的 Toolbar 按钮 */
export interface PluginToolbarButton extends ToolbarButtonOption {
  pluginId: string;
  group: 'left' | 'center' | 'right';
}

/** 插件日志条目（开发者控制台用） */
export interface PluginLogEntry {
  id: number;
  pluginId: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

/** 限频计数器 */
interface RateLimitEntry {
  count: number;
  windowStart: number;
}

interface PluginUiState {
  /** Toolbar 按钮注册表 */
  toolbarButtons: PluginToolbarButton[];
  /** 插件日志缓冲区（最多保留 500 条，超出 FIFO 丢弃） */
  logs: PluginLogEntry[];
}

interface PluginUiActions {
  // Toolbar
  registerToolbarButton: (
    pluginId: string,
    opt: ToolbarButtonOption,
    group?: 'left' | 'center' | 'right',
  ) => void;
  removeToolbarButton: (id: string) => void;
  removeAllForPlugin: (pluginId: string) => void; // disable 时调用
  // 日志
  addLog: (pluginId: string, level: 'info' | 'warn' | 'error', message: string) => void;
  clearLogs: (pluginId?: string) => void;
  // 限频
  checkRateLimit: (pluginId: string, action: 'notify' | 'confirm' | 'prompt') => boolean;
}

export type PluginUiStore = PluginUiState & PluginUiActions;

const MAX_LOGS = 500;
const NOTIFY_LIMIT = 3; // 10s 内最多 3 条
const NOTIFY_WINDOW = 10_000;
const CONFIRM_LIMIT = 2; // 5s 内最多 2 条
const CONFIRM_WINDOW = 5_000;

let _logId = 0;

// 限频计数器（闭包变量，不触发 React re-render）
const _rateLimitMap = new Map<string, RateLimitEntry>();

export const usePluginUiStore = create<PluginUiStore>((set) => ({
  toolbarButtons: [],
  logs: [],

  registerToolbarButton: (pluginId, opt, group = 'right') => {
    set((s) => {
      // 移除同 id 旧按钮（更新）
      const filtered = s.toolbarButtons.filter((b) => b.id !== opt.id);
      return {
        toolbarButtons: [...filtered, { ...opt, pluginId, group }],
      };
    });
  },

  removeToolbarButton: (id) => {
    set((s) => ({ toolbarButtons: s.toolbarButtons.filter((b) => b.id !== id) }));
  },

  removeAllForPlugin: (pluginId) => {
    set((s) => ({
      toolbarButtons: s.toolbarButtons.filter((b) => b.pluginId !== pluginId),
    }));
  },

  addLog: (pluginId, level, message) => {
    const entry: PluginLogEntry = {
      id: ++_logId,
      pluginId,
      level,
      message,
      timestamp: Date.now(),
    };
    set((s) => {
      const logs = [...s.logs, entry];
      // FIFO 超出限制
      if (logs.length > MAX_LOGS) {
        return { logs: logs.slice(logs.length - MAX_LOGS) };
      }
      return { logs };
    });
  },

  clearLogs: (pluginId) => {
    set((s) => ({
      logs: pluginId ? s.logs.filter((l) => l.pluginId !== pluginId) : [],
    }));
  },

  checkRateLimit: (pluginId, action) => {
    const now = Date.now();
    const key = `${pluginId}:${action}`;
    const entry = _rateLimitMap.get(key);

    const limit = action === 'notify' ? NOTIFY_LIMIT : CONFIRM_LIMIT;
    const window = action === 'notify' ? NOTIFY_WINDOW : CONFIRM_WINDOW;

    if (!entry || now - entry.windowStart > window) {
      _rateLimitMap.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= limit) {
      return false;
    }
    entry.count++;
    return true;
  },
}));
