import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useUIStore } from './uiStore';
import { useToastStore } from '../components/Toast';

// FileEntry：与 Rust 端 FileEntry 结构一一对应（serde::Serialize 自动转 camelCase 失败时
// 字段名直接原样传递；这里以原样字段为准，与现有 sftp 模块一致）。
export interface FileEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified: number; // Unix 秒级时间戳
  permissions: string;
  owner: string;
  file_type: 'dir' | 'file' | 'symlink';
}

interface FileState {
  currentPath: string | null;
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  history: string[];
  historyIndex: number;
  selectedEntry: FileEntry | null;
  /** 多选：选中的文件名集合 */
  selectedNames: Set<string>;

  navigate: (hostId: string, path: string, opts?: { skipHistory?: boolean; silentOnError?: boolean }) => Promise<boolean>;
  refresh: (hostId: string) => Promise<void>;
  goBack: (hostId: string) => Promise<void>;
  goForward: (hostId: string) => Promise<void>;
  goUp: (hostId: string) => Promise<void>;
  mkdir: (hostId: string, name: string) => Promise<void>;
  // 创建一个新的空文件
  mkfile: (hostId: string, name: string) => Promise<void>;
  rename: (hostId: string, oldName: string, newName: string) => Promise<void>;
  remove: (hostId: string, name: string, isDir: boolean) => Promise<void>;
  resolvePath: (hostId: string, input: string) => Promise<string | null>;
  selectEntry: (entry: FileEntry | null) => void;
  /** 多选：切换/范围/替换选中 */
  selectOne: (name: string, mode: 'toggle' | 'replace' | 'range') => void;
  /** 多选：清空选中 */
  clearSelection: () => void;
  // 切换主机时重置全部文件浏览器状态，防止旧主机的路径/历史/列表残留
  resetState: () => void;
  // 远程文件读写：返回/写入 UTF-8 文本
  readFileText: (hostId: string, filePath: string) => Promise<string>;
  writeFileText: (hostId: string, filePath: string, content: string) => Promise<void>;
  // 终端 cwd 变化时由 TerminalPanel 调用：导航到新路径，但不回推 pty_cd（回环防护）
  syncFromTerminalCwd: (hostId: string, path: string) => Promise<void>;
}

// 文本类文件后缀（可"查看/编辑"），均为小写并带点号前缀
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.log', '.conf', '.config', '.cfg',
  '.ini', '.env', '.envrc', '.yaml', '.yml', '.json', '.json5',
  '.toml', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte',
  '.py', '.pyw', '.sh', '.bash', '.zsh', '.fish', '.bat', '.cmd',
  '.ps1', '.rb', '.php', '.go', '.rs', '.java', '.kt', '.kts',
  '.c', '.h', '.cpp', '.hpp', '.cc', '.hh', '.cs', '.swift',
  '.sql', '.csv', '.tsv', '.properties', '.dockerfile', '.makefile',
  '.lock', '.plist',
]);

/** 判断某个条目（文件名 + size）是否大概率是可查看的纯文本文件。
 *  - 目录、symlink 直接否
 *  - 扩展名在白名单内 → 是
 *  - 扩展名未知但 size < 512KB 且文件名无典型二进制扩展名 → 是（保守允许小文件）
 */
export function isTextFile(entry: FileEntry): boolean {
  if (entry.is_dir || entry.file_type !== 'file') return false;
  const name = entry.name.toLowerCase();
  const dot = name.lastIndexOf('.');
  const ext = dot >= 0 ? name.slice(dot) : '';
  if (TEXT_EXTENSIONS.has(ext)) return true;
  // 典型二进制扩展名 → 排除
  const BIN_EXTS = new Set([
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.img', '.iso',
    '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar', '.tgz', '.tbz2',
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico',
    '.mp3', '.mp4', '.mov', '.avi', '.mkv', '.wav', '.flac', '.aac',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods',
    '.deb', '.rpm', '.apk', '.ipa', '.class', '.jar', '.war', '.ear',
    '.woff', '.woff2', '.ttf', '.otf', '.eot',
  ]);
  if (BIN_EXTS.has(ext)) return false;
  // 无扩展名或未知扩展名：小文件按文本处理（查看时即便乱码也不会损坏）
  return entry.size < 512 * 1024;
}

// 模块级标志：标记下一次 navigate 是否由终端 cwd 同步触发。
// true 表示来自终端上报的 cwd，此时 navigate 成功后不再调用 pty_cd，避免回环：
//   终端 cd → cwd-changed → syncFromTerminalCwd → navigate → (跳过 pty_cd)
// 用户主动导航（文件浏览器/地址栏）→ navigate → pty_cd → 终端 cwd 同步
let syncFromTerminal = false;

// 记录每个标签最后一次通过 pty_cd 设置的路径，避免重复发送相同的 cd 命令
// （PTY 会回显 cd 命令，多次切换会导致终端里出现大量重复 cd 行）
// key 为 `${hostId}__${tabId}`，按标签维度独立记录，避免多 tab 之间相互干扰
// （若按 host 维度共用一条记录，新建 tab 时会误判"已发过该路径"而跳过 cd，
//  导致新 tab 与文件浏览器目录不一致）
const lastPtyCdPath = new Map<string, string>();

function ptyCdKey(hostId: string, tabId: string | null): string {
  return `${hostId}__${tabId ?? 'default'}`;
}

function parentPath(path: string): string {
  if (!path || path === '/') return '/';
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

function joinPath(base: string, name: string): string {
  if (!base) return '/' + name;
  if (base.endsWith('/')) return base + name;
  return base + '/' + name;
}

// 解析 Rust 端 SftpError 字符串（格式 "Code: message"）为中文提示。
function describeSftpError(err: unknown): string {
  const raw = typeof err === 'string' ? err : err instanceof Error ? err.message : String(err);
  const idx = raw.indexOf(':');
  if (idx <= 0) return raw;
  const code = raw.slice(0, idx).trim();
  const msg = raw.slice(idx + 1).trim();
  const table: Record<string, string> = {
    NotConnected: '未连接到主机',
    PermissionDenied: `权限不足：${msg}`,
    NoSuchPath: `路径不存在：${msg}`,
    NotADirectory: `不是目录：${msg}`,
    AlreadyExists: `已存在同名项：${msg}`,
    SftpError: `SFTP 错误：${msg}`,
  };
  return table[code] ?? raw;
}

export const useFileStore = create<FileState>((set, get) => ({
  currentPath: null,
  entries: [],
  loading: false,
  error: null,
  history: [],
  historyIndex: -1,
  selectedEntry: null,
  selectedNames: new Set<string>(),

  navigate: async (hostId, path, opts) => {
    const skipHistory = opts?.skipHistory ?? false;
    // silentOnError：true 时失败不弹 Toast（用于自动重连后首次加载等时序敏感场景，
    // 调用方会自行做 retry / 状态兜底）。
    const silentOnError = opts?.silentOnError ?? false;
    // 捕获并立即重置标志：即便后续 sftp_list_dir 抛错，标志也不会残留影响下一次导航
    const fromTerminal = syncFromTerminal;
    syncFromTerminal = false;
    // 路径合法性前置校验：远程路径必须以「/」开头（绝对路径），
    // 否则直接失败，避免脏数据（如 hostId UUID）误入 currentPath 进而显示在面包屑中
    if (typeof path !== 'string' || !path.startsWith('/')) {
      const msg = `无效的远程路径：${JSON.stringify(path)}`;
      set({ loading: false, error: msg });
      if (!silentOnError) useToastStore.getState().push('error', msg);
      return false;
    }
    set({ loading: true, error: null });
    try {
      const entries = await invoke<FileEntry[]>('sftp_list_dir', { hostId, path });
      const state = get();
      let history = state.history;
      let historyIndex = state.historyIndex;
      if (!skipHistory) {
        // 截断 forward 历史，再压栈
        history = state.history.slice(0, state.historyIndex + 1);
        // 避免连续重复
        if (history[history.length - 1] !== path) {
          history = [...history, path];
        }
        historyIndex = history.length - 1;
      }
      set({
        currentPath: path,
        entries,
        loading: false,
        error: null,
        selectedEntry: null,
        selectedNames: new Set<string>(),
        history,
        historyIndex,
      });
      useUIStore.getState().setCurrentPath(path);
      // 写入路径缓存（失败不阻断流程）
      // 按活动 tab ID 存储，使每个标签独立记忆各自目录
      try {
        const activeTabId = useUIStore.getState().getActiveTerminalTab(hostId) ?? 'default';
        await invoke('set_path_cache', { hostId, tabId: activeTabId, path });
      } catch {
        // 路径缓存写入失败视为非致命
      }
      // 文件浏览器 → 终端同步：仅当本次 navigate 不是由终端 cwd 同步触发时，
      // 才回推 pty_cd。否则会形成回环（终端 cd → 文件浏览器刷新 → pty_cd → 终端 cd…）。
      if (!fromTerminal) {
        try {
          const activeTab = useUIStore.getState().getActiveTerminalTab(hostId);
          const isOpen = await invoke<boolean>('pty_is_open', { hostId, tabId: activeTab });
          if (isOpen) {
            // 同一标签重复导航到相同路径时跳过 pty_cd，避免终端出现重复 cd 回显
            const cdKey = ptyCdKey(hostId, activeTab);
            if (lastPtyCdPath.get(cdKey) !== path) {
              lastPtyCdPath.set(cdKey, path);
              await invoke('pty_cd', { hostId, tabId: activeTab, path });
            }
          }
        } catch {
          // pty_is_open / pty_cd 失败不阻断文件浏览
        }
      }
      return true;
    } catch (err) {
      const msg = describeSftpError(err);
      set({ loading: false, error: msg });
      if (!silentOnError) useToastStore.getState().push('error', msg);
      return false;
    }
  },

  syncFromTerminalCwd: async (hostId, path) => {
    // 相同路径无需导航：避免重复加载文件列表，也避免无谓的 uiStore 抖动
    if (path === get().currentPath) return;
    // 设置标志：让接下来的 navigate 跳过 pty_cd 回推
    syncFromTerminal = true;
    await get().navigate(hostId, path);
  },

  refresh: async (hostId) => {
    const path = get().currentPath;
    if (!path) return;
    await get().navigate(hostId, path, { skipHistory: true });
  },

  goBack: async (hostId) => {
    const { history, historyIndex } = get();
    if (historyIndex <= 0) return;
    const target = history[historyIndex - 1];
    if (!target) return;
    await get().navigate(hostId, target, { skipHistory: true });
    set({ historyIndex: historyIndex - 1 });
  },

  goForward: async (hostId) => {
    const { history, historyIndex } = get();
    if (historyIndex >= history.length - 1) return;
    const target = history[historyIndex + 1];
    if (!target) return;
    await get().navigate(hostId, target, { skipHistory: true });
    set({ historyIndex: historyIndex + 1 });
  },

  goUp: async (hostId) => {
    const path = get().currentPath;
    if (!path) return;
    const parent = parentPath(path);
    if (parent === path) return;
    await get().navigate(hostId, parent);
  },

  mkdir: async (hostId, name) => {
    const base = get().currentPath;
    if (!base) {
      useToastStore.getState().push('warning', '尚未打开任何目录');
      return;
    }
    const target = joinPath(base, name);
    try {
      await invoke('sftp_mkdir', { hostId, path: target });
      useToastStore.getState().push('success', `已创建文件夹：${name}`);
      await get().refresh(hostId);
    } catch (err) {
      useToastStore.getState().push('error', describeSftpError(err));
    }
  },

  mkfile: async (hostId, name) => {
    const base = get().currentPath;
    if (!base) {
      useToastStore.getState().push('warning', '尚未打开任何目录');
      return;
    }
    const target = joinPath(base, name);
    try {
      // 创建空文件：write zero bytes
      await invoke('sftp_write_file', { hostId, path: target, data: [] });
      useToastStore.getState().push('success', `已创建文件：${name}`);
      await get().refresh(hostId);
    } catch (err) {
      useToastStore.getState().push('error', describeSftpError(err));
    }
  },

  readFileText: async (hostId, filePath) => {
    const bytes = await invoke<number[]>('sftp_read_file', { hostId, path: filePath });
    try {
      const u8 = new Uint8Array(bytes);
      const decoder = new TextDecoder('utf-8', { fatal: false });
      return decoder.decode(u8);
    } catch {
      // fallback: naive
      return String.fromCharCode(...bytes);
    }
  },

  writeFileText: async (hostId, filePath, content) => {
    const encoder = new TextEncoder();
    const u8 = encoder.encode(content);
    const arr = Array.from(u8);
    await invoke('sftp_write_file', { hostId, path: filePath, data: arr });
  },

  rename: async (hostId, oldName, newName) => {
    const base = get().currentPath;
    if (!base) return;
    if (!newName || newName === oldName) return;
    const oldPath = joinPath(base, oldName);
    const newPath = joinPath(base, newName);
    try {
      await invoke('sftp_rename', { hostId, oldPath, newPath });
      useToastStore.getState().push('success', `已重命名为：${newName}`);
      await get().refresh(hostId);
    } catch (err) {
      useToastStore.getState().push('error', describeSftpError(err));
    }
  },

  remove: async (hostId, name, isDir) => {
    const base = get().currentPath;
    if (!base) return;
    const target = joinPath(base, name);
    try {
      if (isDir) {
        await invoke('sftp_remove_dir', { hostId, path: target });
      } else {
        await invoke('sftp_remove_file', { hostId, path: target });
      }
      useToastStore.getState().push('success', `已删除：${name}`);
      // 如果删除的是当前选中项，清空选中
      const sel = get().selectedEntry;
      if (sel && sel.name === name) {
        set({ selectedEntry: null });
      }
      await get().refresh(hostId);
    } catch (err) {
      useToastStore.getState().push('error', describeSftpError(err));
    }
  },

  resolvePath: async (hostId, input) => {
    try {
      const resolved = await invoke<string>('sftp_resolve_path', { hostId, path: input });
      return resolved;
    } catch (err) {
      useToastStore.getState().push('error', `路径解析失败：${describeSftpError(err)}`);
      return null;
    }
  },

  selectEntry: (entry) => set({
    selectedEntry: entry,
    selectedNames: entry ? new Set([entry.name]) : new Set<string>(),
  }),

  selectOne: (name, mode) => {
    const { selectedNames, entries } = get();
    if (mode === 'replace') {
      set({ selectedNames: new Set([name]), selectedEntry: entries.find(e => e.name === name) ?? null });
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

  clearSelection: () => set({ selectedNames: new Set<string>(), selectedEntry: null }),

  resetState: () =>
    set({
      currentPath: null,
      entries: [],
      loading: false,
      error: null,
      history: [],
      historyIndex: -1,
      selectedEntry: null,
      selectedNames: new Set<string>(),
    }),
}));

// 工具函数：暴露给组件复用
export { parentPath, joinPath, describeSftpError, lastPtyCdPath };
