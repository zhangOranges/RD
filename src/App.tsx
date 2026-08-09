import { useEffect, useRef, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { Toolbar } from './components/Toolbar';
import { StatusBar } from './components/StatusBar';
import { ContentArea } from './components/ContentArea';
import { TerminalPanel } from './components/TerminalPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { ToastContainer } from './components/Toast';
import { useHostStore } from './store/hostStore';
import { useUIStore } from './store/uiStore';
import { useFileStore } from './store/fileStore';
import { bindTransferProgressListener } from './store/transferStore';
import './styles/finder.css';

function App() {
  const loadHosts = useHostStore((s) => s.loadHosts);
  const loadCategories = useHostStore((s) => s.loadCategories);
  const initEventListeners = useHostStore((s) => s.initEventListeners);
  const teardownEventListeners = useHostStore((s) => s.teardownEventListeners);

  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const setSidebarResizing = useUIStore((s) => s.setSidebarResizing);
  const sidebarResizing = useUIStore((s) => s.sidebarResizing);

  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const terminalVisibleMap = useUIStore((s) => s.terminalVisible);
  const terminalVisible = !!selectedHostId && !!terminalVisibleMap[selectedHostId];
  const terminalHeight = useUIStore((s) => s.terminalHeight);
  const setTerminalHeight = useUIStore((s) => s.setTerminalHeight);
  const setTerminalResizing = useUIStore((s) => s.setTerminalResizing);
  const terminalResizing = useUIStore((s) => s.terminalResizing);

  useEffect(() => {
    void loadHosts();
    void loadCategories();
    void initEventListeners();
    // 注册全局传输进度事件（上传/下载进度由 Rust 端 emit）
    void bindTransferProgressListener();
    return () => {
      void teardownEventListeners();
    };
  }, [loadHosts, loadCategories, initEventListeners, teardownEventListeners]);

  // 全局快捷键：
  // - Ctrl+,（Windows/Linux）/ Cmd+,（macOS）→ 打开设置
  // - Ctrl+`（Windows/Linux）/ Cmd+`（macOS）→ 切换终端
  // - F5 或 Ctrl+R（Windows/Linux）/ Cmd+R（macOS）→ 刷新当前目录
  useEffect(() => {
    function onGlobalKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      // Ctrl+, / Cmd+, → 打开设置
      if (mod && e.key === ',') {
        e.preventDefault();
        useUIStore.getState().setSettingsVisible(true);
        return;
      }
      // Ctrl+` / Cmd+` → 切换终端
      if (mod && e.key === '`') {
        e.preventDefault();
        const hid = useHostStore.getState().selectedHostId;
        if (hid) useUIStore.getState().toggleTerminal(hid);
        return;
      }
      // F5 或 Ctrl+R / Cmd+R → 刷新当前目录
      if (e.key === 'F5' || (mod && (e.key === 'r' || e.key === 'R'))) {
        const hostId = useHostStore.getState().selectedHostId;
        const connState = hostId
          ? useHostStore.getState().connectionStates[hostId]
          : undefined;
        if (hostId && connState === 'connected') {
          e.preventDefault();
          void useFileStore.getState().refresh(hostId);
        }
        return;
      }
    }
    document.addEventListener('keydown', onGlobalKeyDown);
    return () => document.removeEventListener('keydown', onGlobalKeyDown);
  }, []);

  // 侧边栏拖拽
  const onSidebarMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setSidebarResizing(true);
      const startX = e.clientX;
      const startWidth = sidebarWidth;
      const onMove = (ev: MouseEvent) => {
        setSidebarWidth(startWidth + (ev.clientX - startX));
      };
      const onUp = () => {
        setSidebarResizing(false);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [sidebarWidth, setSidebarWidth, setSidebarResizing],
  );

  // 终端拖拽
  const onTerminalMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setTerminalResizing(true);
      const startY = e.clientY;
      const startHeight = terminalHeight;
      const onMove = (ev: MouseEvent) => {
        // 向上拖增大高度
        setTerminalHeight(startHeight - (ev.clientY - startY));
      };
      const onUp = () => {
        setTerminalResizing(false);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [terminalHeight, setTerminalHeight, setTerminalResizing],
  );

  const terminalRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      className={`app-root ${sidebarResizing ? 'is-resizing-sidebar' : ''} ${
        terminalResizing ? 'is-resizing-terminal' : ''
      }`}
    >
      <Toolbar />

      <div className="app-body">
        <div className="sidebar-wrap" style={{ width: sidebarWidth }}>
          <Sidebar />
        </div>
        <div
          className={`sidebar-resizer ${sidebarResizing ? 'is-active' : ''}`}
          onMouseDown={onSidebarMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整侧边栏宽度"
        />

        <div className="main-wrap">
          <div className="content-wrap">
            <ContentArea />
          </div>

          <div
            className={`terminal-resizer ${terminalVisible && !terminalResizing ? '' : 'is-hidden'} ${terminalResizing ? 'is-active' : ''}`}
            onMouseDown={onTerminalMouseDown}
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整终端高度"
            style={{ display: terminalVisible ? '' : 'none' }}
          />
          <div
            ref={terminalRef}
            className="terminal-panel"
            style={{
              height: terminalHeight,
              display: terminalVisible ? '' : 'none',
            }}
          >
            <TerminalPanel />
          </div>
        </div>
      </div>

      <StatusBar />

      <ToastContainer />
      <SettingsDialog />
    </div>
  );
}

export default App;
