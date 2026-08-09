import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  Folder,
  File as FileIcon,
  FileText,
  CornerLeftUp,
  AlertTriangle,
  FolderPlus,
  FilePlus,
  Pencil,
  Trash2,
  Eye,
  Download,
} from 'lucide-react';
import {
  useFileStore,
  type FileEntry,
  parentPath,
  joinPath,
  isTextFile,
} from '../store/fileStore';
import { useToastStore } from './Toast';
import { TextEditorDialog } from './TextEditorDialog';
import {
  useTransferStore,
  genTaskId,
} from '../store/transferStore';
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
  // 编辑文本时用
}

type InlineCreateMode = null | { kind: 'file' | 'folder'; initial?: string };

const ROW_HEIGHT = 26;
const MIN_COL_WIDTH = 160;

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
  const navigate = useFileStore((s) => s.navigate);
  const selectEntry = useFileStore((s) => s.selectEntry);
  const refresh = useFileStore((s) => s.refresh);
  const rename = useFileStore((s) => s.rename);
  const mkdir = useFileStore((s) => s.mkdir);
  const mkfile = useFileStore((s) => s.mkfile);
  const remove = useFileStore((s) => s.remove);
  const pushToast = useToastStore((s) => s.push);
  const createTransferTask = useTransferStore((s) => s.createTask);
  const setTransferTaskStatus = useTransferStore((s) => s.setTaskStatus);

  // 三栏宽度（左：父目录；中：当前目录；右：预览）
  const [leftWidth, setLeftWidth] = useState(220);
  const [rightWidth, setRightWidth] = useState(280);
  const [resizing, setResizing] = useState<null | 'left' | 'right'>(null);

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

  // 父目录列表（左栏）
  const [parentEntries, setParentEntries] = useState<FileEntry[]>([]);
  const [parentLoading, setParentLoading] = useState(false);
  const [parentError, setParentError] = useState<string | null>(null);

  // 选中目录的子项列表（右栏，选中目录时）
  const [previewEntries, setPreviewEntries] = useState<FileEntry[] | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  // ---- 拖拽上传 ----
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  type OverrideChoice = 'skip' | 'overwrite' | 'ask';
  const [globalOverride, setGlobalOverride] = useState<OverrideChoice>('ask');
  const [previewError, setPreviewError] = useState<string | null>(null);

  // ---- 父目录加载 ----
  useEffect(() => {
    if (!currentPath || currentPath === '/') {
      setParentEntries([]);
      setParentError(null);
      return;
    }
    const parent = parentPath(currentPath);
    if (parent === currentPath) {
      setParentEntries([]);
      return;
    }
    let cancelled = false;
    setParentLoading(true);
    setParentError(null);
    invoke<FileEntry[]>('sftp_list_dir', { hostId, path: parent })
      .then((list) => {
        if (cancelled) return;
        setParentEntries(list);
      })
      .catch((err) => {
        if (cancelled) return;
        setParentError(formatErr(err));
        setParentEntries([]);
      })
      .finally(() => {
        if (!cancelled) setParentLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentPath, hostId]);

  // ---- 右栏预览：选中目录 → 列出子项 ----
  useEffect(() => {
    if (!selectedEntry || !selectedEntry.is_dir || !currentPath) {
      setPreviewEntries(null);
      setPreviewError(null);
      return;
    }
    const target = joinPath(currentPath, selectedEntry.name);
    let cancelled = false;
    setPreviewLoading(true);
    setPreviewError(null);
    invoke<FileEntry[]>('sftp_list_dir', { hostId, path: target })
      .then((list) => {
        if (cancelled) return;
        setPreviewEntries(list);
      })
      .catch((err) => {
        if (cancelled) return;
        setPreviewError(formatErr(err));
        setPreviewEntries([]);
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEntry, currentPath, hostId]);

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
      const hasFiles =
        (e.dataTransfer.files && e.dataTransfer.files.length > 0) ||
        (e.dataTransfer.items &&
          Array.from(e.dataTransfer.items).some((i) => i.kind === 'file'));
      if (!hasFiles) return;
      e.preventDefault();
      setDragOver(false);
      if (uploading) return;
      if (!currentPath) return;

      let items: LocalItem[] = [];
      try {
        items = await collectDroppedItems(e.dataTransfer);
      } catch (err) {
        pushToast('error', `读取拖拽文件失败: ${err}`);
        return;
      }
      if (items.length === 0) return;

      setUploading(true);
      setGlobalOverride('ask');
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
              console.warn('mkdir failed', remotePath, err);
            }
            continue;
          }

          // 3. 文件：检测是否存在（如果是直接顶层，用 entries 缓存）
          // 通用做法：通过 sftp_list_dir 查父目录，或直接写之前判断
          // 简单方案：先判断 entries 中是否有同名
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
                if (all) setGlobalOverride('overwrite');
                needWrite = true;
              } else {
                const skipAll = confirm('对所有后续冲突文件也执行跳过？');
                if (skipAll) setGlobalOverride('skip');
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
              // 每片之前检查前端标记的取消（canceled 状态来自 transfer notification 上的取消按钮 -> sftp_cancel_transfer）
              // Rust 端每次 invoke sftp_upload_chunk 也会再次校验。
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
              // 已经由 transfer-progress（canceled）事件更新了 UI；不需要重复打错误 toast
              // 但计入成功或失败比较合适：记成「跳过/取消」类，这里用 errors+1 方便计数
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
              console.error('upload failed', remotePath, err);
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
    [currentPath, entries, uploading, hostId, refresh, pushToast, createTransferTask, setTransferTaskStatus],
  );

  // ---- 拖拽分隔条 ----
  const onLeftResizerDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing('left');
      const startX = e.clientX;
      const startW = leftWidth;
      const onMove = (ev: MouseEvent) => {
        const w = startW + (ev.clientX - startX);
        setLeftWidth(Math.max(MIN_COL_WIDTH, Math.min(480, w)));
      };
      const onUp = () => {
        setResizing(null);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [leftWidth],
  );

  const onRightResizerDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setResizing('right');
      const startX = e.clientX;
      const startW = rightWidth;
      const onMove = (ev: MouseEvent) => {
        const w = startW - (ev.clientX - startX);
        setRightWidth(Math.max(MIN_COL_WIDTH, Math.min(640, w)));
      };
      const onUp = () => {
        setResizing(null);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [rightWidth],
  );

  // ---- 中栏行交互 ----
  const onRowDoubleClick = useCallback(
    (entry: FileEntry) => {
      if (!currentPath) return;
      if (entry.is_dir) {
        void navigate(hostId, joinPath(currentPath, entry.name));
      } else if (isTextFile(entry)) {
        // 文本文件：双击非名字部分 → 直接以查看模式打开
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

  const onRowSingleClick = useCallback(
    (entry: FileEntry) => {
      selectEntry(entry);
    },
    [selectEntry],
  );

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
    // 如果有重命名或其他内联创建，先清理
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

  // ---- 右键菜单动作 ----
  function openBlankMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ kind: 'blank', x: e.clientX, y: e.clientY });
  }

  function openEntryMenu(e: React.MouseEvent, entry: FileEntry) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ kind: 'entry', x: e.clientX, y: e.clientY, entry });
  }

  function closeCtxMenu() {
    setCtxMenu(null);
  }

  async function handleCtxDelete(entry: FileEntry) {
    const type = entry.is_dir ? '文件夹' : '文件';
    const ok = window.confirm(`确认删除${type}「${entry.name}」？此操作不可撤销。`);
    if (!ok) return;
    closeCtxMenu();
    await remove(hostId, entry.name, entry.is_dir);
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

  // ---- 下载：文件 / 文件夹 ----
  async function handleCtxDownload(entry: FileEntry) {
    if (!currentPath || !hostId) return;
    closeCtxMenu();
    const remotePath = joinPath(currentPath, entry.name);

    try {
      // 1. 弹框选择本地目录（用户选择保存到哪个文件夹下）
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: `选择保存位置 - ${entry.name}`,
        canCreateDirectories: true,
      });
      if (!picked || typeof picked !== 'string') {
        return; // 用户取消
      }
      const localDir = picked;

      // 2. 创建任务记录（展示用）
      const taskId = genTaskId();
      createTransferTask({
        id: taskId,
        kind: 'download',
        hostId,
        name: entry.name,
        remotePath,
        localPath: localDir,
        totalBytes: entry.is_dir ? 0 : entry.size,
      });

      // 3. 调用对应命令：文件 vs 目录
      const cmd = entry.is_dir ? 'sftp_download_dir' : 'sftp_download_file';
      try {
        await invoke(cmd, {
          hostId,
          remotePath,
          localPath: localDir,
          taskId,
        });
        pushToast('success', `已下载：${entry.name}`);
      } catch (err) {
        const msg = String(err);
        if (msg.startsWith('Cancelled:')) {
          // 用户主动取消：不展示错误 toast
          pushToast('info', `已取消下载：${entry.name}`);
        } else {
          // 失败时 Rust 端已 emit 了 error 事件，但为了用户感知，toast 再提一次
          pushToast('error', `下载失败：${msg}`);
        }
      }
    } catch (err) {
      pushToast('error', `选择保存位置失败：${String(err)}`);
    }
  }

  // ---- 父目录行交互（左栏）----
  const onParentRowDoubleClick = useCallback(
    (entry: FileEntry) => {
      if (!entry.is_dir) return;
      if (!currentPath) return;
      // 父目录中的目录项：跳转过去
      const target = joinPath(parentPath(currentPath), entry.name);
      void navigate(hostId, target);
    },
    [currentPath, navigate, hostId],
  );

  const onParentRowClick = useCallback(
    (entry: FileEntry) => {
      // 点击左栏的当前目录项时，相当于刷新当前目录
      if (currentPath && joinPath(parentPath(currentPath), entry.name) === currentPath) {
        void refresh(hostId);
        return;
      }
      if (entry.is_dir) {
        void navigate(hostId, joinPath(parentPath(currentPath ?? '/'), entry.name));
      }
    },
    [currentPath, navigate, refresh, hostId],
  );

  // 当前目录在父目录中的名字（用于左栏高亮）
  const currentNameInParent = useMemo(() => {
    if (!currentPath || currentPath === '/') return null;
    const trimmed = currentPath.replace(/\/+$/, '');
    const idx = trimmed.lastIndexOf('/');
    return idx < 0 ? null : trimmed.slice(idx + 1);
  }, [currentPath]);

  // 注：tauri.conf.json 中已设置 "dragDropEnabled": false，
  // 关闭 Tauri 原生拖拽拦截，让 HTML5 drag/drop 事件正常下发到 webview。
  // 因此这里直接使用 React 的 onDragEnter/onDragOver/onDragLeave/onDrop，
  // 无需 window 级兜底监听或合成 DragEvent 派发。

  return (
    <div
      className={
        'filebrowser' +
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
      <div className="filebrowser-body">
        {/* 左栏：父目录 */}
        <div className="fb-column" style={{ width: leftWidth, flex: `0 0 ${leftWidth}px` }}>
          <div className="fb-column-header">
            {currentPath && currentPath !== '/' ? parentPath(currentPath) : '根目录'}
          </div>
          <div className="fb-column-body">
            {parentLoading && <Loading />}
            {parentError && (
              <div className="fb-empty">
                <AlertTriangle size={22} className="fb-empty-icon" />
                <span>加载父目录失败</span>
              </div>
            )}
            {!parentLoading && !parentError && parentEntries.length === 0 && currentPath !== '/' && (
              <div className="fb-empty">
                <CornerLeftUp size={22} className="fb-empty-icon" />
                <span>无父目录</span>
              </div>
            )}
            {!parentLoading && !parentError && parentEntries.length === 0 && currentPath === '/' && (
              <div className="fb-empty">
                <Folder size={22} className="fb-empty-icon" />
                <span>已在根目录</span>
              </div>
            )}
            {parentEntries.length > 0 && (
              <VirtualList
                entries={parentEntries}
                selectedName={currentNameInParent ?? undefined}
                currentName={currentNameInParent ?? undefined}
                onRowClick={onParentRowClick}
                onRowDoubleClick={onParentRowDoubleClick}
                renamingName={null}
                renameValue=""
                renameInputRef={null}
                onRenameChange={() => {}}
                onRenameCommit={() => {}}
                onRenameCancel={() => {}}
              />
            )}
          </div>
        </div>

        {/* 左分隔条 */}
        <div
          className={`fb-resizer ${resizing === 'left' ? 'is-active' : ''}`}
          onMouseDown={onLeftResizerDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整左栏宽度"
        />

        {/* 中栏：当前目录 */}
        <div className="fb-column" style={{ flex: '1 1 auto', minWidth: MIN_COL_WIDTH }}>
          <div className="fb-column-header">{currentPath ?? '(未打开)'}</div>
          <div
            className="fb-column-body fb-center-column-body"
            onContextMenu={(e) => {
              if (!currentPath) {
                // 未打开远程目录：不做任何操作
                e.preventDefault();
                return;
              }
              // 任何落在 body 空白处的右击都打开「新建」菜单（entry 行有自己的 onContextMenu 会 stopPropagation）
              openBlankMenu(e);
            }}
          >
            {loading && <Loading />}
            {!loading && entries.length === 0 && !currentPath && (
              <div
                className="fb-empty fb-center-empty"
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
                className="fb-empty fb-center-empty"
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
              <div className="fb-inline-create-row">
                <span className={`fb-row-icon ${inlineCreate.kind === 'folder' ? 'fb-icon-dir' : 'fb-icon-file'}`}>
                  {inlineCreate.kind === 'folder' ? <FolderPlus size={14} /> : <FilePlus size={14} />}
                </span>
                <input
                  ref={inlineCreateInputRef}
                  className="fb-row-name-input"
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
                />
              </div>
            )}

            {entries.length > 0 && (
              <VirtualList
                entries={entries}
                selectedName={selectedEntry?.name}
                currentName={undefined}
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
              />
            )}
          </div>
        </div>

        {/* 右分隔条 */}
        <div
          className={`fb-resizer ${resizing === 'right' ? 'is-active' : ''}`}
          onMouseDown={onRightResizerDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="调整右栏宽度"
        />

        {/* 右栏：预览 */}
        <div className="fb-column" style={{ width: rightWidth, flex: `0 0 ${rightWidth}px` }}>
          <div className="fb-column-header">
            {selectedEntry
              ? selectedEntry.is_dir
                ? '目录预览'
                : '文件信息'
              : '预览'}
          </div>
          <div className="fb-column-body">
            {!selectedEntry && (
              <div className="fb-empty">
                <FileText size={22} className="fb-empty-icon" />
                <span>选中文件/文件夹查看预览</span>
              </div>
            )}
            {selectedEntry && selectedEntry.is_dir && (
              <PreviewDir
                loading={previewLoading}
                error={previewError}
                entries={previewEntries}
                onEntryDoubleClick={(entry) => {
                  if (currentPath) {
                    void navigate(hostId, joinPath(joinPath(currentPath, selectedEntry.name), entry.name));
                  }
                }}
              />
            )}
            {selectedEntry && !selectedEntry.is_dir && (
              <FileInfo entry={selectedEntry} />
            )}
          </div>
        </div>
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
                <Trash2 size={11} /> 删除
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
    </div>
  );
}

// ============================================================
// 虚拟滚动列表
// ============================================================
interface VirtualListProps {
  entries: FileEntry[];
  selectedName?: string;
  currentName?: string;
  onRowClick: (entry: FileEntry) => void;
  onRowDoubleClick: (entry: FileEntry) => void;
  onStartRename?: (entry: FileEntry) => void;
  renamingName: string | null;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null> | null;
  onRenameChange: (v: string) => void;
  onRenameCommit: (oldName: string) => void;
  onRenameCancel: () => void;
  onRowContextMenu?: (e: React.MouseEvent, entry: FileEntry) => void;
}

function VirtualList(props: VirtualListProps) {
  const {
    entries,
    selectedName,
    currentName,
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
  } = props;

  const parentRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 16,
  });

  return (
    <div className="fb-list" ref={parentRef}>
      <div
        className="fb-list-inner"
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          position: 'relative',
        }}
      >
        {virtualizer.getVirtualItems().map((vi) => {
          const entry = entries[vi.index];
          const isSelected = entry.name === selectedName;
          const isCurrent = entry.name === currentName;
          const isRenaming = renamingName === entry.name;
          return (
            <div
              key={`${entry.name}-${vi.index}`}
              className={`fb-row ${isSelected ? 'fb-row-selected' : ''} ${isCurrent ? 'fb-row-current' : ''}`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${vi.start}px)`,
              }}
              onClick={() => onRowClick(entry)}
              onDoubleClick={() => onRowDoubleClick(entry)}
              onContextMenu={(e) => {
                e.stopPropagation();
                if (onRowContextMenu) onRowContextMenu(e, entry);
              }}
              title={entry.name}
            >
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
                />
              ) : (
                <span
                  className="fb-row-name"
                  onDoubleClick={(e) => {
                    // 判断双击点是否落在实际文字上：
                    // - 只有在文字上双击 → 重命名（阻止冒泡）
                    // - 在名字 span 内的空白区域双击 → 导航（不阻止冒泡）
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
              {!isRenaming && (
                <span className="fb-row-meta">
                  {entry.is_dir ? '—' : formatSize(entry.size)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// 右栏：选中目录的子项预览
// ============================================================
interface PreviewDirProps {
  loading: boolean;
  error: string | null;
  entries: FileEntry[] | null;
  onEntryDoubleClick: (entry: FileEntry) => void;
}

function PreviewDir({ loading, error, entries, onEntryDoubleClick }: PreviewDirProps) {
  if (loading) return <Loading />;
  if (error) {
    return (
      <div className="fb-empty">
        <AlertTriangle size={22} className="fb-empty-icon" />
        <span>无法读取子项</span>
      </div>
    );
  }
  if (!entries || entries.length === 0) {
    return (
      <div className="fb-empty">
        <Folder size={22} className="fb-empty-icon" />
        <span>空目录</span>
      </div>
    );
  }
  return (
    <div className="fb-info-children">
      {entries.map((entry) => (
        <div
          key={entry.name}
          className="fb-row"
          title={entry.name}
          onDoubleClick={() => onEntryDoubleClick(entry)}
        >
          <span className={`fb-row-icon ${iconClass(entry)}`}>
            <EntryIcon entry={entry} size={14} />
          </span>
          <span className="fb-row-name">{entry.name}</span>
          <span className="fb-row-meta">{entry.is_dir ? '—' : formatSize(entry.size)}</span>
        </div>
      ))}
    </div>
  );
}

// ============================================================
// 右栏：选中文件的信息
// ============================================================
function FileInfo({ entry }: { entry: FileEntry }) {
  return (
    <div className="fb-info">
      <div className="fb-info-header">
        <EntryIcon entry={entry} size={40} className="fb-info-icon" />
        <div className="fb-info-name">{entry.name}</div>
      </div>
      <div className="fb-info-row">
        <span className="fb-info-label">类型</span>
        <span className="fb-info-value">{entry.file_type}</span>
      </div>
      <div className="fb-info-row">
        <span className="fb-info-label">大小</span>
        <span className="fb-info-value">{formatSize(entry.size)}</span>
      </div>
      <div className="fb-info-row">
        <span className="fb-info-label">权限</span>
        <span className="fb-info-value">{entry.permissions}</span>
      </div>
      <div className="fb-info-row">
        <span className="fb-info-label">所有者</span>
        <span className="fb-info-value">{entry.owner}</span>
      </div>
      <div className="fb-info-row">
        <span className="fb-info-label">修改时间</span>
        <span className="fb-info-value">{formatDate(entry.modified)}</span>
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

function formatErr(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
