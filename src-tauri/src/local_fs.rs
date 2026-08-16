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

use crate::{debug_log, LogLevel};

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
pub async fn list_local_dir(
    app: tauri::AppHandle,
    path: String,
) -> Result<Vec<LocalFileEntry>, String> {
    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(&path).map_err(|e| {
        let msg = format!("read dir: {e}");
        debug_log(
            &app,
            LogLevel::Error,
            &format!("list_local_dir: {} path={}", msg, path),
        );
        msg
    })?;
    for entry in read_dir {
        let entry = entry.map_err(|e| {
            let msg = format!("read entry: {e}");
            debug_log(
                &app,
                LogLevel::Error,
                &format!("list_local_dir: {} path={}", msg, path),
            );
            msg
        })?;
        let metadata = entry.metadata().map_err(|e| {
            let msg = format!("metadata: {e}");
            debug_log(
                &app,
                LogLevel::Error,
                &format!("list_local_dir: {} path={}", msg, path),
            );
            msg
        })?;
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
pub async fn local_home_dir(app: tauri::AppHandle) -> Result<String, String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| {
            let msg = "cannot determine home directory".to_string();
            debug_log(&app, LogLevel::Error, &format!("local_home_dir: {}", msg));
            msg
        })
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
pub async fn read_local_file_bytes(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    // 先确认路径是一个常规可读文件
    let meta = std::fs::metadata(&path).map_err(|e| {
        let msg = format!("stat: {e}");
        debug_log(
            &app,
            LogLevel::Error,
            &format!("read_local_file_bytes: {} path={}", msg, path),
        );
        msg
    })?;
    if !meta.is_file() {
        let msg = "not a regular file".to_string();
        debug_log(
            &app,
            LogLevel::Error,
            &format!("read_local_file_bytes: {} path={}", msg, path),
        );
        return Err(msg);
    }
    let size = meta.len();
    const MAX: u64 = 2 * 1024 * 1024 * 1024; // 2 GiB 单次读取上限
    if size > MAX {
        let msg = format!(
            "file too large ({} bytes) to read at once, max is 2 GiB",
            size
        );
        debug_log(
            &app,
            LogLevel::Error,
            &format!("read_local_file_bytes: {} path={}", msg, path),
        );
        return Err(msg);
    }
    let mut f = std::fs::File::open(&path).map_err(|e| {
        let msg = format!("open: {e}");
        debug_log(
            &app,
            LogLevel::Error,
            &format!("read_local_file_bytes: {} path={}", msg, path),
        );
        msg
    })?;
    let mut buf = Vec::with_capacity(size as usize);
    f.read_to_end(&mut buf).map_err(|e| {
        let msg = format!("read: {e}");
        debug_log(
            &app,
            LogLevel::Error,
            &format!("read_local_file_bytes: {} path={} size={}", msg, path, size),
        );
        msg
    })?;
    Ok(buf)
}

/// 读取本地文件指定 [offset, offset+length) 范围的字节，返回原始二进制。
///
/// 使用 tauri::ipc::Response 直接返回字节，避免 JSON 数组序列化开销
/// （56MB 文件走 JSON 需要序列化 5600 万个数字，延迟 10 秒以上）。
/// 前端通过 `invoke<ArrayBuffer>` 接收，无需逐字节拷贝。
#[tauri::command]
pub async fn read_local_file_chunk(
    app: tauri::AppHandle,
    path: String,
    offset: u64,
    length: u64,
) -> Result<tauri::ipc::Response, String> {
    use std::io::{Read, Seek, SeekFrom};

    let meta = std::fs::metadata(&path).map_err(|e| {
        let msg = format!("stat: {e}");
        debug_log(
            &app,
            LogLevel::Error,
            &format!("read_local_file_chunk: {} path={}", msg, path),
        );
        msg
    })?;
    if !meta.is_file() {
        let msg = "not a regular file".to_string();
        debug_log(
            &app,
            LogLevel::Error,
            &format!("read_local_file_chunk: {} path={}", msg, path),
        );
        return Err(msg);
    }
    let file_size = meta.len();
    if offset >= file_size {
        // 越界：返回空
        return Ok(tauri::ipc::Response::new(Vec::<u8>::new()));
    }
    let actual_len = length.min(file_size - offset);

    let mut f = std::fs::File::open(&path).map_err(|e| {
        let msg = format!("open: {e}");
        debug_log(
            &app,
            LogLevel::Error,
            &format!("read_local_file_chunk: {} path={}", msg, path),
        );
        msg
    })?;
    f.seek(SeekFrom::Start(offset)).map_err(|e| {
        let msg = format!("seek: {e}");
        debug_log(
            &app,
            LogLevel::Error,
            &format!(
                "read_local_file_chunk: {} path={} offset={}",
                msg, path, offset
            ),
        );
        msg
    })?;

    let mut buf = vec![0u8; actual_len as usize];
    let mut read = 0u64;
    while read < actual_len {
        let n = f
            .read(&mut buf[read as usize..(actual_len as usize)])
            .map_err(|e| {
                let msg = format!("read: {e}");
                debug_log(
                    &app,
                    LogLevel::Error,
                    &format!(
                        "read_local_file_chunk: {} path={} offset={} read_already={}",
                        msg, path, offset, read
                    ),
                );
                msg
            })?;
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
    app: tauri::AppHandle,
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

    debug_log(
        &app,
        LogLevel::Info,
        &format!(
            "compress_local_dir 开始: dir_path={} dir_name={} -> output={}",
            dir_path, dir_name, output_str
        ),
    );

    let output = std::process::Command::new("tar")
        .args(["-czf", &output_str, "-C", &dir_path, &dir_name])
        .output()
        .map_err(|e| {
            let msg = format!("Failed to run tar: {e}");
            debug_log(
                &app,
                LogLevel::Error,
                &format!(
                    "compress_local_dir: {} dir_path={} dir_name={}",
                    msg, dir_path, dir_name
                ),
            );
            msg
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = format!("tar compress failed: {stderr}");
        debug_log(
            &app,
            LogLevel::Error,
            &format!(
                "compress_local_dir: {} dir_path={} dir_name={}",
                msg, dir_path, dir_name
            ),
        );
        return Err(msg);
    }

    let size = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    debug_log(
        &app,
        LogLevel::Info,
        &format!(
            "compress_local_dir 完成: dir_path={} dir_name={} output={} size={}B",
            dir_path, dir_name, output_str, size
        ),
    );

    Ok(CompressResult {
        path: output_str,
        size,
    })
}

/// 解压本地 tar.gz 文件到指定目录。
#[tauri::command]
pub async fn extract_local_archive(
    app: tauri::AppHandle,
    archive_path: String,
    dest_dir: String,
) -> Result<(), String> {
    debug_log(
        &app,
        LogLevel::Info,
        &format!(
            "extract_local_archive 开始: archive={} dest={}",
            archive_path, dest_dir
        ),
    );

    // 确保目标目录存在
    std::fs::create_dir_all(&dest_dir).map_err(|e| {
        let msg = format!("create dest dir: {e}");
        debug_log(
            &app,
            LogLevel::Error,
            &format!(
                "extract_local_archive: {} archive={} dest={}",
                msg, archive_path, dest_dir
            ),
        );
        msg
    })?;

    let output = std::process::Command::new("tar")
        .args(["-xzf", &archive_path, "-C", &dest_dir])
        .output()
        .map_err(|e| {
            let msg = format!("Failed to run tar: {e}");
            debug_log(
                &app,
                LogLevel::Error,
                &format!(
                    "extract_local_archive: {} archive={} dest={}",
                    msg, archive_path, dest_dir
                ),
            );
            msg
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = format!("tar extract failed: {stderr}");
        debug_log(
            &app,
            LogLevel::Error,
            &format!(
                "extract_local_archive: {} archive={} dest={}",
                msg, archive_path, dest_dir
            ),
        );
        return Err(msg);
    }

    debug_log(
        &app,
        LogLevel::Info,
        &format!(
            "extract_local_archive 完成: archive={} dest={}",
            archive_path, dest_dir
        ),
    );
    Ok(())
}

/// 删除本地文件或目录（用于清理临时压缩包）。
#[tauri::command]
pub async fn delete_local_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let meta = std::fs::metadata(&path).map_err(|e| {
        let msg = format!("stat: {e}");
        debug_log(
            &app,
            LogLevel::Error,
            &format!("delete_local_path: {} path={}", msg, path),
        );
        msg
    })?;
    if meta.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| {
            let msg = format!("remove dir: {e}");
            debug_log(
                &app,
                LogLevel::Error,
                &format!("delete_local_path: {} path={}", msg, path),
            );
            msg
        })?;
    } else {
        std::fs::remove_file(&path).map_err(|e| {
            let msg = format!("remove file: {e}");
            debug_log(
                &app,
                LogLevel::Error,
                &format!("delete_local_path: {} path={}", msg, path),
            );
            msg
        })?;
    }
    Ok(())
}

/// 重命名/移动本地文件或目录。
#[tauri::command]
pub async fn rename_local_path(
    app: tauri::AppHandle,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    std::fs::rename(&old_path, &new_path).map_err(|e| {
        let msg = format!("rename: {e}");
        debug_log(
            &app,
            LogLevel::Error,
            &format!(
                "rename_local_path: {} old={} new={}",
                msg, old_path, new_path
            ),
        );
        msg
    })?;
    Ok(())
}
