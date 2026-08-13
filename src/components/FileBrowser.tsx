import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { invoke } from '@tauri-apps/api/core';
import { writeText as clipboardWriteText } from '@tauri-apps/plugin-clipboard-manager';
import { logWarn, logError } from '../utils/log';
import {
  Folder,
  File as FileIcon,
  FileText,
  FolderPlus,
  FilePlus,
  Pencil,
  Trash2,
  Eye,
  Download,
  Copy,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Lock,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
} from 'lucide-react';
import {
  useFileStore,
  type FileEntry,
  joinPath,
  isTextFile,
} from '../store/fileStore';
import { useHostStore } from '../store/hostStore';
import { useToastStore } from './Toast';
import { TextEditorDialog } from './TextEditorDialog';
import {
  useTransferStore,
  genTaskId,
} from '../store/transferStore';
import {
  uploadLocalItemsToRemote,
  tryParseLocalPanePayload,
  type OverrideChoice,
} from '../utils/uploadFromLocal';
import { useLocalFileStore } from '../store/localFileStore';
import '../styles/filebrowser.css';

interface FileBrowserProps {
  hostId: string;
}

type FbCtxKind = 'blank' | 'entry';

interface FbContextMenuState {
  kind: FbCtxKind;
  x: number;
  y: number;
  entry?: FileEntry;
}

type InlineCreateMode = null | { kind: 'file' | 'folder'; initial?: string };

type SortKey = 'name' | 'size' | 'type' | 'modified' | 'permissions' | 'owner';
type SortDir = 'asc' | 'desc';

const ROW_HEIGHT = 26;

// ---------------------------------------------------------------------------
// 拖拽上传 - 工具类型 & 工具函数
// ---------------------------------------------------------------------------

interface LocalFileItem {
  /** 上传的相对路径 (相对于拖入的根项目), 例如 'foo/bar.txt' 或 'bar.txt' */
  relPath: string;
  /** 原始 File 对象 */
  file: File;
  /** 文件名 */
  name: string;
  /** 是否为目录（若拖入包含目录，这里 false 是文件） */
  isDir: boolean;
}

interface LocalDirItem {
  relPath: string;
  name: string;
  isDir: true;
}

type LocalItem = LocalFileItem | LocalDirItem;

/** 读取拖拽对象中的所有条目（含嵌套目录）。返回扁平列表，第一个目录相对是空。 */
async function collectDroppedItems(
  dataTransfer: DataTransfer,
): Promise<LocalItem[]> {
  const result: LocalItem[] = [];

  // 1. 优先使用 webkitGetAsEntry API 支持文件夹递归
  if (dataTransfer.items && dataTransfer.items.length > 0) {
    const entries: Array<FileSystemEntry | null> = [];
    for (let i = 0; i < dataTransfer.items.length; i++) {
      const item = dataTransfer.items[i];
      if (item.kind === 'file') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry = (item as any).webkitGetAsEntry?.() ?? null;
        entries.push(entry);
      }
    }
    if (entries.some((e) => e !== null)) {
      for (const entry of entries) {
        if (!entry) continue;
        await walkEntry(entry, '', result);
      }
      return result;
    }
  }

  // 2. fallback: 只用 files (无文件夹信息)
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const f = dataTransfer.files[i];
      result.push({
        relPath: f.name,
        name: f.name,
        file: f,
        isDir: false,
      });
    }
  }
  return result;
}

function walkEntry(
  entry: FileSystemEntry,
  baseRel: string,
  out: LocalItem[],
): Promise<void> {
  return new Promise((resolve) => {
    const rel = baseRel ? `${baseRel}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const fileEntry = entry as FileSystemFileEntry;
      fileEntry.file(
        (file) => {
          out.push({ relPath: rel, name: entry.name, file, isDir: false });
          resolve();
        },
        () => resolve(),
      );
    } else if (entry.isDirectory) {
      out.push({ relPath: rel, name: entry.name, isDir: true });
      const dirEntry = entry as FileSystemDirectoryEntry;
      const reader = dirEntry.createReader();
      const readAll = (accum: FileSystemEntry[]) => {
        reader.readEntries(
          (batch) => {
            if (batch.length === 0) {
              void (async () => {
                for (const child of accum) {
                  await walkEntry(child, rel, out);
                }
                resolve();
              })();
              return;
            }
            readAll(accum.concat(...batch));
          },
          () => resolve(),
        );
      };
      readAll([]);
    } else {
      resolve();
    }
  });
}

export function FileBrowser({ hostId }: FileBrowserProps) {
  const currentPath = useFileStore((s) => s.currentPath);
  const entries = useFileStore((s) => s.entries);
  const loading = useFileStore((s) => s.loading);
  const selectedEntry = useFileStore((s) => s.selectedEntry);
  const selectedNames = useFileStore((s) => s.selectedNames);
  const navigate = useFileStore((s) => s.navigate);
  const selectOne = useFileStore((s) => s.selectOne);
  const clearSelection = useFileStore((s) => s.clearSelection);
  const refresh = useFileStore((s) => s.refresh);
  const rename = useFileStore((s) => s.rename);
  const mkdir = useFileStore((s) => s.mkdir);
  const mkfile = useFileStore((s) => s.mkfile);
  const remove = useFileStore((s) => s.remove);
  const resolvePath = useFileStore((s) => s.resolvePath);
  const goBack = useFileStore((s) => s.goBack);
  const goForward = useFileStore((s) => s.goForward);
  const history = useFileStore((s) => s.history);
  const historyIndex = useFileStore((s) => s.historyIndex);
  const pushToast = useToastStore((s) => s.push);
  const createTransferTask = useTransferStore((s) => s.createTask);

  // 主机名称
  const hosts = useHostStore((s) => s.hosts);
  const hostName = useMemo(() => {
    const h = hosts.find((it) => it.id === hostId);
    return h?.name ?? hostId;
  }, [hosts, hostId]);

  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex >= 0 && historyIndex < history.length - 1;

  // 重命名状态
  const [renamingName, setRenamingName] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  // 内联创建（文件/文件夹）状态
  const [inlineCreate, setInlineCreate] = useState<InlineCreateMode>(null);
  const [inlineCreateValue, setInlineCreateValue] = useState('');
  const inlineCreateInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (inlineCreate && inlineCreateInputRef.current) {
      inlineCreateInputRef.current.focus();
      inlineCreateInputRef.current.select();
    }
  }, [inlineCreate]);

  // 右键菜单状态
  const [ctxMenu, setCtxMenu] = useState<FbContextMenuState | null>(null);
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

  // 文本编辑器打开状态
  const [editorTarget, setEditorTarget] = useState<{
    filePath: string;
    fileName: string;
    viewOnly: boolean;
  } | null>(null);

  // ---- 拖拽上传 ----
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [globalOverride, setGlobalOverrideState] = useState<OverrideChoice>('ask');
  const globalOverrideRef = useRef<OverrideChoice>('ask');
  // 状态变更时同步 ref（供共享上传函数读取）
  useEffect(() => {
    globalOverrideRef.current = globalOverride;
  }, [globalOverride]);

  const setGlobalOverrideAndRef = useCallback((v: OverrideChoice) => {
    globalOverrideRef.current = v;
    setGlobalOverrideState(v);
  }, []);

  // ---- 排序状态 ----
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // ---- 排序后的条目（文件夹置顶）----
  // 必须放在 onRowSingleClick 之前声明，因为后者依赖它做 shift 范围选择
  const sortedEntries = useMemo(() => {
    const sorted = [...entries];
    sorted.sort((a, b) => {
      // 文件夹始终置顶
      if (a.is_dir && !b.is_dir) return -1;
      if (!a.is_dir && b.is_dir) return 1;
      let cmp = 0;
      switch (sortKey) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'size':
          cmp = a.size - b.size;
          break;
        case 'type':
          cmp = (a.file_type || '').localeCompare(b.file_type || '');
          break;
        case 'modified':
          cmp = a.modified - b.modified;
          break;
        case 'permissions':
          cmp = (a.permissions || '').localeCompare(b.permissions || '');
          break;
        case 'owner':
          cmp = (a.owner || '').localeCompare(b.owner || '');
          break;
      }
      if (cmp === 0) cmp = a.name.localeCompare(b.name);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [entries, sortKey, sortDir]);

  // ---- 面包屑输入模式 ----
  const [editingPath, setEditingPath] = useState(false);
  const [pathInput, setPathInput] = useState('');
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const breadcrumbRef = useRef<HTMLDivElement | null>(null);

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

  // ---- 重命名 input 自动聚焦 ----
  useEffect(() => {
    if (renamingName && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingName]);

  // ---- 键盘快捷键：选中条目后按回车进入重命名 ----
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || renamingName) return;
      if (!selectedEntry) return;
      // 忽略输入框中的回车
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      setRenamingName(selectedEntry.name);
      setRenameValue(selectedEntry.name);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedEntry, renamingName]);

  // ---- 拖拽上传 - 处理 ----
  //
  // 说明：Tauri/Webview 在 Windows 上拖拽进入时，dataTransfer.types
  // 不一定包含 "Files"（某些情况下是 moz 自定义类型或空），因此
  // dragenter / dragover 不再严格判断 types，而是无条件高亮，
  // 真正的 drop 阶段再检查是否有 files 数据。
  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    setDragOver(true);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer) return;
    e.preventDefault();
    try {
      e.dataTransfer.dropEffect = 'copy';
      e.dataTransfer.effectAllowed = 'copy';
    } catch {
      /* noop */
    }
    setDragOver(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    // 子元素间移动也会触发 dragleave，检查是否仍在当前元素内
    const to = e.relatedTarget as Node | null;
    const self = e.currentTarget as HTMLElement;
    if (to && self.contains(to)) return;
    const rect = self.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (
      x <= rect.left ||
      x >= rect.right ||
      y <= rect.top ||
      y >= rect.bottom
    ) {
      setDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      if (!e.dataTransfer) return;
      if (uploading) return;
      if (!currentPath) return;

      // ---- 分支 A：优先处理来自本地面板的拖拽（选中条目拖到远程） ----
      const localPayload = tryParseLocalPanePayload(e.dataTransfer);
      if (localPayload) {
        e.preventDefault();
        setDragOver(false);
        const connState = useHostStore.getState().connectionStates[hostId];
        if (connState !== 'connected') {
          pushToast('warning', '远程未连接，请先连接主机');
          return;
        }
        if (localPayload.items.length === 0) return;
        if (!localPayload.baseDir) return;

        setUploading(true);
        setGlobalOverrideAndRef('ask');
        const taskName =
          localPayload.items.length === 1
            ? localPayload.items[0].name
            : `${localPayload.items.length} 项`;
        try {
          const { successes, skipped, errors } = await uploadLocalItemsToRemote(
            hostId,
            currentPath,
            localPayload.baseDir,
            localPayload.items.map(({ name, isDir, size }) => ({ name, isDir, size })),
            {
              pushToast,
              createTransferTask,
              cancelTransferTask: useTransferStore.getState().cancelTask,
              globalOverrideRef,
              setGlobalOverride: setGlobalOverrideAndRef,
              remoteEntriesCheck: (topName) =>
                useFileStore.getState().entries.some((en) => en.name === topName),
              refreshRemote: async () => { await refresh(hostId); },
            },
          );
          const msgParts: string[] = [];
          if (successes > 0) msgParts.push(`成功 ${successes}`);
          if (skipped > 0) msgParts.push(`跳过 ${skipped}`);
          if (errors > 0) msgParts.push(`失败 ${errors}`);
          if (msgParts.length > 0) {
            pushToast(
              errors > 0 ? 'warning' : 'success',
              `上传完成 - ${msgParts.join('，')}（${taskName}）`,
            );
          }
        } finally {
          setUploading(false);
        }
        return;
      }

      // ---- 分支 B：操作系统文件拖入（浏览器原生文件 / 文件夹） ----
      const hasFiles =
        (e.dataTransfer.files && e.dataTransfer.files.length > 0) ||
        (e.dataTransfer.items &&
          Array.from(e.dataTransfer.items).some((i) => i.kind === 'file'));
      if (!hasFiles) return;
      e.preventDefault();
      setDragOver(false);

      let items: LocalItem[] = [];
      try {
        items = await collectDroppedItems(e.dataTransfer);
      } catch (err) {
        pushToast('error', `读取拖拽文件失败: ${err}`);
        return;
      }
      if (items.length === 0) return;

      setUploading(true);
      setGlobalOverrideAndRef('ask');
      let successes = 0;
      let skipped = 0;
      let errors = 0;

      try {
        // 1. 先按相对路径排序，目录在文件前（父目录先创建）
        items.sort((a, b) => {
          if (a.isDir && !b.isDir) return -1;
          if (!a.isDir && b.isDir) return 1;
          return a.relPath.localeCompare(b.relPath);
        });

        // 2. 遍历每个条目上传
        for (const item of items) {
          const remotePath = joinPath(currentPath, item.relPath);

          if (item.isDir) {
            // 创建目录 - 一般不存在"是否覆盖"问题（mkdir -p）
            try {
              await invoke('sftp_mkdir_all', {
                hostId,
                path: remotePath,
              });
            } catch (err) {
              // 目录创建失败通常是权限/已存在，这里宽容不中止
              logWarn(`mkdir failed: ${remotePath} ${String(err)}`);
            }
            continue;
          }

          // 3. 文件：检测是否存在（如果是直接顶层，用 entries 缓存）
          const topLevelName = item.relPath.includes('/')
            ? null
            : item.relPath;
          const directlyExists =
            topLevelName !== null &&
            entries.some((en) => en.name === topLevelName);

          let needWrite = true;
          if (directlyExists) {
            if (globalOverride === 'skip') {
              skipped++;
              needWrite = false;
            } else if (globalOverride === 'overwrite') {
              needWrite = true;
            } else {
              // 弹窗询问
              const choice = confirm(
                `文件 "${item.relPath}" 已存在。\n\n是否覆盖？\n"取消" = 跳过，"确定" = 覆盖。`,
              );
              if (choice) {
                // 覆盖，顺便问一下是否全部
                const all = confirm('对所有后续冲突文件也执行覆盖操作？');
                if (all) setGlobalOverrideAndRef('overwrite');
                needWrite = true;
              } else {
                const skipAll = confirm('对所有后续冲突文件也执行跳过？');
                if (skipAll) setGlobalOverrideAndRef('skip');
                skipped++;
                needWrite = false;
              }
            }
          }

          if (!needWrite) continue;

          // 4. 确保父目录存在（嵌套的情况）
          if (item.relPath.includes('/')) {
            const slash = item.relPath.lastIndexOf('/');
            const parentRel = item.relPath.slice(0, slash);
            const parentRemote = joinPath(currentPath, parentRel);
            try {
              await invoke('sftp_mkdir_all', {
                hostId,
                path: parentRemote,
              });
            } catch {
              /* 忽略父目录创建失败（可能已存在），让后续写决定 */
            }
          }

          // 5. 读本地文件（分片）+ 写远程（分片），防止 50MB+ 文件一次性加载导致 UI 卡死
          let uploadTaskId: string | null = null;
          const displayName = item.relPath.split('/').pop() || item.relPath;
          let fileCanceled = false;
          if (item.file) {
            uploadTaskId = genTaskId();
            createTransferTask({
              id: uploadTaskId,
              kind: 'upload',
              hostId,
              name: displayName,
              remotePath,
              localPath: item.file?.webkitRelativePath || item.relPath,
              totalBytes: item.file.size || 0,
              status: 'running',
            });
          }
          try {
            const totalSize = item.file?.size || 0;
            // 空文件也需要走一次分片（is_first=true）确保创建空文件
            if (!item.file) {
              // 没有 file 的条目（理论上不会到这里），跳过
              skipped++;
              continue;
            }
            if (totalSize === 0) {
              // 空文件：直接调用一次首片写入（会 TRUNCATE+CREATE 生成空文件）
              await invoke('sftp_upload_chunk', {
                hostId,
                path: remotePath,
                data: [],
                isFirst: true,
                taskId: uploadTaskId ?? genTaskId(),
                name: displayName,
                totalBytes: 0,
                bytesOffset: 0,
              });
              successes++;
              continue;
            }
            const CHUNK = 256 * 1024; // 256KB per chunk — small enough to keep UI responsive
            let offset = 0;
            let isFirst = true;
            const fileObj: File = item.file;
            while (offset < totalSize) {
              const end = Math.min(offset + CHUNK, totalSize);
              const sliceBlob = fileObj.slice(offset, end);
              const buf = await sliceBlob.arrayBuffer();
              const chunkBytes = new Uint8Array(buf);
              const dataArr = Array.from(chunkBytes);
              // 释放主循环一次，让 UI 有机会重绘 / 事件响应
              // eslint-disable-next-line no-await-in-loop
              await new Promise<void>((r) => setTimeout(r, 0));
              if (uploadTaskId) {
                const t = useTransferStore.getState().tasks.find((x) => x.id === uploadTaskId);
                if (t && (t.status === 'canceled' || t.status === 'error')) {
                  fileCanceled = true;
                  break;
                }
              }
              // eslint-disable-next-line no-await-in-loop
              await invoke('sftp_upload_chunk', {
                hostId,
                path: remotePath,
                data: dataArr,
                isFirst,
                taskId: uploadTaskId ?? genTaskId(),
                name: displayName,
                totalBytes: totalSize,
                bytesOffset: offset,
              });
              isFirst = false;
              offset = end;
            }
            if (fileCanceled) {
              errors++;
            } else {
              successes++;
            }
          } catch (err) {
            const errMsg = String(err);
            // canceled 错误: 前端取消按钮 -> sftp_cancel_transfer -> Rust 端 Err("canceled")
            const isCanceled =
              errMsg === 'canceled' ||
              errMsg.startsWith('canceled') ||
              errMsg.includes('canceled');
            if (isCanceled) {
              // 不打错误 toast；UI 状态已经由 Rust emit 的 canceled 事件同步
            } else {
              errors++;
              logError(`upload failed: ${remotePath} ${String(err)}`);
              pushToast('error', `${item.relPath}: ${errMsg}`);
            }
          }
        }

        // 6. 完成后刷新
        await refresh(hostId);
      } finally {
        setUploading(false);
        const msgParts: string[] = [];
        if (successes > 0) msgParts.push(`成功 ${successes}`);
        if (skipped > 0) msgParts.push(`跳过 ${skipped}`);
        if (errors > 0) msgParts.push(`失败 ${errors}`);
        if (msgParts.length > 0) {
          pushToast(
            errors > 0 ? 'warning' : 'success',
            `上传完成 - ${msgParts.join('，')}`,
          );
        }
      }
    },
    [currentPath, entries, uploading, hostId, refresh, pushToast, createTransferTask, globalOverride, setGlobalOverrideAndRef, globalOverrideRef],
  );

  // ---- 行交互 ----
  const onRowDoubleClick = useCallback(
    (entry: FileEntry) => {
      if (!currentPath) return;
      if (entry.is_dir) {
        void navigate(hostId, joinPath(currentPath, entry.name));
      } else if (isTextFile(entry)) {
        setEditorTarget({
          filePath: joinPath(currentPath, entry.name),
          fileName: entry.name,
          viewOnly: true,
        });
      } else {
        pushToast('info', `已选中文件：${entry.name}（暂不支持直接打开此类文件）`);
      }
    },
    [currentPath, navigate, hostId, pushToast],
  );

  // ---- Shift 范围选择锚点（基于 sortedEntries 的顺序） ----
  // replace 模式下记住锚点；shift+点击时在 [锚点, 当前] 之间全部选中
  const [shiftAnchorName, setShiftAnchorName] = useState<string | null>(null);

  const onRowSingleClick = useCallback(
    (e: React.MouseEvent, entry: FileEntry) => {
      if (e.shiftKey) {
        // 组件内直接按 sortedEntries 的顺序做范围选择，避免 store 用原始 entries 错位
        const ordered = sortedEntries.map((en) => en.name);
        const anchor = shiftAnchorName ?? ordered[0] ?? '';
        let anchorIdx = ordered.indexOf(anchor);
        if (anchorIdx < 0) anchorIdx = 0;
        const targetIdx = ordered.indexOf(entry.name);
        if (targetIdx < 0) return;
        const [lo, hi] = anchorIdx < targetIdx
          ? [anchorIdx, targetIdx]
          : [targetIdx, anchorIdx];
        const next = new Set<string>();
        for (let i = lo; i <= hi; i++) {
          const n = ordered[i];
          if (n !== undefined) next.add(n);
        }
        // 直接写入 store，不走 selectOne('range') 那条基于原始 entries 的错位逻辑
        useFileStore.setState({
          selectedNames: next,
          selectedEntry: entries.find((en) => en.name === entry.name) ?? null,
        });
      } else if (e.ctrlKey || e.metaKey) {
        selectOne(entry.name, 'toggle');
      } else {
        // replace：保存新 anchor
        setShiftAnchorName(entry.name);
        selectOne(entry.name, 'replace');
      }
    },
    [selectOne, sortedEntries, shiftAnchorName, entries],
  );

  // 清空选中时同步清掉锚点
  const clearSelectionAndAnchor = useCallback(() => {
    setShiftAnchorName(null);
    clearSelection();
  }, [clearSelection]);

  // ---- 重命名提交/取消 ----
  const startRename = useCallback((entry: FileEntry) => {
    setRenamingName(entry.name);
    setRenameValue(entry.name);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingName(null);
    setRenameValue('');
  }, []);

  const commitRename = useCallback(
    async (oldName: string) => {
      const newName = renameValue.trim();
      if (!newName || newName === oldName) {
        cancelRename();
        return;
      }
      await rename(hostId, oldName, newName);
      cancelRename();
    },
    [renameValue, rename, hostId, cancelRename],
  );

  // ---- 内联创建：新文件夹 / 新文件 ----
  const startInlineCreate = useCallback((kind: 'file' | 'folder') => {
    setInlineCreate({ kind });
    setInlineCreateValue('');
    setRenamingName(null);
  }, []);

  const cancelInlineCreate = useCallback(() => {
    setInlineCreate(null);
    setInlineCreateValue('');
  }, []);

  const commitInlineCreate = useCallback(async () => {
    if (!inlineCreate) return;
    const name = inlineCreateValue.trim();
    if (!name) {
      cancelInlineCreate();
      return;
    }
    try {
      if (inlineCreate.kind === 'folder') {
        await mkdir(hostId, name);
      } else {
        await mkfile(hostId, name);
      }
    } finally {
      cancelInlineCreate();
    }
  }, [inlineCreate, inlineCreateValue, mkdir, mkfile, hostId, cancelInlineCreate]);

  // ---- 自定义确认对话框（替代 @tauri-apps/plugin-dialog 的 ask 原生样式） ----
  interface MiniDialogState {
    title: string;
    message: string;
    okLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onOk: () => void;
  }
  const [miniDialog, setMiniDialog] = useState<MiniDialogState | null>(null);

  function openMiniDialog(opts: MiniDialogState) {
    setMiniDialog(opts);
  }
  function closeMiniDialog() {
    setMiniDialog(null);
  }

  // ---- 右键菜单动作 ----
  function openBlankMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    clearSelectionAndAnchor();
    setCtxMenu({ kind: 'blank', x: e.clientX, y: e.clientY });
  }

  function openEntryMenu(e: React.MouseEvent, entry: FileEntry) {
    e.preventDefault();
    e.stopPropagation();
    // 右击的条目若不在已选集合中，选中它（替换选中）
    if (!selectedNames.has(entry.name)) {
      selectOne(entry.name, 'replace');
    }
    setCtxMenu({ kind: 'entry', x: e.clientX, y: e.clientY, entry });
  }

  function closeCtxMenu() {
    setCtxMenu(null);
  }

  function handleCtxDelete(entry: FileEntry) {
    const selectedSet = useFileStore.getState().selectedNames;
    const multiSelected = selectedSet.size > 1 && selectedSet.has(entry.name);
    const toDelete: FileEntry[] = multiSelected
      ? entries.filter((e) => selectedSet.has(e.name))
      : [entry];

    const label = multiSelected
      ? `已选 ${toDelete.length} 项`
      : `${entry.is_dir ? '文件夹' : '文件'}「${entry.name}」`;

    openMiniDialog({
      title: '确认删除',
      message: `确认删除${label}？此操作不可撤销。`,
      okLabel: '确认删除',
      cancelLabel: '取消',
      danger: true,
      onOk: async () => {
        closeMiniDialog();
        closeCtxMenu();
        // remove 内部已处理错误提示与刷新；逐个删除，失败不中断后续
        for (const e of toDelete) {
          await remove(hostId, e.name, e.is_dir);
        }
        if (multiSelected) {
          clearSelectionAndAnchor();
        }
      },
    });
  }

  function handleCtxRename(entry: FileEntry) {
    closeCtxMenu();
    setInlineCreate(null);
    setRenamingName(entry.name);
    setRenameValue(entry.name);
  }

  function handleCtxNewFolder() {
    closeCtxMenu();
    startInlineCreate('folder');
  }

  function handleCtxNewFile() {
    closeCtxMenu();
    startInlineCreate('file');
  }

  function handleCtxView(entry: FileEntry) {
    if (!currentPath) return;
    closeCtxMenu();
    setEditorTarget({
      filePath: joinPath(currentPath, entry.name),
      fileName: entry.name,
      viewOnly: true,
    });
  }

  function handleCtxEdit(entry: FileEntry) {
    if (!currentPath) return;
    closeCtxMenu();
    setEditorTarget({
      filePath: joinPath(currentPath, entry.name),
      fileName: entry.name,
      viewOnly: false,
    });
  }

  async function handleCtxCopyPath(entry: FileEntry) {
    if (!currentPath) return;
    closeCtxMenu();
    const fullPath = joinPath(currentPath, entry.name);
    try {
      await clipboardWriteText(fullPath);
      pushToast('success', `已复制路径：${fullPath}`);
    } catch {
      try {
        await navigator.clipboard.writeText(fullPath);
        pushToast('success', `已复制路径：${fullPath}`);
      } catch {
        pushToast('error', '复制路径失败');
      }
    }
  }

  // ---- 下载：文件 / 文件夹（默认下载到本地当前目录，不弹框） ----
  async function handleCtxDownload(entry: FileEntry) {
    if (!currentPath || !hostId) return;
    closeCtxMenu();
    const remotePath = joinPath(currentPath, entry.name);

    // 默认下载到本地面板当前打开的目录
    const localDir = useLocalFileStore.getState().currentPath;
    if (!localDir) {
      pushToast('warning', '请先在本地面板打开一个目录');
      return;
    }

    const taskId = genTaskId();

    // 文件夹：远程压缩 → 下载 tar.gz 到本地目标目录（用户可见）→ 重命名 → 本地解压 → 删除压缩包
    if (entry.is_dir) {
      const { joinLocalPath } = await import('../store/localFileStore');
      // 远程临时压缩文件（/tmp 下即可，远程用户不需要看到）
      const remoteTmpPath = `/tmp/rd_transfer_${Date.now()}.tar.gz`;
      // 下载到本地目标目录的临时文件（用户可见，带 .tmp 后缀）
      const localTarballTmpPath = joinLocalPath(localDir, `${entry.name}.tar.gz.tmp`);
      // 下载完成后的正式压缩包名
      const localTarballFinalPath = joinLocalPath(localDir, `${entry.name}.tar.gz`);

      createTransferTask({
        id: taskId,
        kind: 'download',
        hostId,
        name: entry.name,
        remotePath,
        localPath: localDir,
        totalBytes: 0,
      });

      try {
        // 1. 远程压缩
        useTransferStore.getState().setTaskStatus(taskId, 'running', { name: `${entry.name} (压缩中...)` });
        await invoke('ssh_exec', {
          hostId,
          command: `tar -czf "${remoteTmpPath}" -C "${currentPath}" "${entry.name}"`,
        });

        // 2. 下载 tar.gz 到本地目标目录的临时文件（用户可见）
        useTransferStore.getState().setTaskStatus(taskId, 'running', { name: entry.name });
        await invoke('sftp_download_file', {
          hostId,
          remotePath: remoteTmpPath,
          localPath: localTarballTmpPath,
          taskId,
          displayName: entry.name,
        });

        // 3. 下载完成：将 .tmp 重命名为正式的 .tar.gz
        await invoke('rename_local_path', {
          oldPath: localTarballTmpPath,
          newPath: localTarballFinalPath,
        });

        // 4. 本地解压
        useTransferStore.getState().setTaskStatus(taskId, 'running', { name: `${entry.name} (解压中...)` });
        await invoke('extract_local_archive', {
          archivePath: localTarballFinalPath,
          destDir: localDir,
        });

        // 5. 解压完成后删除本地压缩包
        invoke('delete_local_path', { path: localTarballFinalPath }).catch(() => {});

        // 6. 标记完成
        useTransferStore.getState().setTaskStatus(taskId, 'completed', { name: entry.name });
        await useLocalFileStore.getState().refresh();
      } catch (err) {
        const msg = String(err);
        if (msg.startsWith('Cancelled:')) {
          pushToast('info', `已取消下载：${entry.name}`);
        } else {
          pushToast('error', `下载失败：${msg}`);
        }
      } finally {
        // 7. 清理临时文件（本地 + 远程）
        invoke('delete_local_path', { path: localTarballTmpPath }).catch(() => {});
        invoke('delete_local_path', { path: localTarballFinalPath }).catch(() => {});
        invoke('sftp_remove_file', { hostId, path: remoteTmpPath }).catch(() => {});
      }
      return;
    }

    // 单文件下载（原有逻辑）
    createTransferTask({
      id: taskId,
      kind: 'download',
      hostId,
      name: entry.name,
      remotePath,
      localPath: localDir,
      totalBytes: entry.size,
    });

    try {
      await invoke('sftp_download_file', {
        hostId,
        remotePath,
        localPath: localDir,
        taskId,
      });
      await useLocalFileStore.getState().refresh();
    } catch (err) {
      const msg = String(err);
      if (msg.startsWith('Cancelled:')) {
        pushToast('info', `已取消下载：${entry.name}`);
      } else {
        pushToast('error', `下载失败：${msg}`);
      }
    }
  }

  // ---- 拖拽下载：行 dragstart 写入 dataTransfer，供 Task 6 本地栏拖入下载 ----
  const onRowDragStart = useCallback(
    (e: React.DragEvent, entry: FileEntry) => {
      if (!currentPath) return;
      const fullPath = joinPath(currentPath, entry.name);
      const payload = {
        kind: 'remote-file',
        hostId,
        name: entry.name,
        path: fullPath,
        isDir: entry.is_dir,
        size: entry.size,
      };
      try {
        e.dataTransfer.setData('application/x-remote-file', JSON.stringify(payload));
        e.dataTransfer.setData('text/plain', fullPath);
        e.dataTransfer.effectAllowed = 'copyMove';
      } catch {
        /* noop */
      }
    },
    [currentPath, hostId],
  );

  // ---- 统计信息 ----
  const stats = useMemo(() => {
    let folders = 0;
    let files = 0;
    let totalSize = 0;
    let selectedSize = 0;
    let selectedFolders = 0;
    let selectedFiles = 0;
    for (const e of entries) {
      if (e.is_dir) folders++;
      else {
        files++;
        totalSize += e.size;
      }
      if (selectedNames.has(e.name)) {
        if (e.is_dir) selectedFolders++;
        else {
          selectedFiles++;
          selectedSize += e.size;
        }
      }
    }
    return { folders, files, totalSize, selectedSize, selectedFolders, selectedFiles };
  }, [entries, selectedNames]);

  // ---- 面包屑分段 ----
  const pathSegments = useMemo(() => {
    if (!currentPath) return [];
    // 保护：非绝对路径（如 hostId UUID 等脏数据）不参与面包屑生成，
    // 直接视为未打开状态，避免在地址栏中显示错误路径
    if (!currentPath.startsWith('/')) return [];
    const parts = currentPath.split('/').filter(Boolean);
    const segs: { name: string; path: string }[] = [{ name: '/', path: '/' }];
    let acc = '';
    for (const p of parts) {
      acc = acc + '/' + p;
      segs.push({ name: p, path: acc });
    }
    return segs;
  }, [currentPath]);

  // ---- 切换排序 ----
  const toggleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir('asc');
      return key;
    });
  }, []);

  // ---- 面包屑输入模式 ----
  const enterPathEdit = useCallback(() => {
    setPathInput(currentPath ?? '/');
    setEditingPath(true);
  }, [currentPath]);

  const commitPathEdit = useCallback(async () => {
    const target = pathInput.trim();
    setEditingPath(false);
    if (!target || target === currentPath) return;
    const resolved = await resolvePath(hostId, target);
    if (resolved) {
      void navigate(hostId, resolved);
    }
  }, [pathInput, currentPath, resolvePath, hostId, navigate]);

  const cancelPathEdit = useCallback(() => {
    setEditingPath(false);
  }, []);

  // 注：tauri.conf.json 中已设置 "dragDropEnabled": false，
  // 关闭 Tauri 原生拖拽拦截，让 HTML5 drag/drop 事件正常下发到 webview。
  // 因此这里直接使用 React 的 onDragEnter/onDragOver/onDragLeave/onDrop，
  // 无需 window 级兜底监听或合成 DragEvent 派发。

  return (
    <div
      className={
        'remote-pane' +
        (dragOver ? ' fb-drag-over' : '') +
        (uploading ? ' fb-uploading' : '')
      }
      onContextMenu={(e) => e.preventDefault()}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="fb-drag-overlay">
          <div className="fb-drag-overlay-inner">
            <Folder size={36} strokeWidth={1.2} />
            <div className="fb-drag-title">释放以上传到当前目录</div>
            <div className="fb-drag-subtitle">
              {currentPath ?? '/'}
            </div>
          </div>
        </div>
      )}

      {/* ==================== 顶部工具栏 ==================== */}
      <div className="remote-pane-toolbar">
        <span className="pane-label">远程: {hostName}</span>

        {editingPath ? (
          <input
            ref={pathInputRef}
            className="remote-breadcrumb-input"
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
            placeholder="输入远程路径，回车跳转"
            spellCheck={false}
          />
        ) : (
          <div
            className="remote-breadcrumb"
            ref={breadcrumbRef}
            onClick={(e) => {
              // 仅响应 breadcrumb 容器本身的点击（点空白处进入编辑模式）
              if (e.target === e.currentTarget) enterPathEdit();
            }}
            onDoubleClick={(e) => {
              if (e.target === e.currentTarget) enterPathEdit();
            }}
          >
            {pathSegments.length === 0 && (
              <button
                type="button"
                className="remote-breadcrumb-item remote-breadcrumb-empty"
                onClick={enterPathEdit}
                title="点击输入路径"
              >
                (未打开)
              </button>
            )}
            {pathSegments.map((seg, idx) => {
              const isLast = idx === pathSegments.length - 1;
              return (
                <span key={seg.path} className="remote-breadcrumb-seg">
                  <button
                    type="button"
                    className={
                      'remote-breadcrumb-item' +
                      (isLast ? ' remote-breadcrumb-current' : '')
                    }
                    onClick={() => {
                      if (isLast) {
                        // 点击当前路径段：切换为输入模式
                        enterPathEdit();
                      } else {
                        void navigate(hostId, seg.path);
                      }
                    }}
                    title={seg.path}
                  >
                    {seg.name === '/' ? '根' : seg.name}
                  </button>
                  {idx < pathSegments.length - 1 && (
                    <span className="remote-breadcrumb-sep">/</span>
                  )}
                </span>
              );
            })}
            <button
              type="button"
              className="remote-breadcrumb-edit"
              onClick={enterPathEdit}
              title="编辑路径"
            >
              <Pencil size={11} />
            </button>
          </div>
        )}

        <div className="remote-pane-actions">
          <button
            type="button"
            className="toolbar-btn icon-sm"
            onClick={() => void goBack(hostId)}
            disabled={!canGoBack}
            title="后退"
          >
            <ChevronLeft size={14} />
          </button>
          <button
            type="button"
            className="toolbar-btn icon-sm"
            onClick={() => void goForward(hostId)}
            disabled={!canGoForward}
            title="前进"
          >
            <ChevronRight size={14} />
          </button>
          <button
            type="button"
            className="toolbar-btn icon-sm"
            onClick={() => void refresh(hostId)}
            title="刷新"
          >
            <RefreshCw size={13} />
          </button>
        </div>
      </div>

      {/* ==================== 列表区 ==================== */}
      <div className="remote-pane-list">
        {/* 表头 */}
        <div className="remote-pane-header" role="row">
          <HeaderCell
            label="名称"
            sortKey="name"
            currentKey={sortKey}
            sortDir={sortDir}
            onClick={toggleSort}
            className="remote-pane-cell-name"
          />
          <HeaderCell
            label="大小"
            sortKey="size"
            currentKey={sortKey}
            sortDir={sortDir}
            onClick={toggleSort}
            className="remote-pane-cell-size"
          />
          <HeaderCell
            label="类型"
            sortKey="type"
            currentKey={sortKey}
            sortDir={sortDir}
            onClick={toggleSort}
            className="remote-pane-cell-type"
          />
          <HeaderCell
            label="修改时间"
            sortKey="modified"
            currentKey={sortKey}
            sortDir={sortDir}
            onClick={toggleSort}
            className="remote-pane-cell-modified"
          />
          <HeaderCell
            label="权限"
            sortKey="permissions"
            currentKey={sortKey}
            sortDir={sortDir}
            onClick={toggleSort}
            className="remote-pane-cell-perms"
          />
          <HeaderCell
            label="所有者"
            sortKey="owner"
            currentKey={sortKey}
            sortDir={sortDir}
            onClick={toggleSort}
            className="remote-pane-cell-owner"
          />
        </div>

        {/* 列表 body */}
        <div
          className="remote-pane-body"
          onMouseDown={(e) => {
            // 点击空白处（非行内元素）清空选中
            const tgt = e.target as HTMLElement;
            if (tgt.closest('.remote-pane-row')) return;
            if (tgt.closest('.remote-pane-inline-create')) return;
            clearSelectionAndAnchor();
          }}
          onContextMenu={(e) => {
            if (!currentPath) {
              e.preventDefault();
              return;
            }
            // 任何落在 body 空白处的右击都打开「新建」菜单
            openBlankMenu(e);
          }}
        >
          {loading && <Loading />}
          {!loading && entries.length === 0 && !currentPath && (
            <div
              className="fb-empty"
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <Folder size={22} className="fb-empty-icon" />
              <span>等待打开目录…</span>
            </div>
          )}
          {!loading && entries.length === 0 && currentPath && (
            <div
              className="fb-empty"
              onContextMenu={(e) => {
                if (currentPath) openBlankMenu(e);
              }}
            >
              <Folder size={22} className="fb-empty-icon" />
              <span>空目录</span>
            </div>
          )}

          {/* 内联创建新条目：显示在列表顶部 */}
          {inlineCreate && (
            <div className="remote-pane-inline-create">
              <span className="remote-pane-cell remote-pane-cell-name">
                <span
                  className={`fb-row-icon ${inlineCreate.kind === 'folder' ? 'fb-icon-dir' : 'fb-icon-file'}`}
                >
                  {inlineCreate.kind === 'folder' ? <FolderPlus size={14} /> : <FilePlus size={14} />}
                </span>
                <input
                  ref={inlineCreateInputRef}
                  className="fb-row-name-input remote-pane-inline-input"
                  value={inlineCreateValue}
                  onChange={(e) => setInlineCreateValue(e.target.value)}
                  placeholder={inlineCreate.kind === 'folder' ? '新文件夹名' : '新文件名'}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void commitInlineCreate();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelInlineCreate();
                    }
                  }}
                  onBlur={() => void commitInlineCreate()}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onContextMenu={(e) => e.preventDefault()}
                  onDragStart={(e) => e.preventDefault()}
                />
              </span>
              <span className="remote-pane-cell remote-pane-cell-size" />
              <span className="remote-pane-cell remote-pane-cell-type" />
              <span className="remote-pane-cell remote-pane-cell-modified" />
              <span className="remote-pane-cell remote-pane-cell-perms" />
              <span className="remote-pane-cell remote-pane-cell-owner" />
            </div>
          )}

          {entries.length > 0 && (
            <VirtualList
              entries={sortedEntries}
              selectedNames={selectedNames}
              onRowClick={onRowSingleClick}
              onRowDoubleClick={onRowDoubleClick}
              onStartRename={startRename}
              renamingName={renamingName}
              renameValue={renameValue}
              renameInputRef={renameInputRef}
              onRenameChange={setRenameValue}
              onRenameCommit={(name) => void commitRename(name)}
              onRenameCancel={cancelRename}
              onRowContextMenu={openEntryMenu}
              onRowDragStart={onRowDragStart}
            />
          )}
        </div>
      </div>

      {/* ==================== 底部统计栏 ==================== */}
      <div className="remote-pane-stats">
        <span className="remote-pane-stats-left">
          <span>{stats.folders} 个文件夹, {stats.files} 个文件</span>
          <span className="remote-pane-stats-sep">|</span>
          <span>{formatSize(stats.totalSize)}</span>
          {selectedNames.size > 0 && (
            <>
              <span className="remote-pane-stats-sep">|</span>
              <span style={{ color: 'var(--accent)' }}>
                已选 {selectedNames.size} 项
                {stats.selectedSize > 0 && (
                  <span> · {formatSize(stats.selectedSize)}</span>
                )}
              </span>
            </>
          )}
        </span>
        <span className="sftp-badge" title="SFTP 加密传输">
          <Lock size={10} />
          SFTP
        </span>
      </div>

      {/* ==================== 右键菜单 ==================== */}
      {ctxMenu && (
        <div
          className="host-menu sidebar-context-menu fb-context-menu"
          ref={ctxMenuRef}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            transform: `translate(${ctxMenu.x}px, ${ctxMenu.y}px)`,
          }}
          role="menu"
          onContextMenu={(e) => e.preventDefault()}
        >
          {ctxMenu.kind === 'blank' && (
            <>
              <button
                className="host-menu-item"
                type="button"
                role="menuitem"
                onClick={handleCtxNewFolder}
              >
                <FolderPlus size={11} /> 新建文件夹
              </button>
              <button
                className="host-menu-item"
                type="button"
                role="menuitem"
                onClick={handleCtxNewFile}
              >
                <FilePlus size={11} /> 新建文件
              </button>
            </>
          )}

          {ctxMenu.kind === 'entry' && ctxMenu.entry && (
            <>
              {!ctxMenu.entry.is_dir && isTextFile(ctxMenu.entry) && (
                <>
                  <button
                    className="host-menu-item"
                    type="button"
                    role="menuitem"
                    onClick={() => handleCtxView(ctxMenu.entry!)}
                  >
                    <Eye size={11} /> 查看
                  </button>
                  <button
                    className="host-menu-item"
                    type="button"
                    role="menuitem"
                    onClick={() => handleCtxEdit(ctxMenu.entry!)}
                  >
                    <Pencil size={11} /> 编辑
                  </button>
                  <div className="host-menu-separator" />
                </>
              )}
              <button
                className="host-menu-item"
                type="button"
                role="menuitem"
                onClick={() => void handleCtxDownload(ctxMenu.entry!)}
              >
                <Download size={11} /> 下载到本地
              </button>
              <button
                className="host-menu-item"
                type="button"
                role="menuitem"
                onClick={() => void handleCtxCopyPath(ctxMenu.entry!)}
              >
                <Copy size={11} /> 复制路径
              </button>
              <button
                className="host-menu-item"
                type="button"
                role="menuitem"
                onClick={() => handleCtxRename(ctxMenu.entry!)}
              >
                <Pencil size={11} /> 重命名
              </button>
              <button
                className="host-menu-item host-menu-danger"
                type="button"
                role="menuitem"
                onClick={() => void handleCtxDelete(ctxMenu.entry!)}
              >
                <Trash2 size={11} />
                {selectedNames.size > 1 && selectedNames.has(ctxMenu.entry!.name)
                  ? `删除已选 ${selectedNames.size} 项`
                  : '删除'}
              </button>
            </>
          )}
        </div>
      )}

      {/* ==================== 文本编辑器 ==================== */}
      {editorTarget && (
        <TextEditorDialog
          hostId={hostId}
          filePath={editorTarget.filePath}
          fileName={editorTarget.fileName}
          viewOnly={editorTarget.viewOnly}
          onClose={() => setEditorTarget(null)}
        />
      )}

      {/* ==================== 自定义 mini 确认对话框（紧凑版）：替代 @tauri-apps/plugin-dialog ask 原生样式 ==================== */}
      {miniDialog &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="dialog-overlay sidebar-mini-overlay"
            role="dialog"
            aria-modal="true"
            onClick={() => closeMiniDialog()}
          >
            <div
              className="dialog dialog-mini"
              onClick={(e) => e.stopPropagation()}
              style={{ width: 420 }}
            >
              <div className="dialog-header">
                <div className="sidebar-mini-title-wrap">
                  {miniDialog.danger ? (
                    <AlertTriangle
                      size={16}
                      className="sidebar-mini-icon sidebar-mini-icon-danger"
                    />
                  ) : (
                    <AlertTriangle
                      size={16}
                      className="sidebar-mini-icon sidebar-mini-icon-info"
                    />
                  )}
                  <h3 className="dialog-title">{miniDialog.title}</h3>
                </div>
              </div>
              <div className="dialog-body sidebar-mini-body">
                <p className="sidebar-mini-message">{miniDialog.message}</p>
              </div>
              <div className="dialog-footer sidebar-mini-footer">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => closeMiniDialog()}
                >
                  {miniDialog.cancelLabel ?? '取消'}
                </button>
                <button
                  type="button"
                  className={`btn ${miniDialog.danger ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => miniDialog.onOk()}
                >
                  {miniDialog.okLabel ?? '确定'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

// ============================================================
// 表头单元格
// ============================================================
interface HeaderCellProps {
  label: string;
  sortKey: SortKey;
  currentKey: SortKey;
  sortDir: SortDir;
  onClick: (key: SortKey) => void;
  className: string;
}

function HeaderCell({ label, sortKey, currentKey, sortDir, onClick, className }: HeaderCellProps) {
  const isActive = currentKey === sortKey;
  return (
    <button
      type="button"
      className={`remote-pane-header-item ${className} ${isActive ? 'is-sorted' : ''}`}
      onClick={() => onClick(sortKey)}
    >
      <span className="remote-pane-header-label">{label}</span>
      {isActive && (
        <span className="remote-pane-sort-indicator">
          {sortDir === 'asc' ? <ArrowUp size={10} /> : <ArrowDown size={10} />}
        </span>
      )}
    </button>
  );
}

// ============================================================
// 虚拟滚动列表
// ============================================================
interface VirtualListProps {
  entries: FileEntry[];
  selectedNames: Set<string>;
  onRowClick: (e: React.MouseEvent, entry: FileEntry) => void;
  onRowDoubleClick: (entry: FileEntry) => void;
  onStartRename?: (entry: FileEntry) => void;
  renamingName: string | null;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null> | null;
  onRenameChange: (v: string) => void;
  onRenameCommit: (oldName: string) => void;
  onRenameCancel: () => void;
  onRowContextMenu?: (e: React.MouseEvent, entry: FileEntry) => void;
  onRowDragStart?: (e: React.DragEvent, entry: FileEntry) => void;
}

function VirtualList(props: VirtualListProps) {
  const {
    entries,
    selectedNames,
    onRowClick,
    onRowDoubleClick,
    onStartRename,
    renamingName,
    renameValue,
    renameInputRef,
    onRenameChange,
    onRenameCommit,
    onRenameCancel,
    onRowContextMenu,
    onRowDragStart,
  } = props;

  const parentRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

  return (
    <div className="remote-pane-vlist" ref={parentRef}>
      <div
        className="fb-list-inner"
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const entry = entries[vi.index];
          const isSelected = selectedNames.has(entry.name);
          const isRenaming = renamingName === entry.name;
          return (
            <div
              key={`${entry.name}-${vi.index}`}
              className={`remote-pane-row ${isSelected ? 'selected' : ''}`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
              draggable={!isRenaming}
              onDragStart={(e) => {
                if (isRenaming) {
                  e.preventDefault();
                  return;
                }
                onRowDragStart?.(e, entry);
              }}
              onClick={(e) => onRowClick(e, entry)}
              onDoubleClick={() => onRowDoubleClick(entry)}
              onContextMenu={(e) => {
                e.stopPropagation();
                if (onRowContextMenu) onRowContextMenu(e, entry);
              }}
              title={entry.name}
            >
              {/* 名称 */}
              <span className="remote-pane-cell remote-pane-cell-name">
                <span className={`fb-row-icon ${iconClass(entry)}`}>
                  <EntryIcon entry={entry} size={14} />
                </span>
                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    className="fb-row-name-input"
                    value={renameValue}
                    onChange={(e) => onRenameChange(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        onRenameCommit(entry.name);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        onRenameCancel();
                      }
                    }}
                    onBlur={() => onRenameCommit(entry.name)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    onDragStart={(e) => e.preventDefault()}
                  />
                ) : (
                  <span
                    className="remote-pane-cell-text"
                    onDoubleClick={(e) => {
                      // 仅双击文字本身 → 进入重命名；双击文字外空白 → 触发行双击（导航/打开）
                      const span = e.currentTarget;
                      const x = e.clientX;
                      const y = e.clientY;
                      let onText = false;
                      const range = document.createRange();
                      for (let i = 0; i < span.childNodes.length; i++) {
                        const node = span.childNodes[i];
                        if (node.nodeType === Node.TEXT_NODE) {
                          range.selectNodeContents(node);
                          const rects = range.getClientRects();
                          for (let r = 0; r < rects.length; r++) {
                            const rect = rects[r];
                            if (
                              x >= rect.left &&
                              x <= rect.right &&
                              y >= rect.top &&
                              y <= rect.bottom
                            ) {
                              onText = true;
                              break;
                            }
                          }
                          if (onText) break;
                        }
                      }
                      if (onText) {
                        e.stopPropagation();
                        if (onStartRename) onStartRename(entry);
                      }
                    }}
                  >
                    {entry.name}
                  </span>
                )}
              </span>
              {/* 大小 */}
              <span className="remote-pane-cell remote-pane-cell-size">
                {entry.is_dir ? '—' : formatSize(entry.size)}
              </span>
              {/* 类型 */}
              <span className="remote-pane-cell remote-pane-cell-type">
                {typeLabel(entry)}
              </span>
              {/* 修改时间 */}
              <span className="remote-pane-cell remote-pane-cell-modified">
                {formatDate(entry.modified)}
              </span>
              {/* 权限 */}
              <span className="remote-pane-cell remote-pane-cell-perms">
                {entry.permissions || '—'}
              </span>
              {/* 所有者 */}
              <span className="remote-pane-cell remote-pane-cell-owner">
                {entry.owner || '—'}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// Loading overlay
// ============================================================
function Loading() {
  return (
    <div className="fb-loading">
      <div className="fb-loading-spinner" />
      <span>加载中…</span>
    </div>
  );
}

// ============================================================
// 工具
// ============================================================
function EntryIcon({
  entry,
  size = 14,
  className,
}: {
  entry: FileEntry;
  size?: number;
  className?: string;
}) {
  if (entry.is_dir) return <Folder size={size} className={className} />;
  if (entry.file_type === 'symlink') return <FileText size={size} className={className} />;
  return <FileIcon size={size} className={className} />;
}

function iconClass(entry: FileEntry): string {
  if (entry.is_dir) return 'fb-icon-dir';
  if (entry.file_type === 'symlink') return 'fb-icon-symlink';
  return 'fb-icon-file';
}

function typeLabel(entry: FileEntry): string {
  if (entry.is_dir) return '文件夹';
  if (entry.file_type === 'symlink') return '链接';
  return '文件';
}

function formatSize(bytes: number): string {
  if (bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return `${v} ${units[i]}`;
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

function formatDate(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  if (isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
