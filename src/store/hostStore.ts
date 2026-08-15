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
  ReconnectMeta,
} from '../types';
import { useToastStore } from '../components/Toast';
import { logInfo, logWarn, logError, type LogLevel } from '../utils/log';
// 用动态 getState 避免 zustand 循环依赖
import { useUIStore } from './uiStore';
import { kernelEventBus } from '../utils/eventBus';

/**
 * 统一日志桥：
 * 1) 通过 utils/log 写入 APP_DATA/updates/update.log（持久化到文件，离线可查）
 * 2) 同时打印到 Console（开发期即时可见）
 *
 * 说明：Rust 端对不同级别有不同策略 —— info 仅在"调试日志"开关开启时写入文件；
 *       warn / error 始终写入。Console 不做过滤，全部打印（不会阻塞主流程）。
 */
function writeLog(level: LogLevel, tag: string, detail: string) {
  const line = `[${tag}] ${detail}`;
  // 1) 写文件（不 await，失败静默）
  if (level === 'info') logInfo(line);
  else if (level === 'warn') logWarn(line);
  else logError(line);
  // 2) Console
  const prefix = `[${tag}]`;
  if (level === 'error') console.error(prefix, detail);
  else if (level === 'warn') console.warn(prefix, detail);
  else console.log(prefix, detail);
}

// ============== 连接失败的"人话"文案 ==============

interface FriendlyFailure {
  kind: 'network' | 'auth' | 'config' | 'unknown';
  headline: string;
  suggestion: string;
}

/**
 * 把 os error 10065 / timed out / Permission denied 等技术错误翻译成：
 *   { headline: "用户一眼看懂的短标题", suggestion: "一句话怎么做" }
 * 日志里仍保留原始错误（rawMsg），用户侧只给友好文案。
 */
function classifyConnectFailure(rawMsg: string): FriendlyFailure {
  const t = rawMsg;
  const l = t.toLowerCase();

  if (
    /os error 10065|wsaehostunreach|ehostunreach|host unreachable|no route to host/i.test(t) ||
    l.includes('主机不可达')
  ) {
    return {
      kind: 'network',
      headline: '服务器暂时连不上',
      suggestion: '通常是您的网络断开或服务器关机，会自动重试，您也可以稍后手动点「立即重连」。',
    };
  }

  if (
    /os error 10051|wsaenetunreach|enetunreach|network is unreachable/i.test(t) ||
    l.includes('网络不可达')
  ) {
    return {
      kind: 'network',
      headline: '您的网络好像断开了',
      suggestion: '检查 Wi-Fi / 网线，恢复后会立即抢先重试。',
    };
  }

  if (
    /os error 10061|wsaeconnrefused|econnrefused|connection refused/i.test(t) ||
    l.includes('拒绝连接') ||
    l.includes('目标计算机积极拒绝')
  ) {
    return {
      kind: 'network',
      headline: '服务器 SSH 端口没响应',
      suggestion: '确认服务器是否开机、SSH 服务是否启动，以及端口号是否填写正确。',
    };
  }

  if (
    /os error 10060|wsaetimedout|etimedout|timed? out/i.test(t) ||
    l.includes('连接超时')
  ) {
    return {
      kind: 'network',
      headline: '连接服务器超时',
      suggestion: '可能是网络抖动或服务器负载高，会按间隔自动重试。',
    };
  }

  if (l.includes('temporarily unroutable')) {
    return {
      kind: 'network',
      headline: '暂时路由不到服务器',
      suggestion: '一般出现在 VPN / 代理切换时，网络稳定后会继续自动重试。',
    };
  }

  if (l.includes('name or service not known') || l.includes('getaddrinfo')) {
    return {
      kind: 'config',
      headline: '域名无法解析',
      suggestion: '主机地址填错或 DNS 不可用，请核对主机名 / IP 是否正确。',
    };
  }

  if (
    /authentication failed|permission denied|invalid credential|bad password|bad key|no supported authentication methods/i.test(t) ||
    l.includes('认证失败') ||
    l.includes('密码错误') ||
    l.includes('权限不够')
  ) {
    return {
      kind: 'auth',
      headline: '账号 / 密码 / 私钥认证失败',
      suggestion: '请到「编辑主机」重新填写密码或粘贴私钥后再连。',
    };
  }

  if (l.includes('未找到保存的密码')) {
    return {
      kind: 'config',
      headline: '还没保存密码',
      suggestion: '请到「编辑主机」重新输入一遍密码，保存后再连接。',
    };
  }

  if (l.includes('未找到保存的私钥')) {
    return {
      kind: 'config',
      headline: '还没保存私钥',
      suggestion: '请到「编辑主机」重新粘贴一次私钥，保存后再连接。',
    };
  }

  if (l.includes('主机指纹')) {
    return {
      kind: 'config',
      headline: '主机指纹不匹配',
      suggestion: '服务器可能重装或迁过机，请在「编辑主机」里重新确认指纹。',
    };
  }

  return {
    kind: 'unknown',
    headline: t.length > 32 ? t.slice(0, 32).trim() + '…' : t,
    suggestion: '会自动重试，也可以随时点「立即重连」。',
  };
}

/** 拼出一条给 Toast 看的单条字符串（换行在 Toast 组件 CSS 中已支持） */
function friendlyToastLine(rawMsg: string): string {
  const f = classifyConnectFailure(rawMsg);
  return `${f.headline}｜${f.suggestion}`;
}

interface HostState {
  hosts: HostConfig[];
  categories: CategoryConfig[];
  // 已展开的分类 id 集合
  expandedCategories: Set<string>;
  selectedHostId: string | null;
  connectionStates: Record<string, ConnectionState>;
  /** 重连中的主机元信息（attempt / 下次尝试时间），UI 用它展示「重连中 (N)」与倒计时 */
  reconnectMeta: Record<string, ReconnectMeta>;
  homeDirs: Record<string, string>;
  fingerprints: Record<string, string>;
  _unlistenFn: UnlistenFn | null;
  /** window online/offline 监听器的注销函数（浏览器级网络兜底，Rust SSH 断开事件之外再加一层） */
  _networkUnsubscribeFn: (() => void) | null;
  /** navigator.onLine 2s 轮询心跳 id（Webview2 offline 事件有时不准，用轮询兜底） */
  _networkPollId: number | null;
  /** 轮询/事件共享：上一次检测到的在线状态，用来比较翻转 */
  _lastOnLine: boolean | null;
  /** 每 10s 对前端显示为 CONNECTED 的主机主动查询 Rust connection_state（权威状态） */
  _connHealthPollId: number | null;
  /** 主动断开标记：disconnectHost 调用时把 hostId 写入这里，disconnect 事件命中后跳过自动重连 */
  _voluntaryDisconnects: Set<string>;
  /** 每个 host 的自动重连定时器 / task 句柄，cancelReconnect / 手动断开 / removeHost 时清理 */
  _reconnectTimers: Record<string, { timeoutId: number | null; cancelFlag: { cancelled: boolean } }>;

  loadHosts: () => Promise<void>;
  loadCategories: () => Promise<void>;
  saveCategory: (cat: CategoryConfig) => Promise<void>;
  deleteCategory: (id: string) => Promise<void>;
  toggleCategory: (id: string) => void;
  persistExpanded: () => Promise<void>;

  addHost: (config: HostConfig, credential?: { type: CredentialType; value: string }) => Promise<void>;
  updateHost: (
    config: HostConfig,
    credential?: { type: CredentialType; value: string },
  ) => Promise<void>;
  removeHost: (id: string) => Promise<void>;
  selectHost: (id: string | null) => void;
  setConnectionState: (id: string, state: ConnectionState) => void;
  /** UI 内部设置 reconnecting 状态 + 展示用的 meta（attempt/nextAt） */
  setReconnectState: (id: string, meta: ReconnectMeta) => void;
  /** 清除某台主机的 reconnecting 状态与 meta，切到 disconnected */
  clearReconnectState: (id: string) => void;
  /** 清理某台主机的自动重连定时器（内部工具方法） */
  _clearReconnectTimer: (id: string) => void;

  /**
   * 连接主机。返回 true 表示真正连接成功（已通过 Rust connection_state 二次确认为 connected）。
   * 内部会吞异常 + Toast 提示 + 自动置状态，外部 `void connectHost(...)` fire-and-forget 可安全使用。
   */
  connectHost: (id: string, opts?: { fromAutoReconnect?: boolean; silentOnError?: boolean }) => Promise<boolean>;
  /** 主动断开：写入 voluntary 标记 → 取消自动重连 → 调用 Rust disconnect → 置 DISCONNECTED */
  disconnectHost: (id: string) => Promise<void>;
  /** 手动取消自动重连（点了断线提示条的「取消重连」按钮） */
  cancelReconnect: (id: string) => void;
  /** 断线事件触发后启动自动重连（指数退避 + 最大次数 + 总超时） */
  _startAutoReconnect: (hostId: string) => void;
  initEventListeners: () => Promise<void>;
  teardownEventListeners: () => Promise<void>;
}

const DISCONNECTED: ConnectionState = 'disconnected';
const CONNECTING: ConnectionState = 'connecting';
const CONNECTED: ConnectionState = 'connected';
const RECONNECTING: ConnectionState = 'reconnecting';

/** 自动重连参数：退避间隔 2s → 4s → 8s → 16s → 30s（上限），最多尝试 10 次，最多持续 5 分钟 */
const RECONNECT_INITIAL_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const RECONNECT_MAX_ATTEMPTS = 10;
const RECONNECT_TOTAL_TIMEOUT_MS = 5 * 60 * 1000;
function nextBackoffDelay(attempt: number): number {
  // attempt: 1..N；delay = 2^attempt 秒，上限 30s
  const raw = Math.pow(2, attempt) * 1000;
  return Math.min(raw, RECONNECT_MAX_DELAY_MS);
}

export const useHostStore = create<HostState>((set, get) => ({
  hosts: [],
  categories: [],
  expandedCategories: new Set(['default']),
  selectedHostId: null,
  connectionStates: {},
  reconnectMeta: {},
  homeDirs: {},
  fingerprints: {},
  _unlistenFn: null,
  _networkUnsubscribeFn: null,
  _networkPollId: null,
  _lastOnLine: null,
  _connHealthPollId: null,
  _voluntaryDisconnects: new Set<string>(),
  _reconnectTimers: {},

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
    // 先清理自动重连资源
    get()._clearReconnectTimer(id);
    set((s) => {
      const voluntary = new Set(s._voluntaryDisconnects);
      voluntary.delete(id);
      return { _voluntaryDisconnects: voluntary };
    });
    await invoke('delete_host', { id });
    set((s) => {
      const connectionStates = { ...s.connectionStates };
      const homeDirs = { ...s.homeDirs };
      const fingerprints = { ...s.fingerprints };
      const reconnectMeta = { ...s.reconnectMeta };
      delete connectionStates[id];
      delete homeDirs[id];
      delete fingerprints[id];
      delete reconnectMeta[id];
      return {
        hosts: s.hosts.filter((h) => h.id !== id),
        selectedHostId: s.selectedHostId === id ? null : s.selectedHostId,
        connectionStates,
        homeDirs,
        fingerprints,
        reconnectMeta,
      };
    });
  },

  selectHost: (id) => set({ selectedHostId: id }),

  setConnectionState: (id, state) =>
    set((s) => ({
      connectionStates: { ...s.connectionStates, [id]: state },
    })),

  setReconnectState: (id, meta) =>
    set((s) => ({
      connectionStates: { ...s.connectionStates, [id]: RECONNECTING },
      reconnectMeta: { ...s.reconnectMeta, [id]: meta },
    })),

  clearReconnectState: (id) =>
    set((s) => {
      const connectionStates = { ...s.connectionStates };
      const reconnectMeta = { ...s.reconnectMeta };
      delete reconnectMeta[id];
      connectionStates[id] = DISCONNECTED;
      return { connectionStates, reconnectMeta };
    }),

  _clearReconnectTimer: (id) => {
    const timers = get()._reconnectTimers[id];
    if (timers) {
      if (timers.timeoutId !== null) {
        window.clearTimeout(timers.timeoutId);
      }
      timers.cancelFlag.cancelled = true;
      const next = { ...get()._reconnectTimers };
      delete next[id];
      set({ _reconnectTimers: next });
    }
  },

  cancelReconnect: (id) => {
    get()._clearReconnectTimer(id);
    get().clearReconnectState(id);
    const host = get().hosts.find((h) => h.id === id);
    if (host) {
      useToastStore.getState().push('info', `已取消重连：${host.name}`);
    }
  },

  _startAutoReconnect: (hostId) => {
    const host = get().hosts.find((h) => h.id === hostId);
    const hostName = host?.name ?? hostId;
    const tag = `reconnect:${hostName}`;
    get()._clearReconnectTimer(hostId);

    // 被动断开进入重连的唯一入口（ssh://disconnected、health-check 失配、
    // 2s 离线轮询、window offline 都会汇聚到这里）：立即停掉该主机所有
    // 端口转发，避免旧隧道残留"运行中"状态（重连期间用户会看到状态一直
    // 不变化）。该命令幂等，重复调用无害。
    void invoke('tunnel_stop_all_for_host', { hostId, reason: 'host-reconnecting' })
      .catch((e) => writeLog('warn', tag, `stop tunnels failed: ${formatErr(e)}`));

    const cancelFlag = { cancelled: false };
    const startedAt = Date.now();
    let attempt = 0;

    writeLog(
      'warn',
      tag,
      `start auto-reconnect loop (max=${RECONNECT_MAX_ATTEMPTS}, totalTimeout=5min)`,
    );

    const tryNext = () => {
      if (cancelFlag.cancelled) {
        writeLog('info', tag, 'cancelled');
        return;
      }

      attempt += 1;
      const now = Date.now();

      // 总超时检查
      if (now - startedAt >= RECONNECT_TOTAL_TIMEOUT_MS) {
        writeLog(
          'error',
          tag,
          `total timeout (>= ${RECONNECT_TOTAL_TIMEOUT_MS}ms), stop retrying`,
        );
        get().clearReconnectState(hostId);
        return;
      }

      // 最大次数检查
      if (attempt > RECONNECT_MAX_ATTEMPTS) {
        writeLog(
          'error',
          tag,
          `max attempts (${RECONNECT_MAX_ATTEMPTS}) reached, stop retrying`,
        );
        get().clearReconnectState(hostId);
        return;
      }

      const delay = attempt === 1 ? RECONNECT_INITIAL_DELAY_MS : nextBackoffDelay(attempt - 1);
      const nextAt = now + delay;
      writeLog(
        'warn',
        tag,
        `attempt=${attempt}, delay=${delay}ms, nextAt=${new Date(nextAt).toLocaleTimeString()}`,
      );

      get().setReconnectState(hostId, { attempt, nextDelayMs: delay, nextAt });

      const timeoutId = window.setTimeout(async () => {
        if (cancelFlag.cancelled) {
          writeLog('info', tag, `attempt ${attempt} skipped (cancelled during wait)`);
          return;
        }
        try {
          writeLog('warn', tag, `attempt ${attempt}: invoking connectHost`);
          const ok = await get().connectHost(hostId, { fromAutoReconnect: true });
          if (!ok) {
            writeLog(
              'warn',
              tag,
              `attempt ${attempt}: connectHost returned false → scheduling next`,
            );
            if (!cancelFlag.cancelled) tryNext();
            return;
          }
          writeLog('warn', tag, `attempt ${attempt}: reconnect success`);
          set((s) => {
            const reconnectMeta = { ...s.reconnectMeta };
            delete reconnectMeta[hostId];
            return { reconnectMeta };
          });
          get()._clearReconnectTimer(hostId);
        } catch (e) {
          writeLog(
            'warn',
            tag,
            `attempt ${attempt}: unexpected throw — ${formatErr(e)}; scheduling next`,
          );
          if (!cancelFlag.cancelled) {
            tryNext();
          }
        }
      }, delay);

      // 记录定时器
      set((s) => ({
        _reconnectTimers: {
          ...s._reconnectTimers,
          [hostId]: { timeoutId, cancelFlag },
        },
      }));
    };

    tryNext();
  },

  connectHost: async (id, opts) => {
    const fromAutoReconnect = opts?.fromAutoReconnect === true;
    // 自动重连调用 → 默认不弹失败 Toast（每 2s/4s 红条太吵），由外层按策略提示
    const silentOnError = opts?.silentOnError ?? fromAutoReconnect;
    const state = get().connectionStates[id];
    if (!fromAutoReconnect && (state === CONNECTING || state === CONNECTED)) return false;
    const host = get().hosts.find((h) => h.id === id);
    if (!host) {
      useToastStore.getState().push('error', '找不到主机配置');
      return false;
    }
    if (!fromAutoReconnect) {
      get()._clearReconnectTimer(id);
      set((s) => {
        const reconnectMeta = { ...s.reconnectMeta };
        delete reconnectMeta[id];
        const voluntary = new Set(s._voluntaryDisconnects);
        voluntary.delete(id);
        return { reconnectMeta, _voluntaryDisconnects: voluntary };
      });
    }
    get().setConnectionState(id, CONNECTING);
    if (!fromAutoReconnect) {
      get().selectHost(id);
    }
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
          logError(`[connect] get_credential password failed: ${formatErr(err)}`);
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
          logError(`[connect] get_credential private_key failed: ${formatErr(err)}`);
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

      // ===== 二次确认 Rust 端真实状态（带容差重试，避免 1 tick 时序误判）=====
      //   正常情况下 connect_host 返回 Ok(...) 的同时 Rust connection_state 就是 'connected'；
      //   极少数情况下状态更新有 1~2 个 task 延迟，所以退避 80/150/250ms 再查 3 次（总共 < 半秒），
      //   真连上时第一次就通过用户无感，真失败也能及时拦截。
      const waitMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      let realState = await invoke<string>('connection_state', { hostId: id }).catch(() => 'disconnected');
      if (realState !== 'connected') {
        for (const step of [80, 150, 250]) {
          writeLog(
            'info',
            'connectHost',
            `host=${host.name} — connect_host OK but Rust connection_state=${realState}, retry after ${step}ms`,
          );
          await waitMs(step);
          realState = await invoke<string>('connection_state', { hostId: id }).catch(() => 'disconnected');
          if (realState === 'connected') break;
        }
      }
      if (realState !== 'connected') {
        writeLog(
          'warn',
          'connectHost',
          `host=${host.name} — connect_host returned but Rust connection_state=${realState} after retries → treated as failure`,
        );
        throw new Error(
          `连接结果确认失败：Rust 端状态为 ${realState}（已重试多次），请稍后手动重连或检查网络。`,
        );
      }

      set((s) => ({
        homeDirs: { ...s.homeDirs, [id]: result.home_dir },
        fingerprints: { ...s.fingerprints, [id]: result.fingerprint },
        connectionStates: { ...s.connectionStates, [id]: CONNECTED },
      }));
      // 通知插件内核连接成功：autoStart 隧道（port-forward 等）据此自动启动。
      // connectHost 是所有连接路径的唯一入口（手动 / 自动重连 / 恢复联网重连）。
      const connEvent = fromAutoReconnect ? 'connection:reconnect-success' : 'connection:success';
      kernelEventBus.emit(connEvent, id, result);
      writeLog('info', 'connectHost', `host=${host.name} connected → emit ${connEvent}`);
      const ui = useUIStore.getState();
      if (!ui.terminalTabs[id] || ui.terminalTabs[id].length === 0) {
        ui.addTerminalTab(id);
      }
      ui.setTerminalVisible(id, true);
      return true;
    } catch (err) {
      get().setConnectionState(id, DISCONNECTED);
      const msg = formatErr(err);
      const hostName = host?.name ?? id;
      const cls = classifyConnectFailure(msg);
      writeLog(
        'warn',
        'connectHost',
        `host=${hostName} failed (${cls.kind}): ${msg}`,
      );
      if (!silentOnError) {
        // 手动连接失败：用友好 Toast；未知类型才附在后面给高级用户看
        const kindForToast =
          cls.kind === 'auth' || cls.kind === 'config' ? 'warning' : 'error';
        const line =
          cls.kind === 'unknown'
            ? `连接失败｜${cls.headline} ${cls.suggestion}`
            : friendlyToastLine(msg);
        useToastStore.getState().push(kindForToast, line, 4500);
      }
      return false;
    }
  },

  disconnectHost: async (id) => {
    // 先标记为主动断开，避免随后的 disconnected 事件触发自动重连
    set((s) => {
      const voluntary = new Set(s._voluntaryDisconnects);
      voluntary.add(id);
      return { _voluntaryDisconnects: voluntary };
    });
    // 同时取消正在进行的自动重连
    get()._clearReconnectTimer(id);
    set((s) => {
      const reconnectMeta = { ...s.reconnectMeta };
      delete reconnectMeta[id];
      return { reconnectMeta };
    });
    try {
      await invoke('disconnect_host', { hostId: id });
    } catch (err) {
      useToastStore.getState().push('error', `断开失败：${formatErr(err)}`);
    } finally {
      get().setConnectionState(id, DISCONNECTED);
    }
  },

  initEventListeners: async () => {
    const TAG = 'net-watchdog';
    const state0 = get();

    // —— 抽成共享的状态翻转回调（window 事件 & 轮询心跳共用一套） ——
    const handleBecomeOffline = () => {
      const cur = get();
      const toMark = cur.hosts.filter((h) => {
        const st = cur.connectionStates[h.id];
        return st === CONNECTED || st === CONNECTING || st === RECONNECTING;
      });
      const names = toMark.map((h) => h.name).join(',') || '(none)';
      writeLog(
        toMark.length === 0 ? 'info' : 'warn',
        TAG,
        `offline triggered — target hosts=${names}`,
      );
      if (toMark.length === 0) {
        return;
      }
      for (const host of toMark) {
        get().setConnectionState(host.id, DISCONNECTED);
        get()._clearReconnectTimer(host.id);
        get()._startAutoReconnect(host.id);
      }
    };

    const handleBecomeOnline = () => {
      const cur = get();
      const candidates = cur.hosts.filter((h) => cur.connectionStates[h.id] === RECONNECTING);
      const names = candidates.map((h) => h.name).join(',') || '(none)';
      writeLog(
        candidates.length === 0 ? 'info' : 'warn',
        TAG,
        `online triggered — reconnecting hosts=${names}`,
      );
      if (candidates.length === 0) {
        return;
      }
      for (const host of candidates) {
        get()._clearReconnectTimer(host.id);
        void (async () => {
          get().setReconnectState(host.id, { attempt: 1, nextDelayMs: 0, nextAt: Date.now() });
          try {
            const ok = await get().connectHost(host.id, { fromAutoReconnect: true });
            if (!ok) {
              writeLog(
                'warn',
                TAG,
                `online reconnect host=${host.name} — connectHost returned false → fall back to backoff`,
              );
              get()._startAutoReconnect(host.id);
              return;
            }
            set((s) => {
              const reconnectMeta = { ...s.reconnectMeta };
              delete reconnectMeta[host.id];
              return { reconnectMeta };
            });
            get()._clearReconnectTimer(host.id);
            writeLog('warn', TAG, `online reconnect success host=${host.name}`);
          } catch (e) {
            writeLog(
              'warn',
              TAG,
              `online reconnect unexpected throw host=${host.name}: ${formatErr(e)} → fall back to backoff`,
            );
            get()._startAutoReconnect(host.id);
          }
        })();
      }
    };

    // 接受 navigator.onLine，若与 last 不同则触发（保证幂等）
    const applyOnlineState = (nowOnline: boolean, reason: string) => {
      const last = get()._lastOnLine;
      if (last === nowOnline) return;
      writeLog('info', TAG, `${reason}: navigator.onLine ${last ?? 'null'} → ${nowOnline}`);
      set({ _lastOnLine: nowOnline });
      if (last === null && nowOnline) return;
      if (nowOnline) handleBecomeOnline();
      else handleBecomeOffline();
    };

    // ============== 1) Rust SSH 断开事件 ==============
    if (!state0._unlistenFn) {
      const unlisten = await listen<{ host_id?: string }>('ssh://disconnected', (event) => {
        const hostId = event.payload?.host_id;
        if (!hostId) return;
        const state = get();
        const hostName = state.hosts.find((h) => h.id === hostId)?.name ?? hostId;
        writeLog('warn', TAG, `Rust ssh://disconnected event: host=${hostName}`);
        if (state._voluntaryDisconnects.has(hostId)) {
          writeLog('info', TAG, `host=${hostName} — voluntary disconnect, skip auto-reconnect`);
          set((s) => {
            const voluntary = new Set(s._voluntaryDisconnects);
            voluntary.delete(hostId);
            return { _voluntaryDisconnects: voluntary };
          });
          state.setConnectionState(hostId, DISCONNECTED);
          // 手动断开：SSH 会话已不存在，隧道必然失效，立即清理避免 UI 残留运行态
          void invoke('tunnel_stop_all_for_host', { hostId, reason: 'host-close' })
            .catch((e) => writeLog('warn', TAG, `voluntary disconnect: stop tunnels failed: ${formatErr(e)}`));
          return;
        }
        state.setConnectionState(hostId, DISCONNECTED);
        // 被动断线会进入 _startAutoReconnect，停隧道已在其内部统一处理
        // （覆盖 ssh://disconnected、health-check、轮询等所有检测路径）
        state._startAutoReconnect(hostId);
      });
      set({ _unlistenFn: unlisten });
      writeLog('info', TAG, 'Rust ssh://disconnected listener attached');
    }

    // ============== 2) window online/offline 事件（第一时间） ==============
    if (!get()._networkUnsubscribeFn) {
      const onOffline = () => applyOnlineState(false, 'window offline');
      const onOnline = () => applyOnlineState(true, 'window online');
      window.addEventListener('offline', onOffline);
      window.addEventListener('online', onOnline);
      const unsubscribe = () => {
        window.removeEventListener('offline', onOffline);
        window.removeEventListener('online', onOnline);
      };
      set({ _networkUnsubscribeFn: unsubscribe });
      writeLog('info', TAG, 'window online/offline listeners attached');
    }

    // ============== 3) 2s 轮询心跳（Webview2 offline 事件常不触发，硬性兜底） ==============
    if (get()._networkPollId === null) {
      const pollId = window.setInterval(() => {
        const online = navigator.onLine;
        applyOnlineState(online, '2s-poll');
      }, 2000);
      set({ _networkPollId: pollId });
      writeLog('info', TAG, '2s navigator.onLine poll started');
    }

    // ============== 4) 启动时立即检测一次（避免离线启动没捕获到事件） ==============
    const initialOnline = navigator.onLine;
    writeLog(
      'info',
      TAG,
      `init — initial navigator.onLine = ${initialOnline}, hosts count=${get().hosts.length}`,
    );
    applyOnlineState(initialOnline, 'init-check');

    // ============== 5) Rust 连接健康检查（10s 轮询，权威状态同步） ==============
    if (get()._connHealthPollId === null) {
      const healthTick = async () => {
        const st = get();
        const suspects = st.hosts.filter((h) => st.connectionStates[h.id] === CONNECTED);
        if (suspects.length === 0) return;
        for (const host of suspects) {
          try {
            const real = await invoke<string>('connection_state', { hostId: host.id });
            if (real === 'disconnected' || real === 'connecting') {
              writeLog(
                'warn',
                TAG,
                `health-check mismatch: host=${host.name} UI=CONNECTED Rust=${real} → passive disconnect`,
              );
              if (!get()._voluntaryDisconnects.has(host.id)) {
                get().setConnectionState(host.id, DISCONNECTED);
                get()._clearReconnectTimer(host.id);
                get()._startAutoReconnect(host.id);
              }
            }
          } catch (err) {
            writeLog(
              'warn',
              TAG,
              `health-check invoke error host=${host.name}: ${formatErr(err)} → passive disconnect`,
            );
            if (!get()._voluntaryDisconnects.has(host.id)) {
              get().setConnectionState(host.id, DISCONNECTED);
              get()._clearReconnectTimer(host.id);
              get()._startAutoReconnect(host.id);
            }
          }
        }
      };
      void healthTick();
      const pollId = window.setInterval(() => void healthTick(), 10_000);
      set({ _connHealthPollId: pollId });
      writeLog('info', TAG, '10s Rust connection_state health poll started');
    }
  },

  teardownEventListeners: async () => {
    const unlisten = get()._unlistenFn;
    if (unlisten) {
      await unlisten();
      set({ _unlistenFn: null });
    }
    const net = get()._networkUnsubscribeFn;
    if (net) {
      net();
      set({ _networkUnsubscribeFn: null });
    }
    const pid = get()._networkPollId;
    if (pid !== null) {
      window.clearInterval(pid);
      set({ _networkPollId: null });
    }
    const hpId = get()._connHealthPollId;
    if (hpId !== null) {
      window.clearInterval(hpId);
      set({ _connHealthPollId: null });
    }
    set({ _lastOnLine: null });
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

export { classifyConnectFailure };
