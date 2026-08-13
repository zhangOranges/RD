import { create } from 'zustand';

export type ToolType = 'sftp' | 'port-forward' | 'keys' | 'plugins';

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

// ---- 持久化：终端标签列表 + 活动标签（按主机隔离）----
// 让 tab ID 跨会话稳定，从而 path_cache 能按 tabId 恢复各自目录
const TERMINAL_TABS_KEY = 'terminal_tabs_map';

interface PersistedTabs {
  tabs: Record<string, string[]>;
  active: Record<string, string>;
}

function loadTerminalTabs(): PersistedTabs {
  try {
    const raw = localStorage.getItem(TERMINAL_TABS_KEY);
    if (!raw) return { tabs: {}, active: {} };
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      return { tabs: {}, active: {} };
    }
    return {
      tabs: obj.tabs ?? {},
      active: obj.active ?? {},
    };
  } catch {
    return { tabs: {}, active: {} };
  }
}

function saveTerminalTabs(tabs: Record<string, string[]>, active: Record<string, string>) {
  try {
    localStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify({ tabs, active }));
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
  // 打码模式：开启后对敏感信息（IP、端口、用户名、密码等）进行模糊打码，便于截图
  maskMode: boolean;

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
  // 清除某主机的终端标签持久化数据（删除主机时调用）
  clearTerminalTabsForHost: (hostId: string) => void;
  // 切换打码模式
  toggleMaskMode: () => void;
  // 显式设置打码模式
  setMaskMode: (v: boolean) => void;
}

const MIN_SIDEBAR = 160;
const MAX_SIDEBAR = 420;
const MIN_TERMINAL = 80;
const MAX_TERMINAL = 600;
const MIN_RIGHT_PANEL = 220;
const MAX_RIGHT_PANEL = 420;

const _persistedTabs = loadTerminalTabs();

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
  terminalTabs: _persistedTabs.tabs,
  activeTerminalTab: _persistedTabs.active,
  maskMode: false,

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
    let nextTabs: Record<string, string[]>;
    let nextActive: Record<string, string>;
    if (!existing || existing.length === 0) {
      // 第一个标签固定为 "default"，保持与旧单标签会话兼容
      nextTabs = { ...get().terminalTabs, [hostId]: ['default'] };
      nextActive = { ...get().activeTerminalTab, [hostId]: 'default' };
      set({ terminalTabs: nextTabs, activeTerminalTab: nextActive });
      saveTerminalTabs(nextTabs, nextActive);
      return 'default';
    }
    nextTabs = { ...get().terminalTabs, [hostId]: [...existing, tabId] };
    nextActive = { ...get().activeTerminalTab, [hostId]: tabId };
    set({ terminalTabs: nextTabs, activeTerminalTab: nextActive });
    saveTerminalTabs(nextTabs, nextActive);
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
      saveTerminalTabs(nextTabs, nextActive);
      return { terminalTabs: nextTabs, activeTerminalTab: nextActive };
    });
  },
  getActiveTerminalTab: (hostId) => get().activeTerminalTab[hostId] ?? null,
  setActiveTerminalTab: (hostId, tabId) =>
    set((s) => {
      const nextActive = { ...s.activeTerminalTab, [hostId]: tabId };
      saveTerminalTabs(s.terminalTabs, nextActive);
      return { activeTerminalTab: nextActive };
    }),
  clearTerminalTabsForHost: (hostId) => {
    set((s) => {
      const nextTabs = { ...s.terminalTabs };
      const nextActive = { ...s.activeTerminalTab };
      delete nextTabs[hostId];
      delete nextActive[hostId];
      saveTerminalTabs(nextTabs, nextActive);
      return { terminalTabs: nextTabs, activeTerminalTab: nextActive };
    });
  },
  toggleMaskMode: () => set((s) => ({ maskMode: !s.maskMode })),
  setMaskMode: (v) => set({ maskMode: v }),
}));

export const SIDEBAR_LIMITS = { min: MIN_SIDEBAR, max: MAX_SIDEBAR };
export const TERMINAL_LIMITS = { min: MIN_TERMINAL, max: MAX_TERMINAL };
export const RIGHT_PANEL_LIMITS = { min: MIN_RIGHT_PANEL, max: MAX_RIGHT_PANEL };
