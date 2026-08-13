/**
 * 终端外观设置：字体、字号、行高、字间距等。
 * 持久化在 localStorage，跨会话保留，变化时即时生效。
 */

import { create } from 'zustand';

const STORAGE_KEY = 'terminal_settings';

export interface TerminalSettings {
  /** 字体族，CSS font-family 格式（可用逗号分隔多个备选） */
  fontFamily: string;
  /** 字号（px） */
  fontSize: number;
  /** 行高（倍数） */
  lineHeight: number;
  /** 字间距（px） */
  letterSpacing: number;
}

const DEFAULTS: TerminalSettings = {
  // Nerd Font 优先，确保图标字符能正确显示
  fontFamily:
    '"JetBrainsMono Nerd Font", "JetBrains Mono", "FiraCode Nerd Font", "Fira Code", "Cascadia Code", "CaskaydiaCove Nerd Font", Menlo, Monaco, Consolas, "Courier New", monospace',
  fontSize: 14,
  lineHeight: 1.2,
  letterSpacing: 0.3,
};

function loadSettings(): TerminalSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      return { ...DEFAULTS };
    }
    return { ...DEFAULTS, ...obj };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings(s: TerminalSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

interface TerminalSettingsState {
  settings: TerminalSettings;
  /** 批量更新 */
  setSettings: (patch: Partial<TerminalSettings>) => void;
  /** 重置为默认值 */
  reset: () => void;
}

export const useTerminalStore = create<TerminalSettingsState>((set) => ({
  settings: loadSettings(),
  setSettings: (patch) =>
    set((s) => {
      const next = { ...s.settings, ...patch };
      saveSettings(next);
      return { settings: next };
    }),
  reset: () => {
    saveSettings({ ...DEFAULTS });
    return { settings: { ...DEFAULTS } };
  },
}));

/** 响应式获取当前设置 */
export function useTerminalSettings(): TerminalSettings {
  return useTerminalStore((s) => s.settings);
}

/** 非响应式获取（用于初始化等同步场景） */
export function getTerminalSettings(): TerminalSettings {
  return useTerminalStore.getState().settings;
}
