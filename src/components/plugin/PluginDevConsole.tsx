import { useState, useEffect, useRef, useMemo } from 'react';
import { usePluginUiStore, type PluginLogEntry } from '../../store/pluginUiStore';
import { usePluginStore, initPluginEventListeners } from '../../store/pluginStore';
import { useUIStore } from '../../store/uiStore';
import { Trash2, FolderOpen, Activity } from 'lucide-react';

const PLUGIN_COLORS = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ec4899', '#8b5cf6', '#06b6d4',
];

function pluginColor(id: string): string {
  let sum = 0;
  for (let i = 0; i < id.length; i++) sum += id.charCodeAt(i);
  return PLUGIN_COLORS[sum % PLUGIN_COLORS.length];
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function PluginDevConsole() {
  const logs = usePluginUiStore((s) => s.logs);
  const clearLogs = usePluginUiStore((s) => s.clearLogs);
  const plugins = usePluginStore((s) => s.plugins);
  const startHotReload = usePluginStore((s) => s.startHotReload);
  const stopHotReload = usePluginStore((s) => s.stopHotReload);
  const pluginHotReloadEnabled = useUIStore((s) => s.pluginHotReloadEnabled);
  const setPluginHotReloadEnabled = useUIStore((s) => s.setPluginHotReloadEnabled);

  const [selectedPlugin, setSelectedPlugin] = useState<string>('all');
  const [showInfo, setShowInfo] = useState(true);
  const [showWarn, setShowWarn] = useState(true);
  const [showError, setShowError] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleToggleHotReload = async (v: boolean) => {
    setPluginHotReloadEnabled(v);
    if (v) {
      await startHotReload();
      await initPluginEventListeners();
    } else {
      await stopHotReload();
    }
  };

  const filteredLogs = useMemo(() => {
    return logs.filter((l) => {
      if (selectedPlugin !== 'all' && l.pluginId !== selectedPlugin) return false;
      if (l.level === 'info' && !showInfo) return false;
      if (l.level === 'warn' && !showWarn) return false;
      if (l.level === 'error' && !showError) return false;
      return true;
    });
  }, [logs, selectedPlugin, showInfo, showWarn, showError]);

  // 自动滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [filteredLogs.length]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 300 }}>
      {/* 工具栏 */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          marginBottom: 12,
          flexWrap: 'wrap',
        }}
      >
        <select
          className="settings-select"
          value={selectedPlugin}
          onChange={(e) => setSelectedPlugin(e.target.value)}
          style={{ minWidth: 140 }}
        >
          <option value="all">全部插件</option>
          {plugins.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>

        {/* 级别 toggle */}
        <button
          type="button"
          className={`btn ${showInfo ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setShowInfo(!showInfo)}
          style={{ fontSize: 12, padding: '4px 10px' }}
        >
          Info
        </button>
        <button
          type="button"
          className={`btn ${showWarn ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setShowWarn(!showWarn)}
          style={{ fontSize: 12, padding: '4px 10px' }}
        >
          Warn
        </button>
        <button
          type="button"
          className={`btn ${showError ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setShowError(!showError)}
          style={{ fontSize: 12, padding: '4px 10px' }}
        >
          Error
        </button>

        {/* 热重载监听开关 */}
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: pluginHotReloadEnabled
              ? 'var(--color-primary, #3b82f6)'
              : 'var(--color-text-muted)',
            cursor: 'pointer',
            padding: '4px 10px',
            borderRadius: 6,
            background: pluginHotReloadEnabled
              ? 'var(--color-bg-secondary)'
              : 'transparent',
          }}
        >
          <Activity size={12} />
          <span>监听插件目录（热重载）</span>
          <input
            type="checkbox"
            checked={pluginHotReloadEnabled}
            onChange={(e) => void handleToggleHotReload(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
        </label>

        <div style={{ flex: 1 }} />

        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => console.log('[PluginDevConsole] 打开插件目录（占位）')}
          title="打开插件目录"
          style={{ fontSize: 12, padding: '4px 10px' }}
        >
          <FolderOpen size={12} style={{ marginRight: 4 }} />
          打开目录
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => clearLogs(selectedPlugin === 'all' ? undefined : selectedPlugin)}
          title="清空当前筛选的日志"
          style={{ fontSize: 12, padding: '4px 10px' }}
        >
          <Trash2 size={12} style={{ marginRight: 4 }} />
          清空
        </button>
      </div>

      {/* 日志列表 */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          fontFamily: 'monospace',
          fontSize: 12,
          lineHeight: 1.6,
          background: 'var(--color-bg-secondary)',
          borderRadius: 8,
          padding: 8,
          minHeight: 200,
        }}
      >
        {filteredLogs.length === 0 ? (
          <div
            style={{
              color: 'var(--color-text-muted)',
              textAlign: 'center',
              padding: 32,
              fontSize: 13,
            }}
          >
            暂无日志
          </div>
        ) : (
          filteredLogs.map((entry) => <LogLine key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  );
}

function LogLine({ entry }: { entry: PluginLogEntry }) {
  const color = pluginColor(entry.pluginId);
  const levelColor =
    entry.level === 'error'
      ? 'var(--color-danger, #ef4444)'
      : entry.level === 'warn'
        ? 'var(--color-warning, #f59e0b)'
        : 'var(--color-text-muted)';

  return (
    <div style={{ display: 'flex', gap: 6, padding: '2px 0' }}>
      <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>
        {formatTime(entry.timestamp)}
      </span>
      <span style={{ color, flexShrink: 0, fontWeight: 600 }}>[{entry.pluginId}]</span>
      <span style={{ color: levelColor }}>{entry.message}</span>
    </div>
  );
}
