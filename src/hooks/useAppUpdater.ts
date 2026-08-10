import { useCallback, useEffect, useRef, useState } from 'react';
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

export function useAppUpdater() {
  const [state, setState] = useState<AppUpdaterState>(() => ({
    ...DEFAULT_STATE,
    mirror: getUpdateMirror(),
  }));
  const updateRef = useRef<Update | null>(null);
  const installingRef = useRef(false);
  const platformSizesRef = useRef<Record<string, number>>({});

  const changeMirror = useCallback((m: UpdateMirror) => {
    setUpdateMirror(m);
    setState((s) => ({ ...s, mirror: m }));
  }, []);

  const hideDialog = useCallback(() => {
    setState((s) => ({ ...s, dialogVisible: false }));
  }, []);

  const showDialog = useCallback(() => {
    setState((s) => (s.status === 'available' ? { ...s, dialogVisible: true } : s));
  }, []);

  const doCheck = useCallback(
    async (showNoUpdateToast = false) => {
      if (installingRef.current) return;

      let cur = state.currentVersion;
      if (!cur && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        try {
          cur = await getVersion();
        } catch {
          cur = null;
        }
      }

      setState((s) => {
        if (s.status === 'checking' || s.status === 'downloading') return s;
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
            .__TAURI_UPDATER_ENDPOINTS__ ?? defaultEndpoints;
        const endpoints =
          tauriEndpoints && tauriEndpoints.length > 0 ? tauriEndpoints : defaultEndpoints;

        const mirrorNow = getUpdateMirror();
        const { sizes, notes, version: metaVersion } = await fetchLatestMeta(
          endpoints,
          mirrorNow,
        );
        platformSizesRef.current = sizes;

        const update = await checkUpdater({ timeout: 8000 });
        if (!update) {
          setState((s) => ({
            ...DEFAULT_STATE,
            mirror: s.mirror,
            status: 'idle',
            currentVersion: s.currentVersion || cur || null,
          }));
          if (showNoUpdateToast) {
            showToast({ type: 'info', message: '已经是最新版本', duration: 2500 });
          }
          return;
        }
        updateRef.current = update;

        setState((s) => ({
          ...s,
          status: 'available',
          currentVersion: s.currentVersion || cur || update.currentVersion || null,
          availableVersion: update.version || metaVersion || null,
          releaseNotes: notes,
          dialogVisible: true,
          errorMsg: null,
          downloadedMB: 0,
          progressPct: 0,
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setState((s) => ({
          ...s,
          status: 'error',
          errorMsg: msg,
          downloadedMB: 0,
          progressPct: 0,
        }));
        if (showNoUpdateToast) {
          showToast({ type: 'error', message: `检查更新失败：${msg}`, duration: 5000 });
        }
      }
    },
    [state.currentVersion],
  );

  const doDownloadAndInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update || installingRef.current) return;
    installingRef.current = true;

    setState((s) => ({
      ...s,
      dialogVisible: false,
      status: 'downloading',
      errorMsg: null,
      downloadedMB: 0,
      progressPct: 0,
    }));

    try {
      // 1. 计算/查找本次更新的真实文件大小（字节）
      const platformKey = detectPlatformKey();
      const realSize =
        platformKey && platformSizesRef.current[platformKey]
          ? platformSizesRef.current[platformKey]
          : null;

      // 默认估算：没取到真实 size 时用一个保守值，避免进度"看起来太慢"
      const FALLBACK_SIZE = 80 * 1024 * 1024;

      // 使用对象引用，让 Started 回调可把最终值写回 Progress 可见的位置
      const currentTotalRef: { v: number } = {
        v: realSize && realSize > 0 ? realSize : FALLBACK_SIZE,
      };
      const hasRealSize = realSize && realSize > 0;
      const totalMB = hasRealSize ? (realSize as number) / (1024 * 1024) : null;
      setState((s) => ({
        ...s,
        totalMB: totalMB ? Math.round(totalMB * 10) / 10 : null,
      }));

      let downloaded = 0;
      // clProvided 放在回调外层，Started 回调中更新，Progress 中读取
      let clProvided = false;

      await update.downloadAndInstall(
        (event: DownloadEvent) => {
          switch (event.event) {
            case 'Started': {
              // 尝试从事件中读取 contentLength（部分版本的 updater 事件会提供）
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
              const finalTotal =
                cl && cl > 0 ? cl : currentTotalRef.v;
              currentTotalRef.v = finalTotal;
              const finalMB = finalTotal / (1024 * 1024);
              setState((s) => ({
                ...s,
                downloadedMB: 0,
                progressPct: 0,
                totalMB: Math.round(finalMB * 10) / 10,
              }));
              break;
            }
            case 'Progress': {
              downloaded += event.data.chunkLength;
              const total = currentTotalRef.v;
              const mb = downloaded / (1024 * 1024);
              // 有真实/准确大小时：最多 99%，Finished 置 100%
              // 估算大小时：最多 95%，避免"超过 100%" 的不自然
              const ceiling = hasRealSize || clProvided ? 99 : 95;
              const pct = Math.min(
                ceiling,
                Math.max(1, Math.round((downloaded / total) * 100)),
              );
              setState((s) => ({
                ...s,
                downloadedMB: Math.round(mb * 10) / 10,
                progressPct: Math.max(s.progressPct, pct),
              }));
              break;
            }
            case 'Finished':
              setState((s) => ({
                ...s,
                status: 'installing',
                progressPct: 100,
              }));
              break;
          }
        },
        { timeout: 5 * 60 * 1000 },
      );

      setState((s) => ({ ...s, status: 'done', progressPct: 100 }));
      showToast({
        type: 'success',
        message: '更新完成，程序即将自动重启',
        duration: 4000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, status: 'error', errorMsg: msg }));
      showToast({ type: 'error', message: `更新失败：${msg}`, duration: 5000 });
      installingRef.current = false;
    }
  }, []);

  // 启动自动检查（仅 release 打包后环境）
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    if (isDevProfile()) return;
    void doCheck(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    ...state,
    check: () => doCheck(true),
    install: doDownloadAndInstall,
    dismissError: () =>
      setState((s) => ({
        ...s,
        status: s.status === 'error' ? 'idle' : s.status,
        errorMsg: null,
      })),
    hideDialog,
    showDialog,
    changeMirror,
    isDev: isDevProfile(),
  };
}
