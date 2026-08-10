//! 本地文件系统浏览：供双栏文件管理器左栏使用。
//!
//! 提供 Tauri 命令：
//!  - `list_local_dir`
//!  - `local_home_dir`
//!  - `read_local_file_bytes`（按绝对路径读取本地文件字节，供「从本地栏上传到远程」用）
//!
//! 命令声明为 async 以便在线程池执行同步 IO，不阻塞 UI 线程。

use serde::Serialize;
use std::io::Read;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalFileEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,     // Unix 秒级时间戳
    pub file_type: String, // "dir" | "file" | "symlink"
}

/// 列出本地目录下的条目，文件夹置顶，同类按名称（不区分大小写）排序。
#[tauri::command]
pub async fn list_local_dir(path: String) -> Result<Vec<LocalFileEntry>, String> {
    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&path).map_err(|e| format!("read dir: {e}"))?;
    for entry in read_dir {
        let entry = entry.map_err(|e| format!("read entry: {e}"))?;
        let metadata = entry.metadata().map_err(|e| format!("metadata: {e}"))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let is_dir = metadata.is_dir();
        let file_type = if metadata.is_symlink() {
            "symlink".to_string()
        } else if metadata.is_dir() {
            "dir".to_string()
        } else {
            "file".to_string()
        };
        let size = if is_dir { 0 } else { metadata.len() };
        entries.push(LocalFileEntry {
            name,
            is_dir,
            size,
            modified,
            file_type,
        });
    }
    // 文件夹置顶，同类按名称排序
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

/// 返回当前用户的 home 目录路径。
#[tauri::command]
pub async fn local_home_dir() -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| "cannot determine home directory".to_string())
}

/// 读取本地文件的完整字节（Vec<u8>），返回给前端做 256KB 分片上传。
///
/// 安全约束：
///  - 仅允许常规文件（拒绝目录、设备、symlink 目标是目录的情况）
///  - 单个文件大小上限 2 GiB（避免一次性占满内存）
#[tauri::command]
pub async fn read_local_file_bytes(path: String) -> Result<Vec<u8>, String> {
    // 先确认路径是一个常规可读文件
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat: {e}"))?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }
    let size = meta.len();
    const MAX: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB 单次读取上限
    if size > MAX {
        return Err(format!(
            "file too large ({} bytes) to read at once, max is 2 GiB",
            size
        ));
    }
    let mut f = std::fs::File::open(&path).map_err(|e| format!("open: {e}"))?;
    let mut buf = Vec::with_capacity(size as usize);
    f.read_to_end(&mut buf).map_err(|e| format!("read: {e}"))?;
    Ok(buf)
}

/// 读取本地文件指定 [offset, offset+length) 范围的字节，返回原始二进制。
///
/// 使用 tauri::ipc::Response 直接返回字节，避免 JSON 数组序列化开销
/// （56MB 文件走 JSON 需要序列化 5600 万个数字，延迟 10 秒以上）。
/// 前端通过 `invoke<ArrayBuffer>` 接收，无需逐字节拷贝。
#[tauri::command]
pub async fn read_local_file_chunk(
    path: String,
    offset: u64,
    length: u64,
) -> Result<tauri::ipc::Response, String> {
    use std::io::{Read, Seek, SeekFrom};

    let meta = std::fs::metadata(&path).map_err(|e| format!("stat: {e}"))?;
    if !meta.is_file() {
        return Err("not a regular file".to_string());
    }
    let file_size = meta.len();
    if offset >= file_size {
        // 越界：返回空
        return Ok(tauri::ipc::Response::new(Vec::<u8>::new()));
    }
    let actual_len = length.min(file_size - offset);

    let mut f = std::fs::File::open(&path).map_err(|e| format!("open: {e}"))?;
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek: {e}"))?;

    let mut buf = vec![0u8; actual_len as usize];
    let mut read = 0u64;
    while read < actual_len {
        let n = f
            .read(&mut buf[read as usize..(actual_len as usize)])
            .map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break; // EOF 提前
        }
        read += n as u64;
    }
    buf.truncate(read as usize);
    Ok(tauri::ipc::Response::new(buf))
}
