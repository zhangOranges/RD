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

/// 返回系统临时目录路径。
#[tauri::command]
pub async fn local_temp_dir() -> Result<String, String> {
    Ok(std::env::temp_dir().to_string_lossy().to_string())
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

/// 压缩结果
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompressResult {
    pub path: String,
    pub size: u64,
}

/// 将本地目录压缩为 tar.gz，返回临时文件路径和大小。
/// 调用系统 tar 命令（Windows 10+、macOS、Linux 均自带）。
#[tauri::command]
pub async fn compress_local_dir(
    dir_path: String,
    dir_name: String,
) -> Result<CompressResult, String> {
    let temp_dir = std::env::temp_dir();
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let safe_name = dir_name.replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "_");
    let output_path = temp_dir.join(format!("rd_transfer_{}_{}.tar.gz", timestamp, safe_name));
    let output_str = output_path.to_string_lossy().to_string();

    let output = std::process::Command::new("tar")
        .args(["-czf", &output_str, "-C", &dir_path, &dir_name])
        .output()
        .map_err(|e| format!("Failed to run tar: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tar compress failed: {stderr}"));
    }

    let size = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    Ok(CompressResult {
        path: output_str,
        size,
    })
}

/// 解压本地 tar.gz 文件到指定目录。
#[tauri::command]
pub async fn extract_local_archive(archive_path: String, dest_dir: String) -> Result<(), String> {
    // 确保目标目录存在
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("create dest dir: {e}"))?;

    let output = std::process::Command::new("tar")
        .args(["-xzf", &archive_path, "-C", &dest_dir])
        .output()
        .map_err(|e| format!("Failed to run tar: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("tar extract failed: {stderr}"));
    }
    Ok(())
}

/// 删除本地文件或目录（用于清理临时压缩包）。
#[tauri::command]
pub async fn delete_local_path(path: String) -> Result<(), String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("stat: {e}"))?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| format!("remove dir: {e}"))?;
    } else {
        std::fs::remove_file(&path).map_err(|e| format!("remove file: {e}"))?;
    }
    Ok(())
}

/// 重命名/移动本地文件或目录。
#[tauri::command]
pub async fn rename_local_path(old_path: String, new_path: String) -> Result<(), String> {
    std::fs::rename(&old_path, &new_path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}
