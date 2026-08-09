import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import type {
  TransferProgressPayload,
  TransferStatus,
  TransferTask,
} from '../types';

// ---- 持久化：将已完成的传输任务保存到 localStorage，重启后可查看 ----
const STORAGE_KEY = 'transfer_tasks_v1';
const MAX_PERSIST = 50; // 最多持久化 50 条，避免无限增长

function loadPersistedTasks(): TransferTask[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as TransferTask[];
    if (!Array.isArray(arr)) return [];
    // 重启后 running 状态的任务已不可能还在跑，标记为 error
    return arr.map((t) =>
      t.status === 'running' || t.status === 'queued'
        ? { ...t, status: 'error' as TransferStatus, errorMessage: '应用重启，传输中断' }
        : t,
    );
  } catch {
    return [];
  }
}

function persistTasks(tasks: TransferTask[]) {
  try {
    // 只持久化已完成的任务（running 的重启后也恢复不了）
    const finished = tasks.filter(
      (t) => t.status === 'completed' || t.status === 'error' || t.status === 'canceled',
    );
    // 按 startedAt 倒序，只保留最近 MAX_PERSIST 条
    const sorted = finished.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_PERSIST);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sorted));
  } catch {
    // localStorage 不可用时静默忽略
  }
}

interface TransferState {
  /** 全部任务（包括已完成/失败），按 startedAt 倒序。 */
  tasks: TransferTask[];
  /** 详情弹窗是否可见。 */
  panelVisible: boolean;
  /** 是否有未读通知（有新的进行中/完成/错误消息且用户尚未打开面板）。 */
  hasUnread: boolean;

  /** 注册一个新任务（前端创建任务即调用此函数）。 */
  createTask: (t: Omit<TransferTask, 'status' | 'bytesTransferred' | 'speedBytesPerSec' | 'startedAt' | 'finishedAt'> & { status?: TransferStatus }) => void;
  /** 来自 Rust 后端的进度事件处理。 */
  onProgress: (p: TransferProgressPayload) => void;
  /** 切换详情面板显示。 */
  togglePanel: () => void;
  setPanelVisible: (v: boolean) => void;
  /** 清除已完成 / 错误 / 取消 的历史任务。 */
  clearFinished: () => void;
  /** 根据 id 手动更新任务状态（用于前端侧状态迁移，如 cancel）。 */
  setTaskStatus: (id: string, status: TransferStatus, extra?: Partial<TransferTask>) => void;
  /**
   * 取消一个进行中的任务：
   *  - 下载：通知 Rust 端取消循环，下一块读取立即中断并上报 canceled
   *  - 上传：invoke('sftp_write_file') 已经在跑时无法中途取消；只能标记 canceled，并在 invoke 返回时丢弃成功结果
   */
  cancelTask: (id: string) => void;
  /** 正在进行中的任务数量。 */
  readonly activeCount: number;
  /** 监听 Rust 事件的解绑函数，由 App 调用。 */
  _unlisten?: () => void;
}

/** 生成一个简短的唯一任务 id。 */
export function genTaskId(): string {
  return 't_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** 格式化字节大小（在 store 内集中处理，避免各处重复写）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 0 || !isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${Math.round(v)} ${units[i]}`;
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** 格式化速度：B/s、KB/s、MB/s、GB/s。 */
export function formatSpeed(bps: number): string {
  if (!isFinite(bps) || bps <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = bps;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/** 格式化耗时（毫秒 -> "12s" / "1m23s" / "2h5m"）。 */
export function formatDuration(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return '0s';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s}s`;
  return `${s}s`;
}

/** 为每个任务维护速度采样窗口，不放进 zustand state（避免频繁 set 抖动）。 */
const speedSampler = new Map<string, { lastBytes: number; lastTime: number; ema: number }>();

/** EMA 平滑常数。 */
const EMA_ALPHA = 0.35;

function estimateSpeed(taskId: string, bytes: number, nowMs: number): number {
  const prev = speedSampler.get(taskId);
  if (!prev) {
    speedSampler.set(taskId, { lastBytes: bytes, lastTime: nowMs, ema: 0 });
    return 0;
  }
  const dt = (nowMs - prev.lastTime) / 1000;
  let instant = 0;
  if (dt > 0.001) {
    instant = Math.max(0, (bytes - prev.lastBytes) / dt);
  }
  const ema = prev.ema === 0 ? instant : EMA_ALPHA * instant + (1 - EMA_ALPHA) * prev.ema;
  speedSampler.set(taskId, { lastBytes: bytes, lastTime: nowMs, ema });
  return ema;
}

export const useTransferStore = create<TransferState>((set, get) => ({
  tasks: loadPersistedTasks(),
  panelVisible: false,
  hasUnread: false,

  get activeCount() {
    return get().tasks.filter((t) => t.status === 'running' || t.status === 'queued').length;
  },

  createTask: (t) => {
    const now = Date.now();
    const task: TransferTask = {
      id: t.id,
      kind: t.kind,
      hostId: t.hostId,
      name: t.name,
      remotePath: t.remotePath,
      localPath: t.localPath,
      status: t.status ?? 'running',
      bytesTransferred: 0,
      totalBytes: t.totalBytes ?? 0,
      speedBytesPerSec: 0,
      startedAt: now,
      finishedAt: 0,
      errorMessage: undefined,
    };
    set((s) => {
      const tasks = [task, ...s.tasks];
      persistTasks(tasks);
      // 新任务（running/queued）创建时，如果面板没打开就标为未读红点
      const hasUnread =
        !s.panelVisible && (task.status === 'running' || task.status === 'queued')
          ? true
          : s.hasUnread;
      return { tasks, hasUnread };
    });
  },

  onProgress: (p) => {
    const now = Date.now();
    set((s) => {
      const idx = s.tasks.findIndex((t) => t.id === p.taskId);
      if (idx < 0) {
        // 未注册的 task：不处理（正常流程一定会先 createTask）
        return s;
      }
      const old = s.tasks[idx];
      const speed = estimateSpeed(p.taskId, p.bytesTransferred, now);
      let status: TransferStatus = old.status;
      let finishedAt = old.finishedAt;
      let errMsg = old.errorMessage;
      let hasUnread = s.hasUnread;
      if (p.status === 'running') {
        // 面板未打开且从未标记过 running，视为新通知
        if (!s.panelVisible && old.status !== 'running') hasUnread = true;
        status = 'running';
      } else if (p.status === 'completed') {
        if (!s.panelVisible && status !== 'completed') hasUnread = true;
        status = 'completed';
        finishedAt = now;
      } else if (p.status === 'canceled') {
        if (!s.panelVisible && status !== 'canceled') hasUnread = true;
        status = 'canceled';
        finishedAt = now;
        errMsg = p.message ?? '已取消';
      } else if (p.status === 'error') {
        if (!s.panelVisible && status !== 'error') hasUnread = true;
        status = 'error';
        finishedAt = now;
        errMsg = p.message;
      }
      const total = p.totalBytes > 0 ? p.totalBytes : old.totalBytes;
      const updated: TransferTask = {
        ...old,
        name: p.name || old.name,
        bytesTransferred: p.bytesTransferred,
        totalBytes: total,
        speedBytesPerSec: speed,
        status,
        finishedAt,
        errorMessage: errMsg,
      };
      const tasks = s.tasks.slice();
      tasks[idx] = updated;
      persistTasks(tasks);
      return { tasks, hasUnread };
    });
  },

  togglePanel: () =>
    set((s) => {
      const newVisible = !s.panelVisible;
      return { panelVisible: newVisible, hasUnread: newVisible ? false : s.hasUnread };
    }),
  setPanelVisible: (v) =>
    set((s) => ({
      panelVisible: v,
      hasUnread: v ? false : s.hasUnread,
    })),

  clearFinished: () =>
    set((s) => {
      const tasks = s.tasks.filter((t) => t.status === 'running' || t.status === 'queued');
      persistTasks(tasks);
      return { tasks, hasUnread: false };
    }),

  setTaskStatus: (id, status, extra) => {
    set((s) => {
      const idx = s.tasks.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const tasks = s.tasks.slice();
      const oldTask = tasks[idx];
      const finishedAt =
        (status === 'completed' || status === 'error' || status === 'canceled') &&
        tasks[idx].finishedAt === 0
          ? Date.now()
          : tasks[idx].finishedAt;
      // 面板未打开：任何状态切换到 finished（含 canceled）或 running 都标未读
      let hasUnread = s.hasUnread;
      if (!s.panelVisible) {
        const isFinished =
          status === 'completed' || status === 'error' || status === 'canceled';
        const wasFinished =
          oldTask.status === 'completed' || oldTask.status === 'error' || oldTask.status === 'canceled';
        if ((isFinished && !wasFinished) || (status === 'running' && oldTask.status !== 'running')) {
          hasUnread = true;
        }
      }
      tasks[idx] = { ...tasks[idx], status, finishedAt, ...(extra ?? {}) };
      persistTasks(tasks);
      return { tasks, hasUnread };
    });
  },

  cancelTask: (id) => {
    // 先在前端即时标为 canceled（作为 UI 兜底，避免 Rust 端还没响应时显示在跑）
    const st = useTransferStore.getState();
    const task = st.tasks.find((t) => t.id === id);
    if (!task) return;
    if (task.status !== 'running' && task.status !== 'queued') return;
    st.setTaskStatus(id, 'canceled', { errorMessage: '已取消' });
    // 通知 Rust 端从下一块读取处立即中断下载
    if (typeof window !== 'undefined') {
      import('@tauri-apps/api/core')
        .then(({ invoke }) => invoke('sftp_cancel_transfer', { taskId: id }))
        .catch(() => {});
    }
  },
}));

/**
 * 在 App 引导时注册一次全局 `transfer-progress` 事件监听。
 * 返回解绑函数，组件卸载时（实际是 App 整个生命周期）可调用。
 */
export async function bindTransferProgressListener(): Promise<() => void> {
  const existing = useTransferStore.getState()._unlisten;
  if (existing) return existing;

  const unlisten = await listen<TransferProgressPayload>('transfer-progress', (ev) => {
    useTransferStore.getState().onProgress(ev.payload);
  });
  useTransferStore.setState({ _unlisten: unlisten });
  return unlisten;
}
