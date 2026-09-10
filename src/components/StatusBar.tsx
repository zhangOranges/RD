import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useTranslation } from 'react-i18next';
import {
  ArrowUp,
  ArrowDown,
  Activity,
  Download,
  DownloadCloud,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  History,
  Copy,
  Trash2,
  Send,
} from 'lucide-react';
import { useHostStore } from '../store/hostStore';
import { useUIStore } from '../store/uiStore';
import { useTransferStore, formatSpeed } from '../store/transferStore';
import { useHistoryStore } from '../store/historyStore';
import { useToastStore } from './Toast';
import { version } from '../../package.json';
import { useAppUpdater } from '../hooks/useAppUpdater';

function UpdateBadge() {
  const { t } = useTranslation();
  const updater = useAppUpdater();

  // dev 模式下 latest.json (GitHub releases/latest) 通常不存在，给一个静态提示不主动触发检查
  if (updater.isDev) {
    return (
      <span
        className="statusbar-item update-badge is-dev"
        title={t('update.devModeHint')}
      >
        <Sparkles size={11} />
        <span>{t('update.devOnly')}</span>
      </span>
    );
  }

  if (updater.status === 'idle' || updater.status === 'checking') {
    return (
      <button
        type="button"
        className={`statusbar-item update-badge ${
          updater.status === 'checking' ? 'is-checking' : ''
        }`}
        onClick={() => updater.check()}
        title={t('update.checkHint')}
      >
        <RefreshCw size={11} className={updater.status === 'checking' ? 'spin' : ''} />
        <span>{t('settings.checkUpdate')}</span>
      </button>
    );
  }

  if (updater.status === 'up-to-date') {
    return (
      <button
        type="button"
        className="statusbar-item update-badge is-up-to-date"
        onClick={() => updater.check()}
        title={t('update.upToDateHint')}
      >
        <CheckCircle2 size={11} />
        <span>{t('update.noUpdate')}</span>
      </button>
    );
  }

  if (updater.status === 'error') {
    return (
      <button
        type="button"
        className="statusbar-item update-badge is-error"
        onClick={() => updater.showDialog()}
        title={t('update.checkFailedWithDetail', { msg: updater.errorMsg ?? '' })}
      >
        <AlertTriangle size={11} />
        <span>{t('update.error')}</span>
      </button>
    );
  }

  if (updater.status === 'done') {
    return (
      <span className="statusbar-item update-badge is-done" title={t('update.done')}>
        <CheckCircle2 size={11} />
        <span>{t('update.done')}</span>
      </span>
    );
  }

  if (updater.status === 'available') {
    return (
      <button
        type="button"
        className="statusbar-item update-badge is-available"
        onClick={() => updater.showDialog()}
        title={t('update.availableHint', { version: updater.availableVersion })}
      >
        <Sparkles size={11} />
        <span>{t('update.availableVersion', { version: updater.availableVersion })}</span>
      </button>
    );
  }

  // 下载完成待安装
  if (updater.status === 'downloaded') {
    const title = updater.pendingFromLocal
      ? t('update.downloadedLocalHint', { version: updater.availableVersion ?? '' })
      : t('update.downloadedHint', { version: updater.availableVersion ?? '' });
    return (
      <button
        type="button"
        className={`statusbar-item update-badge is-downloaded ${
          updater.pendingFromLocal ? 'is-pending' : ''
        }`}
        onClick={() => updater.showDialog()}
        title={title}
      >
        <CheckCircle2 size={11} />
        <span>
          {updater.pendingFromLocal
            ? t('update.readyToInstall', { version: updater.availableVersion ?? '' })
            : t('update.downloadedInstall', { version: updater.availableVersion ?? '' })}
        </span>
      </button>
    );
  }

  if (updater.status === 'downloading' || updater.status === 'installing') {
    const hasTotal = updater.totalMB && updater.totalMB > 0;
    const sizeText = hasTotal
      ? `${updater.downloadedMB || 0}/${updater.totalMB}MB`
      : `${updater.downloadedMB || 0}MB`;
    const label =
      updater.status === 'downloading'
        ? t('update.downloadingWithSize', { pct: updater.progressPct || 0, size: sizeText })
        : t('update.installing');
    return (
      <button
        type="button"
        className={`statusbar-item update-badge ${
          updater.status === 'installing' ? 'is-installing' : 'is-downloading'
        }`}
        title={`${label} · ${t('update.clickForDetail')}`}
        onClick={() => updater.showDialog()}
      >
        {updater.status === 'installing' ? (
          <DownloadCloud size={11} />
        ) : (
          <Download size={11} />
        )}
        <span>{label}</span>
        <span className="update-progress">
          <span
            className="update-progress-fill"
            style={{ width: `${updater.progressPct || 0}%` }}
          />
        </span>
      </button>
    );
  }

  return null;
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

/** 历史命令按钮 + 下拉菜单 */
function HistoryButton() {
  const { t } = useTranslation();
  const entries = useHistoryStore((s) => s.entries);
  const removeCommand = useHistoryStore((s) => s.removeCommand);
  const clearAll = useHistoryStore((s) => s.clearAll);

  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const activeTerminalTabMap = useUIStore((s) => s.activeTerminalTab);
  const terminalVisibleMap = useUIStore((s) => s.terminalVisible);
  const setTerminalVisible = useUIStore((s) => s.setTerminalVisible);
  const pushToast = useToastStore((s) => s.push);

  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // 点击外部 / Esc 关闭
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      if (btnRef.current && btnRef.current.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 菜单打开后计算位置：菜单底部贴在按钮顶部之上（向上展开）
  // 依赖 entries.length：清空/增删历史后菜单高度变化，需要重新对齐
  useEffect(() => {
    if (!open || !menuRef.current || !btnRef.current) return;
    const btnRect = btnRef.current.getBoundingClientRect();
    const menuEl = menuRef.current;
    // 下一帧再读尺寸，避免 React 刚写入 DOM 时浏览器 layout 还没完成（尤其清空导致高度突变）
    requestAnimationFrame(() => {
      if (!menuRef.current || !btnRef.current) return;
      const mRect = menuEl.getBoundingClientRect();
      const margin = 8;

      let left = btnRect.right - mRect.width;
      if (left < margin) left = margin;
      if (left + mRect.width > window.innerWidth - margin) {
        left = window.innerWidth - margin - mRect.width;
      }

      // 垂直：菜单底部贴在按钮顶部上方 4px（向上展开），顶部不越界
      let top = btnRect.top - mRect.height - 4;
      if (top < margin) top = margin;

      menuEl.style.left = `${left}px`;
      menuEl.style.top = `${top}px`;
      menuEl.style.bottom = '';
      menuEl.style.right = '';
    });
  }, [open, entries.length]);

  const canSend =
    !!selectedHostId &&
    connectionStates[selectedHostId] === 'connected' &&
    !!activeTerminalTabMap[selectedHostId];

  async function sendToTerminal(command: string) {
    if (!selectedHostId) {
      pushToast('warning', t('statusbar.selectHostFirst'));
      return;
    }
    const connState = connectionStates[selectedHostId];
    if (connState !== 'connected') {
      pushToast('warning', t('statusbar.hostNotConnected'));
      return;
    }
    const tabId = activeTerminalTabMap[selectedHostId];
    if (!tabId) {
      pushToast('warning', t('statusbar.noTerminalTab'));
      return;
    }
    // 确保终端面板可见
    if (!terminalVisibleMap[selectedHostId]) {
      setTerminalVisible(selectedHostId, true);
    }
    // 末尾追加回车
    const bytes = Array.from(new TextEncoder().encode(command + '\r'));
    try {
      await invoke('pty_write', { hostId: selectedHostId, tabId, data: bytes });
      setOpen(false);
    } catch (err) {
      pushToast('error', `${t('statusbar.sendFailed')}：${formatErr(err)}`);
    }
  }

  async function handleCopy(command: string) {
    try {
      await writeText(command);
      pushToast('success', t('statusbar.copiedToClipboard'));
    } catch (err) {
      pushToast('error', `${t('common.copyFailed')}：${formatErr(err)}`);
    }
  }

  function handleRemove(id: string) {
    removeCommand(id);
  }

  function handleClearAll() {
    clearAll();
  }

  return (
    <>
      <button
        type="button"
        ref={btnRef}
        className={`statusbar-item statusbar-history-btn ${open ? 'is-active' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('statusbar.history')}
        title={t('statusbar.historyHint')}
      >
        <History size={11} />
        <span>{t('statusbar.history')}</span>
        {entries.length > 0 && (
          <span className="statusbar-history-count">{entries.length}</span>
        )}
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          className="history-menu tabbar-context-menu host-menu sidebar-context-menu"
          role="menu"
          aria-label={t('statusbar.historyList')}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: 380,
            maxWidth: '90vw',
            maxHeight: '60vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            padding: 0,
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div className="history-menu-header">
            <span className="history-menu-title">{t('statusbar.history')}</span>
            <span className="history-menu-meta">
              {entries.length > 0 ? t('statusbar.historyCount', { n: entries.length }) : t('common.none')}
            </span>
          </div>

          <div className="history-menu-list">
            {entries.length === 0 ? (
              <div className="history-menu-empty">{t('statusbar.noHistory')}</div>
            ) : (
              entries.map((entry) => (
                <div
                  key={entry.id}
                  className="history-menu-item"
                  role="menuitem"
                  title={entry.command}
                >
                  <button
                    type="button"
                    className="history-menu-cmd"
                    onClick={() => void sendToTerminal(entry.command)}
                    disabled={!canSend}
                    title={
                      canSend
                        ? t('statusbar.sendToTerminal')
                        : t('statusbar.connectHostAndOpenTerminal')
                    }
                  >
                    <Send size={11} className="history-menu-send-icon" />
                    <span className="history-menu-cmd-text">{entry.command}</span>
                    <span className="history-menu-count" aria-label={t('statusbar.usageCount', { n: entry.count })}>
                      ×{entry.count}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="history-menu-action"
                    onClick={() => void handleCopy(entry.command)}
                    title={t('common.copy')}
                    aria-label={t('common.copy')}
                  >
                    <Copy size={11} />
                  </button>
                  <button
                    type="button"
                    className="history-menu-action history-menu-action-danger"
                    onClick={() => handleRemove(entry.id)}
                    title={t('common.delete')}
                    aria-label={t('common.delete')}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))
            )}
          </div>

          {entries.length > 0 && (
            <>
              <div className="host-menu-separator" />
              <button
                type="button"
                className="host-menu-item host-menu-danger history-menu-clear"
                onClick={handleClearAll}
                title={t('statusbar.clearAllHistory')}
              >
                <Trash2 size={11} /> {t('statusbar.clearAll')}
              </button>
            </>
          )}
        </div>,
        document.body,
      )}
    </>
  );
}

export function StatusBar() {
  const { t } = useTranslation();
  const hosts = useHostStore((s) => s.hosts);
  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const currentPath = useUIStore((s) => s.currentPath);
  const maskMode = useUIStore((s) => s.maskMode);
  const tasks = useTransferStore((s) => s.tasks);

  const selectedHost = hosts.find((h) => h.id === selectedHostId);
  const connState = selectedHostId ? connectionStates[selectedHostId] : undefined;
  const connectedCount = hosts.filter(
    (h) => connectionStates[h.id] === 'connected',
  ).length;

  const stateText =
    connState === 'connected'
      ? t('statusbar.connected')
      : connState === 'connecting'
        ? t('statusbar.connecting')
        : selectedHost
          ? t('statusbar.disconnected')
          : t('statusbar.idle');

  const uploadSpeed = tasks
    .filter((t) => t.kind === 'upload' && t.status === 'running')
    .reduce((sum, t) => sum + t.speedBytesPerSec, 0);
  const downloadSpeed = tasks
    .filter((t) => t.kind === 'download' && t.status === 'running')
    .reduce((sum, t) => sum + t.speedBytesPerSec, 0);

  const [latency, setLatency] = useState<number | null>(null);
  const isConnected = connState === 'connected';

  useEffect(() => {
    if (!selectedHostId || !isConnected) {
      setLatency(null);
      return;
    }
    let cancelled = false;
    const measure = async () => {
      const start = performance.now();
      try {
        await invoke('sftp_resolve_path', { hostId: selectedHostId, path: '.' });
        if (!cancelled) {
          setLatency(Math.round(performance.now() - start));
        }
      } catch {
        if (!cancelled) {
          setLatency(null);
        }
      }
    };
    measure();
    const timer = window.setInterval(measure, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedHostId, isConnected]);

  const latencyClass =
    latency === null
      ? ''
      : latency <= 100
        ? 'latency-good'
        : latency <= 300
          ? 'latency-warn'
          : 'latency-bad';

  return (
    <footer className="statusbar" role="status" aria-live="polite">
      <div className="statusbar-section">
        <span className="statusbar-item statusbar-version">v{version}</span>
        <UpdateBadge />
        <span className="statusbar-item">
          {t('statusbar.hostCount', { connected: connectedCount, total: hosts.length })}
        </span>
        {selectedHost && (
          <span className="statusbar-item">
            · {selectedHost.name}（
            <span className={maskMode ? 'mask-sensitive' : ''}>
              {selectedHost.host}:{selectedHost.port}
            </span>
            ）
          </span>
        )}
      </div>
      <div className="statusbar-section">
        <HistoryButton />
        {currentPath && (
          <span className={`statusbar-item ${maskMode ? 'mask-sensitive' : ''}`}>
            {currentPath}
          </span>
        )}
        <span className="statusbar-item">{stateText}</span>
        <span className="statusbar-item statusbar-speed">
          <ArrowUp size={10} /> {t('statusbar.upload')}: {formatSpeed(uploadSpeed)}
        </span>
        <span className="statusbar-item statusbar-speed">
          <ArrowDown size={10} /> {t('statusbar.download')}: {formatSpeed(downloadSpeed)}
        </span>
        <span className={`statusbar-item statusbar-latency ${latencyClass}`}>
          <Activity size={10} /> {t('statusbar.latency')}: {latency !== null ? `${latency}ms` : '--'}
        </span>
      </div>
    </footer>
  );
}
