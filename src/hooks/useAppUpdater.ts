import { useCallback, useEffect, useRef, useState } from 'react';
import {
  check as checkUpdater,
  type Update,
  type DownloadEvent,
} from '@tauri-apps/plugin-updater';
import { showToast } from '../components/Toast';

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
  progressPct: number;
  errorMsg: string | null;
}

const DEFAULT_STATE: AppUpdaterState = {
  status: 'idle',
  availableVersion: null,
  currentVersion: null,
  progressPct: 0,
  errorMsg: null,
};

/**
 * 封装 Tauri updater 检查/下载/安装流程。
 * - 注意：`check()` 返回的 Update 对象带有私有字段，不要放进 React 响应式 state，
 *   否则会触发 "Cannot read private member of class"。
 *   这里用 ref 保存原始对象，state 中只暴露纯数据字段用于 UI。
 */
export function useAppUpdater() {
  const [state, setState] = useState<AppUpdaterState>(DEFAULT_STATE);
  // 注意用 ref 保存 check() 返回值，避免被 Proxy 包裹
  const updateRef = useRef<Update | null>(null);
  const installingRef = useRef(false);

  const doCheck = useCallback(async (showNoUpdateToast = false) => {
    if (installingRef.current) return;
    // 检查中不做多余重复
    setState((s) => {
      if (s.status === 'checking' || s.status === 'downloading') return s;
      return {
        ...DEFAULT_STATE,
        status: 'checking',
        currentVersion: s.currentVersion,
      };
    });

    try {
      const update = await checkUpdater();
      if (!update) {
        setState((s) => ({
          ...DEFAULT_STATE,
          status: 'idle',
          currentVersion: s.currentVersion,
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
        currentVersion: s.currentVersion,
        availableVersion: update.version || null,
        errorMsg: null,
        progressPct: 0,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({
        ...s,
        status: 'error',
        errorMsg: msg,
        progressPct: 0,
      }));
      showToast({ type: 'error', message: `检查更新失败：${msg}`, duration: 4000 });
    }
  }, []);

  const doDownloadAndInstall = useCallback(async () => {
    const update = updateRef.current;
    if (!update || installingRef.current) return;
    installingRef.current = true;

    setState((s) => ({ ...s, status: 'downloading', errorMsg: null, progressPct: 0 }));

    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        switch (event.event) {
          case 'Started': {
            setState((s) => ({ ...s, progressPct: 0 }));
            break;
          }
          case 'Progress': {
            const { chunkLength, contentLength } = event.data as {
              chunkLength: number;
              contentLength?: number;
            };
            setState((s) => {
              const prev = s.progressPct;
              if (!contentLength) return { ...s, progressPct: prev };
              const ratio = chunkLength / contentLength;
              const next = Math.min(99, Math.max(prev, Math.round(ratio * 100)));
              return { ...s, progressPct: next };
            });
            break;
          }
          case 'Finished': {
            setState((s) => ({ ...s, status: 'installing', progressPct: 100 }));
            break;
          }
        }
      });
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

  // 启动即自动静默检查一次（不弹 toast）
  useEffect(() => {
    // 只在 Tauri 环境执行（浏览器开发时直接跳过，避免报错）
    if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      void doCheck(false);
    }
  }, [doCheck]);

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
  };
}
