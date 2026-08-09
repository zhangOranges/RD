import { useHostStore } from '../store/hostStore';
import { useUIStore } from '../store/uiStore';
import { version } from '../../package.json';

export function StatusBar() {
  const hosts = useHostStore((s) => s.hosts);
  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const currentPath = useUIStore((s) => s.currentPath);

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
      </div>
    </footer>
  );
}
