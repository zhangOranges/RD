import { invoke } from '@tauri-apps/api/core';
import { joinLocalPath, type LocalFileEntry } from '../store/localFileStore';
import { useTransferStore, genTaskId } from '../store/transferStore';
import { logWarn, logError } from '../utils/log';
import { joinRemotePath } from './path';
import { isCancelError } from './cancel';

export interface LocalFlatItem {
  relPath: string;
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
}

/** 递归读取本地一个目录为扁平条目列表。 */
export async function walkLocalDir(
  dirFullPath: string,
  relBase: string,
  out: LocalFlatItem[],
): Promise<void> {
  const entries = await invoke<LocalFileEntry[]>('list_local_dir', { path: dirFullPath }).catch((e) => {
    logWarn(`读取子目录失败，已跳过: ${dirFullPath} - ${String(e)}`);
    return [];
  });
  for (const e of entries) {
    const childRel = relBase ? `${relBase}/${e.name}` : e.name;
    const childFull = joinLocalPath(dirFullPath, e.name);
    if (e.isDir) {
      out.push({ relPath: childRel, name: e.name, fullPath: childFull, isDir: true, size: 0 });
      await walkLocalDir(childFull, childRel, out);
    } else {
      out.push({ relPath: childRel, name: e.name, fullPath: childFull, isDir: false, size: e.size });
    }
  }
}

/** 把一组本地条目（含文件夹）展开成扁平目录 + 文件列表。 */
export async function collectLocalForUpload(
  localBaseDir: string,
  entries: Array<{ name: string; isDir: boolean; size: number }>,
): Promise<LocalFlatItem[]> {
  const result: LocalFlatItem[] = [];
  const ordered = [...entries].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  for (const e of ordered) {
    const full = joinLocalPath(localBaseDir, e.name);
    if (e.isDir) {
      result.push({ relPath: e.name, name: e.name, fullPath: full, isDir: true, size: 0 });
      await walkLocalDir(full, e.name, result);
    } else {
      result.push({ relPath: e.name, name: e.name, fullPath: full, isDir: false, size: e.size });
    }
  }
  return result;
}

/** 用 Tauri 指令读本地文件字节（ArrayBuffer），按 256KB 切片。
 *
 * 使用 read_local_file_chunk 流式分片读取（每片 256KB），通过
 * tauri::ipc::Response 返回原始字节，避免一次性读取整文件再走 JSON
 * 数组序列化导致的 10 秒级延迟（56MB → 5600 万数字 JSON 编码）。
 * 同时让上传进度条和速率从第一个分片起即时更新。
 *
 * @param totalBytes 调用方已知的文件大小（字节）。若为 0 则回退到整文件读取。
 */
export async function readLocalFileChunked(
  _hostId: string,
  localFullPath: string,
  onChunk: (chunkBytes: ArrayBuffer, offset: number, total: number, isFirst: boolean) => Promise<void>,
  totalBytes?: number,
): Promise<void> {
  const CHUNK = 256 * 1024;
  const total = totalBytes ?? 0;

  // 调用方未提供大小，则回退到一次性整文件读取（兼容性兜底）
  if (total === 0) {
    const bytes = await invoke<number[]>('read_local_file_bytes', { path: localFullPath });
    const fallbackTotal = bytes.length;
    const u8 = new Uint8Array(fallbackTotal);
    for (let i = 0; i < fallbackTotal; i++) u8[i] = bytes[i] & 0xff;
    let offset = 0;
    let isFirst = true;
    while (offset < fallbackTotal) {
      const end = Math.min(offset + CHUNK, fallbackTotal);
      const slice = u8.slice(offset, end).buffer as ArrayBuffer;
      await onChunk(slice, offset, fallbackTotal, isFirst);
      await new Promise<void>((r) => setTimeout(r, 0));
      isFirst = false;
      offset = end;
    }
    if (fallbackTotal === 0) {
      await onChunk(new ArrayBuffer(0), 0, 0, true);
    }
    return;
  }

  // 流式分片读取：每片独立调用 Rust，直接拿到 ArrayBuffer，无 JSON 序列化
  let offset = 0;
  let isFirst = true;
  while (offset < total) {
    const end = Math.min(offset + CHUNK, total);
    const length = end - offset;
    const chunkBuf = await invoke<ArrayBuffer>('read_local_file_chunk', {
      path: localFullPath,
      offset,
      length,
    });
    await onChunk(chunkBuf, offset, total, isFirst);
    await new Promise<void>((r) => setTimeout(r, 0));
    isFirst = false;
    offset = end;
  }
  if (total === 0) {
    await onChunk(new ArrayBuffer(0), 0, 0, true);
  }
}

/** 重新导出，保持现有 import 兼容 */
export { joinRemotePath } from './path';

export type OverrideChoice = 'skip' | 'overwrite' | 'ask';

/**
 * 通过压缩传输上传文件夹：本地压缩 → 上传 tar.gz → 远程解压 → 清理临时文件。
 * 比逐文件上传快得多，尤其适合包含大量小文件的目录。
 */
async function uploadFolderCompressed(
  hostId: string,
  remoteCurrentPath: string,
  localBaseDir: string,
  folderName: string,
  opts: {
    pushToast: (kind: 'success' | 'warning' | 'error' | 'info', msg: string) => void;
    createTransferTask: ReturnType<typeof useTransferStore.getState>['createTask'];
    cancelTransferTask: ReturnType<typeof useTransferStore.getState>['cancelTask'];
    refreshRemote: () => Promise<void>;
  },
): Promise<boolean> {
  const { pushToast, createTransferTask, cancelTransferTask, refreshRemote } = opts;
  const taskId = genTaskId();
  // 临时文件放在远程目标目录中，用户可见
  const remoteTmpPath = joinRemotePath(remoteCurrentPath, `${folderName}.tar.gz.tmp`);
  // 上传完成后重命名为正式的压缩包名
  const remoteFinalPath = joinRemotePath(remoteCurrentPath, `${folderName}.tar.gz`);

  createTransferTask({
    id: taskId,
    kind: 'upload',
    hostId,
    name: folderName,
    remotePath: joinRemotePath(remoteCurrentPath, folderName),
    localPath: localBaseDir,
    totalBytes: 0,
  });

  useTransferStore.getState().setTaskStatus(taskId, 'running');

  let localTarball: string | null = null;
  let remoteCleaned = false;
  try {
    // 1. 本地压缩
    useTransferStore.getState().setTaskStatus(taskId, 'running', { name: `${folderName} (压缩中...)` });
    const result = await invoke<{ path: string; size: number }>('compress_local_dir', {
      dirPath: localBaseDir,
      dirName: folderName,
    });
    localTarball = result.path;

    // 更新 totalBytes 以显示上传进度
    useTransferStore.getState().setTaskStatus(taskId, 'running', {
      totalBytes: result.size,
      name: folderName,
    });

    // 2. 上传 tar.gz 到远程目标目录中的临时文件（用户可见）
    await readLocalFileChunked(hostId, localTarball, async (chunk, offset, total, isFirst) => {
      const t = useTransferStore.getState().tasks.find((x) => x.id === taskId);
      if (t && (t.status === 'canceled' || t.status === 'error')) {
        throw new Error('__canceled__');
      }
      const chunkBytesArr = Array.from(new Uint8Array(chunk));
      await invoke('sftp_upload_chunk', {
        hostId,
        path: remoteTmpPath,
        data: chunkBytesArr,
        isFirst,
        taskId,
        name: `${folderName}.tar.gz`,
        totalBytes: total,
        bytesOffset: offset,
      });
    }, result.size);

    // 3. 上传完成：将 .tmp 重命名为正式的 .tar.gz
    await invoke('sftp_rename', {
      hostId,
      oldPath: remoteTmpPath,
      newPath: remoteFinalPath,
    });

    // 4. 远程解压
    useTransferStore.getState().setTaskStatus(taskId, 'running', { name: `${folderName} (解压中...)` });
    await invoke('ssh_exec', {
      hostId,
      command: `tar -xzf "${remoteFinalPath}" -C "${remoteCurrentPath}"`,
    });

    // 5. 解压完成后删除远程压缩包
    await invoke('sftp_remove_file', { hostId, path: remoteFinalPath }).catch(() => {});
    remoteCleaned = true;

    // 6. 标记完成（恢复任务名）
    useTransferStore.getState().setTaskStatus(taskId, 'completed', { name: folderName });
    return true;
  } catch (err) {
    if (isCancelError(err)) {
      cancelTransferTask(taskId);
      pushToast('info', `已取消上传：${folderName}`);
    } else {
      logError(`文件夹上传失败: ${folderName} - ${String(err)}`);
      pushToast('error', `文件夹上传失败：${folderName} - ${String(err)}`);
      cancelTransferTask(taskId);
    }
    return false;
  } finally {
    // 7. 清理本地临时压缩包
    if (localTarball) {
      invoke('delete_local_path', { path: localTarball }).catch(() => {});
    }
    // 仅在失败时清理远程残留（成功时步骤 5 已删除）
    if (!remoteCleaned) {
      invoke('sftp_remove_file', { hostId, path: remoteTmpPath }).catch(() => {});
      invoke('sftp_remove_file', { hostId, path: remoteFinalPath }).catch(() => {});
    }
    await refreshRemote().catch(() => {});
  }
}

/**
 * 执行本地条目到远程的上传（通用实现）。
 *
 * @param hostId 目标主机 id
 * @param remoteCurrentPath 远程目标目录
 * @param localBaseDir 本地根目录（entries 所在的父目录）
 * @param entries 待上传的本地条目列表（顶层，含文件夹）
 * @param opts 控制参数和回调
 * @returns { successes, skipped, errors }
 */
export async function uploadLocalItemsToRemote(
  hostId: string,
  remoteCurrentPath: string,
  localBaseDir: string,
  entries: Array<{ name: string; isDir: boolean; size: number }>,
  opts: {
    pushToast: (kind: 'success' | 'warning' | 'error' | 'info', msg: string) => void;
    createTransferTask: ReturnType<typeof useTransferStore.getState>['createTask'];
    cancelTransferTask: ReturnType<typeof useTransferStore.getState>['cancelTask'];
    globalOverrideRef: { current: OverrideChoice };
    setGlobalOverride: (v: OverrideChoice) => void;
    remoteEntriesCheck: (topLevelName: string) => boolean;
    refreshRemote: () => Promise<void>;
  },
): Promise<{ successes: number; skipped: number; errors: number }> {
  const {
    pushToast,
    createTransferTask,
    cancelTransferTask,
    globalOverrideRef,
    setGlobalOverride,
    remoteEntriesCheck,
    refreshRemote,
  } = opts;

  let successes = 0;
  let skipped = 0;
  let errors = 0;

  // 分离文件夹和文件：文件夹走压缩传输，文件走逐文件上传
  const topLevelFolders = entries.filter((e) => e.isDir);
  const topLevelFiles = entries.filter((e) => !e.isDir);

  // 1. 先处理文件夹（压缩 → 上传 → 远程解压）
  for (const folder of topLevelFolders) {
    const ok = await uploadFolderCompressed(hostId, remoteCurrentPath, localBaseDir, folder.name, {
      pushToast,
      createTransferTask,
      cancelTransferTask,
      refreshRemote,
    });
    if (ok) {
      successes++;
    } else {
      errors++;
    }
  }

  // 2. 处理文件（保留原有逐文件上传逻辑）
  let flat: LocalFlatItem[] = [];
  try {
    flat = await collectLocalForUpload(localBaseDir, topLevelFiles);
  } catch (err) {
    logError(`读取本地文件失败: ${String(err)}`);
    pushToast('error', `读取本地文件失败：${String(err)}`);
    return { successes, skipped, errors: errors + topLevelFiles.length };
  }
  if (flat.length === 0) {
    return { successes, skipped, errors };
  }
  flat.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.relPath.localeCompare(b.relPath));

  // 预创建所有文件任务为 queued 状态，让用户立刻在传输队列中看到全部待上传文件
  const taskIdMap = new Map<string, string>();
  for (const item of flat) {
    if (item.isDir) continue;
    const tid = genTaskId();
    taskIdMap.set(item.relPath, tid);
    createTransferTask({
      id: tid,
      kind: 'upload',
      hostId,
      name: item.name,
      remotePath: joinRemotePath(remoteCurrentPath, item.relPath),
      localPath: localBaseDir,
      totalBytes: item.size || 0,
      status: 'queued',
    });
  }

  for (const item of flat) {
    const remotePath = joinRemotePath(remoteCurrentPath, item.relPath);

    if (item.isDir) {
      try {
        await invoke('sftp_mkdir_all', { hostId, path: remotePath });
        successes++;
      } catch (e) {
        logWarn(`mkdir failed (ignored): ${remotePath} ${String(e)}`);
      }
      continue;
    }

    // --- 文件：检测冲突 + 分片上传 ---
    const topLevelName = item.relPath.includes('/') ? null : item.relPath;
    const directlyExists = topLevelName !== null && remoteEntriesCheck(topLevelName);

    let needWrite = true;
    if (directlyExists) {
      if (globalOverrideRef.current === 'skip') {
        skipped++;
        needWrite = false;
      } else if (globalOverrideRef.current === 'overwrite') {
        needWrite = true;
      } else {
        const choice = confirm(
          `文件 "${item.relPath}" 已存在。\n\n是否覆盖？\n"取消" = 跳过，"确定" = 覆盖。`,
        );
        if (choice) {
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

    const uploadTaskId = taskIdMap.get(item.relPath)!;
    if (!needWrite) {
      // 被跳过的文件：标记为已取消
      cancelTransferTask(uploadTaskId);
      continue;
    }

    // 确保父目录存在（嵌套）
    if (item.relPath.includes('/')) {
      const slash = item.relPath.lastIndexOf('/');
      const parentRel = item.relPath.slice(0, slash);
      const parentRemote = joinRemotePath(remoteCurrentPath, parentRel);
      try {
        await invoke('sftp_mkdir_all', { hostId, path: parentRemote });
      } catch { /* ignore */ }
    }

    const displayName = item.name;
    let fileCanceled = false;
    // 从 queued 切换到 running
    useTransferStore.getState().setTaskStatus(uploadTaskId, 'running');

    try {
      await readLocalFileChunked(hostId, item.fullPath, async (chunk, offset, total, isFirst) => {
        const t = useTransferStore.getState().tasks.find((x) => x.id === uploadTaskId);
        if (t && (t.status === 'canceled' || t.status === 'error')) {
          fileCanceled = true;
          throw new Error('__canceled__');
        }
        const chunkBytesArr = Array.from(new Uint8Array(chunk));
        await invoke('sftp_upload_chunk', {
          hostId,
          path: remotePath,
          data: chunkBytesArr,
          isFirst,
          taskId: uploadTaskId,
          name: displayName,
          totalBytes: total,
          bytesOffset: offset,
        });
      }, item.size || 0);
      if (fileCanceled) {
        errors++;
      } else {
        successes++;
      }
    } catch (err) {
      if (isCancelError(err)) {
        errors++;
      } else {
        errors++;
        logError(`upload failed: ${remotePath} ${String(err)}`);
        pushToast('error', `${item.relPath}: ${String(err)}`);
        if (uploadTaskId) cancelTransferTask(uploadTaskId);
        // 清理远端残留的不完整文件（大小校验失败时后端已删除，这里兜底其他错误）
        invoke('sftp_remove_file', { hostId, path: remotePath }).catch(() => {});
      }
    }
  }

  if (successes > 0) {
    await refreshRemote();
  }

  return { successes, skipped, errors };
}

/** 拖拽 payload 类型（LocalFilePane → FileBrowser） */
export interface LocalPaneSelectedPayload {
  source: 'local-pane-selected';
  hostId: string;
  baseDir: string;
  items: Array<{ name: string; isDir: boolean; size: number; fileType: string }>;
}

/** 从 DataTransfer 解析本地面板选中的拖拽 payload（如果有） */
export function tryParseLocalPanePayload(dt: DataTransfer): LocalPaneSelectedPayload | null {
  try {
    const raw = dt.getData('application/x-local-pane-selected');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && parsed.source === 'local-pane-selected' && parsed.baseDir && Array.isArray(parsed.items)) {
      return parsed as LocalPaneSelectedPayload;
    }
    return null;
  } catch {
    return null;
  }
}
