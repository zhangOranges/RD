import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useHostStore } from '../store/hostStore';
import { useUIStore } from '../store/uiStore';
import { formatDuration } from '../store/transferStore';

/** Rust 端 ServerStats（camelCase） */
interface ServerStats {
  cpuModel: string;
  cpuCores: number;
  cpuUsage: number;
  memTotalMb: number;
  memUsedMb: number;
  diskTotalGb: number;
  diskUsedGb: number;
  loadAvg: number;
  osInfo: string;
  uptimeSecs: number;
}

function formatUptime(secs: number): string {
  if (!secs || secs <= 0) return '—';
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}天${h}小时`;
  if (h > 0) return `${h}小时${m}分`;
  return `${m}分`;
}

function formatBytes(mb: number): string {
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb} MB`;
}

function formatGb(gb: number): string {
  if (gb >= 1024) return `${(gb / 1024).toFixed(2)} TB`;
  return `${gb.toFixed(1)} GB`;
}

function formatPercent(used: number, total: number): string {
  if (total <= 0) return '—';
  return `${((used / total) * 100).toFixed(1)}%`;
}

/**
 * 右侧面板 - 服务器信息区
 * 展示当前选中主机的连接参数、连接状态、在线时长、服务器硬件信息。
 */
export function ServerInfo() {
  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const hosts = useHostStore((s) => s.hosts);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const maskMode = useUIStore((s) => s.maskMode);

  const host = selectedHostId ? hosts.find((h) => h.id === selectedHostId) : undefined;
  const connState = selectedHostId ? connectionStates[selectedHostId] : undefined;
  const isConnected = connState === 'connected';

  // 在线时长：连接状态变为 connected 时记录开始时间，每秒更新显示
  const connectedSinceRef = useRef<number | null>(null);
  const [, setTick] = useState(0);

  // 服务器硬件信息
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  useEffect(() => {
    if (isConnected) {
      // 进入连接态且尚无开始时间（首次连接或选中已连接主机时）
      if (connectedSinceRef.current === null) {
        connectedSinceRef.current = Date.now();
      }
      const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
      return () => window.clearInterval(timer);
    }
    // 未连接：清空开始时间
    connectedSinceRef.current = null;
  }, [isConnected]);

  // 连接后拉取服务器硬件信息；每 15 秒刷新一次
  useEffect(() => {
    if (!selectedHostId || !isConnected) {
      setStats(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;

    const fetchStats = async () => {
      setStatsLoading(true);
      try {
        const result = await invoke<ServerStats>('get_server_stats', { hostId: selectedHostId });
        if (!cancelled) setStats(result);
      } catch {
        if (!cancelled) setStats(null);
      } finally {
        if (!cancelled) setStatsLoading(false);
      }
    };

    void fetchStats();
    timer = window.setInterval(() => void fetchStats(), 15000);

    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
    };
  }, [selectedHostId, isConnected]);

  const onlineDuration =
    isConnected && connectedSinceRef.current !== null
      ? formatDuration(Date.now() - connectedSinceRef.current)
      : '—';

  if (!selectedHostId || !host) {
    return (
      <section className="rp-section">
        <div className="rp-section-title">服务器信息</div>
        <div className="rp-empty-section">未选择主机</div>
      </section>
    );
  }

  const memPct = stats ? formatPercent(stats.memUsedMb, stats.memTotalMb) : '—';
  const diskPct = stats ? formatPercent(stats.diskUsedGb, stats.diskTotalGb) : '—';

  return (
    <section className="rp-section">
      <div className="rp-section-title">服务器信息</div>
      <div className="rp-info-grid">
        <div className="rp-info-item">
          <span className="rp-info-label">主机</span>
          <span
            className={`rp-info-value ${maskMode ? 'mask-sensitive' : ''}`}
            title={`${host.host}:${host.port}`}
          >
            {host.host}:{host.port}
          </span>
        </div>
        <div className="rp-info-item">
          <span className="rp-info-label">用户</span>
          <span
            className={`rp-info-value ${maskMode ? 'mask-sensitive' : ''}`}
            title={host.username}
          >
            {host.username}
          </span>
        </div>
        <div className="rp-info-item">
          <span className="rp-info-label">端口</span>
          <span className={`rp-info-value ${maskMode ? 'mask-sensitive' : ''}`}>
            {host.port}
          </span>
        </div>
        <div className="rp-info-item">
          <span className="rp-info-label">协议</span>
          <span className="rp-info-value">SSH</span>
        </div>
        <div className="rp-info-item">
          <span className="rp-info-label">系统</span>
          <span className="rp-info-value" title={stats?.osInfo ?? ''}>
            {stats?.osInfo ?? (isConnected ? '获取中…' : 'Linux')}
          </span>
        </div>
        <div className="rp-info-item">
          <span className="rp-info-label">在线时长</span>
          <span className="rp-info-value">{onlineDuration}</span>
        </div>
        <div className="rp-info-item">
          <span className="rp-info-label">运行时长</span>
          <span className="rp-info-value">{stats ? formatUptime(stats.uptimeSecs) : '—'}</span>
        </div>
        <div className="rp-info-item">
          <span className="rp-info-label">负载</span>
          <span className="rp-info-value">{stats ? stats.loadAvg.toFixed(2) : '—'}</span>
        </div>
      </div>

      {isConnected && (
        <div className="rp-hw">
          <div className="rp-hw-row">
            <div className="rp-hw-row-head">
              <span className="rp-hw-label">CPU</span>
              <span className="rp-hw-sub">
                {stats ? `${stats.cpuUsage.toFixed(1)}% · ${stats.cpuCores} 核` : '—'}
              </span>
            </div>
            <div className="rp-hw-detail" title={stats?.cpuModel ?? ''}>
              {stats?.cpuModel ?? (statsLoading ? '获取中…' : '—')}
            </div>
            <div className="rp-hw-bar">
              <div
                className="rp-hw-bar-fill"
                style={{
                  width: stats ? `${Math.min(stats.cpuUsage, 100).toFixed(1)}%` : '0%',
                }}
              />
            </div>
          </div>

          <div className="rp-hw-row">
            <div className="rp-hw-row-head">
              <span className="rp-hw-label">内存</span>
              <span className="rp-hw-sub">
                {stats
                  ? `${formatBytes(stats.memUsedMb)} / ${formatBytes(stats.memTotalMb)} · ${memPct}`
                  : '—'}
              </span>
            </div>
            <div className="rp-hw-bar">
              <div
                className="rp-hw-bar-fill"
                style={{
                  width: stats ? formatPercent(stats.memUsedMb, stats.memTotalMb).replace('%', '') + '%' : '0%',
                }}
              />
            </div>
          </div>

          <div className="rp-hw-row">
            <div className="rp-hw-row-head">
              <span className="rp-hw-label">磁盘</span>
              <span className="rp-hw-sub">
                {stats
                  ? `${formatGb(stats.diskUsedGb)} / ${formatGb(stats.diskTotalGb)} · ${diskPct}`
                  : '—'}
              </span>
            </div>
            <div className="rp-hw-bar">
              <div
                className="rp-hw-bar-fill"
                style={{
                  width: stats ? formatPercent(stats.diskUsedGb, stats.diskTotalGb).replace('%', '') + '%' : '0%',
                }}
              />
            </div>
          </div>
        </div>
      )}

      <div className={`rp-conn-status ${isConnected ? 'connected' : 'disconnected'}`}>
        <span className="rp-conn-dot" />
        <span>{isConnected ? '已连接' : '未连接'}</span>
      </div>
    </section>
  );
}
