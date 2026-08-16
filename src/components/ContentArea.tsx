import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  ServerCog,
  FolderTree,
  RefreshCw,
} from 'lucide-react';
import { useHostStore } from '../store/hostStore';
import { useFileStore } from '../store/fileStore';
import { useToastStore } from './Toast';
import { FileBrowser } from './FileBrowser';
import LocalFilePane from './LocalFilePane';
import { useUIStore } from '../store/uiStore';
import { useTransferStore, genTaskId } from '../store/transferStore';
import { useLocalFileStore } from '../store/localFileStore';
import { logInfo, logWarn } from '../utils/log';

// 已为主机做过初始化的 hostId 集合。避免连接成功后 useEffect 重触发时重复加载。
// 主机断开重连后我们希望重新走缓存逻辑，因此在断开时清掉记录。
const initializedHosts = new Set<string>();

export function ContentArea() {
  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const hosts = useHostStore((s) => s.hosts);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const reconnectMeta = useHostStore((s) => s.reconnectMeta);

  const navigate = useFileStore((s) => s.navigate);
  const resetState = useFileStore((s) => s.resetState);
  const pushToast = useToastStore((s) => s.push);

  // 传输任务注册（远程→本地下载用）
  const createTransferTask = useTransferStore((s) => s.createTask);
  // 本地栏拖拽接收高亮
  const [localDragOver, setLocalDragOver] = useState(false);

  const selectedHost = hosts.find((h) => h.id === selectedHostId);
  const connState = selectedHostId ? connectionStates[selectedHostId] : undefined;

  // 跟踪上次已选中的 hostId；切换主机时清空目标主机的初始化记录，
  // 让自动初始化逻辑为目标主机重新加载缓存路径。
  const lastHostIdRef = useRef<string | null>(null);
  // 本地文件栏按 host 隔离切换（每个主机独立记忆自己的本地目录）
  const setActiveLocalHost = useLocalFileStore((s) => s.setActiveHost);

  useEffect(() => {
    if (!selectedHostId) {
      lastHostIdRef.current = null;
      void setActiveLocalHost(null);
      return;
    }
    if (lastHostIdRef.current !== selectedHostId) {
      // 切换到新主机：清空其初始化标记，强制重新走缓存逻辑
      initializedHosts.delete(selectedHostId);
      lastHostIdRef.current = selectedHostId;
      // 立即重置文件浏览器状态，防止旧主机的路径/列表/历史残留到新主机
      // （尤其同 IP 不同名的主机，不重置会导致终端被 pty_cd 到旧主机路径）
      resetState();
      // 同步切换本地栏的 host 绑定：每个主机独立记忆自己的本地目录
      void setActiveLocalHost(selectedHostId);
    }
  }, [selectedHostId, resetState, setActiveLocalHost]);

  // 已连接 → 自动初始化（仅在首次进入时）
  useEffect(() => {
    if (!selectedHostId || connState !== 'connected') return;
    if (initializedHosts.has(selectedHostId)) return;

    let cancelled = false;
    async function init() {
      if (!selectedHostId || cancelled) return;
      const hostId = selectedHostId;

      // 1) 读取主机配置的 remember_dir（主机级直接决定是否记忆目录）
      const host = useHostStore.getState().hosts.find((h) => h.id === hostId);
      const rememberDir = host?.remember_dir ?? false;

      // 判断路径是否是合法的绝对路径（以 / 开头），避免缓存脏数据（如 hostId UUID）
      // 被误当做路径而显示在面包屑里
      const isValidAbsPath = (p: string | null | undefined): p is string =>
        typeof p === 'string' && p.length > 0 && p.startsWith('/');

      // 2) 读取路径缓存（仅当主机级开启目录记忆时）
      // 读活动 tab 的缓存路径，使文件浏览器跟随活动 tab 恢复目录
      let cachedPath: string | null = null;
      if (rememberDir) {
        try {
          const activeTabId = useUIStore.getState().getActiveTerminalTab(hostId) ?? 'default';
          cachedPath = await invoke<string | null>('get_path_cache', {
            hostId,
            tabId: activeTabId,
          });
          logInfo(`[remote-dir] 读取缓存路径: host=${hostId} tab=${activeTabId} cached=${JSON.stringify(cachedPath)}`);
        } catch {
          cachedPath = null;
        }
        if (!isValidAbsPath(cachedPath)) cachedPath = null;
      } else {
        logInfo(`[remote-dir] 主机未开启目录记忆，跳过缓存读取: host=${hostId}`);
      }

      const home = useHostStore.getState().homeDirs[hostId];

      // 3) 决定起始路径：缓存优先，否则家目录；两者都无效时兜底 '/'
      let startPath: string | null = null;
      if (isValidAbsPath(cachedPath)) startPath = cachedPath;
      else if (isValidAbsPath(home)) startPath = home;

      if (!startPath) {
        // 兜底：尝试直接跳转根目录
        startPath = '/';
      }

      logInfo(`[remote-dir] 起始路径决定: start=${JSON.stringify(startPath)} cached=${JSON.stringify(cachedPath)} home=${JSON.stringify(home)} rememberDir=${rememberDir}`);

      // 4) 尝试 navigate；连接刚成功时 SFTP 子系统可能仍在握手，Timeout 是预期内的时序抖动，
      //    做 2 次小退避重试（每次 200ms），期间抑制 Toast。其他错误立即暴露。
      const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      let ok = await navigate(hostId, startPath, { silentOnError: true });
      if (!ok) {
        const errMsg = useFileStore.getState().error ?? '';
        const isTimeoutLike = /timeout|timed ?out|sftp error/i.test(errMsg);
        if (isTimeoutLike) {
          for (const delay of [200, 400]) {
            if (cancelled) return;
            logWarn(`[remote-dir] SFTP not ready yet (${errMsg.slice(0, 60)}), retry after ${delay}ms`);
            await wait(delay);
            ok = await navigate(hostId, startPath, { silentOnError: true });
            if (ok) break;
          }
        }
      }
      if (!ok && isValidAbsPath(cachedPath) && isValidAbsPath(home) && cachedPath !== home) {
        logWarn(`[remote-dir] 缓存路径失效，降级到家目录: cached=${JSON.stringify(cachedPath)} home=${JSON.stringify(home)}`);
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

  // ---- 双栏拖拽互传：远程 → 本地（下载） ----
  // FileBrowser 的行 dragstart 写入 `application/x-remote-file`，这里在
  // 本地栏外层 div 接收 drop，调用 sftp_download_file/dir 下载到本地当前目录。
  const onLocalDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer) return;
    if (e.dataTransfer.types.includes('application/x-remote-file')) {
      e.preventDefault();
      setLocalDragOver(true);
    }
  }, []);

  const onLocalDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer) return;
      if (e.dataTransfer.types.includes('application/x-remote-file')) {
        e.preventDefault();
        try {
          e.dataTransfer.dropEffect = 'copy';
        } catch {
          /* noop */
        }
        if (!localDragOver) setLocalDragOver(true);
      }
    },
    [localDragOver],
  );

  const onLocalDragLeave = useCallback((e: React.DragEvent) => {
    // 子元素间移动也会触发 dragleave，仅在真正离开容器时清高亮
    const to = e.relatedTarget as Node | null;
    const self = e.currentTarget as HTMLElement;
    if (to && self.contains(to)) return;
    setLocalDragOver(false);
  }, []);

  const onLocalDrop = useCallback(
    async (e: React.DragEvent) => {
      const raw = e.dataTransfer?.getData('application/x-remote-file') ?? '';
      if (!raw) return;
      e.preventDefault();
      setLocalDragOver(false);

      let payload: {
        kind?: string;
        hostId?: string;
        name?: string;
        path?: string;
        isDir?: boolean;
        size?: number;
      };
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }
      if (
        !payload ||
        payload.kind !== 'remote-file' ||
        !payload.hostId ||
        !payload.path ||
        !payload.name
      ) {
        return;
      }
      const isDir = !!payload.isDir;

      const localDir = useLocalFileStore.getState().currentPath;
      if (!localDir) {
        pushToast('warning', '本地未打开目录，无法下载');
        return;
      }

      const taskId = genTaskId();

      // 文件夹：远程压缩 → 下载 tar.gz 到本地目标目录（用户可见）→ 重命名 → 本地解压 → 删除压缩包
      if (isDir) {
        const { joinLocalPath } = await import('../store/localFileStore');
        // 远程临时压缩文件（/tmp 下即可，远程用户不需要看到）
        const remoteTmpPath = `/tmp/rd_transfer_${Date.now()}.tar.gz`;
        // 下载到本地目标目录的临时文件（用户可见，带 .tmp 后缀）
        const localTarballTmpPath = joinLocalPath(localDir, `${payload.name}.tar.gz.tmp`);
        // 下载完成后的正式压缩包名
        const localTarballFinalPath = joinLocalPath(localDir, `${payload.name}.tar.gz`);

        createTransferTask({
          id: taskId,
          kind: 'download',
          hostId: payload.hostId,
          name: payload.name,
          remotePath: payload.path,
          localPath: localDir,
          totalBytes: 0,
        });

        try {
          // 1. 远程压缩
          useTransferStore.getState().setTaskStatus(taskId, 'running', { name: `${payload.name} (压缩中...)` });
          await invoke('ssh_exec', {
            hostId: payload.hostId,
            command: `tar -czf "${remoteTmpPath}" -C "$(dirname "${payload.path}")" "${payload.name}"`,
          });

          // 2. 下载 tar.gz 到本地目标目录的临时文件（用户可见）
          useTransferStore.getState().setTaskStatus(taskId, 'running', { name: payload.name });
          await invoke('sftp_download_file', {
            hostId: payload.hostId,
            remotePath: remoteTmpPath,
            localPath: localTarballTmpPath,
            taskId,
            displayName: payload.name,
          });

          // 3. 下载完成：将 .tmp 重命名为正式的 .tar.gz
          await invoke('rename_local_path', {
            oldPath: localTarballTmpPath,
            newPath: localTarballFinalPath,
          });

          // 4. 本地解压
          useTransferStore.getState().setTaskStatus(taskId, 'running', { name: `${payload.name} (解压中...)` });
          await invoke('extract_local_archive', {
            archivePath: localTarballFinalPath,
            destDir: localDir,
          });

          // 5. 解压完成后删除本地压缩包
          invoke('delete_local_path', { path: localTarballFinalPath }).catch(() => {});

          // 6. 完成
          useTransferStore.getState().setTaskStatus(taskId, 'completed', { name: payload.name });
          await useLocalFileStore.getState().refresh();
        } catch (err) {
          const msg = String(err);
          if (msg.startsWith('Cancelled:')) {
            pushToast('info', `已取消下载：${payload.name}`);
          } else {
            pushToast('error', `下载失败：${msg}`);
          }
        } finally {
          // 7. 清理临时文件
          invoke('delete_local_path', { path: localTarballTmpPath }).catch(() => {});
          invoke('delete_local_path', { path: localTarballFinalPath }).catch(() => {});
          invoke('sftp_remove_file', { hostId: payload.hostId, path: remoteTmpPath }).catch(() => {});
        }
        return;
      }

      // 单文件下载（原有逻辑）
      createTransferTask({
        id: taskId,
        kind: 'download',
        hostId: payload.hostId,
        name: payload.name,
        remotePath: payload.path,
        localPath: localDir,
        totalBytes: payload.size ?? 0,
      });

      try {
        await invoke('sftp_download_file', {
          hostId: payload.hostId,
          remotePath: payload.path,
          localPath: localDir,
          taskId,
        });
        await useLocalFileStore.getState().refresh();
      } catch (err) {
        const msg = String(err);
        if (msg.startsWith('Cancelled:')) {
          pushToast('info', `已取消下载：${payload.name}`);
        } else {
          pushToast('error', `下载失败：${msg}`);
        }
      }
    },
    [pushToast, createTransferTask],
  );

  // 端口转发已迁为内置插件（rd-native-port-forward）：界面/逻辑在插件目录内，
  // 经工具栏"端口转发"按钮打开插件视图宿主，主程序不再渲染。

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

  // 重连中：connState === 'reconnecting'，或有 reconnectMeta（状态翻转瞬间兜底）
  const hostId = selectedHostId ?? '';
  const isReconnecting =
    connState === 'reconnecting' || (connState === 'disconnected' && !!reconnectMeta[hostId]);

  if (connState !== 'connected' && !isReconnecting) {
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

  // 已连接 → SFTP 双栏（左本地 + 右远程）
  const meta = reconnectMeta[hostId];
  const remainingSec = meta?.nextDelayMs != null ? Math.max(0, Math.ceil(meta.nextDelayMs / 1000)) : null;
  return (
    <div className="dual-pane" style={{ position: 'relative' }}>
      <div className="dual-pane-section-title">SFTP 文件管理器</div>
      <div className="dual-pane-body">
        <div
          className={`dual-pane-left${localDragOver ? ' drag-over' : ''}`}
          onDragEnter={onLocalDragEnter}
          onDragOver={onLocalDragOver}
          onDragLeave={onLocalDragLeave}
          onDrop={onLocalDrop}
        >
          <LocalFilePane />
        </div>
        <div className="dual-pane-divider" />
        <div className="dual-pane-right">
          <FileBrowser hostId={selectedHost.id} />
        </div>
      </div>
      {isReconnecting && (
        <div className="sftp-reconnecting-overlay">
          <RefreshCw size={28} className="sftp-reconnecting-icon" />
          <div className="sftp-reconnecting-text">
            <span className="sftp-reconnecting-title">尝试重连中…</span>
            {meta?.attempt != null && (
              <span className="sftp-reconnecting-sub">
                第 {meta.attempt} 次尝试{remainingSec != null ? ` · ${remainingSec}s 后重试` : ''}
              </span>
            )}
            <span className="sftp-reconnecting-hint">网络恢复后将自动恢复连接</span>
          </div>
        </div>
      )}
    </div>
  );
}
