import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';
import { createPortal } from 'react-dom';
import {
  Folder,
  File as FileIcon,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  HardDrive,
  Upload,
  FolderOpen,
} from 'lucide-react';
import { useLocalFileStore, joinLocalPath, type LocalFileEntry } from '../store/localFileStore';
import { useHostStore } from '../store/hostStore';
import { useFileStore } from '../store/fileStore';
import { useTransferStore } from '../store/transferStore';
import { useToastStore } from './Toast';
import {
  uploadLocalItemsToRemote,
  type OverrideChoice,
} from '../utils/uploadFromLocal';
import '../styles/localfile.css';

const ROW_HEIGHT = 26;

// ---------- 工具函数 ----------

/** 将字节数格式化为人类可读字符串。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Unix 秒级时间戳 → `YYYY-MM-DD HH:mm`。 */
function formatTime(unixSec: number): string {
  if (!unixSec) return '';
  const d = new Date(unixSec * 1000);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 文件类型显示文本。 */
function typeLabel(fileType: 'dir' | 'file' | 'symlink'): string {
  if (fileType === 'dir') return '文件夹';
  if (fileType === 'symlink') return '链接';
  return '文件';
}

/** 将 Windows 路径拆分为面包屑分段，每段带可跳转的完整路径。 */
function buildBreadcrumbs(path: string): { name: string; path: string }[] {
  if (!path) return [];
  const parts = path.split('\\').filter(Boolean);
  const segments: { name: string; path: string }[] = [];
  parts.forEach((part, i) => {
    const subParts = parts.slice(0, i + 1);
    // 盘符段需要补回尾部反斜杠：C: → C:\
    const segPath = subParts.length === 1 ? `${subParts[0]}\\` : subParts.join('\\');
    segments.push({ name: part, path: segPath });
  });
  return segments;
}

export default function LocalFilePane() {
  const {
    currentPath,
    entries,
    loading,
    history,
    historyIndex,
    navigate,
    refresh,
    goBack,
    goForward,
    selectedNames,
    selectOne,
    clearSelection,
  } = useLocalFileStore();

  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const remoteCurrentPath = useFileStore((s) => s.currentPath);
  const createTransferTask = useTransferStore((s) => s.createTask);
  const cancelTransferTask = useTransferStore((s) => s.cancelTask);
  const pushToast = useToastStore((s) => s.push);

  const parentRef = useRef<HTMLDivElement | null>(null);
  const breadcrumbRef = useRef<HTMLDivElement | null>(null);

  // ---- 面包屑编辑模式 ----
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const pathInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingPath && pathInputRef.current) {
      pathInputRef.current.focus();
      pathInputRef.current.select();
    }
  }, [editingPath]);

  // 路径变化时自动滚动面包屑到最右侧，显示当前目录
  useEffect(() => {
    if (breadcrumbRef.current) {
      breadcrumbRef.current.scrollLeft = breadcrumbRef.current.scrollWidth;
    }
  }, [currentPath]);

  const enterPathEdit = useCallback(() => {
    setPathInput(currentPath ?? '');
    setEditingPath(true);
  }, [currentPath]);

  const commitPathEdit = useCallback(async () => {
    const target = pathInput.trim();
    setEditingPath(false);
    if (!target || target === currentPath) return;
    const ok = await navigate(target);
    if (!ok) {
      // navigate 内部已 toast 错误，无需重复提示
    }
  }, [pathInput, currentPath, navigate]);

  const cancelPathEdit = useCallback(() => {
    setEditingPath(false);
  }, []);

  // ---- 右键菜单状态 ----
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    kind: 'entry' | 'blank';
    entry?: LocalFileEntry;
  } | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    function onDocClick(e: MouseEvent) {
      if (ctxMenuRef.current && ctxMenuRef.current.contains(e.target as Node)) return;
      setCtxMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setCtxMenu(null);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  // 菜单显示后二次定位（若超出视口右/下边缘则反方向偏移），并确保完全在视口内
  useEffect(() => {
    if (!ctxMenu) return;
    const el = ctxMenuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let x = ctxMenu.x;
    let y = ctxMenu.y;
    if (x + rect.width > window.innerWidth) x = Math.max(0, window.innerWidth - rect.width - 4);
    if (y + rect.height > window.innerHeight) y = Math.max(0, window.innerHeight - rect.height - 4);
    if (x !== ctxMenu.x || y !== ctxMenu.y) {
      el.style.transform = `translate(${x}px, ${y}px)`;
    }
  }, [ctxMenu]);

  // ---- 上传逻辑 ----
  // 上传支持并发：每次调用创建独立的 override ref，避免任务之间状态串扰
  // 不需要 uploading 锁；传输队列以任务为单位独立管理

  const uploadSelectedToRemote = useCallback(
    async () => {
      if (!currentPath) {
        pushToast('warning', '请先打开本地目录');
        return;
      }
      if (!selectedHostId) {
        pushToast('warning', '请先连接远程主机');
        return;
      }
      const connState = connectionStates[selectedHostId];
      if (connState !== 'connected') {
        pushToast('warning', '远程未连接，请先连接主机');
        return;
      }
      if (!remoteCurrentPath) {
        pushToast('warning', '请先在远程打开目标目录');
        return;
      }

      // 上传源：当前多选集合（右击时 openEntryMenu 已保证右击项在选中集合内）
      const sourceEntries = entries.filter((e) => selectedNames.has(e.name));
      if (sourceEntries.length === 0) {
        pushToast('warning', '请先选中要上传的文件或文件夹');
        return;
      }

      setCtxMenu(null);

      // 为本次上传创建独立的 override 作用域（并发上传之间互不影响）
      const overrideRef: { current: OverrideChoice } = { current: 'ask' };

      const taskName =
        sourceEntries.length === 1 ? sourceEntries[0].name : `${sourceEntries.length} 项`;

      try {
        const { successes, skipped, errors } = await uploadLocalItemsToRemote(
          selectedHostId,
          remoteCurrentPath,
          currentPath,
          sourceEntries,
          {
            pushToast,
            createTransferTask,
            cancelTransferTask,
            globalOverrideRef: overrideRef,
            setGlobalOverride: (v) => { overrideRef.current = v; },
            remoteEntriesCheck: (topName) =>
              useFileStore.getState().entries.some((en) => en.name === topName),
            refreshRemote: async () => {
              await useFileStore.getState().refresh(selectedHostId);
            },
          },
        );
        const parts: string[] = [];
        if (successes > 0) parts.push(`成功 ${successes}`);
        if (skipped > 0) parts.push(`跳过 ${skipped}`);
        if (errors > 0) parts.push(`失败 ${errors}`);
        if (parts.length > 0) {
          pushToast(errors > 0 ? 'warning' : 'success', `上传完成 - ${parts.join('，')}（${taskName}）`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err ?? '未知错误');
        if (msg !== '__canceled__') {
          pushToast('warning', `上传失败（${taskName}）：${msg}`);
        }
      }
    },
    [
      currentPath,
      entries,
      selectedNames,
      selectedHostId,
      connectionStates,
      remoteCurrentPath,
      createTransferTask,
      cancelTransferTask,
      pushToast,
    ],
  );

  // 初始化由 ContentArea 的 host 切换逻辑驱动（setActiveHost → initHome），
  // 避免 LocalFilePane 自己 initHome 与按 host 记忆的路径切换逻辑互相冲突。
  // 未选中任何主机时，ContentArea 会触发 setActiveHost(null) 即空串 host 的初始化。

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

  // 面包屑分段
  const crumbs = useMemo(() => buildBreadcrumbs(currentPath ?? ''), [currentPath]);

  // 统计
  const stats = useMemo(() => {
    let dirCount = 0;
    let fileCount = 0;
    let totalSize = 0;
    for (const e of entries) {
      if (e.isDir) dirCount += 1;
      else {
        fileCount += 1;
        totalSize += e.size;
      }
    }
    return { dirCount, fileCount, totalSize };
  }, [entries]);

  const canBack = historyIndex > 0;
  const canForward = historyIndex >= 0 && historyIndex < history.length - 1;

  const handleRowDoubleClick = (entry: (typeof entries)[number]) => {
    if (entry.isDir && currentPath) {
      navigate(joinLocalPath(currentPath, entry.name));
    }
  };

  const handleRowClick = (e: React.MouseEvent, entry: (typeof entries)[number]) => {
    if (e.shiftKey) {
      selectOne(entry.name, 'range');
    } else if (e.ctrlKey || e.metaKey) {
      selectOne(entry.name, 'toggle');
    } else {
      selectOne(entry.name, 'replace');
    }
  };

  const handleRowContextMenu = (e: React.MouseEvent, entry: (typeof entries)[number]) => {
    e.preventDefault();
    e.stopPropagation();
    // 右击目标若不在已选中集合中：选中它（替换选中），形成跟资源管理器一致的「右键某个文件 → 选中的目标就是它」的体验
    if (!selectedNames.has(entry.name)) {
      selectOne(entry.name, 'replace');
    }
    setCtxMenu({ kind: 'entry', x: e.clientX, y: e.clientY, entry });
  };

  const handleBlankContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    clearSelection();
    setCtxMenu({ kind: 'blank', x: e.clientX, y: e.clientY });
  };

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
    if (!currentPath) return;
    const toUpload =
      selectedNames.size > 0
        ? entries.filter((e) => selectedNames.has(e.name))
        : [];
    if (toUpload.length === 0) {
      e.preventDefault();
      return;
    }
    // 把将要上传的条目信息写入 dataTransfer，供 FileBrowser 的 drop 读取并复用上传逻辑
    const payload = {
      source: 'local-pane-selected',
      hostId: selectedHostId ?? '',
      baseDir: currentPath,
      items: toUpload.map((e) => ({
        name: e.name, isDir: e.isDir, size: e.size, fileType: e.fileType,
      })),
    };
    try {
      e.dataTransfer.setData('application/x-local-pane-selected', JSON.stringify(payload));
      e.dataTransfer.setData('text/plain', `${toUpload.length} local items`);
      e.dataTransfer.effectAllowed = 'copy';
    } catch { /* noop */ }
  };

  return (
    <div
      className="local-pane"
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* ---------- 工具栏 ---------- */}
      <div className="local-pane-toolbar">
        <span className="pane-label">
          <HardDrive size={12} style={{ verticalAlign: '-2px', marginRight: 4 }} />
          本地
        </span>
        {editingPath ? (
          <input
            ref={pathInputRef}
            className="local-breadcrumb-input"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void commitPathEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                cancelPathEdit();
              }
            }}
            onBlur={() => void commitPathEdit()}
            placeholder="输入目录路径，例如 C:\Users\Administrator"
          />
        ) : (
          <div
            className="local-breadcrumb"
            ref={breadcrumbRef}
            onDoubleClick={enterPathEdit}
            title={`${currentPath ?? ''}（双击编辑路径）`}
          >
            {crumbs.map((c, i) => (
              <span key={`${c.path}-${i}`} className="local-breadcrumb-wrap">
                {i > 0 && <span className="local-breadcrumb-sep">\</span>}
                <button
                  type="button"
                  className={`local-breadcrumb-item ${i === crumbs.length - 1 ? 'is-current' : ''}`}
                  onClick={() => {
                    if (i === crumbs.length - 1) {
                      // 点击当前段：进入路径编辑模式（与远程栏一致）
                      enterPathEdit();
                    } else {
                      void navigate(c.path);
                    }
                  }}
                  title={`${c.path}${i === crumbs.length - 1 ? '（点击编辑路径）' : ''}`}
                >
                  {c.name}
                </button>
              </span>
            ))}
            {!currentPath && <span className="local-breadcrumb-empty">未打开目录（双击此处输入路径）</span>}
          </div>
        )}
        <div className="local-pane-actions">
          <button
            type="button"
            className="local-action-btn"
            onClick={goBack}
            disabled={!canBack}
            title="后退"
          >
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            className="local-action-btn"
            onClick={goForward}
            disabled={!canForward}
            title="前进"
          >
            <ChevronRight size={15} />
          </button>
          <button
            type="button"
            className="local-action-btn"
            onClick={refresh}
            disabled={!currentPath}
            title="刷新"
          >
            <RefreshCw size={14} className={loading ? 'local-spin' : ''} />
          </button>
        </div>
      </div>

      {/* ---------- 列表 ---------- */}
      <div
        className="local-pane-list"
        ref={parentRef}
        onContextMenu={handleBlankContextMenu}
        onMouseDown={(e) => {
          // 点击空白处（非行内）清空选中
          const tgt = e.target as HTMLElement;
          if (tgt.closest('.local-pane-row')) return;
          clearSelection();
        }}
      >
        {/* 表头 */}
        <div className="local-pane-header" onContextMenu={(e) => e.preventDefault()}>
          <span className="local-pane-col-name">名称</span>
          <span className="local-pane-col-type">类型</span>
          <span className="local-pane-col-time">修改时间</span>
        </div>

        {entries.length === 0 && !loading ? (
          <div className="local-pane-empty">空目录</div>
        ) : (
          <div
            className="local-pane-list-inner"
            style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}
            onContextMenu={handleBlankContextMenu}
          >
            {virtualizer.getVirtualItems().map((vi) => {
              const entry = entries[vi.index];
              const isSelected = selectedNames.has(entry.name);
              return (
                <div
                  key={`${entry.name}-${vi.index}`}
                  className={`local-pane-row ${isSelected ? 'selected' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    if (!isSelected) {
                      // 拖拽未选中的条目：把它变成选中
                      selectOne(entry.name, 'replace');
                    }
                    handleDragStart(e);
                  }}
                  onDragEnd={() => { /* noop */ }}
                  onClick={(e) => handleRowClick(e, entry)}
                  onDoubleClick={() => handleRowDoubleClick(entry)}
                  onContextMenu={(e) => handleRowContextMenu(e, entry)}
                  title={entry.name}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <span className="local-pane-col-name local-pane-row-name">
                    <span className="local-pane-row-icon">
                      {entry.isDir ? (
                        <Folder size={14} className="local-icon-dir" />
                      ) : (
                        <FileIcon size={14} className="local-icon-file" />
                      )}
                    </span>
                    <span className="local-pane-row-label">{entry.name}</span>
                  </span>
                  <span className="local-pane-col-type">{typeLabel(entry.fileType)}</span>
                  <span className="local-pane-col-time">{formatTime(entry.modified)}</span>
                </div>
              );
            })}
          </div>
        )}

        {loading && <div className="local-pane-loading"><span className="local-loading-spinner" /></div>}
      </div>

      {/* ---------- 底部统计 ---------- */}
      <div className="local-pane-stats">
        {currentPath ? (
          <>
            <span>{stats.dirCount} 个文件夹</span>
            <span className="local-stats-sep">,</span>
            <span>{stats.fileCount} 个文件</span>
            <span className="local-stats-sep">|</span>
            <span>{formatSize(stats.totalSize)}</span>
            {selectedNames.size > 0 && (
              <>
                <span className="local-stats-sep">|</span>
                <span style={{ color: 'var(--accent)' }}>已选 {selectedNames.size} 项</span>
              </>
            )}
          </>
        ) : (
          <span>—</span>
        )}
      </div>

      {/* ---------- 右键菜单（Portal 到 body，避免被父容器裁剪） ---------- */}
      {ctxMenu && typeof document !== 'undefined' && createPortal(
        <div
          ref={ctxMenuRef}
          className="host-menu sidebar-context-menu fb-context-menu local-context-menu"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            transform: `translate(${ctxMenu.x}px, ${ctxMenu.y}px)`,
            zIndex: 2147483600,
          }}
          role="menu"
          onContextMenu={(e) => e.preventDefault()}
        >
          {ctxMenu.kind === 'entry' && (
            <>
              <button
                type="button"
                className="host-menu-item"
                role="menuitem"
                onClick={() => void uploadSelectedToRemote()}
                disabled={!selectedHostId || !!remoteCurrentPath === false}
              >
                <Upload size={11} />
                {selectedNames.size > 1
                  ? `上传已选 ${selectedNames.size} 项至远程`
                  : '上传至远程'}
              </button>
              {ctxMenu.entry?.isDir && (
                <button
                  type="button"
                  className="host-menu-item"
                  role="menuitem"
                  onClick={() => {
                    if (!ctxMenu.entry) return;
                    setCtxMenu(null);
                    if (currentPath) void navigate(joinLocalPath(currentPath, ctxMenu.entry.name));
                  }}
                >
                  <FolderOpen size={11} />
                  打开
                </button>
              )}
            </>
          )}
          {ctxMenu.kind === 'blank' && selectedNames.size === 0 ? (
            <div className="host-menu-item" style={{ cursor: 'default', opacity: 0.7 }}>
              <HardDrive size={11} /> {currentPath ? currentPath : '本地'}
            </div>
          ) : null}
          {ctxMenu.kind === 'blank' && selectedNames.size > 0 && (
            <button
              type="button"
              className="host-menu-item"
              role="menuitem"
              onClick={() => void uploadSelectedToRemote()}
              disabled={!selectedHostId || !remoteCurrentPath}
            >
              <Upload size={11} />
              上传已选 {selectedNames.size} 项至远程
            </button>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}

