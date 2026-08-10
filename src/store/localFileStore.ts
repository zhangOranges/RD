import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useToastStore } from '../components/Toast';

// LocalFileEntry：与 Rust 端 LocalFileEntry 结构一一对应
// （serde rename_all = "camelCase" → 字段名为 camelCase）。
export interface LocalFileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: number; // Unix 秒级时间戳
  fileType: 'dir' | 'file' | 'symlink';
}

// ========== 持久化：按 hostId 记录本地目录路径 ==========
// 新格式：localStorage key `local_file_paths_map` = JSON<{ [hostId]: path }>
// 迁移：旧 key `local_file_current_path` 若存在，作为空串 host（未选主机时）的 fallback
const LOCAL_PATH_MAP_KEY = 'local_file_paths_map';
const LEGACY_LOCAL_PATH_KEY = 'local_file_current_path';

/** 读取整个持久化路径映射（含一次性旧 key 迁移） */
function loadPathMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LOCAL_PATH_MAP_KEY);
    let map: Record<string, string> = raw ? JSON.parse(raw) : {};
    if (typeof map !== 'object' || map === null || Array.isArray(map)) map = {};

    // 一次性迁移：旧 key 存在且 map 为空 → 导入到空串 host 作为默认记忆
    const legacy = localStorage.getItem(LEGACY_LOCAL_PATH_KEY);
    if (legacy && legacy.length > 0) {
      if (!map[''] && Object.keys(map).length === 0) map[''] = legacy;
      try {
        localStorage.removeItem(LEGACY_LOCAL_PATH_KEY);
      } catch {
        /* ignore */
      }
      try {
        localStorage.setItem(LOCAL_PATH_MAP_KEY, JSON.stringify(map));
      } catch {
        /* ignore */
      }
    }
    return map;
  } catch {
    return {};
  }
}

/** 把整个路径映射写回 localStorage */
function savePathMap(map: Record<string, string>) {
  try {
    localStorage.setItem(LOCAL_PATH_MAP_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

/** 仅更新某个 hostId 的路径 */
function setCachedPath(hostId: string, path: string | null | undefined) {
  const map = loadPathMap();
  if (!path) delete map[hostId];
  else map[hostId] = path;
  savePathMap(map);
}

function getCachedPath(hostId: string): string | null {
  const map = loadPathMap();
  const v = map[hostId];
  return v && v.length > 0 ? v : null;
}

interface LocalFileState {
  currentPath: string | null;
  entries: LocalFileEntry[];
  loading: boolean;
  error: string | null;
  history: string[];
  historyIndex: number;

  /** 选中的条目名称集合（支持多选）。 */
  selectedNames: Set<string>;

  /** 当前绑定的主机（空串表示未选中任何主机的空闲场景） */
  activeHostId: string;

  /** 已做过初始化的主机，避免重复 navigate */
  initedHosts: Record<string, true>;

  /** 切换单个条目的选中状态。shift/ctrl 多选逻辑由组件层处理。 */
  selectOne: (name: string, mode: 'toggle' | 'replace' | 'range') => void;
  /** 清空所有选中。 */
  clearSelection: () => void;
  /** 批量设置选中（从外部一次性给定集合）。 */
  setSelection: (names: Set<string> | string[]) => void;

  /**
   * 切换绑定主机。
   *  - 旧主机当前路径会被记忆；
   *  - 新主机若有记忆路径则直接恢复，记忆路径失效则 fallback 到家目录；
   *  - 没有选中任何主机（''）时，没有记忆路径则 fallback 家目录。
   */
  setActiveHost: (hostId: string | null) => Promise<void>;

  /** 读取当前 activeHost 的持久化路径并打开；失败时回退到家目录 */
  initHome: () => Promise<void>;
  navigate: (path: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  goUp: () => Promise<void>;
  resetState: () => void;
}

// ---------- Windows 路径工具 ----------
// 项目运行在 Windows，路径分隔符为 `\`。根目录形如 `C:\`。

/** 判断是否为盘根目录（如 `C:\`），根目录不再向上。 */
function isDriveRoot(path: string): boolean {
  return /^[A-Za-z]:\\$/.test(path);
}

/** 取上级目录；已在盘根或为空则原样返回。 */
function parentPath(path: string): string {
  if (!path) return path;
  if (isDriveRoot(path)) return path;
  const parts = path.split('\\').filter(Boolean); // ['C:', 'Users', 'Admin']
  if (parts.length <= 1) return path;
  parts.pop();
  const drive = parts[0];
  const rest = parts.slice(1);
  return rest.length === 0 ? `${drive}\\` : [drive, ...rest].join('\\');
}

/** 拼接子路径：`C:\Users` + `Admin` → `C:\Users\Admin`；`C:\` + `Users` → `C:\Users`。 */
export function joinLocalPath(base: string, name: string): string {
  if (!base) return name;
  if (base.endsWith('\\')) return base + name;
  return `${base}\\${name}`;
}

/** 把 {state} 写到指定 hostId 的持久化 map（失败静默），仅在路径非空时生效。
 *  hostId 允许为空串（表示「未选中任何主机」的空闲场景）
 */
function persistCurrentPathForHost(hostId: string, path: string | null) {
  if (hostId === undefined || hostId === null || !path) return;
  setCachedPath(hostId, path);
}

export const useLocalFileStore = create<LocalFileState>((set, get) => ({
  currentPath: null,
  entries: [],
  loading: false,
  error: null,
  history: [],
  historyIndex: -1,
  activeHostId: '',
  initedHosts: {},
  selectedNames: new Set<string>(),

  // ------------------------------------------------------------------
  selectOne: (name, mode) => {
    const { selectedNames, entries } = get();
    if (mode === 'replace') {
      set({ selectedNames: new Set([name]) });
      return;
    }
    if (mode === 'toggle') {
      const next = new Set(selectedNames);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      set({ selectedNames: next });
      return;
    }
    if (mode === 'range') {
      // 以第一个已选中的条目为锚点，范围选择（跟资源管理器行为一致）
      const orderedNames = entries.map((e) => e.name);
      let anchorIdx = -1;
      for (const n of selectedNames) {
        const idx = orderedNames.indexOf(n);
        if (idx >= 0 && (anchorIdx < 0 || idx < anchorIdx)) anchorIdx = idx;
      }
      if (anchorIdx < 0) anchorIdx = 0;
      const targetIdx = orderedNames.indexOf(name);
      if (targetIdx < 0) return;
      const [lo, hi] = anchorIdx < targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
      const next = new Set<string>();
      for (let i = lo; i <= hi; i++) {
        const n = orderedNames[i];
        if (n !== undefined) next.add(n);
      }
      set({ selectedNames: next });
    }
  },

  clearSelection: () => set({ selectedNames: new Set<string>() }),

  setSelection: (names) => {
    if (names instanceof Set) set({ selectedNames: new Set(names) });
    else set({ selectedNames: new Set(names) });
  },

  // ------------------------------------------------------------------
  setActiveHost: async (rawHostId) => {
    const hostId = rawHostId ?? '';
    const state = get();
    const oldHostId = state.activeHostId;

    // 切到同一个 host，跳过（除非这个 host 还没被初始化过）
    if (oldHostId === hostId) {
      if (!state.initedHosts[hostId]) {
        await get().initHome();
      }
      return;
    }

    // 1) 把旧 host 当前路径记下来（oldHostId 允许为空串）
    if (oldHostId !== undefined && oldHostId !== null && state.currentPath) {
      persistCurrentPathForHost(oldHostId, state.currentPath);
    }

    // 2) 切换 host，先把文件列表清空，避免视觉残留
    set({
      activeHostId: hostId,
      currentPath: null,
      entries: [],
      loading: true,
      error: null,
      history: [],
      historyIndex: -1,
      selectedNames: new Set<string>(),
    });

    // 3) 初始化新 host 的本地目录
    await get().initHome();
  },

  // ------------------------------------------------------------------
  initHome: async () => {
    const hostId = get().activeHostId ?? '';

    // 标记已初始化（即使失败也不重复再跑，避免反复弹 toast）
    set((s) => ({ initedHosts: { ...s.initedHosts, [hostId]: true } }));

    // 优先读取 host 级别的记忆路径
    const cached = getCachedPath(hostId);
    if (cached) {
      const ok = await get().navigate(cached);
      if (ok) return;
      // 缓存路径打不开（目录已删除等）→ 清掉对应 host 的缓存后 fallback 家目录
      setCachedPath(hostId, null);
    }

    try {
      const home = await invoke<string>('local_home_dir');
      await get().navigate(home);
    } catch (err) {
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      set({ loading: false, error: msg });
      useToastStore.getState().push('error', `无法获取主目录：${msg}`);
    }
  },

  // ------------------------------------------------------------------
  navigate: async (path) => {
    set({ loading: true, error: null });
    try {
      const entries = await invoke<LocalFileEntry[]>('list_local_dir', { path });
      const state = get();
      // 截断 forward 历史，再压栈
      let history = state.history.slice(0, state.historyIndex + 1);
      if (history[history.length - 1] !== path) {
        history = [...history, path];
      }
      const historyIndex = history.length - 1;
      set({
        currentPath: path,
        entries,
        loading: false,
        error: null,
        history,
        historyIndex,
        selectedNames: new Set<string>(), // 进入新目录时清空选择
      });
      // 路径记忆：写入当前 hostId 对应的持久化 map
      const hostId = state.activeHostId ?? '';
      persistCurrentPathForHost(hostId, path);
      return true;
    } catch (err) {
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      set({ loading: false, error: msg });
      useToastStore.getState().push('error', `打开目录失败：${msg}`);
      return false;
    }
  },

  // ------------------------------------------------------------------
  refresh: async () => {
    const path = get().currentPath;
    if (!path) return;
    set({ loading: true, error: null });
    try {
      const entries = await invoke<LocalFileEntry[]>('list_local_dir', { path });
      // 刷新后剔除不存在的选择
      const namesOnly = new Set(entries.map((e) => e.name));
      const oldSel = get().selectedNames;
      const newSel = new Set<string>();
      oldSel.forEach((n) => { if (namesOnly.has(n)) newSel.add(n); });
      set({ entries, selectedNames: newSel, loading: false, error: null });
    } catch (err) {
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      set({ loading: false, error: msg });
      useToastStore.getState().push('error', `刷新失败：${msg}`);
    }
  },

  // ------------------------------------------------------------------
  goBack: async () => {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const target = history[historyIndex - 1];
    if (!target) return;
    set({ historyIndex: historyIndex - 1 });
    set({ loading: true, error: null });
    try {
      const entries = await invoke<LocalFileEntry[]>('list_local_dir', { path: target });
      set({ currentPath: target, entries, loading: false, error: null });
      const hostId = get().activeHostId ?? '';
      persistCurrentPathForHost(hostId, target);
    } catch (err) {
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      set({ loading: false, error: msg });
      useToastStore.getState().push('error', `后退失败：${msg}`);
    }
  },

  // ------------------------------------------------------------------
  goForward: async () => {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const target = history[historyIndex + 1];
    if (!target) return;
    set({ historyIndex: historyIndex + 1 });
    set({ loading: true, error: null });
    try {
      const entries = await invoke<LocalFileEntry[]>('list_local_dir', { path: target });
      set({ currentPath: target, entries, loading: false, error: null });
      const hostId = get().activeHostId ?? '';
      persistCurrentPathForHost(hostId, target);
    } catch (err) {
      const msg = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
      set({ loading: false, error: msg });
      useToastStore.getState().push('error', `前进失败：${msg}`);
    }
  },

  // ------------------------------------------------------------------
  goUp: async () => {
    const path = get().currentPath;
    if (!path) return;
    const parent = parentPath(path);
    if (parent === path) return;
    await get().navigate(parent);
  },

  // ------------------------------------------------------------------
  resetState: () =>
    set({
      currentPath: null,
      entries: [],
      loading: false,
      error: null,
      history: [],
      historyIndex: -1,
      selectedNames: new Set<string>(),
    }),
}));
