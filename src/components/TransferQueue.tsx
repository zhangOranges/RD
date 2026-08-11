import { useState } from 'react';
import { X, CheckCircle, AlertCircle, Ban, FolderOpen, Trash2 } from 'lucide-react';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { ask } from '@tauri-apps/plugin-dialog';
import { useTransferStore, formatBytes, formatSpeed } from '../store/transferStore';
import { useToastStore } from './Toast';
import type { TransferTask, TransferKind } from '../types';

/**
 * 右侧面板 - 传输队列区（常驻面板版）
 * 上传 / 下载标签切换，按标签过滤展示任务，支持取消与清除已完成。
 */
export function TransferQueue() {
  const tasks = useTransferStore((s) => s.tasks);
  const cancelTask = useTransferStore((s) => s.cancelTask);
  const clearFinished = useTransferStore((s) => s.clearFinished);
  const clearAll = useTransferStore((s) => s.clearAll);

  const [activeTab, setActiveTab] = useState<TransferKind>('upload');

  const uploadCount = tasks.filter((t) => t.kind === 'upload').length;
  const downloadCount = tasks.filter((t) => t.kind === 'download').length;
  const filtered = tasks.filter((t) => t.kind === activeTab);

  const hasFinished = tasks.some(
    (t) => t.status === 'completed' || t.status === 'error' || t.status === 'canceled',
  );

  return (
    <section className="rp-section" onContextMenu={(e) => e.preventDefault()}>
      <div className="rp-section-title">传输队列</div>
      <div className="rp-clear-actions">
        <button
          type="button"
          className="rp-clear-btn"
          disabled={!hasFinished}
          onClick={() => clearFinished()}
        >
          清除已完成
        </button>
        <button
          type="button"
          className="rp-clear-btn rp-clear-all-btn"
          disabled={tasks.length === 0}
          onClick={async () => {
            if (tasks.some((t) => t.status === 'running' || t.status === 'queued')) {
              const ok = await ask('有正在进行的传输任务，确定要清空全部吗？', {
                title: '确认清空全部',
                kind: 'warning',
                okLabel: '确认清空',
                cancelLabel: '取消',
              });
              if (!ok) return;
            }
            clearAll();
          }}
        >
          <Trash2 size={11} />
          清空全部
        </button>
      </div>
      <div className="rp-tabs">
        <button
          type="button"
          className={`rp-tab ${activeTab === 'upload' ? 'active' : ''}`}
          onClick={() => setActiveTab('upload')}
        >
          上传
          <span className="rp-tab-badge">{uploadCount}</span>
        </button>
        <button
          type="button"
          className={`rp-tab ${activeTab === 'download' ? 'active' : ''}`}
          onClick={() => setActiveTab('download')}
        >
          下载
          <span className="rp-tab-badge">{downloadCount}</span>
        </button>
      </div>

      <div className="rp-task-list">
        {filtered.length === 0 ? (
          <div className="rp-empty">暂无任务</div>
        ) : (
          filtered.map((t) => (
            <TaskItem key={t.id} task={t} onCancel={() => cancelTask(t.id)} />
          ))
        )}
      </div>
    </section>
  );
}

/**
 * 打开下载文件/目录所在的文件夹，并高亮选中。
 * 逻辑与 TransferNotification 中的 revealDownloaded 保持一致。
 */
async function revealDownloaded(task: TransferTask) {
  const pushToast = useToastStore.getState().push;
  if (!task.localPath || !task.name) return;
  const sep = task.localPath.includes('\\') ? '\\' : '/';
  const target = `${task.localPath.replace(/[\\/]$/, '')}${sep}${task.name}`;
  const exists = async (p: string): Promise<boolean> => {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke<{ ok: boolean }>('__noop_check_exists', { path: p }).catch(() => null);
      if (res && typeof res.ok === 'boolean') return res.ok;
      return true; // fallback: 兜底认为存在，交给 opener 自行处理
    } catch {
      return true;
    }
  };
  try {
    await revealItemInDir(target);
  } catch (e) {
    // 若文件不存在，打开父目录作为兜底
    try {
      await revealItemInDir(task.localPath);
      if (!await exists(target)) {
        pushToast('warning', `文件已被删除，已为你打开所在文件夹：${task.name}`);
        return;
      }
    } catch {
      // ignore second error
    }
    console.error('reveal download failed', e, 'target:', target);
    pushToast('error', `无法打开文件夹：${task.name}`);
  }
}

function TaskItem({ task, onCancel }: { task: TransferTask; onCancel: () => void }) {
  const pct =
    task.totalBytes > 0
      ? Math.min(100, Math.round((task.bytesTransferred / task.totalBytes) * 100))
      : 0;

  const isRunning = task.status === 'running';
  const isQueued = task.status === 'queued';

  let statusNode: React.ReactNode;
  if (isQueued) {
    statusNode = <span className="rp-task-status queued">等待中</span>;
  } else if (isRunning) {
    statusNode = <span className="rp-task-status running">{pct}%</span>;
  } else if (task.status === 'completed') {
    statusNode = (
      <span className="rp-task-status completed">
        <CheckCircle size={11} /> 完成
      </span>
    );
  } else if (task.status === 'error') {
    statusNode = (
      <span className="rp-task-status error" title={task.errorMessage}>
        <AlertCircle size={11} /> 失败
      </span>
    );
  } else {
    statusNode = (
      <span className="rp-task-status canceled">
        <Ban size={11} /> 已取消
      </span>
    );
  }

  return (
    <div className="rp-task-item">
      <div className="rp-task-header">
        <span className="rp-task-name" title={task.name}>
          {task.name}
        </span>
        {task.kind === 'download' && task.status === 'completed' && (
          <button
            type="button"
            className="rp-task-reveal"
            title="在文件夹中显示"
            onClick={() => void revealDownloaded(task)}
          >
            <FolderOpen size={12} />
          </button>
        )}
        {(isRunning || isQueued) && (
          <button
            type="button"
            className="rp-task-cancel"
            title="取消传输"
            onClick={onCancel}
          >
            <X size={12} />
          </button>
        )}
      </div>
      <div className={`rp-task-progress${isQueued ? ' is-queued' : ''}`}>
        <div className="rp-task-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="rp-task-info">
        <span className="rp-task-info-left">
          <span title="文件大小">{formatBytes(task.totalBytes)}</span>
          {isRunning && task.speedBytesPerSec > 0 && (
            <span title="传输速度">{formatSpeed(task.speedBytesPerSec)}</span>
          )}
        </span>
        {statusNode}
      </div>
    </div>
  );
}
