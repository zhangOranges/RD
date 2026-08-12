import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  Eraser,
  X,
  SquareTerminal,
  RefreshCw,
  Unplug,
  Plus,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { useHostStore } from '../store/hostStore';
import { useUIStore } from '../store/uiStore';
import { useFileStore, lastPtyCdPath } from '../store/fileStore';
import { useHistoryStore } from '../store/historyStore';
import { useToastStore } from './Toast';
import '@xterm/xterm/css/xterm.css';
import '../styles/terminal.css';

/* PTY 事件 payload 形状（与 Rust 端约定，Task 8 新增 tab_id） */
interface PtyDataPayload {
  host_id: string;
  tab_id: string;
  data: number[];
}
interface PtyCwdPayload {
  host_id: string;
  tab_id: string;
  path: string;
}
interface PtyCmdPayload {
  host_id: string;
  tab_id: string;
  command: string;
}
interface PtyClosedPayload {
  host_id: string;
  tab_id: string;
}

/** 每个标签对应的 xterm 实例 + 辅助对象 */
interface TabInstance {
  term: Terminal;
  fitAddon: FitAddon;
  container: HTMLDivElement;
  /** 切换全屏快捷键监听器的 cleanup，关闭标签时调用 */
  fullscreenKeyCleanup: () => void;
  /** xterm attachCustomKeyEventHandler 的 dispose 函数 */
  customKeyHandlerDispose?: { dispose: () => void };
}

/** 判断是否为全屏切换快捷键：Ctrl+Shift+Enter 或 Cmd+Shift+Enter */
function isFullscreenShortcut(e: KeyboardEvent): boolean {
  return (
    (e.ctrlKey || e.metaKey) &&
    e.shiftKey &&
    (e.key === 'Enter' || e.code === 'Enter')
  );
}

/**
 * 全局防抖时间戳（模块级，不依赖 event 对象）。
 * 用于拦截 xterm API 回调与 DOM 原生监听器因 event 对象不同导致的"双触发"。
 * 正常人类不可能在 300ms 内连续按两次 Ctrl+Shift+Enter，所以 300ms 窗口足够安全。
 */
let _lastFsToggleAt = 0;
const FS_DEBOUNCE_MS = 300;

/**
 * 防抖式切换终端全屏：
 * - 若距离上次成功切换 < FS_DEBOUNCE_MS 则直接跳过
 * - 同时尝试 preventDefault / stopPropagation / stopImmediatePropagation
 * 返回 true 表示实际执行了切换
 */
function debouncedToggleFullscreen(e?: KeyboardEvent): boolean {
  const now = Date.now();
  if (now - _lastFsToggleAt < FS_DEBOUNCE_MS) return false;
  _lastFsToggleAt = now;
  if (e) {
    try {
      e.preventDefault();
    } catch {
      /* ignore */
    }
    try {
      e.stopPropagation();
    } catch {
      /* ignore */
    }
    try {
      (e as unknown as { stopImmediatePropagation?: () => void })
        .stopImmediatePropagation?.();
    } catch {
      /* ignore */
    }
  }
  useUIStore
    .getState()
    .setTerminalFullscreen(!useUIStore.getState().terminalFullscreen);
  return true;
}

function formatErr(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** 每标签快照 / 同步状态的复合 key */
function makeTabKey(hostId: string, tabId: string): string {
  return `${hostId}__${tabId}`;
}

/**
 * 过滤"看起来肯定不是 shell 命令"的字符串。
 *
 * 明确拒绝：
 * - 空 / 纯空白
 * - 单字符（`j` / `k` / `q` / `d` 这类 TUI 按键，即便漏网也不会变成命令）
 * - TUI ex 命令：以 `:` 开头，后接非空白（`:wq` / `:q!` / `:set nu` 等）
 * - less/search: `/pattern`、`?pattern`
 * - 仅由非命令字符组成：纯数字、纯标点、纯路径（不以可执行名开头）
 *
 * 接受：至少 2 个可见字符，首 token 形如可执行名（字母/数字/-/. 构成），
 *       且不是上面的 TUI 前缀。
 */
function isLikelyShellCommand(raw: string): boolean {
  const s = raw.trim();
  if (!s) return false;
  if (s.length < 2) return false;
  if (/^[:/?][\s\S]*$/.test(s)) return false;
  // 首字符必须是 shell 标识符允许的起始字母/数字/下划线/_/./- 之一
  if (!/^[A-Za-z0-9_~.\/-]/.test(s)) return false;
  // 纯数字开头 + 没有空格的"数字串"也不是命令（比如日期/计数回显）
  if (/^\d+$/.test(s)) return false;
  return true;
}

/** 保存 xterm 当前可见缓冲区的所有行，去除尾部空行 */
function saveTerminalSnapshot(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** 恢复快照：先 reset 再逐行写入，最后一行用 write 不加换行 */
function restoreTerminalSnapshot(term: Terminal, lines: string[] | undefined) {
  term.reset();
  if (!lines || lines.length === 0) return;
  for (let i = 0; i < lines.length - 1; i++) {
    term.writeln(lines[i]);
  }
  term.write(lines[lines.length - 1]);
}

const EMPTY_TABS: string[] = [];

/** xterm 主题（Tokyo Night） */
const TERMINAL_THEME = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: 'rgba(122, 162, 247, 0.3)',
  black: '#32344a',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#c0caf5',
  brightBlack: '#565f89',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#acb0d0',
} as const;

/**
 * 终端面板：Xterm.js + Tauri PTY 集成（Task 8 多标签）。
 *
 * 每个主机的每个标签对应一个独立 xterm 实例和 PTY 会话。
 * - 标签管理状态在 uiStore（terminalTabs / activeTerminalTab）。
 * - xterm 实例用 Map<tabId, TabInstance> 管理，切换标签时用 CSS display 切换可见性，
 *   保留所有 PTY 会话不卸载。
 * - 全局事件监听在 mount 时注册一次，按 host_id + tab_id 分发到对应 xterm。
 */
export function TerminalPanel() {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // tabId -> 实例（仅当前主机的标签）
  const tabsRef = useRef<Map<string, TabInstance>>(new Map());
  const roRef = useRef<ResizeObserver | null>(null);
  const fitRafRef = useRef<number | null>(null);
  // 当前已打开的主机（用于事件分发与 cleanup）
  const currentHostRef = useRef<string | null>(null);

  // 每个标签的终端内容快照（切换主机时保存，切回时恢复）
  const snapshotsRef = useRef<Map<string, string[]>>(new Map());
  // 每个标签是否已完成初始路径同步
  const initCwdSyncedRef = useRef<Map<string, boolean>>(new Map());
  // 每个标签的最新 cwd 快照（用于切换标签时同步文件浏览器）
  const tabCwdRef = useRef<Map<string, string>>(new Map());
  // 标记忽略下一个 cwd-changed 事件（终端刚打开时的初始 cwd 不应覆盖文件浏览器）
  const ignoreFirstCwdRef = useRef<Set<string>>(new Set());
  // 标记 PTY 是否刚打开，用于过滤旧会话的 pty://closed 事件
  const justOpenedRef = useRef<Set<string>>(new Set());
  // 已断开的标签 tabId 集合
  const disconnectedTabsRef = useRef<Set<string>>(new Set());
  // 每个标签是否处于 alternate screen（vim/less/htop/nano 等全屏 TUI 进入时置为 true，退出时 false）
  // 处于该模式下时不记录任何命令历史，避免捕获 TUI 内部击键
  const altScreenActiveRef = useRef<Map<string, boolean>>(new Map());
  // 每个标签是否已进入"接受命令上报"阶段。初始化脚本会触发几次 PROMPT_COMMAND
  // 并上报注入命令的假象。只有在用户通过 xterm.onData 发出第一个"真实输入字节"
  // （可打印字符 / 回车 / 退格 / Ctrl+U/W/C 等）后，才把对应标签置为 true，
  // pty://cmd-executed 之后才会记录。方向键、Home/End 等控制序列不解锁。
  const acceptingCmdRef = useRef<Map<string, boolean>>(new Map());

  const [activeDisconnected, setActiveDisconnected] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const hosts = useHostStore((s) => s.hosts);
  const terminalHeight = useUIStore((s) => s.terminalHeight);
  const terminalVisibleMap = useUIStore((s) => s.terminalVisible);
  const setTerminalVisible = useUIStore((s) => s.setTerminalVisible);
  const terminalFullscreen = useUIStore((s) => s.terminalFullscreen);
  const setTerminalFullscreen = useUIStore((s) => s.setTerminalFullscreen);
  const terminalTabsMap = useUIStore((s) => s.terminalTabs);
  const activeTerminalTabMap = useUIStore((s) => s.activeTerminalTab);
  const addTerminalTab = useUIStore((s) => s.addTerminalTab);
  const removeTerminalTab = useUIStore((s) => s.removeTerminalTab);
  const setActiveTerminalTab = useUIStore((s) => s.setActiveTerminalTab);

  const terminalVisible = !!selectedHostId && !!terminalVisibleMap[selectedHostId];
  const isConnected =
    !!selectedHostId && connectionStates[selectedHostId] === 'connected';
  const hostName =
    hosts.find((h) => h.id === selectedHostId)?.name ?? '终端';
  const tabs = selectedHostId
    ? terminalTabsMap[selectedHostId] ?? EMPTY_TABS
    : EMPTY_TABS;
  const activeTab = selectedHostId
    ? activeTerminalTabMap[selectedHostId] ?? null
    : null;

  /* ---------- 触发一次自适应（防抖到 rAF） ---------- */
  const requestFit = (tabId?: string) => {
    const id =
      tabId ??
      (selectedHostId
        ? useUIStore.getState().activeTerminalTab[selectedHostId] ?? undefined
        : undefined);
    if (!id) return;
    const inst = tabsRef.current.get(id);
    if (!inst) return;
    if (fitRafRef.current !== null) {
      cancelAnimationFrame(fitRafRef.current);
    }
    fitRafRef.current = requestAnimationFrame(() => {
      fitRafRef.current = null;
      try {
        inst.fitAddon.fit();
      } catch {
        return;
      }
      const hostId = currentHostRef.current;
      if (hostId) {
        void invoke('pty_resize', {
          hostId,
          tabId: id,
          cols: inst.term.cols,
          rows: inst.term.rows,
        }).catch(() => {
          /* PTY 可能尚未打开 */
        });
      }
    });
  };

  /* ---------- 创建单个标签的 xterm 实例（同步）并打开 PTY ---------- */
  const createTabInstance = (hostId: string, tabId: string) => {
    if (!bodyRef.current) return;
    if (tabsRef.current.has(tabId)) return;

    const term = new Terminal({
      fontSize: 14,
      fontFamily:
        '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, Consolas, "Courier New", monospace',
      fontWeight: '400',
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
      lineHeight: 1.2,
      letterSpacing: 0.3,
      theme: TERMINAL_THEME,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    const container = document.createElement('div');
    container.className = 'terminal-tab-container';
    container.dataset.tabId = tabId;
    // 活动标签可见，其余隐藏
    const activeNow = useUIStore.getState().activeTerminalTab[hostId];
    container.style.display = tabId === activeNow ? 'block' : 'none';
    bodyRef.current.appendChild(container);
    term.open(container);

    // ====== 终端内全屏快捷键拦截（仅 1 层：xterm 官方 API，最可靠） ======
    const cleanupFns: Array<() => void> = [];

    // 仅用 xterm 官方 attachCustomKeyEventHandler 处理终端内按键。
    // 这是终端内部最可靠的拦截点：在 xterm 处理任何键盘事件之前回调，返回 false 让 xterm 忽略此键。
    // 外层 document 还有 1 层兜底（带分流），两侧通过全局时间戳防抖避免双触发。
    let customKeyHandlerDispose: { dispose: () => void } | undefined;
    try {
      const termAny = term as unknown as {
        attachCustomKeyEventHandler?: (
          handler: (e: KeyboardEvent) => boolean,
        ) => { dispose: () => void };
      };
      if (typeof termAny.attachCustomKeyEventHandler === 'function') {
        customKeyHandlerDispose = termAny.attachCustomKeyEventHandler((e) => {
          if (isFullscreenShortcut(e)) {
            debouncedToggleFullscreen(e);
            return false; // 阻止 xterm 继续处理
          }
          return true; // 其他键交给 xterm 正常处理
        });
      }
    } catch {
      /* attachCustomKeyEventHandler 不可用时忽略，交给外层 document 兜底 */
    }

    const fullscreenKeyCleanup = () => {
      for (const fn of cleanupFns) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      customKeyHandlerDispose?.dispose?.();
    };

    tabsRef.current.set(tabId, {
      term,
      fitAddon,
      container,
      fullscreenKeyCleanup,
      customKeyHandlerDispose,
    });

    // 监听 PTY 输出中的 alternate screen 切换 CSI 序列：
    // ESC [ ? 1049 h → 进入全屏 TUI（vim/less/htop/nano/tmux 等）
    // ESC [ ? 1049 l → 退出全屏 TUI，回到 shell 正常缓冲
    // 覆盖 1047/47 等兼容序列（备用缓冲切换不含"保存光标"语义，但同样是 TUI 模式）
    const tabKey = makeTabKey(hostId, tabId);
    const parser = (term as unknown as { parser: {
      registerCsiHandler: (
        spec: { prefix?: string; intermediates?: string; params?: number[]; final: string },
        cb: (params: number[]) => boolean | void,
      ) => void;
    } }).parser;
    const registerAltScreen = (final: 'h' | 'l', mark: boolean) => {
      try {
        parser.registerCsiHandler(
          { final, prefix: '?', intermediates: '' as unknown as undefined },
          (params) => {
            for (const p of params) {
              if (p === 1049 || p === 1047 || p === 47) {
                altScreenActiveRef.current.set(tabKey, mark);
              }
            }
            return false;
          },
        );
      } catch {
        /* 某些 xterm 版本 parser API 不同，忽略即可 */
      }
    };
    registerAltScreen('h', true);
    registerAltScreen('l', false);

    // xterm → PTY：用户输入
    term.onData((data) => {
      const bytes = Array.from(new TextEncoder().encode(data));
      void invoke('pty_write', { hostId, tabId, data: bytes }).catch(() => {
        /* PTY 可能已关闭 */
      });

      // 第一个"真实输入字节"到达时解锁该标签的 cmd 上报。
      // 方向键 / Home / End / 功能键等控制序列（ESC 开头）不解锁，
      // 避免仅通过上下键查看 history 就解锁（初始化 HOOK 仍在触发）。
      const key = makeTabKey(hostId, tabId);
      if (!acceptingCmdRef.current.get(key)) {
        const first = bytes[0];
        const isControlSeq = first === 0x1b; // ESC
        const isRealInput =
          !isControlSeq &&
          bytes.some(
            (b) =>
              // 可打印字符 / 回车 / LF / TAB / BS / DEL / Ctrl+C / Ctrl+U / Ctrl+W
              (b >= 0x20 && b <= 0x7e) ||
              b === 0x09 ||
              b === 0x0a ||
              b === 0x0d ||
              b === 0x03 ||
              b === 0x08 ||
              b === 0x15 ||
              b === 0x17 ||
              b === 0x7f,
          );
        if (isRealInput) acceptingCmdRef.current.set(key, true);
      }
    });

    // 右键复制 / 粘贴
    const xtermEl = container.querySelector('.xterm') as HTMLElement | null;
    if (xtermEl) {
      xtermEl.addEventListener('contextmenu', async (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (term.hasSelection()) {
          const selection = term.getSelection();
          if (selection) {
            try {
              await writeText(selection);
              useToastStore.getState().push('success', '已复制');
            } catch {
              /* ignore */
            }
            term.clearSelection();
          }
        } else {
          try {
            let text: string | null = null;
            try {
              text = await readText();
            } catch {
              try {
                text = await navigator.clipboard.readText();
              } catch {
                /* ignore */
              }
            }
            if (text) {
              const bytes = Array.from(new TextEncoder().encode(text));
              await invoke('pty_write', { hostId, tabId, data: bytes });
            }
          } catch (err) {
            useToastStore
              .getState()
              .push('warning', `粘贴失败：${String(err ?? '无法读取剪贴板')}`);
          }
        }
      });
    }

    // 恢复该标签的快照
    const key = makeTabKey(hostId, tabId);
    const snapshot = snapshotsRef.current.get(key);
    restoreTerminalSnapshot(term, snapshot);

    // 打开 PTY（幂等），返回是否新建了会话
    justOpenedRef.current.add(key);
    void invoke<boolean>('pty_open', { hostId, tabId })
      .then((isNew) => {
        justOpenedRef.current.delete(key);
        // 实例可能已被销毁（切换主机）
        if (!tabsRef.current.has(tabId)) return;
        requestFit(tabId);
        ignoreFirstCwdRef.current.add(key);
        if (isNew) {
          // 新建 PTY 会话：重置该标签的 pty_cd 路径记录
          lastPtyCdPath.delete(key);
          initCwdSyncedRef.current.set(key, false);
          setTimeout(() => {
            if (!tabsRef.current.has(tabId)) return;
            // 优先从路径缓存恢复该标签上次目录（跨会话持久化）；
            // 缓存不存在时回退到文件浏览器当前路径
            void (async () => {
              let targetPath: string | null = null;
              try {
                const cached = await invoke<string | null>('get_path_cache', {
                  hostId,
                  tabId,
                });
                if (cached && cached.startsWith('/')) targetPath = cached;
              } catch {
                /* ignore */
              }
              if (!targetPath) {
                targetPath = useFileStore.getState().currentPath;
              }
              if (targetPath && lastPtyCdPath.get(key) !== targetPath) {
                lastPtyCdPath.set(key, targetPath);
                void invoke('pty_cd', { hostId, tabId, path: targetPath }).catch(
                  () => {},
                );
              }
              initCwdSyncedRef.current.set(key, true);
            })();
          }, 500);
        } else {
          initCwdSyncedRef.current.set(key, true);
        }
      })
      .catch((err) => {
        justOpenedRef.current.delete(key);
        if (!tabsRef.current.has(tabId)) return;
        disconnectedTabsRef.current.add(tabId);
        const active = useUIStore.getState().activeTerminalTab[hostId];
        if (active === tabId) setActiveDisconnected(true);
        useToastStore
          .getState()
          .push('error', `终端打开失败：${formatErr(err)}`);
      });
  };

  /* ---------- Effect 1：全局事件监听 + ResizeObserver（仅 mount 一次） ---------- */
  useEffect(() => {
    if (!bodyRef.current) return;

    const unlistens: UnlistenFn[] = [];
    let disposed = false;

    // PTY → xterm：输出数据（按 host_id + tab_id 分发）
    const dataListenerPromise = listen<PtyDataPayload>('pty://data', (event) => {
      const { host_id, tab_id, data } = event.payload;
      if (currentHostRef.current !== host_id) return;
      const inst = tabsRef.current.get(tab_id);
      if (!inst) return;
      if (!data || data.length === 0) return;
      inst.term.write(new Uint8Array(data));
    });

    // 工作目录变更 → 记录该标签 cwd 快照；若是活动标签则同步到文件浏览器
    const cwdListenerPromise = listen<PtyCwdPayload>(
      'pty://cwd-changed',
      (event) => {
        const { host_id, tab_id, path } = event.payload;
        if (currentHostRef.current !== host_id) return;
        const key = makeTabKey(host_id, tab_id);
        // 无论是否活动标签，都更新该标签的 cwd 快照（切换标签时需要用到）
        tabCwdRef.current.set(key, path);
        const activeTab = useUIStore.getState().activeTerminalTab[host_id];
        if (tab_id !== activeTab) return;
        if (!initCwdSyncedRef.current.get(key)) return;
        if (ignoreFirstCwdRef.current.has(key)) {
          ignoreFirstCwdRef.current.delete(key);
          return;
        }
        void useFileStore.getState().syncFromTerminalCwd(host_id, path);
      },
    );

    // 命令执行完毕：shell PROMPT_COMMAND 通过 OSC 7777;cmd;<command> 报告
    const cmdListenerPromise = listen<PtyCmdPayload>(
      'pty://cmd-executed',
      (event) => {
        const { host_id, tab_id, command } = event.payload;
        if (currentHostRef.current !== host_id) return;
        const key = makeTabKey(host_id, tab_id);
        // 初始化阶段未解锁：注入命令的上报全部丢弃
        if (!acceptingCmdRef.current.get(key)) return;
        if (altScreenActiveRef.current.get(key)) return;
        const cmd = command.replace(/\s+/g, ' ').trim();
        if (isLikelyShellCommand(cmd)) {
          useHistoryStore.getState().recordCommand(cmd);
        }
      },
    );

    // PTY 关闭 / 异常断开
    const closedListenerPromise = listen<PtyClosedPayload>(
      'pty://closed',
      (event) => {
        const { host_id, tab_id } = event.payload;
        if (currentHostRef.current !== host_id) return;
        const key = makeTabKey(host_id, tab_id);
        const markDisconnected = () => {
          disconnectedTabsRef.current.add(tab_id);
          const active = useUIStore.getState().activeTerminalTab[host_id];
          if (active === tab_id) setActiveDisconnected(true);
        };
        if (justOpenedRef.current.has(key)) {
          justOpenedRef.current.delete(key);
          setTimeout(() => {
            if (disposed) return;
            void invoke<boolean>('pty_is_open', { hostId: host_id, tabId: tab_id })
              .then((isOpen) => {
                if (!isOpen) markDisconnected();
              })
              .catch(() => markDisconnected());
          }, 200);
          return;
        }
        markDisconnected();
      },
    );

    void Promise.all([
      dataListenerPromise,
      cwdListenerPromise,
      cmdListenerPromise,
      closedListenerPromise,
    ]).then((fns) => {
      if (disposed) {
        fns.forEach((fn) => fn());
      } else {
        unlistens.push(...fns);
      }
    });

    // ResizeObserver：容器尺寸变化 → fit + pty_resize（活动标签）
    // double rAF 延后一帧再 fit，避免和 React class/Tauri 窗口动画在同一帧竞争布局
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => requestFit());
      });
    });
    ro.observe(bodyRef.current);
    roRef.current = ro;

    // Ctrl+Shift+Enter → 切换终端全屏（全局兜底层，仅一层）。
    // 采用"分流 + 防抖"双保险：
    //   1. 分流：焦点在终端内部时，交给 xterm attachCustomKeyEventHandler 处理（更及时）
    //           焦点在终端外部时（文件树/工具栏等），由 document 层直接兜底
    //   2. 防抖：全局 _lastFsToggleAt 时间戳（300ms 窗口），无论哪一侧先触发，
    //           另一侧在 300ms 内的重复调用都会被丢弃，从根本上杜绝"最大化后立刻还原"
    const onFullscreenDocKey = (e: KeyboardEvent) => {
      if (!isFullscreenShortcut(e)) return;
      const active = document.activeElement as HTMLElement | null;
      const insideTerminal =
        !!active &&
        (active.classList?.contains('xterm-helper-textarea') ||
          (active.closest && !!active.closest('.terminal-tab-container')));
      if (insideTerminal) {
        // 焦点在终端内：xterm 内部那层应该已经处理了（或即将处理）。
        // 这里也调一次，但 300ms 防抖会自动丢弃掉第二次调用，双保险。
        debouncedToggleFullscreen(e);
      } else {
        // 焦点不在终端内：直接执行
        debouncedToggleFullscreen(e);
      }
    };
    document.addEventListener('keydown', onFullscreenDocKey, true);

    return () => {
      disposed = true;
      if (fitRafRef.current !== null) {
        cancelAnimationFrame(fitRafRef.current);
        fitRafRef.current = null;
      }
      ro.disconnect();
      roRef.current = null;
      document.removeEventListener('keydown', onFullscreenDocKey, true);
      unlistens.forEach((fn) => fn());
      unlistens.length = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Effect 2：主机切换 —— 创建/销毁所有标签实例 ---------- */
  useEffect(() => {
    if (!isConnected || !selectedHostId) {
      // 未连接：清理所有实例（PTY 由断开逻辑关闭）
      for (const [, inst] of tabsRef.current) {
        inst.term.dispose();
        inst.container.remove();
      }
      tabsRef.current.clear();
      currentHostRef.current = null;
      return;
    }
    const hostId = selectedHostId;
    currentHostRef.current = hostId;
    setActiveDisconnected(false);

    // 确保主机至少有一个标签（首次自动创建 "default"）
    let currentTabs = useUIStore.getState().terminalTabs[hostId] ?? [];
    if (currentTabs.length === 0) {
      addTerminalTab(hostId);
      currentTabs = useUIStore.getState().terminalTabs[hostId] ?? [];
    }

    // 为每个标签创建 xterm 实例 + 打开 PTY
    for (const tabId of currentTabs) {
      createTabInstance(hostId, tabId);
    }

    // 初次布局
    requestAnimationFrame(() => requestFit());

    return () => {
      // 切换离开前保存每个标签的终端内容
      for (const [tabId, inst] of tabsRef.current) {
        snapshotsRef.current.set(
          makeTabKey(hostId, tabId),
          saveTerminalSnapshot(inst.term),
        );
        try {
          inst.fullscreenKeyCleanup();
        } catch {
          /* ignore */
        }
        inst.customKeyHandlerDispose?.dispose?.();
        inst.term.dispose();
        inst.container.remove();
      }
      tabsRef.current.clear();

      // 仅在主机断开连接时关闭 PTY；面板隐藏时保留会话
      const currentConnState =
        useHostStore.getState().connectionStates[hostId];
      if (currentConnState !== 'connected') {
        // 主机已断开：清空快照和初始同步状态（重连后是全新会话）
        for (const tabId of currentTabs) {
          const key = makeTabKey(hostId, tabId);
          snapshotsRef.current.delete(key);
          initCwdSyncedRef.current.delete(key);
          ignoreFirstCwdRef.current.delete(key);
          justOpenedRef.current.delete(key);
          altScreenActiveRef.current.delete(key);
          disconnectedTabsRef.current.delete(tabId);
          void invoke('pty_close', { hostId, tabId }).catch(() => {});
        }
      }
      currentHostRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHostId, isConnected]);

  /* ---------- Effect 3：活动标签变化 —— 显示/隐藏 + fit + cwd 同步 ---------- */
  useEffect(() => {
    if (!activeTab) {
      setActiveDisconnected(false);
      return;
    }
    // 显示活动标签，隐藏其余
    tabsRef.current.forEach((inst, id) => {
      inst.container.style.display = id === activeTab ? 'block' : 'none';
    });
    requestAnimationFrame(() => requestFit(activeTab));
    // 更新断开状态
    setActiveDisconnected(disconnectedTabsRef.current.has(activeTab));
    // 切换标签时同步文件浏览器到新活动标签的 cwd
    // syncFromTerminalCwd 内部会设置 syncFromTerminal 标志，避免 navigate 又回推 pty_cd 形成回环
    if (selectedHostId) {
      const key = makeTabKey(selectedHostId, activeTab);
      if (initCwdSyncedRef.current.get(key)) {
        const cwd = tabCwdRef.current.get(key);
        if (cwd) {
          void useFileStore.getState().syncFromTerminalCwd(selectedHostId, cwd);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  /* ---------- Effect 4：尺寸/可见性/全屏变化时重新 fit ---------- */
  // 全屏切换会把容器从 flex 子项变成 position:fixed inset:0，
  // 需要等待 React 把 class 写到 DOM、浏览器完成 layout 后再 fit；
  // 用 rAF 嵌套保证在下一帧的 layout 之后再读取尺寸。
  useEffect(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => requestFit());
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalHeight, terminalVisible, terminalFullscreen]);

  /* ---------- 新增标签 ---------- */
  const handleAddTab = () => {
    if (!selectedHostId || !isConnected) return;
    const hostId = selectedHostId;
    const tabId = addTerminalTab(hostId);
    createTabInstance(hostId, tabId);
    // addTerminalTab 已将新标签设为活动，Effect 3 会切换显示
  };

  /* ---------- 关闭标签 ---------- */
  const handleCloseTab = async (tabId: string) => {
    if (!selectedHostId) return;
    const hostId = selectedHostId;
    // 关闭 PTY 会话
    await invoke('pty_close', { hostId, tabId }).catch(() => {});
    // 销毁 xterm 实例
    const inst = tabsRef.current.get(tabId);
    if (inst) {
      try {
        inst.fullscreenKeyCleanup();
      } catch {
        /* ignore */
      }
      inst.customKeyHandlerDispose?.dispose?.();
      inst.term.dispose();
      inst.container.remove();
      tabsRef.current.delete(tabId);
    }
    // 清理每标签状态
    const key = makeTabKey(hostId, tabId);
    snapshotsRef.current.delete(key);
    initCwdSyncedRef.current.delete(key);
    tabCwdRef.current.delete(key);
    ignoreFirstCwdRef.current.delete(key);
    justOpenedRef.current.delete(key);
    lastPtyCdPath.delete(key);
    altScreenActiveRef.current.delete(key);
    disconnectedTabsRef.current.delete(tabId);
    // 从 store 移除（会切换活动标签到相邻标签）
    removeTerminalTab(hostId, tabId);
  };

  /* ---------- 清屏（活动标签） ---------- */
  const handleClear = () => {
    if (!activeTab) return;
    tabsRef.current.get(activeTab)?.term.clear();
  };

  /* ---------- 关闭终端面板 ---------- */
  const handleClose = () => {
    if (selectedHostId) setTerminalVisible(selectedHostId, false);
  };

  /* ---------- 全屏切换 ---------- */
  const handleToggleFullscreen = () => {
    setTerminalFullscreen(!terminalFullscreen);
  };

  /* ---------- 断开后重试（活动标签） ---------- */
  const handleRetry = async () => {
    if (!selectedHostId || !activeTab || retrying) return;
    const hostId = selectedHostId;
    const tabId = activeTab;
    const key = makeTabKey(hostId, tabId);
    setRetrying(true);
    try {
      await invoke('pty_close', { hostId, tabId }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 300));
      justOpenedRef.current.add(key);
      const isNew = await invoke<boolean>('pty_open', { hostId, tabId });
      justOpenedRef.current.delete(key);
      disconnectedTabsRef.current.delete(tabId);
      setActiveDisconnected(false);
      const inst = tabsRef.current.get(tabId);
      if (inst) {
        requestAnimationFrame(() => requestFit(tabId));
        if (isNew) {
          snapshotsRef.current.delete(key);
          inst.term.reset();
          ignoreFirstCwdRef.current.add(key);
        }
      }
    } catch (err) {
      justOpenedRef.current.delete(key);
      useToastStore
        .getState()
        .push('error', `重连失败：${formatErr(err)}`);
    } finally {
      setRetrying(false);
    }
  };

  const showConnectPrompt = !isConnected;
  const showEmptyState = isConnected && tabs.length === 0;

  return (
    <div
      className={`terminal-panel-root${terminalFullscreen ? ' terminal-fullscreen' : ''}`}
    >
      {/* 标签栏 + 操作按钮 */}
      <div className="terminal-header" role="toolbar" aria-label="终端工具栏">
        <div className="terminal-tabs">
          <span className="terminal-header-icon" aria-hidden="true">
            <SquareTerminal size={13} />
          </span>
          {tabs.map((tabId, idx) => (
            <div
              key={tabId}
              className={`terminal-tab${tabId === activeTab ? ' active' : ''}`}
              onClick={() =>
                selectedHostId && setActiveTerminalTab(selectedHostId, tabId)
              }
              title={`${hostName} — 终端 ${idx + 1}`}
            >
              <span className="terminal-tab-label">终端 {idx + 1}</span>
              {tabs.length > 1 && (
                <button
                  className="terminal-tab-close"
                  type="button"
                  aria-label="关闭标签"
                  title="关闭标签"
                  onClick={(e) => {
                    e.stopPropagation();
                    void handleCloseTab(tabId);
                  }}
                >
                  <X size={11} />
                </button>
              )}
            </div>
          ))}
          <button
            className="terminal-tab-add"
            type="button"
            aria-label="新建终端标签"
            title="新建终端标签"
            onClick={handleAddTab}
            disabled={!isConnected}
          >
            <Plus size={13} />
          </button>
        </div>
        <div className="terminal-header-actions">
          {isConnected && (
            <span className="terminal-header-state">已连接</span>
          )}
          <button
            className="terminal-titlebar-btn"
            type="button"
            aria-label={terminalFullscreen ? '退出全屏' : '全屏'}
            title={terminalFullscreen ? '退出全屏 (Ctrl+Shift+Enter)' : '全屏 (Ctrl+Shift+Enter)'}
            onClick={handleToggleFullscreen}
          >
            {terminalFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            className="terminal-titlebar-btn"
            type="button"
            aria-label="清屏"
            title="清屏"
            onClick={handleClear}
            disabled={!isConnected || activeDisconnected}
          >
            <Eraser size={13} />
          </button>
          <button
            className="terminal-titlebar-btn"
            type="button"
            aria-label="关闭终端"
            title="关闭终端"
            onClick={handleClose}
          >
            <X size={13} />
          </button>
        </div>
      </div>

      {/* 终端主体 */}
      <div className="terminal-body" ref={bodyRef}>
        {/* Xterm 渲染节点由 createTabInstance 动态注入 */}

        {/* 未连接提示 */}
        {showConnectPrompt && (
          <div className="terminal-overlay">
            <span className="terminal-overlay-icon" aria-hidden="true">
              <Unplug size={26} />
            </span>
            <p className="terminal-overlay-title">请先连接主机</p>
            <p className="terminal-overlay-sub">
              在左侧侧边栏选择并连接一个主机后，终端将自动打开
            </p>
          </div>
        )}

        {/* 标签全部关闭时的空状态 */}
        {showEmptyState && (
          <div className="terminal-overlay">
            <span className="terminal-overlay-icon" aria-hidden="true">
              <SquareTerminal size={26} />
            </span>
            <p className="terminal-overlay-title">没有打开的终端</p>
            <button
              className="terminal-retry-btn"
              type="button"
              onClick={handleAddTab}
            >
              <Plus size={13} />
              新建终端
            </button>
          </div>
        )}

        {/* 活动 PTY 标签断开重试 */}
        {activeDisconnected && isConnected && !showEmptyState && (
          <div className="terminal-overlay">
            <span className="terminal-overlay-icon" aria-hidden="true">
              <RefreshCw size={26} />
            </span>
            <p className="terminal-overlay-title">连接已断开</p>
            <p className="terminal-overlay-sub">终端会话已结束，点击重试重新打开</p>
            <button
              className="terminal-retry-btn"
              type="button"
              onClick={() => void handleRetry()}
              disabled={retrying}
            >
              <RefreshCw size={13} />
              {retrying ? '重连中…' : '重试'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
