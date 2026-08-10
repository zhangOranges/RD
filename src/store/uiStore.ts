import { create } from 'zustand';

export type ToolType = 'sftp' | 'terminal' | 'port-forward' | 'remote-cmd' | 'keys' | 'plugins';

// ---- 持久化：终端显示/隐藏状态按主机隔离 ----
const TERMINAL_VISIBLE_KEY = 'terminal_visible_map';

function loadTerminalVisible(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(TERMINAL_VISIBLE_KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return {};
    return obj;
  } catch {
    return {};
  }
}

function saveTerminalVisible(map: Record<string, boolean>) {
  try {
    localStorage.setItem(TERMINAL_VISIBLE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

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
  // 工具菜单选中项
  activeTool: ToolType;
  // 右侧功能面板宽度
  rightPanelWidth: number;
  // 是否正在拖拽右侧面板
  rightPanelResizing: boolean;
  // 右侧功能面板可见性
  rightPanelVisible: boolean;
  // 终端全屏状态
  terminalFullscreen: boolean;
  // 侧边栏搜索关键词
  sidebarSearch: string;
  // 每主机的终端标签 id 列表（Task 8 多标签）
  terminalTabs: Record<string, string[]>;
  // 每主机当前活动的终端标签 id
  activeTerminalTab: Record<string, string>;

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
  setActiveTool: (t: ToolType) => void;
  setRightPanelWidth: (w: number) => void;
  setRightPanelResizing: (v: boolean) => void;
  setRightPanelVisible: (v: boolean) => void;
  toggleRightPanel: () => void;
  setTerminalFullscreen: (v: boolean) => void;
  setSidebarSearch: (s: string) => void;
  // 新增终端标签，返回新 tabId；若主机还没有标签则先创建 "default"
  addTerminalTab: (hostId: string) => string;
  // 移除标签；若移除活动标签则切换到相邻标签；移除最后一个则清空
  removeTerminalTab: (hostId: string, tabId: string) => void;
  // 获取主机当前活动标签 id（无标签返回 null）
  getActiveTerminalTab: (hostId: string) => string | null;
  // 设置主机当前活动标签
  setActiveTerminalTab: (hostId: string, tabId: string) => void;
}

const MIN_SIDEBAR = 160;
const MAX_SIDEBAR = 420;
const MIN_TERMINAL = 80;
const MAX_TERMINAL = 600;
const MIN_RIGHT_PANEL = 220;
const MAX_RIGHT_PANEL = 420;

export const useUIStore = create<UIState>((set, get) => ({
  sidebarWidth: 220,
  terminalVisible: loadTerminalVisible(),
  terminalHeight: 240,
  currentPath: null,
  sidebarResizing: false,
  terminalResizing: false,
  settingsVisible: false,
  activeTool: 'sftp',
  rightPanelWidth: 280,
  rightPanelResizing: false,
  rightPanelVisible: true,
  terminalFullscreen: false,
  sidebarSearch: '',
  terminalTabs: {},
  activeTerminalTab: {},

  setSidebarWidth: (w) =>
    set({
      sidebarWidth: Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, Math.round(w))),
    }),
  setSidebarResizing: (v) => set({ sidebarResizing: v }),
  toggleTerminal: (hostId) =>
    set((s) => {
      const next = {
        ...s.terminalVisible,
        [hostId]: !s.terminalVisible[hostId],
      };
      saveTerminalVisible(next);
      return { terminalVisible: next };
    }),
  setTerminalVisible: (hostId, v) =>
    set((s) => {
      const next = { ...s.terminalVisible, [hostId]: v };
      saveTerminalVisible(next);
      return { terminalVisible: next };
    }),
  isTerminalVisible: (hostId) => !!get().terminalVisible[hostId],
  setTerminalHeight: (h) =>
    set({
      terminalHeight: Math.min(MAX_TERMINAL, Math.max(MIN_TERMINAL, Math.round(h))),
    }),
  setTerminalResizing: (v) => set({ terminalResizing: v }),
  setCurrentPath: (p) => set({ currentPath: p }),
  setSettingsVisible: (v) => set({ settingsVisible: v }),
  toggleSettings: () => set((s) => ({ settingsVisible: !s.settingsVisible })),
  setActiveTool: (t) => set({ activeTool: t }),
  setRightPanelWidth: (w) =>
    set({
      rightPanelWidth: Math.min(MAX_RIGHT_PANEL, Math.max(MIN_RIGHT_PANEL, Math.round(w))),
    }),
  setRightPanelResizing: (v) => set({ rightPanelResizing: v }),
  setRightPanelVisible: (v) => set({ rightPanelVisible: v }),
  toggleRightPanel: () => set((s) => ({ rightPanelVisible: !s.rightPanelVisible })),
  setTerminalFullscreen: (v) => set({ terminalFullscreen: v }),
  setSidebarSearch: (s) => set({ sidebarSearch: s }),
  addTerminalTab: (hostId) => {
    const tabId = 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const existing = get().terminalTabs[hostId];
    if (!existing || existing.length === 0) {
      // 第一个标签固定为 "default"，保持与旧单标签会话兼容
      const tabs = ['default'];
      set((s) => ({
        terminalTabs: { ...s.terminalTabs, [hostId]: tabs },
        activeTerminalTab: { ...s.activeTerminalTab, [hostId]: 'default' },
      }));
      return 'default';
    }
    const tabs = [...existing, tabId];
    set((s) => ({
      terminalTabs: { ...s.terminalTabs, [hostId]: tabs },
      activeTerminalTab: { ...s.activeTerminalTab, [hostId]: tabId },
    }));
    return tabId;
  },
  removeTerminalTab: (hostId, tabId) => {
    const existing = get().terminalTabs[hostId] ?? [];
    const idx = existing.indexOf(tabId);
    if (idx === -1) return;
    const tabs = existing.filter((t) => t !== tabId);
    set((s) => {
      const nextTabs = { ...s.terminalTabs };
      const nextActive = { ...s.activeTerminalTab };
      if (tabs.length === 0) {
        delete nextTabs[hostId];
        delete nextActive[hostId];
      } else {
        nextTabs[hostId] = tabs;
        // 若移除的是活动标签，切换到相邻标签
        if (s.activeTerminalTab[hostId] === tabId) {
          const fallback = tabs[Math.min(idx, tabs.length - 1)];
          nextActive[hostId] = fallback;
        }
      }
      return { terminalTabs: nextTabs, activeTerminalTab: nextActive };
    });
  },
  getActiveTerminalTab: (hostId) => get().activeTerminalTab[hostId] ?? null,
  setActiveTerminalTab: (hostId, tabId) =>
    set((s) => ({ activeTerminalTab: { ...s.activeTerminalTab, [hostId]: tabId } })),
}));

export const SIDEBAR_LIMITS = { min: MIN_SIDEBAR, max: MAX_SIDEBAR };
export const TERMINAL_LIMITS = { min: MIN_TERMINAL, max: MAX_TERMINAL };
export const RIGHT_PANEL_LIMITS = { min: MIN_RIGHT_PANEL, max: MAX_RIGHT_PANEL };
