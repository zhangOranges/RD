import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import type { RDContext, EventBus, RdEventMap, PluginManifest, ToolbarButtonOption, HostConfigSafe, ThemeInfo, HttpRequestOptions, HttpResponse, SftpFile, CommandResult, SshExecOptions, TransferHandle, TunnelMode, TunnelRule, TunnelStatus, RdTunnelsFile, TunnelConflictStrategy, TunnelImportResult } from '../types/plugin';
import { RD_TUNNELS_SCHEMA_URL } from '../types/plugin';
import type { HostConfig, CategoryConfig, ConnectionState, ConnectResult, CredentialType } from '../types';
import { useToastStore } from '../components/Toast';
import { usePluginUiStore } from '../store/pluginUiStore';
import { useHostStore, classifyConnectFailure } from '../store/hostStore';
import { useUIStore } from '../store/uiStore';
import { logInfo, logWarn, logError } from '../utils/log';
import { sanitizeHostConfig, sanitizeHostConfigs } from './hostSafe';
import { ConfirmDialog } from '../components/plugin/ConfirmDialog';
import { PromptDialog } from '../components/plugin/PromptDialog';
import {
  getCurrentThemeInfo,
  listAllThemeInfos,
  PRESET_OPTIONS,
  useThemeStore,
} from '../store/themeStore';

export const SDK_API_VERSION = 'v1';
export const ERR_NOT_IMPLEMENTED = 'NOT_IMPLEMENTED';
export const ERR_PERMISSION_DENIED = 'PERMISSION_DENIED';
export { sanitizeHostConfig, sanitizeHostConfigs } from './hostSafe';

function notImplemented(): never {
  throw new Error(ERR_NOT_IMPLEMENTED);
}

function notImplementedAsync(): Promise<never> {
  return Promise.reject(new Error(ERR_NOT_IMPLEMENTED));
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * 客户端层权限校验：调用 Rust 内核 `plugin_assert_perm` 检查插件是否被授予权限。
 * 与内核层共同构成双层校验：前端拦截 + 后端强制。
 * 失败时抛出 `PERMISSION_DENIED: <perm>`。
 */
async function assertPermission(pluginId: string, perm: string): Promise<void> {
  try {
    await invoke('plugin_assert_perm', { id: pluginId, perm });
  } catch {
    throw new Error(`PERMISSION_DENIED: ${perm}`);
  }
}

function mapRuleDto(dto: Record<string, unknown>): TunnelRule {
  return {
    id: String(dto.id ?? ''),
    hostId: String(dto.host_id ?? dto.hostId ?? ''),
    mode: String(dto.mode ?? 'local') as TunnelMode,
    localAddr: String(dto.local_addr ?? dto.localAddr ?? ''),
    localPort: Number(dto.local_port ?? dto.localPort ?? 0),
    remoteAddr: dto.remote_addr != null ? String(dto.remote_addr)
                : dto.remoteAddr != null ? String(dto.remoteAddr) : undefined,
    remotePort: dto.remote_port != null ? Number(dto.remote_port)
                : dto.remotePort != null ? Number(dto.remotePort) : undefined,
    autoStart: Boolean(dto.auto_start ?? dto.autoStart ?? false),
    tags: (dto.tags as unknown[])?.map(String),
    comment: dto.comment != null ? String(dto.comment) : undefined,
    createdAt: Number(dto.created_at ?? dto.createdAt ?? Date.now()),
  };
}
function mapStatusDto(dto: Record<string, unknown>): TunnelStatus {
  return {
    tunnelId: String(dto.tunnel_id ?? dto.tunnelId ?? ''),
    running: Boolean(dto.running ?? false),
    pid: dto.pid != null ? Number(dto.pid) : undefined,
    error: dto.error != null ? String(dto.error) : undefined,
    boundHostId: dto.bound_host_id != null ? String(dto.bound_host_id)
                 : dto.boundHostId != null ? String(dto.boundHostId) : undefined,
    acceptedConns: Number(dto.accepted_conns ?? dto.acceptedConns ?? 0),
    startTimeMs: dto.start_time_ms != null ? Number(dto.start_time_ms)
                  : dto.startTimeMs != null ? Number(dto.startTimeMs) : undefined,
  };
}
export { mapRuleDto, mapStatusDto };

type ListenerEntry = {
  event: keyof RdEventMap;
  listener: (...args: unknown[]) => void;
  owner?: object;
};

export function createEventBus(): EventBus {
  const listeners: ListenerEntry[] = [];

  function on<K extends keyof RdEventMap>(
    event: K,
    listener: (...args: RdEventMap[K]) => void,
    owner?: object,
  ): void {
    listeners.push({
      event,
      listener: listener as (...args: unknown[]) => void,
      owner,
    });
  }

  function off<K extends keyof RdEventMap>(
    event: K,
    listener: (...args: RdEventMap[K]) => void,
  ): void {
    for (let i = listeners.length - 1; i >= 0; i--) {
      if (listeners[i].event === event && listeners[i].listener === listener) {
        listeners.splice(i, 1);
      }
    }
  }

  function offAll(owner: object): void {
    for (let i = listeners.length - 1; i >= 0; i--) {
      if (listeners[i].owner === owner) {
        listeners.splice(i, 1);
      }
    }
  }

  function emit<K extends keyof RdEventMap>(event: K, ...args: RdEventMap[K]): void {
    const targets = listeners.filter((l) => l.event === event);
    for (const entry of targets) {
      try {
        entry.listener(...(args as unknown[]));
      } catch {
        // ignore listener errors
      }
    }
  }

  return { on, off, offAll, emit };
}

export function createRDContext(opts: {
  pluginId: string;
  manifest: PluginManifest;
  sdkVersion: string;
}): Partial<RDContext> {
  void opts.sdkVersion;
  const pluginId = opts.pluginId;
  return {
    pluginId: opts.pluginId,
    manifest: opts.manifest,
    ui: {
      registerToolbarButton: (option: ToolbarButtonOption) => {
        void assertPermission(opts.pluginId, 'ui.inject-menu')
          .then(() => {
            usePluginUiStore.getState().registerToolbarButton(pluginId, option, option.group ?? 'right');
          })
          .catch((e) => {
            console.warn(
              `[plugin:${pluginId}] registerToolbarButton blocked: ${e instanceof Error ? e.message : String(e)}`,
            );
          });
      },
      removeToolbarButton: (id: string) => {
        void assertPermission(opts.pluginId, 'ui.inject-menu')
          .then(() => {
            usePluginUiStore.getState().removeToolbarButton(id);
          })
          .catch((e) => {
            console.warn(
              `[plugin:${pluginId}] removeToolbarButton blocked: ${e instanceof Error ? e.message : String(e)}`,
            );
          });
      },
      registerSidebarAction: () => notImplemented(),
      removeSidebarAction: () => notImplemented(),
      registerFileContextMenu: () => notImplemented(),
      removeFileContextMenu: () => notImplemented(),
      registerSettingsSubTab: () => notImplemented(),
      removeSettingsSubTab: () => notImplemented(),
      registerRightPanel: () => notImplemented(),
      removeRightPanel: () => notImplemented(),
      notify: (kind, message) => {
        void assertPermission(opts.pluginId, 'ui.notification')
          .then(() => {
            if (!usePluginUiStore.getState().checkRateLimit(pluginId, 'notify')) {
              console.warn(`[plugin:${pluginId}] notify dropped due to rate limit`);
              return;
            }
            useToastStore.getState().push(kind, message);
          })
          .catch((e) => {
            console.warn(
              `[plugin:${pluginId}] notify blocked: ${e instanceof Error ? e.message : String(e)}`,
            );
          });
      },
      confirm: async (title: string, message: string): Promise<boolean> => {
        await assertPermission(opts.pluginId, 'ui.dialog');
        if (!usePluginUiStore.getState().checkRateLimit(pluginId, 'confirm')) {
          console.warn(`[plugin:${pluginId}] confirm dropped due to rate limit`);
          return false;
        }
        return new Promise<boolean>((resolve) => {
          const container = document.createElement('div');
          document.body.appendChild(container);
          const cleanup = () => {
            container.remove();
          };
          const root = createRoot(container);
          root.render(
            createElement(ConfirmDialog, {
              title,
              message,
              onConfirm: () => {
                cleanup();
                root.unmount();
                resolve(true);
              },
              onCancel: () => {
                cleanup();
                root.unmount();
                resolve(false);
              },
            }),
          );
        });
      },
      prompt: async (
        title: string,
        message: string,
        defaultValue?: string,
      ): Promise<string | null> => {
        await assertPermission(opts.pluginId, 'ui.dialog');
        if (!usePluginUiStore.getState().checkRateLimit(pluginId, 'prompt')) {
          console.warn(`[plugin:${pluginId}] prompt dropped due to rate limit`);
          return null;
        }
        return new Promise<string | null>((resolve) => {
          const container = document.createElement('div');
          document.body.appendChild(container);
          const cleanup = () => {
            container.remove();
          };
          const root = createRoot(container);
          root.render(
            createElement(PromptDialog, {
              title,
              message,
              defaultValue,
              onConfirm: (value: string) => {
                cleanup();
                root.unmount();
                resolve(value);
              },
              onCancel: () => {
                cleanup();
                root.unmount();
                resolve(null);
              },
            }),
          );
        });
      },
      openPluginConfig: () => notImplemented(),
      focusHost: () => notImplemented(),
      focusTerminal: () => notImplemented(),
      openRightPanel: () => notImplemented(),
      closeRightPanel: () => notImplemented(),
      openPluginView: (pluginId?: string) => {
        usePluginUiStore.getState().openPluginView(pluginId ?? opts.pluginId);
      },
      closePluginView: () => {
        usePluginUiStore.getState().closePluginView();
      },
    },
    storage: {
      get: async <T = unknown>(key: string): Promise<T | null> => {
        await assertPermission(opts.pluginId, 'storage.read');
        const val = await invoke<unknown | null>('plugin_storage_get', {
          pid: opts.pluginId,
          k: key,
        });
        return val as T | null;
      },
      set: async <T = unknown>(key: string, value: T): Promise<void> => {
        await assertPermission(opts.pluginId, 'storage.write');
        await invoke('plugin_storage_set', { pid: opts.pluginId, k: key, v: value });
      },
      remove: async (key: string): Promise<void> => {
        await assertPermission(opts.pluginId, 'storage.write');
        await invoke('plugin_storage_remove', { pid: opts.pluginId, k: key });
      },
      keys: async (): Promise<string[]> => {
        await assertPermission(opts.pluginId, 'storage.read');
        return await invoke<string[]>('plugin_storage_keys', { pid: opts.pluginId });
      },
      clear: async (): Promise<void> => {
        await assertPermission(opts.pluginId, 'storage.write');
        await invoke('plugin_storage_remove_all', { pid: opts.pluginId });
      },
    },
    // 以下分组暂未实现具体逻辑，但已加权限校验：
    // - ssh.* 需要 ssh.run
    // - sftp.* 需要 sftp.operate
    // - server 读操作需要 server.read，写操作需要 server.write，分类管理需要 server.manage
    // - http.* 需要 network.http
    // - tunnel.* 需要 tunnel.manage
    // - theme.* 需要 theme.read
    ssh: {
      exec: async (hostId: string, command: string, options?: SshExecOptions): Promise<CommandResult> => {
        await assertPermission(opts.pluginId, 'ssh.run');
        if (useUIStore.getState().pluginDisableAllSsh) {
          throw new Error('PERMISSION_DENIED: ssh.run disabled by global switch');
        }
        const state = useHostStore.getState().connectionStates[hostId];
        if (state !== 'connected') {
          throw new Error(`HOST_NOT_AVAILABLE: ${hostId} is ${state}`);
        }
        let finalCmd = command;
        const cwd = options?.cwd;
        if (cwd && cwd.trim()) {
          finalCmd = `cd ${shellEscape(cwd)} && ${command}`;
        }
        const timeoutMs = options?.timeoutMs ?? 30_000;
        let timedOut = false;
        const timeoutPromise = new Promise<never>((_, rej) => {
          setTimeout(() => {
            timedOut = true;
            rej(new Error('COMMAND_TIMEOUT: ssh exec timed out'));
          }, timeoutMs);
        });
        try {
          const logCmd = finalCmd.length > 200 ? finalCmd.slice(0, 200) + '...' : finalCmd;
          logInfo(`[plugin:${opts.pluginId}] ssh.exec ${hostId}: ${logCmd}`);
          const stdout: string = await Promise.race([
            invoke<string>('ssh_exec', { hostId, command: finalCmd }),
            timeoutPromise,
          ]);
          // 成功路径 stdout 不落日志：仅在返回值携带（前端可见），避免敏感输出进入日志
          return { success: true, output: stdout, exitCode: 0 };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (timedOut) {
            return { success: false, output: msg, exitCode: -1 };
          }
          const friendly = classifyConnectFailure(msg);
          // 失败日志脱敏：避免（哪怕是）命令 stdout/stderr 片段被打到日志里
          // 1) 截断原始错误信息到 300 字符；
          // 2) 遮蔽常见可能带 stdout 的片段（stdout: / stderr: / raw output: 等）
          let logMsg = msg.length > 300 ? msg.slice(0, 300) + `...(+${msg.length - 300}B)` : msg;
          logMsg = logMsg.replace(
            /((?:stdout|stderr|raw[_\- ]?output)\s*[:=]\s*)([^\n]{8,})/gi,
            (_m, prefix: string, body: string) =>
              `${prefix}<redacted len=${body.length}>`,
          );
          logWarn(`[plugin:${opts.pluginId}] ssh.exec 失败: ${friendly.headline} - ${logMsg}`);
          const outputHuman = `${friendly.headline}\n建议：${friendly.suggestion}\n（原始错误：${msg}）`;
          const match = /code (\d+)/.exec(msg);
          const exitCode = match ? Number(match[1]) : 1;
          return { success: false, output: outputHuman, exitCode };
        }
      },
      startShell: async () => {
        await assertPermission(opts.pluginId, 'ssh.run');
        return notImplementedAsync();
      },
      writeToTerminal: async () => {
        await assertPermission(opts.pluginId, 'ssh.run');
        return notImplementedAsync();
      },
      resizeTerminal: async () => {
        await assertPermission(opts.pluginId, 'ssh.run');
        return notImplementedAsync();
      },
      closeTerminal: async () => {
        await assertPermission(opts.pluginId, 'ssh.run');
        return notImplementedAsync();
      },
    },
    sftp: {
      list: async (hostId: string, path: string): Promise<SftpFile[]> => {
        await assertPermission(opts.pluginId, 'sftp.operate');
        if (useHostStore.getState().connectionStates[hostId] !== 'connected') {
          throw new Error(`HOST_NOT_AVAILABLE: ${hostId}`);
        }
        const entries = await invoke<Array<Record<string, unknown>>>('sftp_list_dir', { hostId, path });
        return entries.map((e) => {
          const name = String(e.name ?? '');
          const filePath = `${path}/${name}`.replace(/\/+/g, '/');
          const type = String(e.type ?? 'file');
          const isDir = type === 'dir' || type === 'directory';
          return {
            path: filePath,
            name,
            isDir,
            size: Number(e.size ?? 0),
            modifiedAt: Number(e.modifiedAt ?? e.modified_at ?? 0),
            permissions: e.permissions != null ? String(e.permissions) : undefined,
          };
        });
      },

      stat: async (hostId: string, path: string): Promise<SftpFile> => {
        await assertPermission(opts.pluginId, 'sftp.operate');
        if (useHostStore.getState().connectionStates[hostId] !== 'connected') {
          throw new Error(`HOST_NOT_AVAILABLE: ${hostId}`);
        }
        const e = await invoke<Record<string, unknown>>('sftp_stat', { hostId, path });
        const name = String(e.name ?? path.split('/').pop() ?? path);
        const type = String(e.type ?? 'file');
        const isDir = type === 'dir' || type === 'directory';
        return {
          path,
          name,
          isDir,
          size: Number(e.size ?? 0),
          modifiedAt: Number(e.modifiedAt ?? e.modified_at ?? 0),
          permissions: e.permissions != null ? String(e.permissions) : undefined,
        };
      },

      mkdir: async (hostId: string, path: string, recursive = false): Promise<void> => {
        await assertPermission(opts.pluginId, 'sftp.operate');
        if (useHostStore.getState().connectionStates[hostId] !== 'connected') {
          throw new Error(`HOST_NOT_AVAILABLE: ${hostId}`);
        }
        try {
          await invoke('sftp_mkdir', { hostId, path });
        } catch (e) {
          if (!recursive) throw e;
        }
      },

      remove: async (hostId: string, path: string, _recursive = false): Promise<void> => {
        await assertPermission(opts.pluginId, 'sftp.operate');
        if (useHostStore.getState().connectionStates[hostId] !== 'connected') {
          throw new Error(`HOST_NOT_AVAILABLE: ${hostId}`);
        }
        await invoke('sftp_remove', { hostId, path });
      },

      rename: async (hostId: string, oldPath: string, newPath: string): Promise<void> => {
        await assertPermission(opts.pluginId, 'sftp.operate');
        if (useHostStore.getState().connectionStates[hostId] !== 'connected') {
          throw new Error(`HOST_NOT_AVAILABLE: ${hostId}`);
        }
        await invoke('sftp_rename', { hostId, oldPath, newPath });
      },

      readFile: async (hostId: string, path: string): Promise<Uint8Array> => {
        await assertPermission(opts.pluginId, 'sftp.operate');
        if (useHostStore.getState().connectionStates[hostId] !== 'connected') {
          throw new Error(`HOST_NOT_AVAILABLE: ${hostId}`);
        }
        const bytes = await invoke<number[]>('sftp_read_file', { hostId, path });
        return new Uint8Array(bytes);
      },

      writeFile: async (hostId: string, path: string, data: Uint8Array | string): Promise<void> => {
        await assertPermission(opts.pluginId, 'sftp.operate');
        if (useHostStore.getState().connectionStates[hostId] !== 'connected') {
          throw new Error(`HOST_NOT_AVAILABLE: ${hostId}`);
        }
        const content: number[] = typeof data === 'string'
          ? Array.from(new TextEncoder().encode(data))
          : Array.from(data);
        await invoke('sftp_write_file', { hostId, path, content, overwrite: true });
      },

      upload: async (): Promise<TransferHandle> => {
        await assertPermission(opts.pluginId, 'sftp.operate');
        const taskId = `NOT_IMPLEMENTED_${Date.now()}`;
        return {
          taskId,
          abort: () => {},
          onProgress: () => {},
          finished: async () => 'error' as const,
        };
      },
      download: async (): Promise<TransferHandle> => {
        await assertPermission(opts.pluginId, 'sftp.operate');
        const taskId = `NOT_IMPLEMENTED_${Date.now()}`;
        return {
          taskId,
          abort: () => {},
          onProgress: () => {},
          finished: async () => 'error' as const,
        };
      },
    },
    server: {
      listAll: async (): Promise<HostConfigSafe[]> => {
        await assertPermission(opts.pluginId, 'server.read');
        const { hosts } = useHostStore.getState();
        return sanitizeHostConfigs(hosts);
      },

      get: async (hostId: string): Promise<HostConfigSafe | null> => {
        await assertPermission(opts.pluginId, 'server.read');
        const host = useHostStore.getState().hosts.find((h) => h.id === hostId);
        return host ? sanitizeHostConfig(host) : null;
      },

      getConnectionState: async (hostId: string): Promise<ConnectionState> => {
        await assertPermission(opts.pluginId, 'server.read');
        return useHostStore.getState().connectionStates[hostId] ?? 'disconnected';
      },

      listCategories: async (): Promise<CategoryConfig[]> => {
        await assertPermission(opts.pluginId, 'server.read');
        return useHostStore.getState().categories;
      },

      testConnection: async (hostId: string): Promise<ConnectResult> => {
        await assertPermission(opts.pluginId, 'server.manage');
        const ok = await useHostStore.getState().connectHost(hostId);
        if (!ok) throw new Error('CONNECT_FAILED');
        const state = useHostStore.getState();
        return {
          home_dir: state.homeDirs[hostId] ?? '',
          fingerprint: state.fingerprints[hostId] ?? '',
        };
      },

      add: async (host): Promise<HostConfig> => {
        await assertPermission(opts.pluginId, 'server.write');
        if (useUIStore.getState().pluginDisableAllServerWrite) {
          throw new Error('PERMISSION_DENIED: server.write disabled by global switch');
        }
        const { password, private_key, ...base } = host;
        const cred: { type: CredentialType; value: string } | undefined =
          password != null && password !== ''
            ? { type: 'password', value: password as string }
            : private_key != null && private_key !== ''
              ? { type: 'private_key', value: private_key as string }
              : undefined;
        const generatedId = `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const baseWithId = base as unknown as { id?: string };
        const config: HostConfig = {
          id: baseWithId.id ?? generatedId,
          name: base.name ?? '',
          host: base.host ?? '',
          port: base.port ?? 22,
          username: base.username ?? '',
          auth_type: base.auth_type ?? 'password',
          remember_dir: base.remember_dir ?? false,
          remark: base.remark ?? '',
          category_id: base.category_id ?? '',
          path_cache_id: base.path_cache_id,
        };
        await useHostStore.getState().addHost(config, cred);
        const saved = useHostStore
          .getState()
          .hosts.find((h) => h.id === config.id) ??
          useHostStore
            .getState()
            .hosts.find((h) => h.name === config.name && h.host === config.host);
        return saved as HostConfig;
      },

      update: async (hostId, patch): Promise<HostConfig> => {
        await assertPermission(opts.pluginId, 'server.write');
        if (useUIStore.getState().pluginDisableAllServerWrite) {
          throw new Error('PERMISSION_DENIED: server.write disabled by global switch');
        }
        const { password, private_key, ...base } = patch;
        const cred =
          password != null
            ? ({ type: 'password' as const, value: password as string } as const)
            : private_key != null
              ? ({ type: 'private_key' as const, value: private_key as string } as const)
              : undefined;
        const prev = useHostStore.getState().hosts.find((h) => h.id === hostId);
        if (!prev) throw new Error(`HOST_NOT_FOUND: ${hostId}`);
        const updated: HostConfig = { ...prev, ...base, id: hostId };
        await useHostStore.getState().updateHost(updated, cred);
        const saved = useHostStore.getState().hosts.find((h) => h.id === hostId);
        return saved as HostConfig;
      },

      remove: async (hostId): Promise<void> => {
        await assertPermission(opts.pluginId, 'server.write');
        if (useUIStore.getState().pluginDisableAllServerWrite) {
          throw new Error('PERMISSION_DENIED: server.write disabled by global switch');
        }
        await useHostStore.getState().removeHost(hostId);
      },

      addCategory: async (name, order): Promise<CategoryConfig> => {
        await assertPermission(opts.pluginId, 'server.write');
        if (useUIStore.getState().pluginDisableAllServerWrite) {
          throw new Error('PERMISSION_DENIED: server.write disabled by global switch');
        }
        const id = `cat_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
        const cat: CategoryConfig = { id, name, order: order ?? 0 };
        try {
          await useHostStore.getState().saveCategory(cat);
        } catch {
          /* ignore */
        }
        return cat;
      },

      updateCategory: async (catId, patch): Promise<CategoryConfig> => {
        await assertPermission(opts.pluginId, 'server.write');
        if (useUIStore.getState().pluginDisableAllServerWrite) throw new Error('PERMISSION_DENIED');
        const prev = useHostStore.getState().categories.find((c) => c.id === catId);
        if (!prev) throw new Error(`CATEGORY_NOT_FOUND: ${catId}`);
        const updated = { ...prev, ...patch };
        try {
          await useHostStore.getState().saveCategory(updated);
        } catch {
          /* ignore */
        }
        return updated;
      },

      removeCategory: async (catId): Promise<void> => {
        await assertPermission(opts.pluginId, 'server.write');
        if (useUIStore.getState().pluginDisableAllServerWrite) throw new Error('PERMISSION_DENIED');
        try {
          await useHostStore.getState().deleteCategory(catId);
        } catch {
          /* ignore */
        }
      },

      connect: async (hostId) => {
        await assertPermission(opts.pluginId, 'server.manage');
        await useHostStore.getState().connectHost(hostId);
      },
      disconnect: async (hostId) => {
        await assertPermission(opts.pluginId, 'server.manage');
        await useHostStore.getState().disconnectHost(hostId);
      },
      cancelReconnect: (hostId) => {
        void assertPermission(opts.pluginId, 'server.manage').catch(() => {});
        useHostStore.getState().cancelReconnect(hostId);
      },
    },
    http: {
      request: async <T = unknown>(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse<T>> => {
        await assertPermission(opts.pluginId, 'network.http');
        const { method = 'GET', headers, body, timeoutMs = 15_000 } = options;
        let bodyStr: string | undefined;
        if (body != null) {
          if (typeof body === 'string') bodyStr = body;
          else if (body instanceof Uint8Array) bodyStr = Array.from(body).join(',');
          else if (typeof body === 'object') {
            try { bodyStr = JSON.stringify(body); } catch { bodyStr = String(body); }
          } else { bodyStr = String(body); }
        }
        const allowInternal = useUIStore.getState().pluginAllowInternalHttp;
        const dto = await invoke<{
          status: number;
          status_text: string;
          headers: Record<string, string>;
          body: unknown;
          ok: boolean;
        }>('plugin_http_request', {
          id: opts.pluginId,
          url,
          method,
          headers,
          body: bodyStr,
          timeoutMs,
          allowInternal,
        });
        return {
          status: dto.status,
          statusText: dto.status_text,
          headers: dto.headers,
          data: dto.body as T,
          ok: dto.ok,
        };
      },
      get: async <T = unknown>(url: string, headers?: Record<string, string>): Promise<HttpResponse<T>> => {
        await assertPermission(opts.pluginId, 'network.http');
        const allowInternal = useUIStore.getState().pluginAllowInternalHttp;
        const dto = await invoke<{
          status: number;
          status_text: string;
          headers: Record<string, string>;
          body: unknown;
          ok: boolean;
        }>('plugin_http_request', {
          id: opts.pluginId,
          url,
          method: 'GET',
          headers,
          timeoutMs: 15_000,
          allowInternal,
        });
        return {
          status: dto.status,
          statusText: dto.status_text,
          headers: dto.headers,
          data: dto.body as T,
          ok: dto.ok,
        };
      },
      post: async <T = unknown>(url: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResponse<T>> => {
        await assertPermission(opts.pluginId, 'network.http');
        let bodyStr: string | undefined;
        if (body != null) {
          if (typeof body === 'string') bodyStr = body;
          else if (body instanceof Uint8Array) bodyStr = Array.from(body).join(',');
          else if (typeof body === 'object') {
            try { bodyStr = JSON.stringify(body); } catch { bodyStr = String(body); }
          } else { bodyStr = String(body); }
        }
        const allowInternal = useUIStore.getState().pluginAllowInternalHttp;
        const dto = await invoke<{
          status: number;
          status_text: string;
          headers: Record<string, string>;
          body: unknown;
          ok: boolean;
        }>('plugin_http_request', {
          id: opts.pluginId,
          url,
          method: 'POST',
          headers,
          body: bodyStr,
          timeoutMs: 15_000,
          allowInternal,
        });
        return {
          status: dto.status,
          statusText: dto.status_text,
          headers: dto.headers,
          data: dto.body as T,
          ok: dto.ok,
        };
      },
      put: async <T = unknown>(url: string, body?: unknown, headers?: Record<string, string>): Promise<HttpResponse<T>> => {
        await assertPermission(opts.pluginId, 'network.http');
        let bodyStr: string | undefined;
        if (body != null) {
          if (typeof body === 'string') bodyStr = body;
          else if (body instanceof Uint8Array) bodyStr = Array.from(body).join(',');
          else if (typeof body === 'object') {
            try { bodyStr = JSON.stringify(body); } catch { bodyStr = String(body); }
          } else { bodyStr = String(body); }
        }
        const allowInternal = useUIStore.getState().pluginAllowInternalHttp;
        const dto = await invoke<{
          status: number;
          status_text: string;
          headers: Record<string, string>;
          body: unknown;
          ok: boolean;
        }>('plugin_http_request', {
          id: opts.pluginId,
          url,
          method: 'PUT',
          headers,
          body: bodyStr,
          timeoutMs: 15_000,
          allowInternal,
        });
        return {
          status: dto.status,
          statusText: dto.status_text,
          headers: dto.headers,
          data: dto.body as T,
          ok: dto.ok,
        };
      },
      delete: async <T = unknown>(url: string, headers?: Record<string, string>): Promise<HttpResponse<T>> => {
        await assertPermission(opts.pluginId, 'network.http');
        const allowInternal = useUIStore.getState().pluginAllowInternalHttp;
        const dto = await invoke<{
          status: number;
          status_text: string;
          headers: Record<string, string>;
          body: unknown;
          ok: boolean;
        }>('plugin_http_request', {
          id: opts.pluginId,
          url,
          method: 'DELETE',
          headers,
          timeoutMs: 15_000,
          allowInternal,
        });
        return {
          status: dto.status,
          statusText: dto.status_text,
          headers: dto.headers,
          data: dto.body as T,
          ok: dto.ok,
        };
      },
    },
    tunnel: {
      listRules: async (hostId) => {
        await assertPermission(opts.pluginId, 'tunnel.manage');
        const arr = await invoke<Record<string, unknown>[]>('tunnel_list_rules', { hostId });
        return arr.map(mapRuleDto);
      },
      getRule: async (tunnelId) => {
        await assertPermission(opts.pluginId, 'tunnel.manage');
        const all = await invoke<Record<string, unknown>[]>('tunnel_list_rules', { hostId: undefined });
        const found = all.find(r => String(r.id ?? r.tunnel_id) === tunnelId);
        return found ? mapRuleDto(found) : null;
      },
      addRule: async (rule, options) => {
        await assertPermission(opts.pluginId, 'tunnel.manage');
        const allowRemote = options?.allowRemote ?? useUIStore.getState().tunnelAllowRemoteForwarding;
        const confirmListenAll = options?.confirmListenAll ?? useUIStore.getState().tunnelConfirmListenAllLast;
        // Rust TunnelRuleDto 为 serde camelCase，直接传 camelCase 键
        const dto = {
          id: `tunnel_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
          hostId: rule.hostId,
          mode: rule.mode,
          localAddr: rule.localAddr,
          localPort: rule.localPort,
          remoteAddr: rule.remoteAddr,
          remotePort: rule.remotePort,
          autoStart: rule.autoStart,
          tags: rule.tags,
          comment: rule.comment,
          createdAt: Date.now(),
        };
        const saved = await invoke<Record<string, unknown>>('tunnel_add_rule', {
          rule: dto,
          confirmListenAll,
          allowRemote,
        });
        logInfo(`[plugin:${opts.pluginId}] tunnel.addRule ${saved.id} mode=${rule.mode}`);
        return mapRuleDto(saved);
      },
      updateRule: async (tunnelId, patch, options) => {
        await assertPermission(opts.pluginId, 'tunnel.manage');
        // Rust tunnel_update_rule 接收完整规则对象（camelCase），先拉取原规则合并 patch
        const all = await invoke<Record<string, unknown>[]>('tunnel_list_rules', { hostId: undefined });
        const found = all.find(r => String(r.id ?? '') === tunnelId);
        if (!found) {
          throw new Error(`RULE_NOT_FOUND: ${tunnelId}`);
        }
        const merged = { ...found, ...patch };
        const allowRemote = options?.allowRemote ?? useUIStore.getState().tunnelAllowRemoteForwarding;
        const confirmListenAll = options?.confirmListenAll ?? useUIStore.getState().tunnelConfirmListenAllLast;
        const saved = await invoke<Record<string, unknown>>('tunnel_update_rule', {
          rule: merged,
          confirmListenAll,
          allowRemote,
        });
        logInfo(`[plugin:${opts.pluginId}] tunnel.updateRule ${tunnelId}`);
        return mapRuleDto(saved);
      },
      removeRule: async (tunnelId) => {
        await assertPermission(opts.pluginId, 'tunnel.manage');
        try {
          await invoke('tunnel_stop', { ruleId: tunnelId });
        } catch (_) { /* 没在运行忽略 */ }
        await invoke('tunnel_remove_rule', { ruleId: tunnelId });
        logInfo(`[plugin:${opts.pluginId}] tunnel.removeRule ${tunnelId}`);
      },
      start: async (tunnelId, options) => {
        await assertPermission(opts.pluginId, 'tunnel.manage');
        const allowRemote = options?.allowRemote ?? useUIStore.getState().tunnelAllowRemoteForwarding;
        const confirmListenAll = options?.confirmListenAll ?? useUIStore.getState().tunnelConfirmListenAllLast;
        const dto = await invoke<Record<string, unknown>>('tunnel_start', {
          ruleId: tunnelId,
          confirmListenAll,
          allowRemote,
        });
        logInfo(`[plugin:${opts.pluginId}] tunnel.start ${tunnelId} -> running=${dto.running}`);
        return mapStatusDto(dto);
      },
      stop: async (tunnelId) => {
        await assertPermission(opts.pluginId, 'tunnel.manage');
        await invoke('tunnel_stop', { ruleId: tunnelId });
        logInfo(`[plugin:${opts.pluginId}] tunnel.stop ${tunnelId}`);
      },
      stopAllForHost: async (hostId, reason = 'host-reconnecting') => {
        await assertPermission(opts.pluginId, 'tunnel.manage');
        const stopped = await invoke<string[]>('tunnel_stop_all_for_host', { hostId, reason });
        logInfo(`[plugin:${opts.pluginId}] tunnel.stopAllForHost ${hostId} count=${stopped.length}`);
        return stopped;
      },
      getStatus: async (tunnelId) => {
        await assertPermission(opts.pluginId, 'tunnel.manage');
        const all = await invoke<Record<string, unknown>[]>('tunnel_list_statuses', { hostId: undefined });
        const found = all.find(s => String(s.tunnel_id ?? s.tunnelId) === tunnelId);
        return found ? mapStatusDto(found) : null;
      },
      listStatuses: async (hostId) => {
        await assertPermission(opts.pluginId, 'tunnel.manage');
        const arr = await invoke<Record<string, unknown>[]>('tunnel_list_statuses', { hostId });
        return arr.map(mapStatusDto);
      },
      exportRules: async (): Promise<RdTunnelsFile> => {
        await assertPermission(opts.pluginId, 'tunnel.manage');
        const json = await invoke<string>('tunnel_export_rules');
        const parsed = JSON.parse(json) as Record<string, unknown>;
        return {
          $schema: String(parsed.$schema ?? RD_TUNNELS_SCHEMA_URL) as RdTunnelsFile['$schema'],
          specVersion: String(parsed.specVersion ?? '1.0') as RdTunnelsFile['specVersion'],
          exportTime: Number(parsed.exportTime ?? Date.now()),
          exportedBy: String(parsed.exportedBy ?? 'rd-app 0.1.94'),
          rules: (parsed.rules as unknown[]).map(r => mapRuleDto(r as Record<string, unknown>)),
        };
      },
      importRules: async (file: RdTunnelsFile, onConflict: TunnelConflictStrategy = 'skip'): Promise<TunnelImportResult> => {
        await assertPermission(opts.pluginId, 'tunnel.manage');
        // RdTunnelsFile 为 serde camelCase，字段保持 camelCase 序列化
        const payload = JSON.stringify(file);
        const dto = await invoke<Record<string, unknown>>('tunnel_import_rules', {
          jsonContent: payload,
          onConflict,
        });
        const rules = (dto.rules as unknown[]).map(r => mapRuleDto(r as Record<string, unknown>));
        logInfo(`[plugin:${opts.pluginId}] tunnel.importRules imported=${dto.imported} skipped=${dto.skipped} overwritten=${dto.overwritten} renamed=${dto.renamed}`);
        return {
          imported: Number(dto.imported ?? 0),
          skipped: Number(dto.skipped ?? 0),
          overwritten: Number(dto.overwritten ?? 0),
          renamed: Number(dto.renamed ?? 0),
          rules,
        };
      },
    },
    theme: {
      getCurrent: async () => {
        await assertPermission(opts.pluginId, 'theme.read');
        return getCurrentThemeInfo() as unknown as ThemeInfo;
      },
      listAll: async () => {
        await assertPermission(opts.pluginId, 'theme.read');
        return listAllThemeInfos() as unknown as ThemeInfo[];
      },
      get: async (themeId) => {
        await assertPermission(opts.pluginId, 'theme.read');
        const all = listAllThemeInfos();
        const found = all.find(t => t.id === themeId);
        return (found ?? null) as unknown as ThemeInfo | null;
      },
      apply: async (themeId) => {
        await assertPermission(opts.pluginId, 'theme.read');
        const currentIds = [
          ...PRESET_OPTIONS.map(o => o.id),
          ...useThemeStore.getState().customThemes.map(t => t.id),
          'system',
        ];
        if (!currentIds.includes(themeId)) throw new Error(`THEME_NOT_FOUND: ${themeId}`);
        useThemeStore.getState().setTheme(themeId);
      },
    },
    log: {
      info: (msg: string, ...args: unknown[]) => {
        void args;
        logInfo(`[plugin:${pluginId}] ${msg}`);
        usePluginUiStore.getState().addLog(pluginId, 'info', msg);
      },
      warn: (msg: string, ...args: unknown[]) => {
        void args;
        logWarn(`[plugin:${pluginId}] ${msg}`);
        usePluginUiStore.getState().addLog(pluginId, 'warn', msg);
      },
      error: (msg: string, ...args: unknown[]) => {
        void args;
        logError(`[plugin:${pluginId}] ${msg}`);
        usePluginUiStore.getState().addLog(pluginId, 'error', msg);
        useToastStore.getState().push('error', `[plugin:${pluginId}] ${msg}`, 5000);
      },
    },
  };
}
