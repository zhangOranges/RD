import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { PluginManifest, PluginCategory, TunnelErrorCode, TunnelStatus } from '../types/plugin';
import { pluginLifecycleManager } from '../utils/pluginLifecycleManager';
import { kernelEventBus } from '../utils/eventBus';
import { mapStatusDto } from '../utils/pluginSdk';
import { useUIStore } from './uiStore';
import { usePluginUiStore } from './pluginUiStore';

export interface PluginInfo {
  id: string;
  version: string;
  name: string;
  description: string;
  author: string;
  category: string;
  apiVersion: string;
  minRdVersion: string;
  enabled: boolean;
  installTimeMs: number;
  lastLoadTimeMs: number;
  grantedPermissions: string[];
  config: Record<string, unknown>;
  loadError?: string | null;
  manifestPath?: string;
  manifest: PluginManifest;
}

interface PluginStoreState {
  plugins: PluginInfo[];
  loading: boolean;
  error: string | null;
}

interface PluginStoreActions {
  loadPlugins: () => Promise<void>;
  togglePlugin: (id: string, enabled: boolean) => Promise<void>;
  uninstallPlugin: (id: string) => Promise<void>;
  installFromDir: (dirPath: string) => Promise<PluginInfo | null>;
  installFromFile: (zipPath: string) => Promise<PluginInfo | null>;
  uninstallComplete: (id: string) => Promise<void>;
  startHotReload: () => Promise<void>;
  stopHotReload: () => Promise<void>;
  reloadPlugin: (pluginId: string) => Promise<boolean>;
  getConfig: (id: string) => Promise<Record<string, unknown>>;
  setConfig: (id: string, config: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getGranted: (id: string) => Promise<string[]>;
  setGranted: (id: string, perms: string[]) => Promise<string[]>;
  getPlugin: (id: string) => PluginInfo | null;
}

export type PluginStore = PluginStoreState & PluginStoreActions;

function str(v: unknown, fallback = ''): string {
  return v === undefined || v === null ? fallback : String(v);
}

function bool(v: unknown, fallback = false): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function arrStr(v: unknown): string[] {
  return Array.isArray(v) ? (v as string[]) : [];
}

function objRec(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v ? (v as Record<string, unknown>) : {};
}

function manifestFromRaw(rawManifest: unknown): PluginManifest {
  const m = objRec(rawManifest);
  const id = str(m.id ?? m.plugin_id);
  const name = str(m.name ?? id);
  const version = str(m.version ?? '0.0.0');
  const apiVersion = str(m.apiVersion ?? m.api_version ?? 'v1') as 'v1';
  const author = str(m.author);
  const description = str(m.description);
  const category = (str(m.category, 'other') as PluginCategory) || 'other';
  const entry = str(m.entry);
  const indexHtmlRaw = m.indexHtml ?? m.index_html;
  const indexHtml = indexHtmlRaw == null ? '' : String(indexHtmlRaw);
  const configSchema =
    m.configSchema ?? m.config_schema != null
      ? (objRec(m.configSchema ?? m.config_schema) as Record<string, unknown>)
      : undefined;
  const icon = m.icon != null ? str(m.icon) : undefined;
  const permissions = arrStr(m.permissions) as PluginManifest['permissions'];
  const conflict = m.conflict != null ? arrStr(m.conflict) : undefined;
  const requires = m.requires != null ? arrStr(m.requires) : undefined;
  const minRdVersion = str(m.minRdVersion ?? m.min_rd_version ?? '0.1.0');
  const hotReload = bool(m.hotReload ?? m.hot_reload, false);
  const homepage = m.homepage != null ? str(m.homepage) : undefined;
  const license = m.license != null ? str(m.license) : undefined;
  return {
    id,
    name,
    version,
    apiVersion,
    author,
    description,
    category,
    entry,
    indexHtml,
    configSchema,
    icon,
    permissions,
    conflict,
    requires,
    minRdVersion,
    hotReload,
    homepage,
    license,
  };
}

function mapPluginInfo(r: Record<string, unknown>): PluginInfo {
  const manifest = manifestFromRaw(r.manifest);
  return {
    id: manifest.id || str(r.id ?? r.plugin_id),
    version: manifest.version || str(r.version),
    name: manifest.name || str(r.name),
    description: manifest.description || str(r.description),
    author: manifest.author || str(r.author),
    category: manifest.category || str(r.category ?? 'other'),
    apiVersion: manifest.apiVersion || str(r.api_version ?? r.apiVersion ?? 'v1'),
    minRdVersion: manifest.minRdVersion || str(r.min_rd_version ?? r.minRdVersion ?? ''),
    enabled: Boolean(r.enabled ?? false),
    installTimeMs: Number(r.install_time_ms ?? r.installTimeMs ?? 0),
    lastLoadTimeMs: Number(r.last_load_time_ms ?? r.lastLoadTimeMs ?? 0),
    grantedPermissions: Array.isArray(r.granted_permissions ?? r.grantedPermissions)
      ? ((r.granted_permissions ?? r.grantedPermissions) as string[])
      : [],
    config: typeof r.config === 'object' && r.config ? (r.config as Record<string, unknown>) : {},
    loadError: (r.load_error as string) ?? (r.loadError as string) ?? null,
    manifestPath: r.manifest_path != null ? String(r.manifest_path) : undefined,
    manifest,
  };
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  plugins: [],
  loading: false,
  error: null,

  loadPlugins: async () => {
    set({ loading: true, error: null });
    try {
      const raw = await invoke<Record<string, unknown>[]>('plugin_list');
      const plugins: PluginInfo[] = raw.map((r) => mapPluginInfo(r));
      set({ plugins });
    } catch (e) {
      set({ error: formatErr(e) });
    } finally {
      set({ loading: false });
    }
  },

  togglePlugin: async (id, enabled) => {
    try {
      await invoke('plugin_toggle', { id, enabled });
    } catch (e) {
      set({ error: formatErr(e) });
      throw e;
    }
    await get().loadPlugins();
    const enabledList = get()
      .plugins.filter((p) => p.enabled)
      .map((p) => ({ id: p.id, manifest: p.manifest }));
    pluginLifecycleManager
      .setDesiredPlugins(enabledList)
      .catch((e) => console.warn('[pluginStore] lifecycle 同步失败', e));
  },

  uninstallPlugin: async (id) => {
    try {
      await invoke('plugin_uninstall', { id });
    } catch (e) {
      set({ error: formatErr(e) });
      throw e;
    }
    await get().loadPlugins();
    const enabledList = get()
      .plugins.filter((p) => p.enabled)
      .map((p) => ({ id: p.id, manifest: p.manifest }));
    pluginLifecycleManager
      .setDesiredPlugins(enabledList)
      .catch((e) => console.warn('[pluginStore] lifecycle 同步失败', e));
  },

  installFromDir: async (dirPath) => {
    try {
      const info = await invoke<Record<string, unknown>>('plugin_install_from_dir', { dirPath });
      await get().loadPlugins();
      const enabledList = get()
        .plugins.filter((p) => p.enabled)
        .map((p) => ({ id: p.id, manifest: p.manifest }));
      pluginLifecycleManager
        .setDesiredPlugins(enabledList)
        .catch((e) => console.warn('[pluginStore] lifecycle 同步失败', e));
      return mapPluginInfo(info);
    } catch (e) {
      set({ error: formatErr(e) });
      throw e;
    }
  },

  installFromFile: async (zipPath) => {
    try {
      const info = await invoke<Record<string, unknown>>('plugin_install_from_file', { zipPath });
      await get().loadPlugins();
      const enabledList = get()
        .plugins.filter((p) => p.enabled)
        .map((p) => ({ id: p.id, manifest: p.manifest }));
      pluginLifecycleManager
        .setDesiredPlugins(enabledList)
        .catch((e) => console.warn('[pluginStore] lifecycle 同步失败', e));
      return mapPluginInfo(info);
    } catch (e) {
      set({ error: formatErr(e) });
      throw e;
    }
  },

  uninstallComplete: async (id) => {
    try {
      await invoke('plugin_uninstall_complete', { id });
    } catch (e) {
      set({ error: formatErr(e) });
      throw e;
    }
    await get().loadPlugins();
    const enabledList = get()
      .plugins.filter((p) => p.enabled)
      .map((p) => ({ id: p.id, manifest: p.manifest }));
    pluginLifecycleManager
      .setDesiredPlugins(enabledList)
      .catch((e) => console.warn('[pluginStore] lifecycle 同步失败', e));
  },

  startHotReload: async () => {
    try {
      await invoke('plugin_start_hot_reload');
    } catch (e) {
      console.warn('[pluginStore] startHotReload 失败', e);
    }
  },

  stopHotReload: async () => {
    try {
      await invoke('plugin_stop_hot_reload');
    } catch (e) {
      console.warn('[pluginStore] stopHotReload 失败', e);
    }
  },

  reloadPlugin: async (pluginId) => {
    const plugin = get().getPlugin(pluginId);
    if (!plugin) {
      console.warn(`[pluginStore] reloadPlugin: 插件不存在 ${pluginId}`);
      return false;
    }
    if (!plugin.manifest.hotReload) {
      console.log(`[pluginStore] skip hot reload for ${pluginId}: hotReload=false`);
      return false;
    }

    const wasEnabled = plugin.enabled;

    try {
      // Step 1-2: disable + destroy 旧实例
      await pluginLifecycleManager.destroyPlugin(pluginId);

      // Step 3: 重新加载 store（获取最新 manifest）
      await get().loadPlugins();
      const updated = get().getPlugin(pluginId);
      if (!updated) {
        throw new Error(`插件 ${pluginId} 重新加载后未找到`);
      }

      // Step 4-5: 如果之前 enabled，重新 mount + init + enable
      if (wasEnabled || updated.enabled) {
        const enabledList = get()
          .plugins.filter((p) => p.enabled)
          .map((p) => ({ id: p.id, manifest: p.manifest }));
        await pluginLifecycleManager.setDesiredPlugins(enabledList);
      }

      // Step 6: 日志
      usePluginUiStore
        .getState()
        .addLog(pluginId, 'info', `插件 ${updated.name} 已热重载`);
      return true;
    } catch (e) {
      console.error(`[pluginStore] reloadPlugin 失败 ${pluginId}:`, e);
      usePluginUiStore
        .getState()
        .addLog(
          pluginId,
          'error',
          `热重载失败: ${e instanceof Error ? e.message : String(e)}`,
        );
      return false;
    }
  },

  getConfig: async (id) => {
    try {
      return await invoke<Record<string, unknown>>('plugin_get_config', { id });
    } catch {
      return {};
    }
  },

  setConfig: async (id, config) => {
    return await invoke<Record<string, unknown>>('plugin_set_config', { id, config });
  },

  getGranted: async (id) => {
    try {
      return await invoke<string[]>('plugin_get_granted', { id });
    } catch {
      return [];
    }
  },

  setGranted: async (id, perms) => {
    return await invoke<string[]>('plugin_set_granted', { id, perms });
  },

  getPlugin: (id) => {
    return get().plugins.find((p) => p.id === id) ?? null;
  },
}));

// ---- 模块级 Tauri 事件监听（热重载 + 卸载 + 隧道事件 + autoStart）----
let hotReloadUnlisten: (() => void) | null = null;
let uninstalledUnlisten: (() => void) | null = null;
let tunnelEventRegistered = false;
let _tunnelUnlisteners: Array<() => void> = [];
let autoStartEventRegistered = false;
let _autoStartUnlisteners: Array<() => void> = [];

async function autoStartTunnelsForHost(hostId: string) {
  try {
    const rules = await invoke<Record<string, unknown>[]>('tunnel_list_rules', { hostId });
    const autoRules = rules.filter(r => Boolean(r.auto_start ?? r.autoStart));
    const allowRemote = useUIStore.getState().tunnelAllowRemoteForwarding;
    const confirmAll = useUIStore.getState().tunnelConfirmListenAllLast;
    await Promise.allSettled(autoRules.map(async (r) => {
      try {
        const tid = String(r.id ?? '');
        await invoke('tunnel_start', { tunnelId: tid, confirmListenAll: confirmAll, allowRemote });
      } catch (e) {
        console.warn(`[pluginStore] autoStart 失败 host=${hostId}: ${e}`);
      }
    }));
  } catch (e) {
    console.warn('[pluginStore] autoStartTunnelsForHost 异常', e);
  }
}

/**
 * 初始化插件相关的 Tauri 事件监听器。
 * - `plugin:hot-reload`：收到后延迟 300ms 再执行 reloadPlugin（等文件写入完成）
 * - `plugin:uninstalled`：收到后刷新插件列表
 * - tunnel:* 4 事件：转发到 kernelEventBus
 * - autoStart：监听 connection:success / reconnect-success → 启动 autoStart=true 的规则
 * 重复调用安全（已注册则跳过）。
 */
export async function initPluginEventListeners(): Promise<void> {
  if (!hotReloadUnlisten) {
    hotReloadUnlisten = await listen<string>('plugin:hot-reload', async (event) => {
      const pluginId = event.payload;
      console.log(`[pluginStore] 收到热重载事件: ${pluginId}`);
      // 延迟 300ms 等文件写入完成
      await new Promise((r) => setTimeout(r, 300));
      await usePluginStore.getState().reloadPlugin(pluginId);
    });

    uninstalledUnlisten = await listen<string>('plugin:uninstalled', async (event) => {
      const pluginId = event.payload;
      console.log(`[pluginStore] 收到卸载事件: ${pluginId}`);
      await usePluginStore.getState().loadPlugins();
    });
  }

  if (!tunnelEventRegistered) {
    const unlistenStart = await listen<Record<string, unknown>>('tunnel:start', (event) => {
      const status: TunnelStatus = mapStatusDto(event.payload);
      kernelEventBus.emit('tunnel:start', String(event.payload.tunnel_id ?? event.payload.tunnelId ?? ''), status);
    });
    const unlistenStop = await listen<Record<string, unknown>>('tunnel:stop', (event) => {
      const tid = String(event.payload.tunnelId ?? event.payload.tunnel_id ?? '');
      const reason = String(event.payload.reason ?? 'manual') as 'manual' | 'host-close' | 'host-reconnecting' | 'uninstall';
      kernelEventBus.emit('tunnel:stop', tid, reason);
    });
    const unlistenError = await listen<Record<string, unknown>>('tunnel:error', (event) => {
      const tid = String(event.payload.tunnelId ?? event.payload.tunnel_id ?? '');
      const code = String(event.payload.code ?? 'SSH_CHANNEL_ERROR') as TunnelErrorCode;
      const msg = String(event.payload.message ?? event.payload.msg ?? '');
      kernelEventBus.emit('tunnel:error', tid, code, msg);
    });
    const unlistenConn = await listen<Record<string, unknown>>('tunnel:connection', (event) => {
      const tid = String(event.payload.tunnelId ?? event.payload.tunnel_id ?? '');
      const peer = String(event.payload.peerAddr ?? event.payload.peer_addr ?? '');
      const port = Number(event.payload.peerPort ?? event.payload.peer_port ?? 0);
      kernelEventBus.emit('tunnel:connection', tid, peer, port);
    });
    _tunnelUnlisteners = [unlistenStart, unlistenStop, unlistenError, unlistenConn];
    tunnelEventRegistered = true;
  }

  if (!autoStartEventRegistered) {
    const connHandler = async (hostId: string) => {
      await autoStartTunnelsForHost(hostId);
    };
    const reconnHandler = async (hostId: string) => {
      await autoStartTunnelsForHost(hostId);
    };
    kernelEventBus.on('connection:success', connHandler);
    kernelEventBus.on('connection:reconnect-success', reconnHandler);
    _autoStartUnlisteners = [
      () => kernelEventBus.off('connection:success', connHandler),
      () => kernelEventBus.off('connection:reconnect-success', reconnHandler),
    ];
    autoStartEventRegistered = true;
  }
}

/**
 * 清理插件事件监听器（应用退出或不再需要热重载时调用）。
 */
export function cleanupPluginEventListeners(): void {
  hotReloadUnlisten?.();
  uninstalledUnlisten?.();
  hotReloadUnlisten = null;
  uninstalledUnlisten = null;
  _tunnelUnlisteners.forEach(u => u && u());
  _tunnelUnlisteners = [];
  tunnelEventRegistered = false;
  _autoStartUnlisteners.forEach(u => u && u());
  _autoStartUnlisteners = [];
  autoStartEventRegistered = false;
}
