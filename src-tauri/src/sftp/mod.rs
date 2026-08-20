//! SFTP channel management and basic file operations.
//!
//! This module owns the lifecycle of persistent SFTP sessions, one per
//! connected host. Sessions are created lazily on first use and kept alive
//! for reuse across subsequent operations. When the underlying SSH transport
//! goes away (see [`crate::ssh`]), the cached SFTP session becomes stale;
//! the next operation will fail, evict the stale entry, and rebuild on the
//! following call.
//!
//! All Tauri commands return `Result<T, String>` where the error string is
//! prefixed with a stable code (`"NoSuchPath: ..."`, `"PermissionDenied:
//! ..."`, etc.) — see [`super::error::SftpError`].

pub mod error;
pub mod model;

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{FileAttributes, FileType, OpenFlags};
use serde::Serialize;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::ssh::SshState;
use crate::{debug_log, LogLevel};

pub use error::{is_session_closed, SftpError};
pub use model::FileEntry;

/// 已被取消的传输任务集合。
/// 下载循环每处理一块/每个文件前检查此表，命中则立即中断并上报 canceled。
fn cancelled_tasks() -> &'static Mutex<HashSet<String>> {
    static CELL: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(HashSet::new()))
}

pub fn mark_task_cancelled(task_id: &str) {
    if let Ok(mut set) = cancelled_tasks().lock() {
        set.insert(task_id.to_string());
    }
}

pub fn is_task_cancelled(task_id: &str) -> bool {
    cancelled_tasks()
        .lock()
        .map(|m| m.contains(task_id))
        .unwrap_or(false)
}

/// 传输进度事件：Rust 端 emit 到前端 Webview。
/// 前端通过 listen("transfer-progress") 统一消费。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgressEvent {
    /// 前端生成的唯一任务 ID
    pub task_id: String,
    /// 任务种类
    pub kind: String, // "download" | "upload"
    /// 远程文件名或目录名（展示用）
    pub name: String,
    /// 已传输字节
    pub bytes_transferred: u64,
    /// 总字节（未统计完为 0）
    pub total_bytes: u64,
    /// 当前状态
    pub status: String, // "running" | "completed" | "error"
    /// 额外信息：错误消息等
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// Global SFTP session state, registered with Tauri via `.manage(new_state())`.
///
/// Each host id maps to an `Arc<SftpSession>`. The `Arc` lets us release the
/// map lock immediately after lookup so that long-running file operations on
/// one host don't block operations on another (and concurrent operations on
/// the same host proceed in parallel — all `SftpSession` methods take
/// `&self`).
pub struct SftpState {
    sessions: tokio::sync::Mutex<HashMap<String, Arc<SftpSession>>>,
}

impl SftpState {
    pub fn new() -> Self {
        Self {
            sessions: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Return the cached SFTP session for `host_id`, creating one on first
    /// use. The session is opened on the existing SSH connection obtained
    /// from [`SshState::get_connection`].
    ///
    /// If a cached session exists but the underlying SSH transport has died,
    /// the caller will get an error from the actual SFTP operation; that
    /// path triggers [`Self::invalidate`] so the next call rebuilds.
    async fn ensure_sftp(
        &self,
        host_id: &str,
        ssh_state: &SshState,
        app_handle: Option<&tauri::AppHandle>,
    ) -> Result<Arc<SftpSession>, SftpError> {
        // Fast path: a live session is already cached.
        {
            let map = self.sessions.lock().await;
            if let Some(s) = map.get(host_id) {
                return Ok(s.clone());
            }
        }

        // Slow path: open a fresh SFTP channel on the existing SSH session.
        if let Some(app) = app_handle {
            debug_log(
                app,
                LogLevel::Info,
                &format!("SFTP 创建会话: host_id={}", host_id),
            );
        }
        let shared_handle = ssh_state.get_connection(host_id).await?;
        let handle = shared_handle.read().await;

        let channel = handle.channel_open_session().await.map_err(|e| {
            let err = SftpError::Sftp(format!("open session: {e}"));
            if let Some(app) = app_handle {
                debug_log(
                    app,
                    LogLevel::Error,
                    &format!("SFTP open session 失败: host_id={} - {}", host_id, err),
                );
            }
            err
        })?;

        channel.request_subsystem(true, "sftp").await.map_err(|e| {
            let err = SftpError::Sftp(format!("request sftp subsystem: {e}"));
            if let Some(app) = app_handle {
                debug_log(
                    app,
                    LogLevel::Error,
                    &format!("SFTP request subsystem 失败: host_id={} - {}", host_id, err),
                );
            }
            err
        })?;

        let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| {
            let err = SftpError::Sftp(format!("init sftp: {e}"));
            if let Some(app) = app_handle {
                debug_log(
                    app,
                    LogLevel::Error,
                    &format!("SFTP init session 失败: host_id={} - {}", host_id, err),
                );
            }
            err
        })?;

        let sftp = Arc::new(sftp);
        let mut map = self.sessions.lock().await;
        map.insert(host_id.to_string(), sftp.clone());
        if let Some(app) = app_handle {
            debug_log(
                app,
                LogLevel::Info,
                &format!("SFTP 会话就绪: host_id={}", host_id),
            );
        }
        Ok(sftp)
    }

    /// Drop the cached session for `host_id` (if any). Called when an
    /// operation fails with a connection-level error so the next call
    /// rebuilds from the (possibly reconnected) SSH session.
    async fn invalidate(&self, host_id: &str) {
        let mut map = self.sessions.lock().await;
        map.remove(host_id);
    }
}

impl Default for SftpState {
    fn default() -> Self {
        Self::new()
    }
}

/// Constructor used by the Tauri builder: `.manage(sftp::new_state())`.
pub fn new_state() -> SftpState {
    SftpState::new()
}

// ---------------------------------------------------------------------------
// FileEntry construction helpers
// ---------------------------------------------------------------------------

/// Convert a raw [`FileAttributes`] + name into a [`FileEntry`].
fn file_entry_from_attrs(name: String, attrs: &FileAttributes) -> FileEntry {
    let ftype = attrs.file_type();
    let is_dir = ftype.is_dir();
    let file_type = match ftype {
        FileType::Dir => "dir",
        FileType::File => "file",
        FileType::Symlink => "symlink",
        FileType::Other => "file",
    };
    let owner = attrs
        .user
        .clone()
        .or_else(|| attrs.uid.map(|u| u.to_string()))
        .unwrap_or_else(|| "0".to_string());

    FileEntry {
        name,
        is_dir,
        size: attrs.size.unwrap_or(0),
        modified: attrs.mtime.map(|t| t as i64).unwrap_or(0),
        permissions: format_permissions(attrs.permissions),
        owner,
        file_type: file_type.to_string(),
    }
}

/// Format the low 9 permission bits as a 9-char `rwxr-xr-x` string.
fn format_permissions(perm: Option<u32>) -> String {
    let p = perm.unwrap_or(0);
    let bits: [(u32, char); 9] = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    bits.iter()
        .map(|(bit, ch)| if p & bit != 0 { *ch } else { '-' })
        .collect()
}

/// Sort entries: directories first, then by name (case-sensitive ascending).
fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| match b.is_dir.cmp(&a.is_dir) {
        std::cmp::Ordering::Equal => a.name.cmp(&b.name),
        other => other,
    });
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// List the contents of a remote directory.
#[tauri::command]
pub async fn sftp_list_dir(
    host_id: String,
    path: String,
    ssh_state: tauri::State<'_, SshState>,
    sftp_state: tauri::State<'_, SftpState>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<FileEntry>, String> {
    let mut attempt = 0u32;
    loop {
        let sftp = sftp_state
            .ensure_sftp(&host_id, &ssh_state, Some(&app_handle))
            .await?;
        match sftp.read_dir(path.clone()).await {
            Ok(rd) => {
                let mut entries: Vec<FileEntry> = rd
                    .map(|entry| file_entry_from_attrs(entry.file_name(), &entry.metadata()))
                    .collect();
                sort_entries(&mut entries);
                return Ok(entries);
            }
            Err(e) => {
                let mapped: SftpError = e.into();
                if is_session_closed(&mapped) && attempt == 0 {
                    debug_log(
                        &app_handle,
                        LogLevel::Warn,
                        &format!(
                            "sftp_list_dir 会话失效，重试: host_id={} path={}",
                            host_id, path
                        ),
                    );
                    sftp_state.invalidate(&host_id).await;
                    attempt += 1;
                    continue;
                }
                debug_log(
                    &app_handle,
                    LogLevel::Warn,
                    &format!(
                        "sftp_list_dir 失败: host_id={} path={} - {}",
                        host_id, path, mapped
                    ),
                );
                return Err(mapped.into());
            }
        }
    }
}

/// Create a remote directory.
#[tauri::command]
pub async fn sftp_mkdir(
    host_id: String,
    path: String,
    ssh_state: tauri::State<'_, SshState>,
    sftp_state: tauri::State<'_, SftpState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let mut attempt = 0u32;
    loop {
        let sftp = sftp_state
            .ensure_sftp(&host_id, &ssh_state, Some(&app_handle))
            .await?;
        match sftp.create_dir(path.clone()).await {
            Ok(_) => return Ok(()),
            Err(e) => {
                let mapped: SftpError = e.into();
                if is_session_closed(&mapped) && attempt == 0 {
                    sftp_state.invalidate(&host_id).await;
                    attempt += 1;
                    continue;
                }
                debug_log(
                    &app_handle,
                    LogLevel::Warn,
                    &format!(
                        "sftp_mkdir 失败: host_id={} path={} - {}",
                        host_id, path, mapped
                    ),
                );
                return Err(mapped.into());
            }
        }
    }
}

/// Rename / move a remote file or directory.
#[tauri::command]
pub async fn sftp_rename(
    host_id: String,
    old_path: String,
    new_path: String,
    ssh_state: tauri::State<'_, SshState>,
    sftp_state: tauri::State<'_, SftpState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let mut attempt = 0u32;
    loop {
        let sftp = sftp_state
            .ensure_sftp(&host_id, &ssh_state, Some(&app_handle))
            .await?;
        match sftp.rename(old_path.clone(), new_path.clone()).await {
            Ok(_) => return Ok(()),
            Err(e) => {
                let mapped: SftpError = e.into();
                if is_session_closed(&mapped) && attempt == 0 {
                    sftp_state.invalidate(&host_id).await;
                    attempt += 1;
                    continue;
                }
                debug_log(
                    &app_handle,
                    LogLevel::Warn,
                    &format!(
                        "sftp_rename 失败: host_id={} {} -> {} - {}",
                        host_id, old_path, new_path, mapped
                    ),
                );
                return Err(mapped.into());
            }
        }
    }
}

/// Delete a remote file.
#[tauri::command]
pub async fn sftp_remove_file(
    host_id: String,
    path: String,
    ssh_state: tauri::State<'_, SshState>,
    sftp_state: tauri::State<'_, SftpState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let mut attempt = 0u32;
    loop {
        let sftp = sftp_state
            .ensure_sftp(&host_id, &ssh_state, Some(&app_handle))
            .await?;
        match sftp.remove_file(path.clone()).await {
            Ok(_) => return Ok(()),
            Err(e) => {
                let mapped: SftpError = e.into();
                if is_session_closed(&mapped) && attempt == 0 {
                    sftp_state.invalidate(&host_id).await;
                    attempt += 1;
                    continue;
                }
                debug_log(
                    &app_handle,
                    LogLevel::Warn,
                    &format!(
                        "sftp_remove_file 失败: host_id={} path={} - {}",
                        host_id, path, mapped
                    ),
                );
                return Err(mapped.into());
            }
        }
    }
}

/// Recursively delete a remote directory.
///
/// SFTP `rmdir` only works on empty directories; this function lists the
/// directory contents, recursively removes each entry, then finally calls
/// `rmdir` on the now-empty directory.
fn remove_dir_recursive(
    sftp: Arc<SftpSession>,
    path: String,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), SftpError>> + Send>> {
    Box::pin(async move {
        // First try the fast path: if the directory is already empty, a single
        // rmdir will succeed and we avoid a full traversal.
        match sftp.remove_dir(path.clone()).await {
            Ok(_) => return Ok(()),
            Err(_) => { /* fall through to recursive removal */ }
        }

        // Recursive path: list contents and delete each entry.
        let entries: Vec<_> = sftp
            .read_dir(path.clone())
            .await?
            .map(|e| (e.file_name(), e.metadata()))
            .collect();

        for (name, attrs) in entries {
            // Skip `.` and `..` entries
            if name == "." || name == ".." {
                continue;
            }
            let child_path = if path.ends_with('/') {
                format!("{}{}", path, name)
            } else {
                format!("{}/{}", path, name)
            };
            if attrs.file_type().is_dir() {
                remove_dir_recursive(sftp.clone(), child_path).await?;
            } else {
                sftp.remove_file(child_path).await?;
            }
        }

        // Now the directory should be empty – one final rmdir.
        sftp.remove_dir(path).await?;
        Ok(())
    })
}

/// Delete a remote directory (recursively).
#[tauri::command]
pub async fn sftp_remove_dir(
    host_id: String,
    path: String,
    ssh_state: tauri::State<'_, SshState>,
    sftp_state: tauri::State<'_, SftpState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let mut attempt = 0u32;
    loop {
        let sftp = sftp_state
            .ensure_sftp(&host_id, &ssh_state, Some(&app_handle))
            .await?;
        match remove_dir_recursive(sftp.clone(), path.clone()).await {
            Ok(_) => return Ok(()),
            Err(e) => {
                if is_session_closed(&e) && attempt == 0 {
                    sftp_state.invalidate(&host_id).await;
                    attempt += 1;
                    continue;
                }
                debug_log(
                    &app_handle,
                    LogLevel::Warn,
                    &format!(
                        "sftp_remove_dir 失败: host_id={} path={} - {}",
                        host_id, path, e
                    ),
                );
                return Err(e.into());
            }
        }
    }
}

/// Resolve a (possibly relative) path to its canonical absolute form using
/// the SFTP `realpath` operation.
#[tauri::command]
pub async fn sftp_resolve_path(
    host_id: String,
    path: String,
    ssh_state: tauri::State<'_, SshState>,
    sftp_state: tauri::State<'_, SftpState>,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    let mut attempt = 0u32;
    loop {
        let sftp = sftp_state
            .ensure_sftp(&host_id, &ssh_state, Some(&app_handle))
            .await?;
        match sftp.canonicalize(path.clone()).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                let mapped: SftpError = e.into();
                if is_session_closed(&mapped) && attempt == 0 {
                    sftp_state.invalidate(&host_id).await;
                    attempt += 1;
                    continue;
                }
                debug_log(
                    &app_handle,
                    LogLevel::Warn,
                    &format!(
                        "sftp_resolve_path 失败: host_id={} path={} - {}",
                        host_id, path, mapped
                    ),
                );
                return Err(mapped.into());
            }
        }
    }
}

/// 判断分片上传是否已完成。
///
/// 空文件（total_bytes=0）也算完成 —— 之前用 `transferred >= total_bytes && total_bytes > 0`
/// 会导致 0 字节文件永远收不到 "completed" 事件，任务卡在 running。
fn is_upload_complete(transferred: u64, total_bytes: u64) -> bool {
    transferred >= total_bytes
}

/// 远端文件大小校验结果。
#[derive(Debug)]
enum SizeCheckResult {
    /// 大小匹配
    Match,
    /// 大小不匹配（期望 vs 实际）
    Mismatch { expected: u64, actual: u64 },
    /// 服务器未返回 size（fstat 返回 None），无法校验
    Unknown,
}

/// 校验远端文件大小是否与预期一致。
fn check_remote_size(remote_size: Option<u64>, total_bytes: u64) -> SizeCheckResult {
    match remote_size {
        Some(actual) if actual != total_bytes => SizeCheckResult::Mismatch {
            expected: total_bytes,
            actual,
        },
        Some(_) => SizeCheckResult::Match,
        None => SizeCheckResult::Unknown,
    }
}

/// Recursively create a directory and all missing parent components.
///
/// Analogous to `mkdir -p`. Existing directories are not an error.
fn mkdir_p_helper(path: &str) -> Vec<String> {
    // Strip trailing slash, collect components from top down.
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return vec![];
    }
    let is_absolute = trimmed.starts_with('/');
    let parts: Vec<&str> = trimmed.split('/').filter(|p| !p.is_empty()).collect();
    let mut out = Vec::with_capacity(parts.len());
    let mut acc = String::new();
    for (i, part) in parts.iter().enumerate() {
        if i > 0 || is_absolute {
            acc.push('/');
        }
        acc.push_str(part);
        out.push(acc.clone());
    }
    out
}

/// Recursively create a directory (mkdir -p).
///
/// Existing directories are silently skipped (matches `mkdir -p` semantics).
/// For any error returned by `create_dir`, we first try `try_exists` to
/// determine whether the directory is already present before truly failing.
#[tauri::command]
pub async fn sftp_mkdir_all(
    host_id: String,
    path: String,
    ssh_state: tauri::State<'_, SshState>,
    sftp_state: tauri::State<'_, SftpState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let dirs = mkdir_p_helper(&path);
    for dir in dirs {
        let mut attempt = 0u32;
        loop {
            let sftp = sftp_state
                .ensure_sftp(&host_id, &ssh_state, Some(&app_handle))
                .await?;
            match sftp.create_dir(dir.clone()).await {
                Ok(_) => break,
                Err(e) => {
                    let mapped: SftpError = e.into();
                    // mkdir -p semantics: any error first gets a second chance
                    // via `try_exists` – if the directory is already there,
                    // that's fine (covers AlreadyExists, PermissionDenied on
                    // an existing dir, weird server StatusCode::Failure with
                    // "file exists" text, etc.).
                    if let Ok(true) = sftp.try_exists(dir.clone()).await {
                        break;
                    }
                    if is_session_closed(&mapped) && attempt == 0 {
                        sftp_state.invalidate(&host_id).await;
                        attempt += 1;
                        continue;
                    }
                    debug_log(
                        &app_handle,
                        LogLevel::Warn,
                        &format!(
                            "sftp_mkdir_all 失败: host_id={} dir={} - {}",
                            host_id, dir, mapped
                        ),
                    );
                    return Err(mapped.into());
                }
            }
        }
    }
    Ok(())
}

/// Write a byte array to a remote file, creating it (or truncating if existing).
///
/// Note: `SftpSession::write` only opens with `WRITE`, missing `CREATE`.
/// For uploads we always need CREATE | TRUNCATE | WRITE, so we open the file
/// explicitly with those flags and then `write_all` into it.
#[tauri::command]
pub async fn sftp_write_file(
    host_id: String,
    path: String,
    data: Vec<u8>,
    ssh_state: tauri::State<'_, SshState>,
    sftp_state: tauri::State<'_, SftpState>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let mut attempt = 0u32;
    loop {
        let sftp = sftp_state
            .ensure_sftp(&host_id, &ssh_state, Some(&app_handle))
            .await?;
        let flags = OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE;
        match sftp.open_with_flags(path.clone(), flags).await {
            Ok(mut file) => match file.write_all(&data).await {
                Ok(_) => return Ok(()),
                Err(e) => {
                    let mapped: SftpError = e.into();
                    if is_session_closed(&mapped) && attempt == 0 {
                        sftp_state.invalidate(&host_id).await;
                        attempt += 1;
                        continue;
                    }
                    debug_log(
                        &app_handle,
                        LogLevel::Warn,
                        &format!(
                            "sftp_write_file 写入失败: host_id={} path={} - {}",
                            host_id, path, mapped
                        ),
                    );
                    return Err(mapped.into());
                }
            },
            Err(e) => {
                let mapped: SftpError = e.into();
                if is_session_closed(&mapped) && attempt == 0 {
                    sftp_state.invalidate(&host_id).await;
                    attempt += 1;
                    continue;
                }
                debug_log(
                    &app_handle,
                    LogLevel::Warn,
                    &format!(
                        "sftp_write_file 打开失败: host_id={} path={} - {}",
                        host_id, path, mapped
                    ),
                );
                return Err(mapped.into());
            }
        }
    }
}

/// Read a remote file's content as raw bytes.
#[tauri::command]
pub async fn sftp_read_file(
    host_id: String,
    path: String,
    ssh_state: tauri::State<'_, SshState>,
    sftp_state: tauri::State<'_, SftpState>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<u8>, String> {
    let mut attempt = 0u32;
    loop {
        let sftp = sftp_state
            .ensure_sftp(&host_id, &ssh_state, Some(&app_handle))
            .await?;
        match sftp.read(path.clone()).await {
            Ok(data) => return Ok(data),
            Err(e) => {
                let mapped: SftpError = e.into();
                if is_session_closed(&mapped) && attempt == 0 {
                    sftp_state.invalidate(&host_id).await;
                    attempt += 1;
                    continue;
                }
                debug_log(
                    &app_handle,
                    LogLevel::Warn,
                    &format!(
                        "sftp_read_file 失败: host_id={} path={} - {}",
                        host_id, path, mapped
                    ),
                );
                return Err(mapped.into());
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 下载：远程 -> 本地（带进度事件上报）
// ---------------------------------------------------------------------------

/// 递归扫描远程目录，收集 (remote_path, size)。
/// 用于下载前预估总大小。
///
/// `async fn` 递归需要 `Box::pin` 间接层，与 `remove_dir_recursive` 同理。
fn collect_remote_entries(
    sftp: Arc<SftpSession>,
    remote_path: String,
    out_list: std::sync::Arc<tokio::sync::Mutex<Vec<(String, u64)>>>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), SftpError>> + Send>> {
    Box::pin(async move {
        let entries: Vec<_> = sftp
            .read_dir(remote_path.clone())
            .await?
            .map(|e| (e.file_name(), e.metadata()))
            .collect();
        for (name, attrs) in entries {
            if name == "." || name == ".." {
                continue;
            }
            let child = if remote_path.ends_with('/') {
                format!("{}{}", remote_path, name)
            } else {
                format!("{}/{}", remote_path, name)
            };
            if attrs.file_type().is_dir() {
                collect_remote_entries(sftp.clone(), child, out_list.clone()).await?;
            } else {
                let size = attrs.size.unwrap_or(0);
                out_list.lock().await.push((child, size));
            }
        }
        Ok(())
    })
}

/// 分块读取远程文件 -> 写到本地文件；每 256KB 或每完成一个文件 emit 一次进度。
#[allow(clippy::too_many_arguments)]
async fn download_single_file(
    sftp: Arc<SftpSession>,
    remote_path: &str,
    local_path: &Path,
    app_handle: &tauri::AppHandle,
    task_id: &str,
    display_name: &str,
    bytes_transferred: &mut u64,
    total_bytes: u64,
) -> Result<(), SftpError> {
    // 确保父目录存在
    if let Some(parent) = local_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| SftpError::Sftp(format!("create local dir: {e}")))?;
    }

    // 先检查取消（读文件前）
    if is_task_cancelled(task_id) {
        return Err(SftpError::Cancelled);
    }

    // 打开远程文件
    let flags = OpenFlags::READ;
    let mut remote_file = sftp.open_with_flags(remote_path.to_string(), flags).await?;

    // 打开本地文件（使用标准库 File + BufWriter 禁用 tokio 的内部缓冲，
    // 并用 sync_data 每写完一块就 flush 到磁盘，让用户在文件管理器中
    // 能实时看到 .tmp 文件大小随下载进度增长）
    use std::io::Write;
    let std_file = std::fs::File::create(local_path)
        .map_err(|e| SftpError::Sftp(format!("create local file: {e}")))?;
    let mut local_file = std::io::BufWriter::with_capacity(256 * 1024, std_file);

    const CHUNK: usize = 256 * 1024; // 256KB
    let mut buf = vec![0u8; CHUNK];
    loop {
        if is_task_cancelled(task_id) {
            return Err(SftpError::Cancelled);
        }
        let n = remote_file
            .read(&mut buf)
            .await
            .map_err(|e| SftpError::Sftp(format!("read remote: {e}")))?;
        if n == 0 {
            break;
        }
        local_file
            .write_all(&buf[..n])
            .map_err(|e| SftpError::Sftp(format!("write local: {e}")))?;
        // 写完一块立刻 flush + sync 到磁盘，保证目录中看到的文件大小实时更新
        local_file
            .flush()
            .map_err(|e| SftpError::Sftp(format!("flush local: {e}")))?;
        local_file
            .get_ref()
            .sync_data()
            .map_err(|e| SftpError::Sftp(format!("sync local: {e}")))?;
        *bytes_transferred += n as u64;

        // 进度上报
        let evt = TransferProgressEvent {
            task_id: task_id.to_string(),
            kind: "download".to_string(),
            name: display_name.to_string(),
            bytes_transferred: *bytes_transferred,
            total_bytes,
            status: "running".to_string(),
            message: None,
        };
        let _ = app_handle.emit("transfer-progress", &evt);
    }
    // 最终再 flush 一次
    local_file
        .flush()
        .map_err(|e| SftpError::Sftp(format!("flush local final: {e}")))?;
    local_file
        .get_ref()
        .sync_all()
        .map_err(|e| SftpError::Sftp(format!("sync all final: {e}")))?;
    Ok(())
}

/// 下载单个远程文件到本地文件路径。
///
/// - 若 `local_path` 是目录，则在该目录下用远程文件名保存。
/// - 通过 `task_id` 用 `transfer-progress` 事件向前端上报进度。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn sftp_download_file(
    host_id: String,
    remote_path: String,
    local_path: String,
    task_id: String,
    display_name: Option<String>,
    app_handle: tauri::AppHandle,
    ssh_state: tauri::State<'_, SshState>,
    sftp_state: tauri::State<'_, SftpState>,
) -> Result<(), String> {
    let display_name = display_name.unwrap_or_else(|| {
        Path::new(&remote_path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| remote_path.clone())
    });

    let mut attempt = 0u32;
    loop {
        let sftp = sftp_state
            .ensure_sftp(&host_id, &ssh_state, Some(&app_handle))
            .await?;

        // 1. 探测文件大小
        let total = sftp
            .metadata(remote_path.clone())
            .await
            .map(|m| m.size.unwrap_or(0))
            .unwrap_or(0);

        // 2. 解析本地目标路径（如果是目录则拼接文件名）
        let local_pb = PathBuf::from(&local_path);
        let target_local: PathBuf = if local_pb.is_dir() {
            let fname = Path::new(&remote_path)
                .file_name()
                .map(|s| s.to_os_string())
                .unwrap_or_else(|| std::ffi::OsString::from("download"));
            local_pb.join(fname)
        } else {
            local_pb.clone()
        };

        if attempt == 0 {
            debug_log(
                &app_handle,
                LogLevel::Info,
                &format!(
                    "sftp_download_file 开始: host_id={} {} -> {} ({} 字节)",
                    host_id,
                    remote_path,
                    target_local.display(),
                    total
                ),
            );
        }

        let mut transferred = 0u64;
        match download_single_file(
            sftp.clone(),
            &remote_path,
            &target_local,
            &app_handle,
            &task_id,
            &display_name,
            &mut transferred,
            total,
        )
        .await
        {
            Ok(_) => {
                debug_log(
                    &app_handle,
                    LogLevel::Info,
                    &format!(
                        "sftp_download_file 完成: host_id={} {} ({} 字节)",
                        host_id, remote_path, transferred
                    ),
                );
                let evt = TransferProgressEvent {
                    task_id: task_id.clone(),
                    kind: "download".to_string(),
                    name: display_name,
                    bytes_transferred: transferred,
                    total_bytes: total,
                    status: "completed".to_string(),
                    message: None,
                };
                let _ = app_handle.emit("transfer-progress", &evt);
                return Ok(());
            }
            Err(e) => {
                if matches!(e, SftpError::Cancelled) {
                    debug_log(
                        &app_handle,
                        LogLevel::Info,
                        &format!(
                            "sftp_download_file 取消: host_id={} {}",
                            host_id, remote_path
                        ),
                    );
                    let evt = TransferProgressEvent {
                        task_id: task_id.clone(),
                        kind: "download".to_string(),
                        name: display_name,
                        bytes_transferred: transferred,
                        total_bytes: total,
                        status: "canceled".to_string(),
                        message: Some("已取消".to_string()),
                    };
                    let _ = app_handle.emit("transfer-progress", &evt);
                    return Err("Cancelled: cancelled by user".to_string());
                }
                if is_session_closed(&e) && attempt == 0 {
                    sftp_state.invalidate(&host_id).await;
                    attempt += 1;
                    continue;
                }
                let err_msg: String = e.into();
                debug_log(
                    &app_handle,
                    LogLevel::Error,
                    &format!(
                        "sftp_download_file 失败: host_id={} {} - {}",
                        host_id, remote_path, err_msg
                    ),
                );
                let evt = TransferProgressEvent {
                    task_id: task_id.clone(),
                    kind: "download".to_string(),
                    name: display_name,
                    bytes_transferred: transferred,
                    total_bytes: total,
                    status: "error".to_string(),
                    message: Some(err_msg.clone()),
                };
                let _ = app_handle.emit("transfer-progress", &evt);
                return Err(err_msg);
            }
        }
    }
}

/// 下载远程目录到本地目录（递归）。
///
/// 行为：在 `local_path` 下创建一个与远程目录同名的子目录，内容完整镜像。
#[tauri::command]
pub async fn sftp_download_dir(
    host_id: String,
    remote_path: String,
    local_path: String,
    task_id: String,
    app_handle: tauri::AppHandle,
    ssh_state: tauri::State<'_, SshState>,
    sftp_state: tauri::State<'_, SftpState>,
) -> Result<(), String> {
    let dir_name = Path::new(&remote_path)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "download_dir".to_string());
    let display_name = dir_name.clone();

    let mut attempt = 0u32;
    loop {
        let sftp = sftp_state
            .ensure_sftp(&host_id, &ssh_state, Some(&app_handle))
            .await?;

        // 1. 收集所有文件 + 统计总大小
        let files_arc = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::<(String, u64)>::new()));
        match collect_remote_entries(sftp.clone(), remote_path.clone(), files_arc.clone()).await {
            Ok(_) => {}
            Err(e) => {
                if is_session_closed(&e) && attempt == 0 {
                    sftp_state.invalidate(&host_id).await;
                    attempt += 1;
                    continue;
                }
                let err_msg: String = e.into();
                debug_log(
                    &app_handle,
                    LogLevel::Error,
                    &format!(
                        "sftp_download_dir 收集文件失败: host_id={} {} - {}",
                        host_id, remote_path, err_msg
                    ),
                );
                let evt = TransferProgressEvent {
                    task_id: task_id.clone(),
                    kind: "download".to_string(),
                    name: display_name.clone(),
                    bytes_transferred: 0,
                    total_bytes: 0,
                    status: "error".to_string(),
                    message: Some(err_msg.clone()),
                };
                let _ = app_handle.emit("transfer-progress", &evt);
                return Err(err_msg);
            }
        }
        let files: Vec<(String, u64)> = match std::sync::Arc::try_unwrap(files_arc) {
            Ok(m) => m.into_inner(),
            Err(arc) => arc.lock().await.clone(),
        };
        let total_bytes: u64 = files.iter().map(|(_, s)| *s).sum();

        if attempt == 0 {
            debug_log(
                &app_handle,
                LogLevel::Info,
                &format!(
                    "sftp_download_dir 开始: host_id={} {} -> {} ({} 个文件, {} 字节)",
                    host_id,
                    remote_path,
                    local_path,
                    files.len(),
                    total_bytes
                ),
            );
        }

        // 2. 本地根目录：local_path / dir_name
        let local_root = PathBuf::from(&local_path).join(&dir_name);
        if let Err(e) = tokio::fs::create_dir_all(&local_root).await {
            let err_msg = format!("create local dir: {e}");
            debug_log(
                &app_handle,
                LogLevel::Error,
                &format!(
                    "sftp_download_dir 创建本地目录失败: {} - {}",
                    local_root.display(),
                    err_msg
                ),
            );
            let evt = TransferProgressEvent {
                task_id: task_id.clone(),
                kind: "download".to_string(),
                name: display_name.clone(),
                bytes_transferred: 0,
                total_bytes,
                status: "error".to_string(),
                message: Some(err_msg.clone()),
            };
            let _ = app_handle.emit("transfer-progress", &evt);
            return Err(format!("SftpError: {err_msg}"));
        }

        // 3. 逐个下载文件
        let mut transferred = 0u64;
        let mut result: Result<(), SftpError> = Ok(());
        for (remote_file, _size) in &files {
            if is_task_cancelled(&task_id) {
                result = Err(SftpError::Cancelled);
                break;
            }
            // 计算相对路径以便映射到本地
            let rel = if remote_file.starts_with(&remote_path) {
                let mut r = remote_file[remote_path.len()..].to_string();
                if r.starts_with('/') {
                    r.remove(0);
                }
                r
            } else {
                remote_file.clone()
            };
            let local_target = if rel.is_empty() {
                // 理论上不会到这里：collect_remote_entries 不会收录目录本身
                local_root.clone()
            } else {
                local_root.join(&rel)
            };

            match download_single_file(
                sftp.clone(),
                remote_file,
                &local_target,
                &app_handle,
                &task_id,
                &display_name,
                &mut transferred,
                total_bytes,
            )
            .await
            {
                Ok(_) => {}
                Err(e) => {
                    result = Err(e);
                    break;
                }
            }
        }

        match result {
            Ok(_) => {
                debug_log(
                    &app_handle,
                    LogLevel::Info,
                    &format!(
                        "sftp_download_dir 完成: host_id={} {} ({} 字节)",
                        host_id, remote_path, transferred
                    ),
                );
                let evt = TransferProgressEvent {
                    task_id: task_id.clone(),
                    kind: "download".to_string(),
                    name: display_name,
                    bytes_transferred: transferred,
                    total_bytes,
                    status: "completed".to_string(),
                    message: None,
                };
                let _ = app_handle.emit("transfer-progress", &evt);
                return Ok(());
            }
            Err(e) => {
                if matches!(e, SftpError::Cancelled) {
                    debug_log(
                        &app_handle,
                        LogLevel::Info,
                        &format!(
                            "sftp_download_dir 取消: host_id={} {}",
                            host_id, remote_path
                        ),
                    );
                    let evt = TransferProgressEvent {
                        task_id: task_id.clone(),
                        kind: "download".to_string(),
                        name: display_name,
                        bytes_transferred: transferred,
                        total_bytes,
                        status: "canceled".to_string(),
                        message: Some("已取消".to_string()),
                    };
                    let _ = app_handle.emit("transfer-progress", &evt);
                    return Err("Cancelled: cancelled by user".to_string());
                }
                if is_session_closed(&e) && attempt == 0 {
                    sftp_state.invalidate(&host_id).await;
                    attempt += 1;
                    continue;
                }
                let err_msg: String = e.into();
                debug_log(
                    &app_handle,
                    LogLevel::Error,
                    &format!(
                        "sftp_download_dir 失败: host_id={} {} - {}",
                        host_id, remote_path, err_msg
                    ),
                );
                let evt = TransferProgressEvent {
                    task_id: task_id.clone(),
                    kind: "download".to_string(),
                    name: display_name,
                    bytes_transferred: transferred,
                    total_bytes,
                    status: "error".to_string(),
                    message: Some(err_msg.clone()),
                };
                let _ = app_handle.emit("transfer-progress", &evt);
                return Err(err_msg);
            }
        }
    }
}

// --- sftp_write_file end marker ---

/// 分片上传文件（前端 Blob.slice() 分块 -> 逐片 invoke 到这里）。
///
/// - 首片 (`is_first == true`): 使用 `CREATE | TRUNCATE | WRITE` 打开文件，写入首片。
/// - 后续片: 使用 `CREATE | WRITE` 打开，通过 `seek(bytes_offset)` 定位后写入。
///   不使用 APPEND 模式：避免写入中途失败重试时把整片数据追加到已部分写入的
///   文件尾部，导致数据重复和内容错位。改为显式 offset 写入后，重试是幂等的
///   —— seek 到同一 offset 覆盖写入，不会引入重复字节。
/// - 每片写完都通过 `transfer-progress` 事件上报当前累计字节。
/// - 写完后调用 `flush()` 等待所有 pending write ack 确认，确保：
///   (1) 写入失败能被检测到从而触发重试；
///   (2) 若服务器支持 fsync@openssh.com 则同步落盘。
/// - 支持取消: 每次调用前都会检查 `CANCELLED_TASKS`，命中则返回错误并清理。
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn sftp_upload_chunk(
    host_id: String,
    path: String,
    data: Vec<u8>,
    is_first: bool,
    task_id: String,
    name: String,
    total_bytes: u64,
    bytes_offset: u64,
    app_handle: tauri::AppHandle,
    ssh_state: tauri::State<'_, SshState>,
    sftp_state: tauri::State<'_, SftpState>,
) -> Result<(), String> {
    // 先检查取消（写文件前）
    if is_task_cancelled(&task_id) {
        let evt = TransferProgressEvent {
            task_id: task_id.clone(),
            kind: "upload".to_string(),
            name: name.clone(),
            bytes_transferred: bytes_offset,
            total_bytes,
            status: "canceled".to_string(),
            message: Some("canceled".to_string()),
        };
        let _ = app_handle.emit("transfer-progress", &evt);
        return Err("canceled".to_string());
    }

    let mut attempt = 0u32;
    loop {
        let sftp = sftp_state
            .ensure_sftp(&host_id, &ssh_state, Some(&app_handle))
            .await?;
        let flags = if is_first {
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE
        } else {
            // 不使用 APPEND：改用 seek(bytes_offset) 显式定位写入位置。
            // 这样写入失败重试时，seek 到同一 offset 覆盖写入，是幂等的，
            // 不会把整片数据追加到已部分写入的文件尾部导致数据重复。
            OpenFlags::CREATE | OpenFlags::WRITE
        };
        match sftp.open_with_flags(path.clone(), flags).await {
            Ok(mut file) => {
                // 第二次取消检查：打开文件后（防止取消信号在 open 期间产生）
                if is_task_cancelled(&task_id) {
                    drop(file);
                    let evt = TransferProgressEvent {
                        task_id: task_id.clone(),
                        kind: "upload".to_string(),
                        name: name.clone(),
                        bytes_transferred: bytes_offset,
                        total_bytes,
                        status: "canceled".to_string(),
                        message: Some("canceled".to_string()),
                    };
                    let _ = app_handle.emit("transfer-progress", &evt);
                    return Err("canceled".to_string());
                }
                // seek(offset) + write_all + flush 统一处理：
                // 任一步失败都走同一套重试逻辑。flush 会 drain 所有
                // pending write ack —— 不调用 flush 的话 write_all 返回
                // Ok 并不保证服务器已确认写入，失败无法被检测到。
                let write_result = async {
                    use std::io::SeekFrom;
                    file.seek(SeekFrom::Start(bytes_offset)).await?;
                    file.write_all(&data).await?;
                    file.flush().await
                }
                .await;
                match write_result {
                    Ok(_) => {
                        let transferred = bytes_offset + data.len() as u64;
                        let is_completed = is_upload_complete(transferred, total_bytes);

                        // 最后一片写完后校验远端文件大小，防止静默丢数据
                        if is_completed {
                            match file.metadata().await {
                                Ok(attrs) => match check_remote_size(attrs.size, total_bytes) {
                                    SizeCheckResult::Mismatch { expected, actual } => {
                                        let err_msg = format!(
                                            "上传完成但远端文件大小不匹配: 期望 {} 字节, 实际 {} 字节",
                                            expected, actual
                                        );
                                        debug_log(
                                            &app_handle,
                                            LogLevel::Error,
                                            &format!(
                                                "sftp_upload_chunk 大小校验失败: host_id={} {} - {}",
                                                host_id, path, err_msg
                                            ),
                                        );
                                        drop(file);
                                        // 删除不完整的远端文件，避免残留脏数据
                                        let _ = sftp.remove_file(path.clone()).await;
                                        let evt = TransferProgressEvent {
                                            task_id: task_id.clone(),
                                            kind: "upload".to_string(),
                                            name,
                                            bytes_transferred: transferred,
                                            total_bytes,
                                            status: "error".to_string(),
                                            message: Some(err_msg.clone()),
                                        };
                                        let _ = app_handle.emit("transfer-progress", &evt);
                                        return Err(err_msg);
                                    }
                                    SizeCheckResult::Match => { /* 大小匹配，正常通过 */ }
                                    SizeCheckResult::Unknown => {
                                        debug_log(
                                            &app_handle,
                                            LogLevel::Warn,
                                            &format!(
                                                "sftp_upload_chunk: 远端未返回文件大小，跳过校验: {}",
                                                path
                                            ),
                                        );
                                    }
                                },
                                Err(e) => {
                                    // metadata 调用失败：无法校验，记录警告但不阻断上传
                                    debug_log(
                                        &app_handle,
                                        LogLevel::Warn,
                                        &format!(
                                            "sftp_upload_chunk: 无法获取远端文件大小进行校验: {} - {}",
                                            path, e
                                        ),
                                    );
                                }
                            }
                        }

                        drop(file);
                        if is_completed {
                            debug_log(
                                &app_handle,
                                LogLevel::Info,
                                &format!(
                                    "sftp_upload_chunk 完成: host_id={} {} ({} 字节)",
                                    host_id, path, transferred
                                ),
                            );
                        }
                        let evt = TransferProgressEvent {
                            task_id: task_id.clone(),
                            kind: "upload".to_string(),
                            name: name.clone(),
                            bytes_transferred: transferred,
                            total_bytes,
                            status: if is_completed {
                                "completed".to_string()
                            } else {
                                "running".to_string()
                            },
                            message: None,
                        };
                        let _ = app_handle.emit("transfer-progress", &evt);
                        return Ok(());
                    }
                    Err(e) => {
                        let mapped: SftpError = e.into();
                        if is_session_closed(&mapped) && attempt == 0 {
                            sftp_state.invalidate(&host_id).await;
                            attempt += 1;
                            continue;
                        }
                        let err_msg: String = mapped.into();
                        debug_log(
                            &app_handle,
                            LogLevel::Error,
                            &format!(
                                "sftp_upload_chunk 写入失败: host_id={} {} offset={} - {}",
                                host_id, path, bytes_offset, err_msg
                            ),
                        );
                        let evt = TransferProgressEvent {
                            task_id: task_id.clone(),
                            kind: "upload".to_string(),
                            name,
                            bytes_transferred: bytes_offset,
                            total_bytes,
                            status: "error".to_string(),
                            message: Some(err_msg.clone()),
                        };
                        let _ = app_handle.emit("transfer-progress", &evt);
                        return Err(err_msg);
                    }
                }
            }
            Err(e) => {
                let mapped: SftpError = e.into();
                if is_session_closed(&mapped) && attempt == 0 {
                    sftp_state.invalidate(&host_id).await;
                    attempt += 1;
                    continue;
                }
                let err_msg: String = mapped.into();
                debug_log(
                    &app_handle,
                    LogLevel::Error,
                    &format!(
                        "sftp_upload_chunk 打开失败: host_id={} {} - {}",
                        host_id, path, err_msg
                    ),
                );
                let evt = TransferProgressEvent {
                    task_id: task_id.clone(),
                    kind: "upload".to_string(),
                    name,
                    bytes_transferred: bytes_offset,
                    total_bytes,
                    status: "error".to_string(),
                    message: Some(err_msg.clone()),
                };
                let _ = app_handle.emit("transfer-progress", &evt);
                return Err(err_msg);
            }
        }
    }
}

/// 取消某个传输任务（无论上传还是下载）。
///
/// 下载任务会在下一块读取/下一个文件处理前立即中断并上报 `canceled` 状态。
/// 上传任务（sftp_write_file）无法中断正在写入的 invoke，但此操作会把任务从
/// 已取消集合中登记；前端在收到 OK/错误回报时可以据此丢弃结果。
#[tauri::command]
pub fn sftp_cancel_transfer(task_id: String) -> Result<(), String> {
    mark_task_cancelled(&task_id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---- is_upload_complete ----

    #[test]
    fn test_is_upload_complete_empty_file() {
        // 空文件：transferred=0, total_bytes=0 → 必须返回 true
        // 修复前 `total_bytes > 0` 条件导致空文件永不完成
        assert!(is_upload_complete(0, 0));
    }

    #[test]
    fn test_is_upload_complete_last_chunk() {
        assert!(is_upload_complete(100, 100));
        assert!(is_upload_complete(256 * 1024, 256 * 1024));
    }

    #[test]
    fn test_is_upload_complete_intermediate_chunk() {
        assert!(!is_upload_complete(256 * 1024, 1024 * 1024));
        assert!(!is_upload_complete(0, 100));
    }

    // ---- check_remote_size ----

    #[test]
    fn test_check_remote_size_match() {
        assert!(matches!(check_remote_size(Some(100), 100), SizeCheckResult::Match));
        // 空文件也算匹配
        assert!(matches!(check_remote_size(Some(0), 0), SizeCheckResult::Match));
    }

    #[test]
    fn test_check_remote_size_mismatch() {
        match check_remote_size(Some(99), 100) {
            SizeCheckResult::Mismatch { expected, actual } => {
                assert_eq!(expected, 100);
                assert_eq!(actual, 99);
            }
            other => panic!("expected Mismatch, got {:?}", other),
        }
        // 空文件但远端有数据
        match check_remote_size(Some(50), 0) {
            SizeCheckResult::Mismatch { expected, actual } => {
                assert_eq!(expected, 0);
                assert_eq!(actual, 50);
            }
            other => panic!("expected Mismatch, got {:?}", other),
        }
    }

    #[test]
    fn test_check_remote_size_unknown() {
        assert!(matches!(check_remote_size(None, 100), SizeCheckResult::Unknown));
        assert!(matches!(check_remote_size(None, 0), SizeCheckResult::Unknown));
    }

    // ---- mkdir_p_helper ----

    #[test]
    fn test_mkdir_p_helper_empty() {
        assert_eq!(mkdir_p_helper(""), Vec::<String>::new());
        assert_eq!(mkdir_p_helper("/"), Vec::<String>::new());
        assert_eq!(mkdir_p_helper("///"), Vec::<String>::new());
    }

    #[test]
    fn test_mkdir_p_helper_simple_relative() {
        assert_eq!(mkdir_p_helper("foo"), vec!["foo"]);
    }

    #[test]
    fn test_mkdir_p_helper_simple_absolute() {
        assert_eq!(mkdir_p_helper("/foo"), vec!["/foo"]);
    }

    #[test]
    fn test_mkdir_p_helper_nested_relative() {
        assert_eq!(mkdir_p_helper("foo/bar"), vec!["foo", "foo/bar"]);
    }

    #[test]
    fn test_mkdir_p_helper_nested_absolute() {
        assert_eq!(mkdir_p_helper("/foo/bar"), vec!["/foo", "/foo/bar"]);
    }

    #[test]
    fn test_mkdir_p_helper_trailing_slash() {
        assert_eq!(mkdir_p_helper("foo/"), vec!["foo"]);
        assert_eq!(mkdir_p_helper("/foo/"), vec!["/foo"]);
    }

    #[test]
    fn test_mkdir_p_helper_double_slash() {
        assert_eq!(mkdir_p_helper("foo//bar"), vec!["foo", "foo/bar"]);
    }

    #[test]
    fn test_mkdir_p_helper_deeply_nested() {
        assert_eq!(
            mkdir_p_helper("/a/b/c/d"),
            vec!["/a", "/a/b", "/a/b/c", "/a/b/c/d"]
        );
    }
}
