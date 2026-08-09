import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  HostConfig,
  CategoryConfig,
  ConnectParams,
  ConnectResult,
  ConnectionState,
  CredentialType,
} from '../types';
import { useToastStore } from '../components/Toast';

interface HostState {
  hosts: HostConfig[];
  categories: CategoryConfig[];
  // 已展开的分类 id 集合
  expandedCategories: Set<string>;
  selectedHostId: string | null;
  connectionStates: Record<string, ConnectionState>;
  homeDirs: Record<string, string>;
  fingerprints: Record<string, string>;
  _unlistenFn: UnlistenFn | null;

  loadHosts: () => Promise<void>;
  loadCategories: () => Promise<void>;
  saveCategory: (cat: CategoryConfig) => Promise<void>;
  deleteCategory: (id: string) => Promise<void>;
  toggleCategory: (id: string) => void;
  // 持久化展开状态
  persistExpanded: () => Promise<void>;

  addHost: (config: HostConfig, credential?: { type: CredentialType; value: string }) => Promise<void>;
  updateHost: (
    config: HostConfig,
    credential?: { type: CredentialType; value: string },
  ) => Promise<void>;
  removeHost: (id: string) => Promise<void>;
  selectHost: (id: string | null) => void;
  setConnectionState: (id: string, state: ConnectionState) => void;

  connectHost: (id: string) => Promise<void>;
  disconnectHost: (id: string) => Promise<void>;
  initEventListeners: () => Promise<void>;
  teardownEventListeners: () => Promise<void>;
}

const DISCONNECTED: ConnectionState = 'disconnected';
const CONNECTING: ConnectionState = 'connecting';
const CONNECTED: ConnectionState = 'connected';

export const useHostStore = create<HostState>((set, get) => ({
  hosts: [],
  categories: [],
  expandedCategories: new Set(['default']),
  selectedHostId: null,
  connectionStates: {},
  homeDirs: {},
  fingerprints: {},
  _unlistenFn: null,

  loadHosts: async () => {
    try {
      const list = await invoke<HostConfig[]>('list_hosts');
      set({ hosts: list ?? [] });
    } catch (err) {
      useToastStore.getState().push('error', `加载主机列表失败：${formatErr(err)}`);
      set({ hosts: [] });
    }
  },

  loadCategories: async () => {
    try {
      const list = await invoke<CategoryConfig[]>('list_categories');
      set({ categories: list ?? [] });
      // 恢复持久化的展开状态
      try {
        const saved = await invoke<string>('get_setting', { key: 'sidebar_expanded_categories' });
        if (saved) {
          const arr = JSON.parse(saved) as string[];
          set({ expandedCategories: new Set(arr) });
        }
      } catch {
        // ignore: no saved state
      }
    } catch (err) {
      useToastStore.getState().push('error', `加载分类失败：${formatErr(err)}`);
      set({ categories: [] });
    }
  },

  saveCategory: async (cat) => {
    await invoke('save_category', { cat });
    set((s) => {
      const idx = s.categories.findIndex((c) => c.id === cat.id);
      const next = [...s.categories];
      if (idx >= 0) next[idx] = cat;
      else next.push(cat);
      next.sort((a, b) => a.order - b.order);
      return { categories: next };
    });
  },

  deleteCategory: async (id) => {
    await invoke('delete_category', { id });
    set((s) => ({
      categories: s.categories.filter((c) => c.id !== id),
      expandedCategories: (() => {
        const next = new Set(s.expandedCategories);
        next.delete(id);
        return next;
      })(),
    }));
    // 将该分类下的主机迁移到 default
    set((s) => ({
      hosts: s.hosts.map((h) => (h.category_id === id ? { ...h, category_id: 'default' } : h)),
    }));
  },

  toggleCategory: (id) => {
    set((s) => {
      const next = new Set(s.expandedCategories);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { expandedCategories: next };
    });
    void get().persistExpanded();
  },

  persistExpanded: async () => {
    const { expandedCategories } = get();
    const arr = Array.from(expandedCategories);
    try {
      await invoke('set_setting', { key: 'sidebar_expanded_categories', value: JSON.stringify(arr) });
    } catch {
      // ignore
    }
  },

  addHost: async (config, credential) => {
    const host = { ...config, category_id: config.category_id || 'default' };
    await invoke('save_host', { host });
    set((s) => ({ hosts: [...s.hosts, host] }));
    if (credential && credential.value) {
      await invoke('save_credential', {
        hostId: host.id,
        credType: credential.type,
        value: credential.value,
      });
    }
  },

  updateHost: async (config, credential) => {
    await invoke('save_host', { host: config });
    set((s) => ({
      hosts: s.hosts.map((h) => (h.id === config.id ? config : h)),
    }));
    if (credential && credential.value) {
      await invoke('save_credential', {
        hostId: config.id,
        credType: credential.type,
        value: credential.value,
      });
    }
  },

  removeHost: async (id) => {
    await invoke('delete_host', { id });
    set((s) => {
      const connectionStates = { ...s.connectionStates };
      const homeDirs = { ...s.homeDirs };
      const fingerprints = { ...s.fingerprints };
      delete connectionStates[id];
      delete homeDirs[id];
      delete fingerprints[id];
      return {
        hosts: s.hosts.filter((h) => h.id !== id),
        selectedHostId: s.selectedHostId === id ? null : s.selectedHostId,
        connectionStates,
        homeDirs,
        fingerprints,
      };
    });
  },

  selectHost: (id) => set({ selectedHostId: id }),

  setConnectionState: (id, state) =>
    set((s) => ({
      connectionStates: { ...s.connectionStates, [id]: state },
    })),

  connectHost: async (id) => {
    const state = get().connectionStates[id];
    if (state === CONNECTING || state === CONNECTED) return;
    const host = get().hosts.find((h) => h.id === id);
    if (!host) {
      useToastStore.getState().push('error', '找不到主机配置');
      return;
    }
    get().setConnectionState(id, CONNECTING);
    get().selectHost(id);
    try {
      let password: string | null = null;
      let privateKey: string | null = null;
      if (host.auth_type === 'password') {
        try {
          password = await invoke<string | null>('get_credential', {
            hostId: id,
            credType: 'password',
          });
        } catch (err) {
          console.error('[connect] get_credential password failed:', err);
          throw new Error(`读取密码失败：${formatErr(err)}，请编辑主机重新输入密码`);
        }
        if (!password) {
          throw new Error('未找到保存的密码，请编辑主机重新输入密码');
        }
      } else {
        try {
          privateKey = await invoke<string | null>('get_credential', {
            hostId: id,
            credType: 'private_key',
          });
        } catch (err) {
          console.error('[connect] get_credential private_key failed:', err);
          throw new Error(`读取私钥失败：${formatErr(err)}，请编辑主机重新粘贴私钥`);
        }
        if (!privateKey) {
          throw new Error('未找到保存的私钥，请编辑主机重新粘贴私钥');
        }
      }
      const params: ConnectParams = {
        host_id: id,
        host: host.host,
        port: host.port,
        username: host.username,
        auth_type: host.auth_type,
        password,
        private_key: privateKey,
      };
      const result = await invoke<ConnectResult>('connect_host', { params });
      set((s) => ({
        homeDirs: { ...s.homeDirs, [id]: result.home_dir },
        fingerprints: { ...s.fingerprints, [id]: result.fingerprint },
        connectionStates: { ...s.connectionStates, [id]: CONNECTED },
      }));
      useToastStore.getState().push('success', `已连接：${host.name}`);
    } catch (err) {
      get().setConnectionState(id, DISCONNECTED);
      useToastStore.getState().push('error', `连接失败：${formatErr(err)}`);
    }
  },

  disconnectHost: async (id) => {
    try {
      await invoke('disconnect_host', { hostId: id });
    } catch (err) {
      useToastStore.getState().push('error', `断开失败：${formatErr(err)}`);
    } finally {
      get().setConnectionState(id, DISCONNECTED);
    }
  },

  initEventListeners: async () => {
    if (get()._unlistenFn) return;
    const unlisten = await listen<{ host_id?: string }>('ssh://disconnected', (event) => {
      const hostId = event.payload?.host_id;
      if (hostId) {
        get().setConnectionState(hostId, DISCONNECTED);
        const host = get().hosts.find((h) => h.id === hostId);
        if (host) {
          useToastStore.getState().push('warning', `已断开：${host.name}`);
        }
      }
    });
    set({ _unlistenFn: unlisten });
  },

  teardownEventListeners: async () => {
    const unlisten = get()._unlistenFn;
    if (unlisten) {
      await unlisten();
      set({ _unlistenFn: null });
    }
  },
}));

function formatErr(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
