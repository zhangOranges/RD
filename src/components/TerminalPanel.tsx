import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import { readText, writeText } from '@tauri-apps/plugin-clipboard-manager';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { Eraser, X, SquareTerminal, RefreshCw, Unplug } from 'lucide-react';
import { useHostStore } from '../store/hostStore';
import { useUIStore } from '../store/uiStore';
import { useFileStore, lastPtyCdPath } from '../store/fileStore';
import { useToastStore } from './Toast';
import '@xterm/xterm/css/xterm.css';
import '../styles/terminal.css';

/* PTY 事件 payload 形状（与 Rust 端约定） */
interface PtyDataPayload {
  host_id: string;
  data: number[];
}
interface PtyCwdPayload {
  host_id: string;
  path: string;
}
interface PtyClosedPayload {
  host_id: string;
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
  // 去除尾部连续空行，避免恢复时光标在最后一行下方
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

/**
 * 终端面板：Xterm.js + Tauri PTY 集成。
 *
 * 生命周期：
 * - 组件 mount：创建 Terminal / FitAddon，open 到容器；
 *   若 selectedHostId 存在且已连接，invoke pty_open 并注册 pty://* 事件监听。
 * - hostId / 连接状态变化：先 pty_close 旧的并清理监听，再 pty_open 新的。
 * - 组件 unmount：pty_close + 取消监听 + dispose 终端实例。
 *
 * 该组件无 props，全部状态来自 hostStore / uiStore。
 */
export function TerminalPanel() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const fitRafRef = useRef<number | null>(null);
  // 当前已打开 PTY 的 hostId（用于在 cleanup 时关闭正确的会话）
  const openedHostRef = useRef<string | null>(null);
  // 标记是否忽略下一个 cwd-changed 事件（终端刚打开时的初始 cwd 不应覆盖文件浏览器）
  const ignoreFirstCwdRef = useRef<boolean>(false);
  // 标记 PTY 是否刚打开，用于过滤旧会话的 pty://closed 事件
  const justOpenedRef = useRef<boolean>(false);
  // 每个主机的终端内容快照：切换主机时保存旧主机输出，切回时恢复
  const termSnapshotsRef = useRef<Map<string, string[]>>(new Map());
  // 每个主机是否已完成初始路径同步（PTY 刚打开时忽略 cwd 事件，等 pty_cd 完成后再放行）
  const initCwdSyncedRef = useRef<Map<string, boolean>>(new Map());

  const [disconnected, setDisconnected] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const hosts = useHostStore((s) => s.hosts);
  const terminalHeight = useUIStore((s) => s.terminalHeight);
  const terminalVisibleMap = useUIStore((s) => s.terminalVisible);
  const setTerminalVisible = useUIStore((s) => s.setTerminalVisible);
  const terminalVisible = !!selectedHostId && !!terminalVisibleMap[selectedHostId];

  const isConnected =
    !!selectedHostId && connectionStates[selectedHostId] === 'connected';
  const hostName =
    hosts.find((h) => h.id === selectedHostId)?.name ?? '终端';

  /* ---------- 触发一次自适应（防抖到 rAF） ---------- */
  const requestFit = () => {
    const term = termRef.current;
    const fit = fitRef.current;
    const hostId = openedHostRef.current;
    if (!term || !fit) return;
    if (fitRafRef.current !== null) {
      cancelAnimationFrame(fitRafRef.current);
    }
    fitRafRef.current = requestAnimationFrame(() => {
      fitRafRef.current = null;
      try {
        fit.fit();
      } catch {
        /* 容器尚未布局好时忽略 */
        return;
      }
      if (hostId) {
        void invoke('pty_resize', {
          hostId,
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {
          /* PTY 可能尚未打开 */
        });
      }
    });
  };

  /* ---------- Effect 1：终端实例生命周期（仅 mount 一次） ---------- */
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      fontSize: 14,
      fontFamily: '"JetBrains Mono", "Fira Code", "Cascadia Code", Menlo, Monaco, Consolas, "Courier New", monospace',
      fontWeight: '400',
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 10000,
      allowProposedApi: true,
      lineHeight: 1.2,
      letterSpacing: 0.3,
      theme: {
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
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    termRef.current = term;
    fitRef.current = fit;

    // xterm 会吞掉 contextmenu 事件，需要在 xterm 的内部 DOM 上直接监听
    const xtermEl = containerRef.current.querySelector('.xterm') as HTMLElement | null;
    if (xtermEl) {
      xtermEl.addEventListener('contextmenu', async (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const term = termRef.current;
        if (!term || !openedHostRef.current) return;
        const hostId = openedHostRef.current;
        const hasSelection = term.hasSelection();
        if (hasSelection) {
          // 有选中则复制
          const selection = term.getSelection();
          if (selection) {
            try {
              await writeText(selection);
              useToastStore.getState().push('success', '已复制');
            } catch {
              /* 忽略错误 */
            }
            term.clearSelection();
          }
        } else {
          // 无选中则粘贴
          try {
            let text: string | null = null;
            try {
              text = await readText();
            } catch {
              /* Tauri 插件失败时回退到 navigator.clipboard */
              try {
                text = await navigator.clipboard.readText();
              } catch {
                /* ignore */
              }
            }
            if (text) {
              const bytes = Array.from(new TextEncoder().encode(text));
              await invoke('pty_write', { hostId, data: bytes });
            }
          } catch (err) {
            useToastStore
              .getState()
              .push('warning', `粘贴失败：${String(err ?? '无法读取剪贴板')}`);
          }
        }
      });
    }

    // 初次布局；容器可能刚渲染，下一帧再 fit 一次以拿到准确尺寸
    try {
      fit.fit();
    } catch {
      /* ignore */
    }
    requestAnimationFrame(() => requestFit());

    // ResizeObserver：容器尺寸变化 → fit + pty_resize
    const ro = new ResizeObserver(() => {
      requestFit();
    });
    ro.observe(containerRef.current);
    roRef.current = ro;

    return () => {
      if (fitRafRef.current !== null) {
        cancelAnimationFrame(fitRafRef.current);
        fitRafRef.current = null;
      }
      ro.disconnect();
      roRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- Effect 2：PTY 会话生命周期 ---------- */
  useEffect(() => {
    if (!isConnected || !selectedHostId) return;
    const hostId = selectedHostId;
    let disposed = false;
    const unlistens: UnlistenFn[] = [];
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;

    setDisconnected(false);
    openedHostRef.current = hostId;

    // xterm → PTY：用户输入 / 粘贴
    const onDataDisp = term.onData((data) => {
      const bytes = Array.from(new TextEncoder().encode(data));
      void invoke('pty_write', { hostId, data: bytes }).catch(() => {
        /* PTY 可能已关闭 */
      });
    });

    // PTY → xterm：输出数据
    const dataListenerPromise = listen<PtyDataPayload>('pty://data', (event) => {
      if (event.payload.host_id !== hostId) return;
      const arr = event.payload.data;
      if (!arr || arr.length === 0) return;
      term.write(new Uint8Array(arr));
    });

    // 工作目录变更 → 同步到文件浏览器
    const cwdListenerPromise = listen<PtyCwdPayload>(
      'pty://cwd-changed',
      (event) => {
        if (event.payload.host_id !== hostId) return;
        // PTY 新建会话时，在初始 pty_cd 完成前忽略所有 cwd 事件
        // （避免 shell 的 home 路径覆盖 ContentArea 的缓存路径）
        if (!initCwdSyncedRef.current.get(hostId)) return;
        if (ignoreFirstCwdRef.current) {
          ignoreFirstCwdRef.current = false;
          return;
        }
        void useFileStore.getState().syncFromTerminalCwd(hostId, event.payload.path);
      },
    );

    // PTY 关闭 / 异常断开
    const closedListenerPromise = listen<PtyClosedPayload>(
      'pty://closed',
      (event) => {
        if (event.payload.host_id !== hostId) return;
        if (justOpenedRef.current) {
          justOpenedRef.current = false;
          setTimeout(() => {
            if (disposed) return;
            void invoke('pty_is_open', { hostId })
              .then((isOpen) => {
                if (!isOpen && !disposed) {
                  setDisconnected(true);
                }
              })
              .catch(() => {
                if (!disposed) setDisconnected(true);
              });
          }, 200);
          return;
        }
        setDisconnected(true);
      },
    );

    void Promise.all([
      dataListenerPromise,
      cwdListenerPromise,
      closedListenerPromise,
    ]).then((fns) => {
      if (disposed) {
        fns.forEach((fn) => fn());
      } else {
        unlistens.push(...fns);
      }
    });

    // 打开 PTY（幂等），返回是否新建了会话
    justOpenedRef.current = true;
    void invoke<boolean>('pty_open', { hostId })
      .then((isNew) => {
        if (disposed) return;
        justOpenedRef.current = false;
        requestAnimationFrame(() => requestFit());
        // 恢复该主机的终端快照。cleanup 时已清空终端并保存了快照，
        // 这里无论 isNew 都恢复，让切回的主机能看到之前的输出。
        const snapshot = termSnapshotsRef.current.get(hostId);
        restoreTerminalSnapshot(term, snapshot);
        ignoreFirstCwdRef.current = true;
        if (isNew) {
          // 新建 PTY 会话：重置该主机的 pty_cd 路径记录，
          // 让后续 ContentArea init 时能正确发送 pty_cd（新 shell 在 home 目录）
          lastPtyCdPath.delete(hostId);
          // 初始同步前忽略 cwd 事件，防止 shell 的 home 路径覆盖缓存路径
          initCwdSyncedRef.current.set(hostId, false);
          // 延迟读取 currentPath：ContentArea 的 init() 是 fire-and-forget，
          // pty_open 回调执行时 navigate 可能还没完成，currentPath 仍是 null。
          // 在 setTimeout 里读取，确保 ContentArea init 已设置好路径。
          setTimeout(() => {
            if (disposed) return;
            const fState = useFileStore.getState();
            const targetPath = fState.currentPath;
            if (targetPath && lastPtyCdPath.get(hostId) !== targetPath) {
              lastPtyCdPath.set(hostId, targetPath);
              void invoke('pty_cd', { hostId, path: targetPath }).catch(() => {});
            }
            // 初始 pty_cd 完成后，放行后续 cwd 事件
            initCwdSyncedRef.current.set(hostId, true);
          }, 500);
        }
      })
      .catch((err) => {
        if (disposed) return;
        justOpenedRef.current = false;
        setDisconnected(true);
        useToastStore
          .getState()
          .push('error', `终端打开失败：${formatErr(err)}`);
      });

    return () => {
      disposed = true;
      // 切换离开前保存当前终端内容，切回时可恢复
      if (termRef.current) {
        termSnapshotsRef.current.set(hostId, saveTerminalSnapshot(termRef.current));
        // 清空终端显示，避免下一个主机的 PTY 输出混入旧主机内容
        termRef.current.reset();
      }
      onDataDisp.dispose();
      unlistens.forEach((fn) => fn());
      unlistens.length = 0;
      // 仅在主机断开连接时关闭 PTY；面板隐藏时保留会话
      const currentConnState =
        useHostStore.getState().connectionStates[hostId];
      if (currentConnState !== 'connected') {
        // 主机已断开：清空快照和初始同步状态（重连后是全新会话，旧输出无意义）
        termSnapshotsRef.current.delete(hostId);
        initCwdSyncedRef.current.delete(hostId);
        const opened = openedHostRef.current;
        if (opened) {
          void invoke('pty_close', { hostId: opened }).catch(() => {});
          openedHostRef.current = null;
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedHostId, isConnected]);

  /* ---------- Effect 3：terminalHeight / 可见性变化时重新 fit ---------- */
  useEffect(() => {
    // 等待浏览器应用内联高度后再 fit
    requestAnimationFrame(() => requestFit());
  }, [terminalHeight, terminalVisible]);

  /* ---------- 清屏 ---------- */
  const handleClear = () => {
    termRef.current?.clear();
  };

  /* ---------- 关闭终端面板 ---------- */
  const handleClose = () => {
    if (selectedHostId) setTerminalVisible(selectedHostId, false);
  };

  /* ---------- 断开后重试 ---------- */
  const handleRetry = async () => {
    if (!selectedHostId || retrying) return;
    setRetrying(true);
    try {
      // 先关闭可能残留的旧会话
      await invoke('pty_close', { hostId: selectedHostId }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 300));
      justOpenedRef.current = true;
      const isNew = await invoke<boolean>('pty_open', { hostId: selectedHostId });
      justOpenedRef.current = false;
      setDisconnected(false);
      requestAnimationFrame(() => requestFit());
      // 重连后清空旧快照并重置终端
      if (isNew) {
        termSnapshotsRef.current.delete(selectedHostId);
        termRef.current?.reset();
        ignoreFirstCwdRef.current = true;
      }
    } catch (err) {
      justOpenedRef.current = false;
      useToastStore
        .getState()
        .push('error', `重连失败：${formatErr(err)}`);
    } finally {
      setRetrying(false);
    }
  };

  const showConnectPrompt = !isConnected;

  return (
    <div className="terminal-panel-root">
      {/* 标题栏 */}
      <div className="terminal-titlebar" role="toolbar" aria-label="终端工具栏">
        <span className="terminal-titlebar-icon" aria-hidden="true">
          <SquareTerminal size={13} />
        </span>
        <span className="terminal-titlebar-title" title={hostName}>
          {hostName}
        </span>
        {isConnected && (
          <span className="terminal-titlebar-state">已连接</span>
        )}
        <div className="terminal-titlebar-actions">
          <button
            className="terminal-titlebar-btn"
            type="button"
            aria-label="清屏"
            title="清屏"
            onClick={handleClear}
            disabled={!isConnected || disconnected}
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
      <div className="terminal-body" ref={containerRef}>
        {/* Xterm 渲染节点由 term.open 注入 */}

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

        {/* PTY 断开重试 */}
        {disconnected && isConnected && (
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
