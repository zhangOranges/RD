import { useEffect } from 'react';
import { create } from 'zustand';
import { getVersion } from '@tauri-apps/api/app';
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

/** 更新源镜像 */
export type UpdateMirror = 'github' | 'ghproxy' | 'ghmirror' | 'kgithub';

export const UPDATE_MIRROR_OPTIONS: {
  id: UpdateMirror;
  name: string;
  desc: string;
}[] = [
  { id: 'github', name: 'GitHub 官方', desc: '直连，海外访问速度优先' },
  { id: 'ghproxy', name: 'ghproxy 镜像', desc: '国内推荐：ghproxy.com 加速' },
  { id: 'ghmirror', name: 'gh-mirror 镜像', desc: '国内推荐：gh-api.com 加速' },
  { id: 'kgithub', name: 'kgithub 镜像', desc: 'kgithub.com 镜像加速' },
];

const UPDATE_MIRROR_KEY = 'app_updater_mirror';
const UPDATE_PENDING_KEY = 'app_updater_pending';

interface PendingUpdate {
  version: string;
  downloadedAt: number;
}

export function getUpdateMirror(): UpdateMirror {
  try {
    const raw = localStorage.getItem(UPDATE_MIRROR_KEY);
    if (!raw) return 'github';
    const valid = UPDATE_MIRROR_OPTIONS.some((o) => o.id === raw);
    return (valid ? (raw as UpdateMirror) : 'github') ?? 'github';
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

/**
 * 并行测试所有镜像源对 latest.json 的访问延迟，返回延迟最低的镜像。
 * 每个镜像只发一个 HEAD 请求（不下载 body），带 6 秒超时。
 * 所有镜像都失败时回退到用户当前设定的源。
 */
async function pickFastestMirror(
  endpoints: readonly string[],
  userMirror: UpdateMirror,
): Promise<UpdateMirror> {
  const allMirrors = UPDATE_MIRROR_OPTIONS.map((o) => o.id);
  const results = await Promise.all(
    allMirrors.map(async (m) => {
      const url = m === 'github' ? endpoints[0] : applyMirror(endpoints[0], m);
      const start = performance.now();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const resp = await fetch(url, {
          method: 'HEAD',
          cache: 'no-store',
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const elapsed = performance.now() - start;
        // HEAD 可能返回 405（部分镜像不支持 HEAD），但只要能连上就算可用
        return { mirror: m, elapsed, ok: resp.ok || resp.status === 405 };
      } catch {
        return { mirror: m, elapsed: Infinity, ok: false };
      }
    }),
  );

  // 过滤出能连通的，按延迟升序取最快
  const reachable = results.filter((r) => r.ok && r.elapsed < Infinity);
  if (reachable.length === 0) return userMirror;
  reachable.sort((a, b) => a.elapsed - b.elapsed);
  return reachable[0].mirror;
}

/** 将 GitHub 下载 URL 根据选择的镜像源进行转换 */
function applyMirror(url: string, mirror: UpdateMirror): string {
  if (mirror === 'github') return url;
  try {
    const u = new URL(url);
    if (u.hostname !== 'github.com' && !u.hostname.endsWith('.github.com')) return url;
    const pathname = u.pathname;
    switch (mirror) {
      case 'ghproxy':
        return `https://ghproxy.com/${url}`;
      case 'ghmirror':
        return `https://gh-api.com/${url}`;
      case 'kgithub':
        return `https://kgithub.com${pathname}`;
      default:
        return url;
    }
  } catch {
    return url;
  }
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

  // 2) 如首选没拿到 size，依次 fallback 各镜像（仅在未取到任何 size 时）
  if (Object.keys(sizes).length === 0) {
    const fallbacks: UpdateMirror[] =
      mirror === 'github'
        ? ['ghproxy', 'ghmirror', 'kgithub']
        : (['github', 'ghproxy', 'ghmirror', 'kgithub'] as UpdateMirror[]).filter(
            (m) => m !== mirror,
          );
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
