import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ArrowUp,
  ArrowDown,
  Activity,
  Download,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
} from 'lucide-react';
import { useHostStore } from '../store/hostStore';
import { useUIStore } from '../store/uiStore';
import { useTransferStore, formatSpeed } from '../store/transferStore';
import { version } from '../../package.json';
import { useAppUpdater } from '../hooks/useAppUpdater';

function UpdateBadge() {
  const updater = useAppUpdater();

  // dev 模式下 latest.json (GitHub releases/latest) 通常不存在，给一个静态提示不主动触发检查
  if (updater.isDev) {
    return (
      <span
        className="statusbar-item update-badge is-dev"
        title="开发模式下自动检查会被跳过。需先打 tag + Release 发布后，用打包好的安装包测试更新。"
      >
        <Sparkles size={11} />
        <span>更新：仅打包版可用</span>
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
        title="检查更新（最多等待 8 秒）"
      >
        <RefreshCw size={11} className={updater.status === 'checking' ? 'spin' : ''} />
        <span>检查更新</span>
      </button>
    );
  }

  if (updater.status === 'error') {
    return (
      <button
        type="button"
        className="statusbar-item update-badge is-error"
        onClick={() => updater.check()}
        title={`更新失败：${updater.errorMsg ?? ''}（点击重试）`}
      >
        <AlertTriangle size={11} />
        <span>更新错误</span>
      </button>
    );
  }

  if (updater.status === 'done') {
    return (
      <span className="statusbar-item update-badge is-done" title="已完成更新">
        <CheckCircle2 size={11} />
        <span>已更新</span>
      </span>
    );
  }

  if (updater.status === 'available') {
    return (
      <button
        type="button"
        className="statusbar-item update-badge is-available"
        onClick={() => updater.showDialog()}
        title={`发现新版本 v${updater.availableVersion}，点击查看更新内容`}
      >
        <Sparkles size={11} />
        <span>更新 v{updater.availableVersion} 可用</span>
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
        ? `下载中 ${updater.progressPct || 0}% · ${sizeText}`
        : '安装中…';
    return (
      <span className="statusbar-item update-badge is-downloading" title={label}>
        <Download size={11} />
        <span>{label}</span>
        <span className="update-progress">
          <span
            className="update-progress-fill"
            style={{ width: `${updater.progressPct || 0}%` }}
          />
        </span>
      </span>
    );
  }

  return null;
}

export function StatusBar() {
  const hosts = useHostStore((s) => s.hosts);
  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const currentPath = useUIStore((s) => s.currentPath);
  const tasks = useTransferStore((s) => s.tasks);

  const selectedHost = hosts.find((h) => h.id === selectedHostId);
  const connState = selectedHostId ? connectionStates[selectedHostId] : undefined;
  const connectedCount = hosts.filter(
    (h) => connectionStates[h.id] === 'connected',
  ).length;

  const stateText =
    connState === 'connected'
      ? '已连接'
      : connState === 'connecting'
        ? '连接中'
        : selectedHost
          ? '未连接'
          : '空闲';

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
          主机 {connectedCount}/{hosts.length}
        </span>
        {selectedHost && (
          <span className="statusbar-item">
            · {selectedHost.name}（{selectedHost.host}:{selectedHost.port}）
          </span>
        )}
      </div>
      <div className="statusbar-section">
        {currentPath && <span className="statusbar-item">{currentPath}</span>}
        <span className="statusbar-item">{stateText}</span>
        <span className="statusbar-item statusbar-speed">
          <ArrowUp size={10} /> 上传: {formatSpeed(uploadSpeed)}
        </span>
        <span className="statusbar-item statusbar-speed">
          <ArrowDown size={10} /> 下载: {formatSpeed(downloadSpeed)}
        </span>
        <span className={`statusbar-item statusbar-latency ${latencyClass}`}>
          <Activity size={10} /> 延迟: {latency !== null ? `${latency}ms` : '--'}
        </span>
      </div>
    </footer>
  );
}
