import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ServerCog, FolderTree } from 'lucide-react';
import { useHostStore } from '../store/hostStore';
import { useFileStore } from '../store/fileStore';
import { useToastStore } from './Toast';
import { FileBrowser } from './FileBrowser';

// 已为主机做过初始化的 hostId 集合。避免连接成功后 useEffect 重触发时重复加载。
// 主机断开重连后我们希望重新走缓存逻辑，因此在断开时清掉记录。
const initializedHosts = new Set<string>();

export function ContentArea() {
  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const hosts = useHostStore((s) => s.hosts);
  const connectionStates = useHostStore((s) => s.connectionStates);

  const navigate = useFileStore((s) => s.navigate);
  const resetState = useFileStore((s) => s.resetState);
  const pushToast = useToastStore((s) => s.push);

  const selectedHost = hosts.find((h) => h.id === selectedHostId);
  const connState = selectedHostId ? connectionStates[selectedHostId] : undefined;

  // 跟踪上次已选中的 hostId；切换主机时清空目标主机的初始化记录，
  // 让自动初始化逻辑为目标主机重新加载缓存路径。
  const lastHostIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedHostId) {
      lastHostIdRef.current = null;
      return;
    }
    if (lastHostIdRef.current !== selectedHostId) {
      // 切换到新主机：清空其初始化标记，强制重新走缓存逻辑
      initializedHosts.delete(selectedHostId);
      lastHostIdRef.current = selectedHostId;
      // 立即重置文件浏览器状态，防止旧主机的路径/列表/历史残留到新主机
      // （尤其同 IP 不同名的主机，不重置会导致终端被 pty_cd 到旧主机路径）
      resetState();
    }
  }, [selectedHostId, resetState]);

  // 已连接 → 自动初始化（仅在首次进入时）
  useEffect(() => {
    if (!selectedHostId || connState !== 'connected') return;
    if (initializedHosts.has(selectedHostId)) return;

    let cancelled = false;
    async function init() {
      if (!selectedHostId || cancelled) return;
      const hostId = selectedHostId;

      // 1) 读取主机配置的 remember_dir（主机级直接决定是否记忆目录）
      //    优先级：主机级 > 全局级。HostConfig.remember_dir 总有值，直接决定本次初始化行为。
      //    全局设置 remember_dir_global 仅影响"新建主机时 remember_dir 的默认值"，
      //    在 Task 10 的设置页中配置，不影响此处已有主机的初始化逻辑。
      const host = useHostStore.getState().hosts.find((h) => h.id === hostId);
      const rememberDir = host?.remember_dir ?? false;

      // 2) 读取路径缓存（仅当主机级开启目录记忆时）
      let cachedPath: string | null = null;
      if (rememberDir) {
        try {
          cachedPath = await invoke<string | null>('get_path_cache', {
            hostId,
            tabId: 'default',
          });
        } catch {
          cachedPath = null;
        }
      }

      const home = useHostStore.getState().homeDirs[hostId];

      // 3) 决定起始路径：缓存优先，否则家目录
      const startPath = cachedPath ?? home;
      if (!startPath) {
        pushToast('warning', '未能获取家目录，请在地址栏输入路径');
        initializedHosts.add(hostId);
        return;
      }

      // 4) 尝试 navigate；缓存路径失效时降级到家目录
      const ok = await navigate(hostId, startPath);
      if (!ok && cachedPath && home && cachedPath !== home) {
        pushToast('warning', `上次路径已失效，已切换到家目录：${home}`);
        await navigate(hostId, home);
      }

      initializedHosts.add(hostId);
    }

    void init();
    return () => {
      cancelled = true;
    };
  }, [selectedHostId, connState, navigate, pushToast]);

  // 主机断开 → 清理初始化记录，下次重连重新走缓存
  useEffect(() => {
    if (!selectedHostId) return;
    if (connectionStates[selectedHostId] === 'disconnected') {
      initializedHosts.delete(selectedHostId);
    }
  }, [selectedHostId, connectionStates]);

  if (!selectedHost) {
    return (
      <div className="content-placeholder">
        <FolderTree size={48} className="content-placeholder-icon" />
        <p className="content-placeholder-title">请选择或连接一台主机</p>
        <p className="content-placeholder-sub">
          在左侧侧边栏点击主机发起连接，或点击 + 新增主机。
        </p>
      </div>
    );
  }

  if (connState !== 'connected') {
    return (
      <div className="content-placeholder">
        <ServerCog size={48} className="content-placeholder-icon" />
        <p className="content-placeholder-title">{selectedHost.name}</p>
        <p className="content-placeholder-sub">
          {connState === 'connecting' ? '正在连接…' : '尚未连接，点击主机项发起连接'}
        </p>
      </div>
    );
  }

  return <FileBrowser hostId={selectedHost.id} />;
}
