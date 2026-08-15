import { useEffect, useRef, useCallback, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { TabBar } from './components/TabBar';
import { StatusBar } from './components/StatusBar';
import { ContentArea } from './components/ContentArea';
import { TerminalPanel } from './components/TerminalPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { UpdateDialog } from './components/UpdateDialog';
import { ToastContainer } from './components/Toast';
import { PortForwardPluginBootstrap } from './components/plugin/PortForwardPluginBootstrap';
import { RightPanel } from './components/RightPanel';
import { useHostStore } from './store/hostStore';
import { useUIStore } from './store/uiStore';
import { useFileStore } from './store/fileStore';
import { matchShortcut } from './store/shortcutStore';
import { bindTransferProgressListener } from './store/transferStore';
import './styles/finder.css';
import './styles/tabbar.css';
import './styles/rightpanel.css';

function App() {
  const loadHosts = useHostStore((s) => s.loadHosts);
  const loadCategories = useHostStore((s) => s.loadCategories);
  const initEventListeners = useHostStore((s) => s.initEventListeners);
  const teardownEventListeners = useHostStore((s) => s.teardownEventListeners);
  const [appReady, setAppReady] = useState(false);
  const [fadeOut, setFadeOut] = useState(false);

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

  const rightPanelWidth = useUIStore((s) => s.rightPanelWidth);
  const setRightPanelWidth = useUIStore((s) => s.setRightPanelWidth);
  const rightPanelResizing = useUIStore((s) => s.rightPanelResizing);
  const setRightPanelResizing = useUIStore((s) => s.setRightPanelResizing);
  const rightPanelVisible = useUIStore((s) => s.rightPanelVisible);

  useEffect(() => {
    let done = false;
    Promise.all([
      loadHosts(),
      loadCategories(),
      initEventListeners(),
      bindTransferProgressListener(),
    ])
      .then(() => {
        done = true;
        setFadeOut(true);
        setTimeout(() => setAppReady(true), 350);
      })
      .catch(() => {
        done = true;
        setFadeOut(true);
        setTimeout(() => setAppReady(true), 350);
      });
    return () => {
      if (!done) setAppReady(true);
      void teardownEventListeners();
    };
  }, [loadHosts, loadCategories, initEventListeners, teardownEventListeners]);

  // 全局禁用浏览器原生右键菜单（自定义菜单已在各组件内 preventDefault，此处兜底拦截漏网区域）
  useEffect(() => {
    const handler = (e: MouseEvent) => e.preventDefault();
    document.addEventListener('contextmenu', handler);
    return () => document.removeEventListener('contextmenu', handler);
  }, []);

  // 全局快捷键（可通过设置面板自定义）：
  // - openSettings: 打开设置
  // - toggleTerminal: 切换终端显示
  // - terminalFullscreen: 切换终端全屏（仅终端可见时生效）
  // - refreshDir: 刷新当前目录
  useEffect(() => {
    function onGlobalKeyDown(e: KeyboardEvent) {
      // 打开设置
      if (matchShortcut('openSettings', e)) {
        e.preventDefault();
        useUIStore.getState().setSettingsVisible(true);
        return;
      }
      // 切换终端显示
      if (matchShortcut('toggleTerminal', e)) {
        e.preventDefault();
        const hid = useHostStore.getState().selectedHostId;
        if (hid) useUIStore.getState().toggleTerminal(hid);
        return;
      }
      // 切换终端全屏（仅终端可见时生效）
      if (matchShortcut('terminalFullscreen', e)) {
        const hid = useHostStore.getState().selectedHostId;
        const visible = hid ? !!useUIStore.getState().terminalVisible[hid] : false;
        if (visible) {
          e.preventDefault();
          useUIStore
            .getState()
            .setTerminalFullscreen(!useUIStore.getState().terminalFullscreen);
        }
        return;
      }
      // 刷新当前目录
      if (matchShortcut('refreshDir', e)) {
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

  // 右侧面板拖拽（向左拖增大宽度）
  const onRightPanelMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setRightPanelResizing(true);
      const startX = e.clientX;
      const startWidth = rightPanelWidth;
      const onMove = (ev: MouseEvent) => {
        setRightPanelWidth(startWidth - (ev.clientX - startX));
      };
      const onUp = () => {
        setRightPanelResizing(false);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [rightPanelWidth, setRightPanelWidth, setRightPanelResizing],
  );

  const terminalRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      className={`app-root ${sidebarResizing ? 'is-resizing-sidebar' : ''} ${
        terminalResizing ? 'is-resizing-terminal' : ''
      } ${rightPanelResizing ? 'is-resizing-rightpanel' : ''}`}
    >
      <TabBar />

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
        {/* 右侧面板分隔条 */}
        <div
          className={`rightpanel-resizer ${rightPanelResizing ? 'is-active' : ''}`}
          onMouseDown={onRightPanelMouseDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右侧面板宽度"
          style={{ display: rightPanelVisible ? '' : 'none' }}
        />
        {/* 右侧面板区 */}
        <div
          className="rightpanel-wrap"
          style={{ width: rightPanelWidth, display: rightPanelVisible ? '' : 'none' }}
        >
          <RightPanel />
        </div>
      </div>

      <StatusBar />

      <ToastContainer />
      <SettingsDialog />
      <UpdateDialog />
      <PortForwardPluginBootstrap />

      {/* 启动加载遮罩 */}
      {!appReady && (
        <div className={`app-splash ${fadeOut ? 'app-splash-fadeout' : ''}`}>
          <div className="app-splash-logo">RD</div>
          <div className="app-slash-spinner" />
          <div className="app-splash-text">正在加载…</div>
        </div>
      )}
    </div>
  );
}

export default App;
