import { useEffect } from 'react';
import { create } from 'zustand';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import {
  check as checkUpdater,
  type Update,
  type DownloadEvent,
} from '@tauri-apps/plugin-updater';
import { useToastStore } from '../components/Toast';
import type { ToastKind } from '../types';

function showToast(opts: {
  type: ToastKind;
  message: string;
  duration?: number;
}) {
  const { push } = useToastStore.getState();
  push(opts.type, opts.message, opts.duration);
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded' // 下载完成，等待用户确认安装
  | 'installing'
  | 'done'
  | 'error';

/** 更新源镜像：'github' 为内置官方源，其他字符串为自定义镜像 URL 前缀（如 'https://gh-proxy.com'） */
export type UpdateMirror = string;

export interface MirrorOption {
  id: UpdateMirror;
  name: string;
  desc: string;
  /** 是否内置（不可删除） */
  builtin: boolean;
}

const BUILTIN_MIRRORS: MirrorOption[] = [
  { id: 'github', name: 'GitHub 官方', desc: '直连，海外访问速度优先', builtin: true },
  { id: 'https://v4.gh-proxy.org', name: 'v4.gh-proxy 镜像', desc: '国内推荐：v4.gh-proxy.org 加速', builtin: true },
];

const CUSTOM_MIRRORS_KEY = 'app_updater_custom_mirrors';
const UPDATE_MIRROR_KEY = 'app_updater_mirror';
const UPDATE_PENDING_KEY = 'app_updater_pending';

/** 读取用户自定义镜像列表 */
function getCustomMirrors(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_MIRRORS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((v) => typeof v === 'string' && v.trim().length > 0);
  } catch {
    return [];
  }
}

/** 保存用户自定义镜像列表 */
function setCustomMirrors(list: string[]) {
  try {
    localStorage.setItem(CUSTOM_MIRRORS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/** 添加自定义镜像，返回是否添加成功（重复返回 false） */
export function addCustomMirror(url: string): boolean {
  const normalized = normalizeMirrorUrl(url);
  if (!normalized) return false;
  const list = getCustomMirrors();
  if (list.includes(normalized) || BUILTIN_MIRRORS.some((m) => m.id === normalized)) return false;
  list.push(normalized);
  setCustomMirrors(list);
  return true;
}

/** 删除自定义镜像 */
export function removeCustomMirror(url: string): boolean {
  const normalized = normalizeMirrorUrl(url);
  if (!normalized) return false;
  const list = getCustomMirrors();
  const idx = list.indexOf(normalized);
  if (idx === -1) return false;
  list.splice(idx, 1);
  setCustomMirrors(list);
  // 如果删除的是当前选中的源，回退到 github
  if (getUpdateMirror() === normalized) {
    setUpdateMirror('github');
  }
  return true;
}

/** 规范化镜像 URL：去尾部斜杠，补 https:// */
function normalizeMirrorUrl(url: string): string {
  let v = url.trim();
  if (!v) return '';
  // 补协议
  if (!v.startsWith('http://') && !v.startsWith('https://')) {
    v = 'https://' + v;
  }
  // 去尾部斜杠
  v = v.replace(/\/+$/, '');
  return v;
}

/** 获取所有镜像选项（内置 + 自定义） */
export function getMirrorOptions(): MirrorOption[] {
  const customs = getCustomMirrors();
  const customOpts: MirrorOption[] = customs.map((url) => {
    let name: string;
    try {
      name = new URL(url).hostname;
    } catch {
      name = url;
    }
    return { id: url, name: `${name} 镜像`, desc: url, builtin: false };
  });
  return [...BUILTIN_MIRRORS, ...customOpts];
}

/** 兼容旧代码的静态导出（动态读取一次） */
export const UPDATE_MIRROR_OPTIONS = BUILTIN_MIRRORS;

interface PendingUpdate {
  version: string;
  downloadedAt: number;
}

export function getUpdateMirror(): UpdateMirror {
  try {
    const raw = localStorage.getItem(UPDATE_MIRROR_KEY);
    if (!raw) return 'github';
    return raw;
  } catch {
    return 'github';
  }
}

export function setUpdateMirror(mirror: UpdateMirror) {
  try {
    localStorage.setItem(UPDATE_MIRROR_KEY, mirror);
  } catch {
    /* ignore */
  }
}

function getPendingUpdate(): PendingUpdate | null {
  try {
    const raw = localStorage.getItem(UPDATE_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingUpdate;
    if (!parsed || typeof parsed.version !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function setPendingUpdate(p: PendingUpdate | null) {
  try {
    if (p) localStorage.setItem(UPDATE_PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(UPDATE_PENDING_KEY);
  } catch {
    /* ignore */
  }
}

export type MirrorDelayResult = Record<string, number | null>;

/** 默认的 latest.json endpoint（与 check() 内保持一致，模块外调用时可直接用） */
const DEFAULT_LATEST_ENDPOINT =
  'https://github.com/zhangOranges/RD/releases/latest/download/latest.json';

/**
 * 并行测试所有镜像源对 latest.json 的访问延迟，返回每个源的耗时（毫秒）或 null（失败/超时）。
 * 通过 Rust 后端 invoke('probe_url') 发 HTTP HEAD 请求，完全绕过浏览器 CORS 限制。
 * 超 6 秒返回 -1（失败）。
 */
export async function probeMirrorLatency(
  endpoint: string = DEFAULT_LATEST_ENDPOINT,
): Promise<MirrorDelayResult> {
  const options = getMirrorOptions();
  const results = await Promise.all(
    options.map(async (opt) => {
      const url = opt.id === 'github' ? endpoint : applyMirror(endpoint, opt.id);
      try {
        const ms = await invoke<number>('probe_url', { url });
        return { mirror: opt.id, ms };
      } catch {
        return { mirror: opt.id, ms: -1 };
      }
    }),
  );

  const out: MirrorDelayResult = {};
  for (const r of results) {
    out[r.mirror] = typeof r.ms === 'number' && r.ms >= 0 ? r.ms : null;
  }
  return out;
}

/**
 * 并行测试所有镜像源对 latest.json 的访问延迟，返回延迟最低的镜像。
 * 所有镜像都失败时回退到用户当前设定的源。
 */
async function pickFastestMirror(
  endpoints: readonly string[],
  userMirror: UpdateMirror,
): Promise<UpdateMirror> {
  const all = await probeMirrorLatency(endpoints[0]);
  const options = getMirrorOptions();
  const reachable = options
    .map((o) => ({ mirror: o.id, elapsed: all[o.id] ?? Infinity }))
    .filter((r) => typeof r.elapsed === 'number' && Number.isFinite(r.elapsed)) as Array<{
    mirror: UpdateMirror;
    elapsed: number;
  }>;
  if (reachable.length === 0) return userMirror;
  reachable.sort((a, b) => a.elapsed - b.elapsed);
  return reachable[0].mirror;
}

/**
 * 将 GitHub 下载 URL 根据选择的镜像源进行转换。
 * mirror 为 'github' 时原样返回；否则作为 URL 前缀拼接（如 'https://gh-proxy.com' + '/' + url）。
 */
function applyMirror(url: string, mirror: UpdateMirror): string {
  if (mirror === 'github') return url;
  // mirror 是自定义镜像前缀，直接拼接
  return `${mirror}/${url}`;
}

export interface AppUpdaterState {
  status: UpdateStatus;
  availableVersion: string | null;
  currentVersion: string | null;
  downloadedMB: number;
  /** 文件总大小 MB（来自 latest.json） */
  totalMB: number | null;
  progressPct: number;
  errorMsg: string | null;
  /** 更新说明（release notes / changelog） */
  releaseNotes: string | null;
  /** 是否显示更新对话框 */
  dialogVisible: boolean;
  mirror: UpdateMirror;
  /** 是否检测到本地有待安装的已下载包（跨 session 恢复） */
  pendingFromLocal: boolean;
}

const DEFAULT_STATE: AppUpdaterState = {
  status: 'idle',
  availableVersion: null,
  currentVersion: null,
  downloadedMB: 0,
  totalMB: null,
  progressPct: 0,
  errorMsg: null,
  releaseNotes: null,
  dialogVisible: false,
  mirror: 'github',
  pendingFromLocal: false,
};

function isDevProfile(): boolean {
  if (typeof window === 'undefined') return false;
  const viteDev = !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
  return viteDev;
}

/** 从 latest.json URL 手动拉取，提取 size 和 notes */
async function fetchLatestMeta(endpoints: readonly string[], mirror: UpdateMirror) {
  const sizes: Record<string, number> = {};
  let notes: string | null = null;
  let version: string | null = null;

  const tryFetch = async (url: string) => {
    try {
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) return false;
      const data = (await resp.json()) as {
        version?: string;
        notes?: string;
        platforms?: Record<
          string,
          { signature: string; url: string; format?: string; size?: number }
        >;
      };
      if (!version) version = data.version ?? null;
      if (!notes) notes = data.notes ?? null;
      if (data.platforms) {
        for (const [key, p] of Object.entries(data.platforms)) {
          if (typeof p.size === 'number' && p.size > 0) {
            sizes[key] = sizes[key] ?? p.size;
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  };

  // 1) 首选：用户设定的源
  for (const ep of endpoints) {
    const url = mirror === 'github' ? ep : applyMirror(ep, mirror);
    if (await tryFetch(url)) {
      return { sizes, notes, version };
    }
  }

  // 2) 如首选没拿到 size，依次 fallback 其他镜像（仅在未取到任何 size 时）
  if (Object.keys(sizes).length === 0) {
    const allOpts = getMirrorOptions();
    const fallbacks = allOpts
      .map((o) => o.id)
      .filter((m) => m !== mirror);
    for (const fb of fallbacks) {
      for (const ep of endpoints) {
        const url = applyMirror(ep, fb);
        if (await tryFetch(url)) {
          if (Object.keys(sizes).length > 0) {
            return { sizes, notes, version };
          }
        }
      }
    }
  }

  return { sizes, notes, version };
}

function detectPlatformKey(): string | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows-x86_64';
  if (ua.includes('mac')) return 'darwin-aarch64';
  if (ua.includes('linux')) return 'linux-x86_64';
  return null;
}

// ---- 模块级变量（不触发 re-render，全组件共享）----
let updateRef: Update | null = null;
let downloadingRef = false;
let installingRef = false;
let platformSizesRef: Record<string, number> = {};
let autoCheckDone = false;

// ---- Zustand store ----
interface AppUpdaterStore extends AppUpdaterState {
  changeMirror: (m: UpdateMirror) => void;
  hideDialog: () => void;
  showDialog: () => void;
  check: () => void;
  /** 仅开始后台下载，下载中用户可关闭对话框；下载完成后自动进入 downloaded 状态并弹出确认 */
  download: () => void;
  /** 立即执行安装（调用前需已完成 download），并自动重启 */
  install: () => void;
  /** 稍后安装（本次关闭对话框，下次启动时再次检查本地待安装包） */
  installLater: () => void;
  dismissError: () => void;
  isDev: boolean;
}

const useUpdaterStore = create<AppUpdaterStore>((set, get) => ({
  ...DEFAULT_STATE,
  mirror: getUpdateMirror(),
  isDev: isDevProfile(),

  changeMirror: (m: UpdateMirror) => {
    setUpdateMirror(m);
    set({ mirror: m });
  },

  hideDialog: () => set({ dialogVisible: false }),

  showDialog: () => {
    const s = get().status;
    if (s === 'available' || s === 'downloaded' || s === 'downloading' || s === 'error') {
      set({ dialogVisible: true });
    }
  },

  dismissError: () =>
    set((s) => ({
      status: s.status === 'error' ? 'idle' : s.status,
      errorMsg: null,
    })),

  check: async () => {
    if (downloadingRef || installingRef) return;

    let cur = get().currentVersion;
    if (!cur && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        cur = await getVersion();
      } catch {
        cur = null;
      }
    }

    set((s) => {
      if (s.status === 'checking' || s.status === 'downloading' || s.status === 'installing')
        return s;
      return {
        ...DEFAULT_STATE,
        mirror: s.mirror,
        status: 'checking',
        currentVersion: s.currentVersion || cur || null,
      };
    });

    try {
      const defaultEndpoints = [
        'https://github.com/zhangOranges/RD/releases/latest/download/latest.json',
      ];
      const tauriEndpoints: readonly string[] =
        (window as unknown as { __TAURI_UPDATER_ENDPOINTS__?: readonly string[] })
          .__TAURI_UPDATER_ENDPOINTS__ ??
        defaultEndpoints;
      const endpoints =
        tauriEndpoints && tauriEndpoints.length > 0 ? tauriEndpoints : defaultEndpoints;

      // 自动检查更新时测速选最优镜像（手动点击检查也走此逻辑）
      const userMirror = getUpdateMirror();
      const fastestMirror = await pickFastestMirror(endpoints, userMirror);
      // 更新 state 中的 mirror 为测速结果，用户可在对话框/设置中手动覆盖
      set({ mirror: fastestMirror });

      const { sizes, notes, version: metaVersion } = await fetchLatestMeta(
        endpoints,
        fastestMirror,
      );
      platformSizesRef = sizes;

      const update = await checkUpdater({ timeout: 8000 });
      if (!update) {
        // 没有可用更新 → 清除本地 pending 记录（旧版遗留的）
        setPendingUpdate(null);
        set((s) => ({
          ...DEFAULT_STATE,
          mirror: s.mirror,
          status: 'idle',
          currentVersion: s.currentVersion || cur || null,
        }));
        showToast({ type: 'info', message: '已经是最新版本', duration: 2500 });
        return;
      }
      updateRef = update;

      // 有可用更新 → 检查本地是否有已下载待安装的同版本包
      const pending = getPendingUpdate();
      const latestV = update.version || metaVersion || null;
      const pendingMatches = pending && latestV && pending.version === latestV;

      if (pendingMatches) {
        // 标记本地有待安装包，用户确认时再执行"安装"步骤（download 会从缓存秒下）
        set((s) => ({
          ...s,
          status: 'downloaded',
          currentVersion: s.currentVersion || cur || update.currentVersion || null,
          availableVersion: latestV,
          releaseNotes: notes,
          dialogVisible: true,
          errorMsg: null,
          downloadedMB: 0,
          progressPct: 100,
          pendingFromLocal: true,
        }));
        return;
      }
      // 版本变化了，清理旧 pending
      if (pending && pending.version !== latestV) setPendingUpdate(null);

      set((s) => ({
        ...s,
        status: 'available',
        currentVersion: s.currentVersion || cur || update.currentVersion || null,
        availableVersion: latestV,
        releaseNotes: notes,
        dialogVisible: true,
        errorMsg: null,
        downloadedMB: 0,
        progressPct: 0,
        pendingFromLocal: false,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      set({
        status: 'error',
        errorMsg: msg,
        downloadedMB: 0,
        progressPct: 0,
      });
      showToast({ type: 'error', message: `检查更新失败：${msg}`, duration: 5000 });
    }
  },

  download: async () => {
    const update = updateRef;
    if (!update || downloadingRef || installingRef) return;
    downloadingRef = true;

    set({
      status: 'downloading',
      errorMsg: null,
      downloadedMB: 0,
      progressPct: 0,
    });

    try {
      // 1. 计算/查找本次更新的真实文件大小（字节）
      const platformKey = detectPlatformKey();
      const realSize =
        platformKey && platformSizesRef[platformKey]
          ? platformSizesRef[platformKey]
          : null;

      // 默认估算：没取到真实 size 时用一个保守值，避免进度"看起来太慢"
      const FALLBACK_SIZE = 80 * 1024 * 1024;

      // 使用对象引用，让 Started 回调可把最终值写回 Progress 可见的位置
      const currentTotalRef: { v: number } = {
        v: realSize && realSize > 0 ? realSize : FALLBACK_SIZE,
      };
      const hasRealSize = realSize && realSize > 0;
      const totalMB = hasRealSize ? (realSize as number) / (1024 * 1024) : null;
      set({
        totalMB: totalMB ? Math.round(totalMB * 10) / 10 : null,
      });

      let downloaded = 0;
      let clProvided = false;

      // 2. 仅下载（不安装）
      await update.download((event: DownloadEvent) => {
        switch (event.event) {
          case 'Started': {
            const data = event.data as unknown as { contentLength?: unknown } | undefined;
            let cl: number | null = null;
            if (data && typeof data === 'object' && 'contentLength' in data) {
              const v = data.contentLength;
              if (typeof v === 'number' && v > 0) {
                cl = v;
                clProvided = true;
              }
            }
            downloaded = 0;
            const finalTotal = cl && cl > 0 ? cl : currentTotalRef.v;
            currentTotalRef.v = finalTotal;
            const finalMB = finalTotal / (1024 * 1024);
            set({
              downloadedMB: 0,
              progressPct: 0,
              totalMB: Math.round(finalMB * 10) / 10,
            });
            break;
          }
          case 'Progress': {
            downloaded += event.data.chunkLength;
            const total = currentTotalRef.v;
            const mb = downloaded / (1024 * 1024);
            const ceiling = hasRealSize || clProvided ? 99 : 95;
            const pct = Math.min(
              ceiling,
              Math.max(1, Math.round((downloaded / total) * 100)),
            );
            set((s) => ({
              downloadedMB: Math.round(mb * 10) / 10,
              progressPct: Math.max(s.progressPct, pct),
            }));
            break;
          }
          case 'Finished':
            set({
              progressPct: 100,
            });
            break;
        }
      }, { timeout: 5 * 60 * 1000 });

      // 3. 下载完成 → 进入"待安装"状态，并自动弹出确认对话框
      const version = get().availableVersion;
      if (version) {
        setPendingUpdate({ version, downloadedAt: Date.now() });
      }
      downloadingRef = false;
      set({
        status: 'downloaded',
        pendingFromLocal: false,
        dialogVisible: true,
        progressPct: 100,
      });
      showToast({
        type: 'success',
        message: '更新包已下载完成',
        duration: 3000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      downloadingRef = false;
      set({ status: 'error', errorMsg: msg });
      showToast({ type: 'error', message: `下载更新失败：${msg}`, duration: 5000 });
    }
  },

  install: async () => {
    const update = updateRef;
    if (!update || installingRef) return;
    // 如果 pendingFromLocal（本地有待安装包），先重新 download 一次（Tauri 缓存命中会秒下）
    // 这样确保 Rust 侧的 Resource 状态与 install 对齐
    if (get().pendingFromLocal || get().status === 'downloaded') {
      try {
        // 重新执行下载（走本地缓存，Finished 会立即触发）
        await update.download(() => {}, { timeout: 2 * 60 * 1000 });
      } catch {
        // 缓存命中失败不致命，继续尝试安装
      }
    }
    installingRef = true;
    set({ status: 'installing' });
    try {
      await update.install();
      set({ status: 'done', progressPct: 100 });
      showToast({
        type: 'success',
        message: '更新完成，程序即将自动重启',
        duration: 4000,
      });
      // 安装成功 → 清理 pending
      setPendingUpdate(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      installingRef = false;
      set({ status: 'error', errorMsg: msg });
      showToast({ type: 'error', message: `安装更新失败：${msg}`, duration: 5000 });
    }
  },

  installLater: () => {
    // 用户选择稍后安装 → 保留 pending 记录（下次启动自动识别）
    // 仅关闭对话框即可
    set({ dialogVisible: false });
    showToast({
      type: 'info',
      message: '已保留更新包，下次启动时将再次提示安装',
      duration: 3000,
    });
  },
}));

/** 兼容旧接口的 hook 包装 */
export function useAppUpdater() {
  const store = useUpdaterStore();

  // 启动自动检查（仅 release 打包后环境，仅一次）
  useEffect(() => {
    if (autoCheckDone) return;
    autoCheckDone = true;
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    if (isDevProfile()) return;
    void store.check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return store;
}
