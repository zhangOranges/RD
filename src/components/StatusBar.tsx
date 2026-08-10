import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArrowUp, ArrowDown, Activity } from 'lucide-react';
import { useHostStore } from '../store/hostStore';
import { useUIStore } from '../store/uiStore';
import { useTransferStore, formatSpeed } from '../store/transferStore';
import { version } from '../../package.json';

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

  // 实时上传/下载速率：累加所有 running 任务的速度
  const uploadSpeed = tasks
    .filter((t) => t.kind === 'upload' && t.status === 'running')
    .reduce((sum, t) => sum + t.speedBytesPerSec, 0);
  const downloadSpeed = tasks
    .filter((t) => t.kind === 'download' && t.status === 'running')
    .reduce((sum, t) => sum + t.speedBytesPerSec, 0);

  // 网络延迟：每 5 秒通过 sftp_resolve_path 往返时间测量
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
