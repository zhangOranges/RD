/**
 * 快捷键存储与匹配。
 *
 * 持久化在 localStorage，跨会话保留。每个快捷键有一个稳定 id，
 * 用户可在设置面板修改或重置为默认值。
 *
 * 数据结构说明：
 * - shortcut 以规范化字符串存储，如 "Ctrl+Shift+Enter"、"Cmd+K"
 * - 匹配时优先精确匹配字符串；mac 下 Cmd 视为主修饰键，其他平台用 Ctrl
 */

import { create } from 'zustand';

const STORAGE_KEY = 'shortcut_map';

/** 平台标识：用于选择默认修饰键 */
const isMac =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '');

/** 修饰键组合（不含主键） */
export interface ShortcutKeys {
  /** Ctrl 键（mac 下也可用） */
  ctrl: boolean;
  /** Cmd 键（mac）；非 mac 平台无此键，默认用 Ctrl */
  meta: boolean;
  /** Shift 键 */
  shift: boolean;
  /** Alt/Option 键 */
  alt: boolean;
  /** 主键：字母 / 数字 / 符号 / 功能键，如 "K", "Enter", "F5", "," */
  key: string;
}

/** 快捷键元信息：用于设置面板展示 */
export interface ShortcutMeta {
  /** 稳定 id，用于 store key */
  id: string;
  /** 显示名称 */
  label: string;
  /** 功能说明 */
  desc: string;
  /** 默认值（规范化字符串） */
  defaultValue: string;
}

/** 所有快捷键定义 */
export const SHORTCUTS: ShortcutMeta[] = [
  {
    id: 'openSettings',
    label: '打开设置',
    desc: '快速打开应用设置面板',
    defaultValue: isMac ? 'Cmd+,' : 'Ctrl+,',
  },
  {
    id: 'toggleTerminal',
    label: '切换终端显示',
    desc: '显示或隐藏当前主机的终端面板',
    defaultValue: isMac ? 'Cmd+`' : 'Ctrl+`',
  },
  {
    id: 'terminalFullscreen',
    label: '终端全屏',
    desc: '切换终端面板的最大化/还原',
    defaultValue: isMac ? 'Cmd+Shift+Enter' : 'Ctrl+Shift+Enter',
  },
  {
    id: 'refreshDir',
    label: '刷新目录',
    desc: '刷新当前远程目录列表',
    defaultValue: 'F5',
  },
  {
    id: 'focusSearch',
    label: '聚焦搜索',
    desc: '聚焦侧边栏主机搜索框',
    defaultValue: isMac ? 'Cmd+K' : 'Ctrl+K',
  },
];

const DEFAULT_MAP: Record<string, string> = Object.fromEntries(
  SHORTCUTS.map((s) => [s.id, s.defaultValue]),
);

/** 从 localStorage 加载已保存的快捷键映射 */
function loadMap(): Record<string, string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MAP };
    const obj = JSON.parse(raw);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
      return { ...DEFAULT_MAP };
    }
    // 合并默认值（保证新增的快捷键有默认值）
    return { ...DEFAULT_MAP, ...obj };
  } catch {
    return { ...DEFAULT_MAP };
  }
}

function saveMap(map: Record<string, string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* ignore */
  }
}

interface ShortcutState {
  /** 快捷键映射：id → 规范化字符串 */
  map: Record<string, string>;
  /** 修改某快捷键 */
  setShortcut: (id: string, value: string) => void;
  /** 重置某快捷键为默认值 */
  resetShortcut: (id: string) => void;
  /** 重置所有快捷键 */
  resetAll: () => void;
}

export const useShortcutStore = create<ShortcutState>((set) => ({
  map: loadMap(),
  setShortcut: (id, value) =>
    set((s) => {
      const next = { ...s.map, [id]: value };
      saveMap(next);
      return { map: next };
    }),
  resetShortcut: (id) =>
    set((s) => {
      const next = { ...s.map, [id]: DEFAULT_MAP[id] };
      saveMap(next);
      return { map: next };
    }),
  resetAll: () => {
    saveMap({ ...DEFAULT_MAP });
    return { map: { ...DEFAULT_MAP } };
  },
}));

/* ============================================================
 * 解析与匹配工具
 * ============================================================ */

/** 把规范化字符串解析为结构化键 */
export function parseShortcut(s: string): ShortcutKeys {
  const parts = s.split('+').map((p) => p.trim());
  return {
    ctrl: parts.includes('Ctrl'),
    meta: parts.includes('Cmd'),
    shift: parts.includes('Shift'),
    alt: parts.includes('Alt'),
    key: parts[parts.length - 1] ?? '',
  };
}

/** 判断一个 KeyboardEvent 是否匹配指定快捷键 id */
export function matchShortcut(id: string, e: KeyboardEvent): boolean {
  const map = useShortcutStore.getState().map;
  const raw = map[id];
  if (!raw) return false;
  const sk = parseShortcut(raw);

  // 修饰键匹配：mac 下 Cmd 优先，其他平台用 Ctrl
  const ctrlOk = sk.ctrl ? e.ctrlKey : !e.ctrlKey || sk.meta;
  const metaOk = sk.meta ? e.metaKey : !e.metaKey || sk.ctrl;
  const shiftOk = sk.shift ? e.shiftKey : !e.shiftKey;
  const altOk = sk.alt ? e.altKey : !e.altKey;

  // 主键匹配：不区分大小写，优先用 e.key，回退到 e.code
  const keyLower = sk.key.toLowerCase();
  const eKeyLower = e.key.toLowerCase();
  const keyMatch = eKeyLower === keyLower || e.code === sk.key;

  // 处理 Ctrl+` 这种特殊键：e.key 可能是 "`" 或 "Dead"
  if (keyLower === '`') {
    return ctrlOk && metaOk && shiftOk && altOk && (eKeyLower === '`' || e.key === 'Dead');
  }

  return ctrlOk && metaOk && shiftOk && altOk && keyMatch;
}

/** 把 KeyboardEvent 转为规范化字符串（用于录入新快捷键） */
export function eventToShortcut(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.metaKey) parts.push('Cmd');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  // 主键：规范化功能键名
  let key = e.key;
  if (key === ' ') key = 'Space';
  // 单字母转大写展示
  if (key.length === 1) key = key.toUpperCase();
  parts.push(key);
  return parts.join('+');
}

/** 获取某快捷键的当前值（响应式） */
export function useShortcut(id: string): string {
  return useShortcutStore((s) => s.map[id] ?? '');
}

/** 获取某快捷键的当前值（非响应式，用于事件回调） */
export function getShortcut(id: string): string {
  return useShortcutStore.getState().map[id] ?? '';
}
