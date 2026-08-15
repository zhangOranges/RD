import { useState, useEffect, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Minus,
  Square,
  Copy,
  Plus,
  Settings,
  TerminalSquare,
  Power,
  Palette,
  Check,
  Puzzle,
} from 'lucide-react';
import { useThemeStore, useThemeOptions } from '../store/themeStore';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useHostStore } from '../store/hostStore';
import { useUIStore } from '../store/uiStore';
import { usePluginStore } from '../store/pluginStore';
import { usePluginUiStore } from '../store/pluginUiStore';
import { useToastStore } from './Toast';
import { HostDialog } from './HostDialog';
import type { HostConfig } from '../types';
import '../styles/tabbar.css';

interface ContextMenuState {
  hostId: string;
  x: number;
  y: number;
}

export function TabBar() {
  const hosts = useHostStore((s) => s.hosts);
  const categories = useHostStore((s) => s.categories);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const reconnectMeta = useHostStore((s) => s.reconnectMeta);
  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const selectHost = useHostStore((s) => s.selectHost);
  const disconnectHost = useHostStore((s) => s.disconnectHost);
  const cancelReconnect = useHostStore((s) => s.cancelReconnect);

  const toggleTerminal = useUIStore((s) => s.toggleTerminal);
  const setSettingsVisible = useUIStore((s) => s.setSettingsVisible);
  const terminalVisibleMap = useUIStore((s) => s.terminalVisible);
  const maskMode = useUIStore((s) => s.maskMode);
  // 已安装插件列表（菜单内容）：随 pluginStore 异步加载，只显示已启用的插件
  const plugins = usePluginStore((s) => s.plugins);
  const pluginsLoading = usePluginStore((s) => s.loading);
  const enabledPlugins = plugins.filter((p) => p.enabled);
  const [pluginMenuOpen, setPluginMenuOpen] = useState(false);
  const pluginMenuRef = useRef<HTMLDivElement | null>(null);

  // 点击插件菜单外部时关闭
  useEffect(() => {
    if (!pluginMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (pluginMenuRef.current && !pluginMenuRef.current.contains(e.target as Node)) {
        setPluginMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [pluginMenuOpen]);

  const pushToast = useToastStore((s) => s.push);

  // 主题切换
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const themeOptions = useThemeOptions();
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);

  // 用于倒计时显示刷新（每 500ms）
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, []);

  // 标签 = 所有 connectionState 为 connected / connecting / reconnecting 的主机
  const tabs = useMemo<HostConfig[]>(
    () =>
      hosts.filter(
        (h) =>
          connectionStates[h.id] === 'connected' ||
          connectionStates[h.id] === 'connecting' ||
          connectionStates[h.id] === 'reconnecting',
      ),
    [hosts, connectionStates],
  );

  // 重连中状态下的关闭行为：取消重连 + 切到 disconnected
  async function handleTabCloseOrCancel(host: HostConfig, e: React.MouseEvent) {
    e.stopPropagation();
    const state = connectionStates[host.id];
    if (state === 'reconnecting') {
      cancelReconnect(host.id);
    }
    const idx = tabs.findIndex((t) => t.id === host.id);
    const next = tabs[idx + 1] ?? tabs[idx - 1] ?? null;
    await disconnectHost(host.id);
    selectHost(next ? next.id : null);
  }

  // 窗口最大化状态
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized).catch(() => {});
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setIsMaximized).catch(() => {});
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // 右键菜单
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ctxMenu) return;
    function onDocClick(e: MouseEvent) {
      if (ctxMenuRef.current && ctxMenuRef.current.contains(e.target as Node)) return;
      setCtxMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setCtxMenu(null);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  // 菜单渲染后做边界检测，靠近视口右/下边缘时向上/左偏移
  useEffect(() => {
    if (!ctxMenu || !ctxMenuRef.current) return;
    const el = ctxMenuRef.current;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let shiftX = 0;
    let shiftY = 0;
    if (rect.right > window.innerWidth - margin) {
      shiftX = rect.right - (window.innerWidth - margin);
    }
    if (rect.bottom > window.innerHeight - margin) {
      shiftY = rect.bottom - (window.innerHeight - margin);
    }
    if (shiftX !== 0 || shiftY !== 0) {
      el.style.left = `${ctxMenu.x - shiftX}px`;
      el.style.top = `${ctxMenu.y - shiftY}px`;
    }
  }, [ctxMenu]);

  // 主题菜单：点击外部或按 Esc 关闭
  useEffect(() => {
    if (!themeMenuOpen) return;
    function onDocClick(e: MouseEvent) {
      if (themeMenuRef.current && themeMenuRef.current.contains(e.target as Node)) return;
      if (themeBtnRef.current && themeBtnRef.current.contains(e.target as Node)) return;
      setThemeMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setThemeMenuOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [themeMenuOpen]);

  // 主题菜单：底部溢出时改为向上弹出
  useEffect(() => {
    if (!themeMenuOpen || !themeMenuRef.current || !themeBtnRef.current) return;
    const menuEl = themeMenuRef.current;
    const rect = menuEl.getBoundingClientRect();
    const margin = 8;
    if (rect.bottom > window.innerHeight - margin) {
      const btnRect = themeBtnRef.current.getBoundingClientRect();
      menuEl.style.top = `${btnRect.top - rect.height - 4}px`;
    }
  }, [themeMenuOpen]);

  // 「+」按钮 → 打开主机对话框（新建主机）
  const [dialogOpen, setDialogOpen] = useState(false);

  // ===== 窗口控制 =====
  async function handleMinimize() {
    await getCurrentWindow().minimize();
  }
  async function handleMaximize() {
    await getCurrentWindow().toggleMaximize();
  }
  async function handleClose() {
    await getCurrentWindow().close();
  }

  // ===== 标签交互 =====
  function handleTabClick(host: HostConfig) {
    selectHost(host.id);
  }

  // 保留 handleTabClose 兼容（内部转调新方法）
  async function handleTabClose(host: HostConfig, e: React.MouseEvent) {
    await handleTabCloseOrCancel(host, e);
  }

  function handleTerminalToggle() {
    if (selectedHostId) toggleTerminal(selectedHostId);
  }

  function handleSettings() {
    setSettingsVisible(true);
  }

  // ===== 右键菜单 =====
  function openContextMenu(e: React.MouseEvent, host: HostConfig) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ hostId: host.id, x: e.clientX, y: e.clientY });
  }

  async function closeTab(hostId: string) {
    setCtxMenu(null);
    if (connectionStates[hostId] === 'reconnecting') {
      cancelReconnect(hostId);
    }
    const idx = tabs.findIndex((t) => t.id === hostId);
    const next = tabs[idx + 1] ?? tabs[idx - 1] ?? null;
    await disconnectHost(hostId);
    selectHost(next ? next.id : null);
  }

  async function closeOthers(hostId: string) {
    setCtxMenu(null);
    const others = tabs.filter((t) => t.id !== hostId);
    await Promise.all(others.map((t) => disconnectHost(t.id)));
    selectHost(hostId);
  }

  async function closeToRight(hostId: string) {
    setCtxMenu(null);
    const idx = tabs.findIndex((t) => t.id === hostId);
    if (idx < 0) return;
    const right = tabs.slice(idx + 1);
    await Promise.all(right.map((t) => disconnectHost(t.id)));
    selectHost(hostId);
  }

  async function copyConnectionInfo(hostId: string) {
    setCtxMenu(null);
    const host = hosts.find((h) => h.id === hostId);
    if (!host) return;
    const text = `${host.username}@${host.host}:${host.port}`;
    try {
      await writeText(text);
      pushToast('success', `已复制：${text}`);
    } catch (err) {
      pushToast('error', `复制失败：${formatErr(err)}`);
    }
  }

  const ctxHost = ctxMenu ? hosts.find((h) => h.id === ctxMenu.hostId) : undefined;
  const terminalVisible = !!selectedHostId && !!terminalVisibleMap[selectedHostId];

  return (
    <header className="tabbar" role="toolbar" aria-label="顶部标签栏">
      {/* 窗口控制按钮（macOS 风格 14×14px 圆形：红/黄/绿） */}
      <div className="tabbar-win-controls">
        <button
          type="button"
          className="tabbar-win-btn tabbar-win-close"
          title="关闭"
          aria-label="关闭窗口"
          onClick={() => void handleClose()}
        >
          <X size={12} />
        </button>
        <button
          type="button"
          className="tabbar-win-btn tabbar-win-minimize"
          title="最小化"
          aria-label="最小化窗口"
          onClick={() => void handleMinimize()}
        >
          <Minus size={12} />
        </button>
        <button
          type="button"
          className="tabbar-win-btn tabbar-win-maximize"
          title={isMaximized ? '还原' : '最大化'}
          aria-label="最大化/还原窗口"
          onClick={() => void handleMaximize()}
        >
          {isMaximized ? <Copy size={11} /> : <Square size={10} />}
        </button>
      </div>

      {/* 品牌标识「RD」 */}
      <div className="tabbar-brand" aria-label="RD 远程文件管理器">
        RD
      </div>

      {/* 多服务器标签页区域 */}
      <div className="tabbar-tabs" role="tablist">
        {tabs.map((host) => {
          const state = connectionStates[host.id] ?? 'disconnected';
          const active = host.id === selectedHostId;
          const meta = reconnectMeta[host.id];
          const isReconnecting = state === 'reconnecting';
          const countdownSec = meta
            ? Math.max(0, Math.ceil((meta.nextAt - Date.now()) / 1000))
            : 0;
          return (
            <div
              key={host.id}
              className={`tabbar-tab ${active ? 'tabbar-tab-active' : ''} ${
                isReconnecting ? 'tabbar-tab-reconnecting' : ''
              }`}
              role="tab"
              tabIndex={0}
              aria-selected={active}
              title={
                isReconnecting
                  ? `${host.username}@${host.host}:${host.port} — 重连中（第 ${meta?.attempt ?? 1} 次，${countdownSec}s 后重试）`
                  : `${host.username}@${host.host}:${host.port}`
              }
              onClick={() => handleTabClick(host)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handleTabClick(host);
                }
              }}
              onContextMenu={(e) => openContextMenu(e, host)}
            >
              <span
                className={`tabbar-tab-dot host-state-${state}`}
                aria-hidden="true"
              />
              <span className="tabbar-tab-name">
                {host.name}
                {isReconnecting && meta && (
                  <span className="tabbar-reconnect-count" title={`${countdownSec}s 后第 ${meta.attempt} 次重试`}>
                    {meta.attempt}
                  </span>
                )}
              </span>
              <span className={`tabbar-tab-addr ${maskMode ? 'mask-sensitive' : ''}`}>
                {isReconnecting
                  ? `重连中 · ${countdownSec}s`
                  : `${host.username}@{host.host}`}
              </span>
              <button
                type="button"
                className="tabbar-tab-close"
                aria-label="关闭标签"
                title={isReconnecting ? '取消重连并关闭' : '关闭标签'}
                onClick={(e) => void handleTabClose(host, e)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="tabbar-add"
          aria-label="新建主机标签"
          title="新建主机"
          onClick={() => setDialogOpen(true)}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* 右上角功能按钮 */}
      <div className="tabbar-actions">
        {/* 插件工具入口：常驻显示，菜单列出已安装插件（异步加载） */}
        <div className="tabbar-plugin-anchor" ref={pluginMenuRef}>
          <button
            type="button"
            className={`tabbar-plugin-trigger ${
              pluginMenuOpen ? 'tabbar-plugin-trigger-active' : ''
            }`}
            title="插件"
            aria-label="插件"
            aria-haspopup="menu"
            aria-expanded={pluginMenuOpen}
            onClick={() => setPluginMenuOpen((v) => !v)}
          >
            <Puzzle size={15} />
            {enabledPlugins.length > 0 && (
              <span className="tabbar-plugin-badge">{enabledPlugins.length}</span>
            )}
          </button>
          {pluginMenuOpen && (
            <div className="tabbar-plugin-menu" role="menu">
              {enabledPlugins.length > 0 ? (
                enabledPlugins.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="tabbar-plugin-menu-item"
                    onClick={() => {
                      setPluginMenuOpen(false);
                      // 仅启用插件展示，点击直接打开视图
                      usePluginUiStore.getState().openPluginView(p.id);
                    }}
                  >
                    <span
                      className="tabbar-plugin-menu-dot"
                      style={{ background: 'var(--accent)' }}
                    />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {p.name}
                    </span>
                  </button>
                ))
              ) : pluginsLoading ? (
                <div className="tabbar-plugin-menu-hint">插件加载中…</div>
              ) : (
                <div className="tabbar-plugin-menu-hint">暂无已启用的插件</div>
              )}
            </div>
          )}
        </div>
        <button
          type="button"
          className={`tabbar-action-btn ${
            terminalVisible ? 'tabbar-action-btn-active' : ''
          }`}
          aria-label="切换终端"
          title="显示/隐藏终端"
          onClick={handleTerminalToggle}
          disabled={!selectedHostId}
        >
          <TerminalSquare size={15} />
        </button>
        <button
          type="button"
          ref={themeBtnRef}
          className={`tabbar-action-btn ${
            themeMenuOpen ? 'tabbar-action-btn-active' : ''
          }`}
          aria-label="切换主题"
          title="切换主题"
          aria-haspopup="menu"
          aria-expanded={themeMenuOpen}
          onClick={() => setThemeMenuOpen((v) => !v)}
        >
          <Palette size={15} />
        </button>
        <button
          type="button"
          className="tabbar-action-btn"
          aria-label="设置"
          title="设置"
          onClick={handleSettings}
        >
          <Settings size={15} />
        </button>
      </div>

      {/* 主题切换下拉菜单 */}
      {themeMenuOpen && createPortal(
        <div
          ref={themeMenuRef}
          className="theme-menu tabbar-context-menu host-menu sidebar-context-menu"
          role="menu"
          aria-label="选择主题"
          style={{
            position: 'fixed',
            top: themeBtnRef.current
              ? themeBtnRef.current.getBoundingClientRect().bottom + 4
              : 0,
            left: themeBtnRef.current
              ? themeBtnRef.current.getBoundingClientRect().right - 160
              : 0,
            width: 160,
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {themeOptions.map((opt) => {
            const active = theme === opt.id;
            return (
              <button
                key={opt.id}
                className="host-menu-item theme-menu-item"
                type="button"
                role="menuitemradio"
                aria-checked={active}
                title={opt.desc}
                onClick={() => {
                  setTheme(opt.id);
                  setThemeMenuOpen(false);
                }}
              >
                <span
                  className="theme-menu-swatch"
                  style={{ background: opt.swatch }}
                  aria-hidden="true"
                />
                <span className="theme-menu-text">{opt.name}</span>
                {active && <Check size={12} className="theme-menu-check" />}
              </button>
            );
          })}
        </div>,
        document.body,
      )}

      {/* 右键菜单（通过 Portal 挂载到 body，避免 tabbar 的 backdrop-filter
           导致 position:fixed 失效及 transform 引起的左上角闪烁） */}
      {ctxMenu && ctxHost && createPortal(
        <div
          className="tabbar-context-menu host-menu sidebar-context-menu"
          ref={ctxMenuRef}
          style={{
            position: 'fixed',
            top: ctxMenu.y,
            left: ctxMenu.x,
          }}
          role="menu"
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="host-menu-item"
            type="button"
            role="menuitem"
            onClick={() => void closeTab(ctxHost.id)}
          >
            <X size={11} /> 关闭当前
          </button>
          <button
            className="host-menu-item"
            type="button"
            role="menuitem"
            onClick={() => void closeOthers(ctxHost.id)}
          >
            <Power size={11} /> 关闭其他
          </button>
          <button
            className="host-menu-item"
            type="button"
            role="menuitem"
            onClick={() => void closeToRight(ctxHost.id)}
          >
            <Power size={11} /> 关闭右侧
          </button>
          <div className="host-menu-separator" />
          <button
            className="host-menu-item"
            type="button"
            role="menuitem"
            onClick={() => void copyConnectionInfo(ctxHost.id)}
          >
            <Copy size={11} /> 复制连接信息
          </button>
        </div>,
        document.body,
      )}

      {/* 主机对话框（「+」按钮触发新建主机） */}
      {dialogOpen && (
        <HostDialog
          host={null}
          categories={categories}
          presetCategoryId="default"
          onClose={() => setDialogOpen(false)}
        />
      )}
    </header>
  );
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
