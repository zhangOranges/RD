import { useState, useEffect } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  TerminalSquare,
  ArrowUp,
  Minus,
  Square,
  X,
  Copy,
} from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useUIStore } from '../store/uiStore';
import { useHostStore } from '../store/hostStore';
import { useFileStore } from '../store/fileStore';
import { usePluginUiStore, type PluginToolbarButton } from '../store/pluginUiStore';
import { AddressBar } from './AddressBar';
import { TransferNotification } from './TransferNotification';
import '../styles/filebrowser.css';
import '../styles/transfer.css';

export function Toolbar() {
  const currentPath = useUIStore((s) => s.currentPath);
  const toggleTerminal = useUIStore((s) => s.toggleTerminal);
  const terminalVisibleMap = useUIStore((s) => s.terminalVisible);
  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const terminalVisible = !!selectedHostId && !!terminalVisibleMap[selectedHostId];

  const refresh = useFileStore((s) => s.refresh);
  const goBack = useFileStore((s) => s.goBack);
  const goForward = useFileStore((s) => s.goForward);
  const goUp = useFileStore((s) => s.goUp);
  const history = useFileStore((s) => s.history);
  const historyIndex = useFileStore((s) => s.historyIndex);

  // 插件注册的 Toolbar 按钮，按 group 分组渲染
  const pluginButtons = usePluginUiStore((s) => s.toolbarButtons);
  const leftPluginButtons = pluginButtons.filter((b) => b.group === 'left');
  const centerPluginButtons = pluginButtons.filter((b) => b.group === 'center');
  const rightPluginButtons = pluginButtons.filter((b) => b.group === 'right');

  const [isMaximized, setIsMaximized] = useState(false);

  // 监听窗口最大化状态
  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setIsMaximized).catch(() => {});
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setIsMaximized).catch(() => {});
    });
    return () => { void unlisten.then((fn) => fn()); };
  }, []);

  async function handleMinimize() {
    await getCurrentWindow().minimize();
  }
  async function handleMaximize() {
    const win = getCurrentWindow();
    await win.toggleMaximize();
  }
  async function handleClose() {
    await getCurrentWindow().close();
  }

  const connState = selectedHostId ? connectionStates[selectedHostId] : undefined;
  const connected = connState === 'connected' && !!selectedHostId;
  const canGoBack = connected && historyIndex > 0;
  const canGoForward = connected && historyIndex >= 0 && historyIndex < history.length - 1;
  const canGoUp = connected && !!currentPath && currentPath !== '/';

  async function handleRefresh() {
    if (!selectedHostId) return;
    await refresh(selectedHostId);
  }

  async function handleBack() {
    if (!selectedHostId) return;
    await goBack(selectedHostId);
  }

  async function handleForward() {
    if (!selectedHostId) return;
    await goForward(selectedHostId);
  }

  async function handleUp() {
    if (!selectedHostId) return;
    await goUp(selectedHostId);
  }

  return (
    <header className="toolbar" role="toolbar" aria-label="顶部工具栏">
      {/* 窗口控制按钮（macOS 风格：左上角） */}
      <div className="win-controls">
        <button
          type="button"
          className="win-btn win-btn-close"
          title="关闭"
          aria-label="关闭窗口"
          onClick={() => void handleClose()}
        >
          <X size={12} />
        </button>
        <button
          type="button"
          className="win-btn win-btn-minimize"
          title="最小化"
          aria-label="最小化窗口"
          onClick={() => void handleMinimize()}
        >
          <Minus size={12} />
        </button>
        <button
          type="button"
          className="win-btn win-btn-maximize"
          title={isMaximized ? '还原' : '最大化'}
          aria-label="最大化/还原窗口"
          onClick={() => void handleMaximize()}
        >
          {isMaximized ? <Copy size={11} /> : <Square size={10} />}
        </button>
      </div>

      {leftPluginButtons.length > 0 && (
        <div className="toolbar-group toolbar-plugin-group">
          {leftPluginButtons.map((btn) => (
            <PluginButton key={btn.id} btn={btn} />
          ))}
        </div>
      )}

      <div className="toolbar-group">
        <button
          className="toolbar-btn"
          type="button"
          aria-label="后退"
          title="后退"
          onClick={handleBack}
          disabled={!canGoBack}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          className="toolbar-btn"
          type="button"
          aria-label="前进"
          title="前进"
          onClick={handleForward}
          disabled={!canGoForward}
        >
          <ChevronRight size={16} />
        </button>
        <button
          className="toolbar-btn"
          type="button"
          aria-label="返回上级"
          title="返回上级"
          onClick={handleUp}
          disabled={!canGoUp}
        >
          <ArrowUp size={14} />
        </button>
        <button
          className="toolbar-btn"
          type="button"
          aria-label="刷新"
          title="刷新"
          onClick={handleRefresh}
          disabled={!connected}
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {connected && selectedHostId ? (
        <AddressBar hostId={selectedHostId} currentPath={currentPath} />
      ) : (
        <div className="toolbar-path">
          <span className="toolbar-path-placeholder">未连接主机</span>
        </div>
      )}

      {centerPluginButtons.length > 0 && (
        <div className="toolbar-group toolbar-plugin-group">
          {centerPluginButtons.map((btn) => (
            <PluginButton key={btn.id} btn={btn} />
          ))}
        </div>
      )}

      <div className="toolbar-group">
        <button
          className={`toolbar-btn ${terminalVisible ? 'toolbar-btn-active' : ''}`}
          type="button"
          aria-label="切换终端"
          title="显示/隐藏终端"
          onClick={() => { if (selectedHostId) toggleTerminal(selectedHostId); }}
        >
          <TerminalSquare size={16} />
        </button>
        <TransferNotification />
      </div>

      {rightPluginButtons.length > 0 && (
        <div className="toolbar-group toolbar-plugin-group">
          {rightPluginButtons.map((btn) => (
            <PluginButton key={btn.id} btn={btn} />
          ))}
        </div>
      )}
    </header>
  );
}

function PluginButton({ btn }: { btn: PluginToolbarButton }) {
  return (
    <button
      className="toolbar-btn"
      type="button"
      title={btn.tooltip ?? btn.label}
      aria-label={btn.label}
      disabled={btn.disabled}
      onClick={() => { void btn.onClick(); }}
    >
      {btn.icon ? (
        <span className="toolbar-plugin-icon">{btn.icon}</span>
      ) : (
        <span>{btn.label}</span>
      )}
    </button>
  );
}
