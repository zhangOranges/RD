import { create } from 'zustand';

interface UIState {
  // 侧边栏宽度
  sidebarWidth: number;
  // 终端面板可见性（按主机隔离：每个主机各自记住终端是否打开）
  terminalVisible: Record<string, boolean>;
  // 终端面板高度（px）
  terminalHeight: number;
  // 当前浏览路径（Task 7 维护）
  currentPath: string | null;
  // 是否正在拖拽侧边栏
  sidebarResizing: boolean;
  // 是否正在拖拽终端
  terminalResizing: boolean;
  // 设置弹窗可见性（Task 10）
  settingsVisible: boolean;

  setSidebarWidth: (w: number) => void;
  setSidebarResizing: (v: boolean) => void;
  toggleTerminal: (hostId: string) => void;
  setTerminalVisible: (hostId: string, v: boolean) => void;
  isTerminalVisible: (hostId: string) => boolean;
  setTerminalHeight: (h: number) => void;
  setTerminalResizing: (v: boolean) => void;
  setCurrentPath: (p: string | null) => void;
  setSettingsVisible: (v: boolean) => void;
  toggleSettings: () => void;
}

const MIN_SIDEBAR = 160;
const MAX_SIDEBAR = 420;
const MIN_TERMINAL = 80;
const MAX_TERMINAL = 600;

export const useUIStore = create<UIState>((set, get) => ({
  sidebarWidth: 220,
  terminalVisible: {},
  terminalHeight: 240,
  currentPath: null,
  sidebarResizing: false,
  terminalResizing: false,
  settingsVisible: false,

  setSidebarWidth: (w) =>
    set({
      sidebarWidth: Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, Math.round(w))),
    }),
  setSidebarResizing: (v) => set({ sidebarResizing: v }),
  toggleTerminal: (hostId) =>
    set((s) => ({
      terminalVisible: {
        ...s.terminalVisible,
        [hostId]: !s.terminalVisible[hostId],
      },
    })),
  setTerminalVisible: (hostId, v) =>
    set((s) => ({
      terminalVisible: { ...s.terminalVisible, [hostId]: v },
    })),
  isTerminalVisible: (hostId) => !!get().terminalVisible[hostId],
  setTerminalHeight: (h) =>
    set({
      terminalHeight: Math.min(MAX_TERMINAL, Math.max(MIN_TERMINAL, Math.round(h))),
    }),
  setTerminalResizing: (v) => set({ terminalResizing: v }),
  setCurrentPath: (p) => set({ currentPath: p }),
  setSettingsVisible: (v) => set({ settingsVisible: v }),
  toggleSettings: () => set((s) => ({ settingsVisible: !s.settingsVisible })),
}));

export const SIDEBAR_LIMITS = { min: MIN_SIDEBAR, max: MAX_SIDEBAR };
export const TERMINAL_LIMITS = { min: MIN_TERMINAL, max: MAX_TERMINAL };
