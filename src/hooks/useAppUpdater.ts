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

export interface AppUpdaterState {
  status: UpdateStatus;
  availableVersion: string | null;
  currentVersion: string | null;
  /** 已下载 MB，用于 UI 显示 */
  downloadedMB: number;
  /** 0~100，不知道总大小时按递增增量显示一条假进度线 */
  progressPct: number;
  errorMsg: string | null;
}

const DEFAULT_STATE: AppUpdaterState = {
  status: 'idle',
  availableVersion: null,
  currentVersion: null,
  downloadedMB: 0,
  progressPct: 0,
  errorMsg: null,
};

/**
 * 判断当前是否为开发/调试模式：
 * 1. import.meta.env.DEV 由 Vite 注入（前端 dev server 一定是 true）
 * 2. location.protocol !== 'tauri:' 也是 dev（t dev 时 Vite 用 http://localhost:1420 提供页面）
 */
function isDevProfile(): boolean {
  if (typeof window === 'undefined') return false;
  const viteDev = !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
  const httpHosted = typeof location !== 'undefined' && location.protocol !== 'tauri:';
  return viteDev || httpHosted;
}

/**
 * 封装 Tauri updater 检查/下载/安装流程。
 *
 * 踩坑记录：
 * 1. `check()` 返回的 `Update` 对象带有私有字段，不能放进 React 响应式 state（会被 Proxy 包裹）。
 *    这里用 `updateRef` 保存原始对象，state 中只暴露纯数据字段供 UI 使用。
 * 2. `DownloadEvent.Progress.data` 只有 `chunkLength`（本次增量字节数），没有 `contentLength`，
 *    只能自己累计已下载字节数，按「估算上限 * 0.9 + 已达 Finished 就直接 100」的策略显示进度条。
 * 3. 自动检查只在打包后的 release profile 中执行，dev 模式下 GitHub `/releases/latest/download/latest.json`
 *    多半是 404，为避免反复弹「检查更新失败」干扰开发，启动期静默跳过。
 */
export function useAppUpdater() {
  const [state, setState] = useState<AppUpdaterState>(DEFAULT_STATE);
  const updateRef = useRef<Update | null>(null);
  const installingRef = useRef(false);

  const doCheck = useCallback(async (showNoUpdateToast = false) => {
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
        status: 'checking',
        currentVersion: s.currentVersion || cur || null,
      };
    });

    try {
      // 8 秒超时，避免 GitHub 网络不通时一直僵在 checking 状态
      const update = await checkUpdater({ timeout: 8000 });
      if (!update) {
        setState((s) => ({
          ...DEFAULT_STATE,
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
        availableVersion: update.version || null,
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
  }, [state.currentVersion]);

  const doDownloadAndInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update || installingRef.current) return;
    installingRef.current = true;

    setState((s) => ({
      ...s,
      status: 'downloading',
      errorMsg: null,
      downloadedMB: 0,
      progressPct: 0,
    }));

    try {
      // 估算一个「足够大的包大小上限」用于绘制进度条（updater 不给 contentLength）：
      //   - Windows nsis/msi 一般 ~80MB
      //   - macOS dmg ~120MB
      //   - Linux AppImage ~140MB
      // 超过上限时进度条按 95% 停留，等 Finished 事件再到 100%，视觉体验更合理。
      const estimatedMax = 180 * 1024 * 1024;
      let downloaded = 0;

      await update.downloadAndInstall(
        (event: DownloadEvent) => {
          switch (event.event) {
            case 'Started':
              downloaded = 0;
              setState((s) => ({ ...s, downloadedMB: 0, progressPct: 0 }));
              break;
            case 'Progress': {
              downloaded += event.data.chunkLength;
              const mb = downloaded / (1024 * 1024);
              const pct = Math.min(
                95,
                Math.round((downloaded / estimatedMax) * 100),
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
        { timeout: 5 * 60 * 1000 }, // 下载阶段 5 分钟超时（防止大文件无限挂起）
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
    /** 用于 StatusBar 在 dev 模式隐藏更新入口，避免每次点必失败 */
    isDev: isDevProfile(),
  };
}
