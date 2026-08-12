import { create } from 'zustand';

/**
 * 命令历史存储：
 * - 按使用频率（count）降序排序，相同频率按最近使用时间降序
 * - 最多保留 100 条，超过时按 count 升序 + lastUsed 升序淘汰最旧
 * - 通过 localStorage 持久化，跨会话保留
 */

export interface HistoryEntry {
  id: string;
  command: string;
  /** 使用次数（频率） */
  count: number;
  /** 最近一次使用时间戳（ms） */
  lastUsed: number;
}

const STORAGE_KEY = 'cmd_history';
const MAX_ENTRIES = 100;

function loadEntries(): HistoryEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj)) return [];
    return obj
      .filter(
        (e): e is HistoryEntry =>
          e &&
          typeof e === 'object' &&
          typeof e.id === 'string' &&
          typeof e.command === 'string' &&
          typeof e.count === 'number' &&
          typeof e.lastUsed === 'number',
      )
      .slice(0, MAX_ENTRIES);
  } catch {
    return [];
  }
}

function saveEntries(entries: HistoryEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    /* ignore */
  }
}

/** 计算命令的稳定 id（避免重复记录） */
function makeId(command: string): string {
  // 简单 hash，避免引入额外依赖
  let h = 5381;
  for (let i = 0; i < command.length; i++) {
    h = (h * 33) ^ command.charCodeAt(i);
  }
  return 'c_' + (h >>> 0).toString(36);
}

/** 排序：count 降序 → lastUsed 降序 */
function sortEntries(entries: HistoryEntry[]): HistoryEntry[] {
  return [...entries].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.lastUsed - a.lastUsed;
  });
}

/** 裁剪到上限：保留排序后前 MAX_ENTRIES 条 */
function trimEntries(entries: HistoryEntry[]): HistoryEntry[] {
  return entries.length > MAX_ENTRIES ? entries.slice(0, MAX_ENTRIES) : entries;
}

interface HistoryState {
  entries: HistoryEntry[];
  /** 记录一条命令：已存在则 count+1、lastUsed 更新；否则新增 */
  recordCommand: (command: string) => void;
  /** 删除一条命令 */
  removeCommand: (id: string) => void;
  /** 清空全部历史 */
  clearAll: () => void;
}

const initialEntries = sortEntries(loadEntries());

export const useHistoryStore = create<HistoryState>((set) => ({
  entries: initialEntries,
  recordCommand: (rawCommand) => {
    const command = rawCommand.trim();
    if (!command) return;
    const id = makeId(command);
    set((s) => {
      const now = Date.now();
      const idx = s.entries.findIndex((e) => e.id === id);
      let next: HistoryEntry[];
      if (idx >= 0) {
        // 已存在：count+1，更新 lastUsed
        next = s.entries.map((e) =>
          e.id === id ? { ...e, count: e.count + 1, lastUsed: now } : e,
        );
      } else {
        // 新增
        next = [
          ...s.entries,
          { id, command, count: 1, lastUsed: now },
        ];
      }
      // 排序 + 裁剪 + 持久化
      const sorted = sortEntries(next);
      const trimmed = trimEntries(sorted);
      saveEntries(trimmed);
      return { entries: trimmed };
    });
  },
  removeCommand: (id) => {
    set((s) => {
      const next = s.entries.filter((e) => e.id !== id);
      saveEntries(next);
      return { entries: next };
    });
  },
  clearAll: () => {
    saveEntries([]);
    set({ entries: [] });
  },
}));
