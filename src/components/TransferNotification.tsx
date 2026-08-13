import { useEffect, useRef } from 'react';
import {
  Download,
  Upload,
  Bell,
  X,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Trash2,
  Clock,
  Gauge,
  FolderOpen,
} from 'lucide-react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { exists } from '@tauri-apps/plugin-fs';
import {
  useTransferStore,
  formatBytes,
  formatSpeed,
  formatDuration,
} from '../store/transferStore';
import { useToastStore } from './Toast';
import { logError } from '../utils/log';
import type { TransferTask } from '../types';
import '../styles/transfer.css';

/**
 * 右上角传输通知：
 *  - 铃铛图标按钮（常驻 toolbar，带红点 / 数字 badge）
 *  - 点击展开抽屉式面板，列出所有上传/下载任务：
 *      · 进度条（占比 %）
 *      · 当前速度
 *      · 总耗时 / 剩余时间估算
 *      · 状态徽标（进行中 / 已完成 / 失败）
 *  - 底部"清除历史"按钮
 */
export function TransferNotification() {
  const tasks = useTransferStore((s) => s.tasks);
  const panelVisible = useTransferStore((s) => s.panelVisible);
  const togglePanel = useTransferStore((s) => s.togglePanel);
  const setPanelVisible = useTransferStore((s) => s.setPanelVisible);
  const clearFinished = useTransferStore((s) => s.clearFinished);
  const activeCount = useTransferStore((s) => s.activeCount);
  const hasUnread = useTransferStore((s) => s.hasUnread);

  const panelRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  // 点击面板外关闭
  useEffect(() => {
    if (!panelVisible) return;
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (panelRef.current && panelRef.current.contains(target)) return;
      if (btnRef.current && btnRef.current.contains(target)) return;
      setPanelVisible(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setPanelVisible(false);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [panelVisible, setPanelVisible]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`toolbar-btn tn-trigger ${activeCount > 0 ? 'tn-trigger-active' : ''}`}
        title="传输进度"
        aria-label="传输进度"
        onClick={() => togglePanel()}
      >
        <Bell size={16} />
        {/* 进行中任务：显示数字 badge */}
        {activeCount > 0 && (
          <span className="tn-badge" aria-hidden>
            {activeCount}
          </span>
        )}
        {/* 无进行中任务但有未读通知：显示红点 */}
        {activeCount === 0 && hasUnread && (
          <span className="tn-badge tn-badge-dot" aria-hidden />
        )}
        {activeCount > 0 && <span className="tn-pulse" aria-hidden />}
      </button>

      {panelVisible && (
        <div
          ref={panelRef}
          className="tn-panel"
          role="dialog"
          aria-label="传输进度"
        >
          <div className="tn-panel-header">
            <div className="tn-panel-title">
              <Bell size={14} />
              <span>传输进度</span>
              {activeCount > 0 && (
                <span className="tn-panel-subtitle">{activeCount} 个进行中</span>
              )}
            </div>
            <div className="tn-panel-actions">
              <button
                type="button"
                className="tn-action-btn"
                title="清除已完成任务"
                onClick={() => clearFinished()}
              >
                <Trash2 size={12} />
                <span>清除历史</span>
              </button>
              <button
                type="button"
                className="tn-action-btn"
                title="关闭"
                onClick={() => setPanelVisible(false)}
              >
                <X size={14} />
              </button>
            </div>
          </div>

          <div className="tn-panel-body">
            {tasks.length === 0 && (
              <div className="tn-empty">
                <Clock size={26} className="tn-empty-icon" />
                <div className="tn-empty-text">暂无传输任务</div>
                <div className="tn-empty-sub">上传或下载的进度会显示在这里</div>
              </div>
            )}
            {tasks.length > 0 &&
              tasks.map((t) => (
                <TransferTaskCard key={t.id} task={t} />
              ))}
          </div>
        </div>
      )}
    </>
  );
}

// ============================================================
// 单任务卡片
// ============================================================
function TransferTaskCard({ task }: { task: TransferTask }) {
  const pct =
    task.totalBytes > 0
      ? Math.min(100, Math.round((task.bytesTransferred / task.totalBytes) * 100))
      : 0;
  const elapsed =
    task.finishedAt > 0 ? task.finishedAt - task.startedAt : Date.now() - task.startedAt;
  const remaining = estimateRemaining(task);

  return (
    <div className={`tn-card tn-card-${task.status}`}>
      <div className="tn-card-head">
        <span className={`tn-kind tn-kind-${task.kind}`}>
          {task.kind === 'download' ? (
            <Download size={11} />
          ) : (
            <Upload size={11} />
          )}
          <span>{task.kind === 'download' ? '下载' : '上传'}</span>
        </span>
        <span className="tn-card-name" title={task.remotePath}>
          {task.name}
        </span>
        <div className="tn-card-head-right">
          {(task.status === 'running' || task.status === 'queued') && (
            <button
              type="button"
              className="tn-icon-btn tn-icon-btn-cancel"
              title="取消传输"
              onClick={() => useTransferStore.getState().cancelTask(task.id)}
            >
              <X size={13} />
            </button>
          )}
          {task.status === 'canceled' && task.errorMessage && (
            <span className="tn-card-error-inline tn-card-canceled-inline" title={task.errorMessage}>
              <AlertCircle size={11} />
            </span>
          )}
          {task.status === 'error' && task.errorMessage && (
            <span className="tn-card-error-inline" title={task.errorMessage}>
              <AlertCircle size={11} />
            </span>
          )}
          <StatusBadge status={task.status} />
          {task.kind === 'download' && task.status === 'completed' && (
            <button
              type="button"
              className="tn-icon-btn"
              title="在文件夹中显示"
              onClick={() => void revealDownloaded(task)}
            >
              <FolderOpen size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="tn-card-bar">
        <div className="tn-bar-track">
          <div
            className={`tn-bar-fill tn-bar-fill-${task.status}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        <span className="tn-bar-pct">{pct}%</span>
        <span className="tn-card-meta-inline">
          <span title="已传输 / 总量">
            {formatBytes(task.bytesTransferred)}
            {task.totalBytes > 0 && ` / ${formatBytes(task.totalBytes)}`}
          </span>
          {(task.status === 'running' || task.speedBytesPerSec > 0) && (
            <span title="当前速度" className="tn-meta-speed">
              <Gauge size={10} /> {formatSpeed(task.speedBytesPerSec)}
            </span>
          )}
          <span title="耗时">
            <Clock size={10} /> {formatDuration(elapsed)}
            {task.status === 'running' && remaining !== null && (
              <> · {remaining > 0 ? `剩 ${formatDuration(remaining * 1000)}` : '即将完成'}</>
            )}
          </span>
        </span>
      </div>
    </div>
  );
}

/**
 * 打开下载文件/目录所在的文件夹，并高亮选中。
 * 使用 plugin-opener 的 revealItemInDir。
 */
async function revealDownloaded(task: TransferTask) {
  if (!task.localPath || !task.name) return;
  // 下载的最终路径总是：<用户选择的目录> / <远程文件名或目录名>
  const sep = task.localPath.includes('\\') ? '\\' : '/';
  const target = `${task.localPath.replace(/[\\/]$/, '')}${sep}${task.name}`;
  try {
    // 先检查文件/目录是否仍存在
    const targetExists = await exists(target);
    if (!targetExists) {
      // 兜底：父目录可能还在，仅文件/目录本身被删
      const parentDir = task.localPath;
      const parentExists = await exists(parentDir).catch(() => false);
      if (parentExists) {
        // 父目录在，目标被删：打开父目录 + 友好提示
        await revealItemInDir(parentDir).catch(() => {});
        useToastStore
          .getState()
          .push('warning', `文件已被删除，已为你打开所在文件夹：${task.name}`);
      } else {
        // 连父目录都没了
        useToastStore
          .getState()
          .push('error', `下载路径已不存在：${task.name}`);
      }
      return;
    }
    await revealItemInDir(target);
  } catch (e) {
    logError(`reveal download failed: ${String(e)} target: ${target}`);
    useToastStore
      .getState()
      .push('error', `无法打开文件夹：${task.name}`);
  }
}

function StatusBadge({ status }: { status: TransferTask['status'] }) {
  switch (status) {
    case 'queued':
      return (
        <span className="tn-status tn-status-queued">
          <Clock size={11} /> 排队中
        </span>
      );
    case 'running':
      return (
        <span className="tn-status tn-status-running">
          <Loader2 size={11} className="is-spin" /> 传输中
        </span>
      );
    case 'completed':
      return (
        <span className="tn-status tn-status-completed">
          <CheckCircle2 size={11} /> 已完成
        </span>
      );
    case 'error':
      return (
        <span className="tn-status tn-status-error">
          <AlertCircle size={11} /> 失败
        </span>
      );
    case 'canceled':
      return (
        <span className="tn-status tn-status-canceled">
          <X size={11} /> 已取消
        </span>
      );
  }
}

function estimateRemaining(task: TransferTask): number | null {
  if (task.status !== 'running') return null;
  if (task.totalBytes <= 0) return null;
  if (task.speedBytesPerSec <= 0) return null;
  const remain = Math.max(0, task.totalBytes - task.bytesTransferred);
  return Math.round(remain / task.speedBytesPerSec);
}
