// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
pub mod local_fs;
pub mod pty;
pub mod sftp;
pub mod ssh;
mod storage;

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;
use tauri::{Emitter, Manager};

/// 日志级别
#[derive(Clone, Copy)]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

impl LogLevel {
    fn tag(&self) -> &'static str {
        match self {
            LogLevel::Info => "INFO ",
            LogLevel::Warn => "WARN ",
            LogLevel::Error => "ERROR",
        }
    }
}

/// 调试日志开关状态（全局原子读取，无锁）
struct DebugLogState(AtomicBool);

impl DebugLogState {
    fn new(enabled: bool) -> Self {
        DebugLogState(AtomicBool::new(enabled))
    }

    fn is_enabled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }

    fn set(&self, enabled: bool) {
        self.0.store(enabled, Ordering::Relaxed);
    }
}

/// 获取更新日志文件路径（app_data_dir/updates/update.log）
fn get_update_log_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = get_updates_dir(app)?;
    Some(dir.join("update.log"))
}

/// 写入一行日志到 update.log（自动追加时间戳和级别标签）
/// 调试关闭时仅记录 Warn/Error，开启后记录所有级别
fn write_update_log(app: &tauri::AppHandle, level: LogLevel, msg: &str) {
    // 调试未开启时，跳过 Info 级别日志
    let debug_enabled = app
        .try_state::<DebugLogState>()
        .map(|s| s.is_enabled())
        .unwrap_or(false);
    if !debug_enabled && matches!(level, LogLevel::Info) {
        return;
    }

    let log_path = match get_update_log_path(app) {
        Some(p) => p,
        None => return,
    };

    let now = chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f");
    let line = format!("[{}] [{}] {}\n", now, level.tag(), msg);

    use std::io::Write;
    // 以追加模式打开文件，失败则静默忽略
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let _ = file.write_all(line.as_bytes());
    }

    // 同时输出到 stderr，方便开发调试
    eprint!("[UPDATE-LOG] {}", line);
}

/// 全局调试日志：受 DebugLogState 控制
/// - Info 级别仅在调试开启时写入
/// - Warn/Error 始终写入
/// 供其他模块调用，统一写入 update.log
pub fn debug_log(app: &tauri::AppHandle, level: LogLevel, msg: &str) {
    write_update_log(app, level, msg);
}

/// 前端调用：写入一条更新日志
/// level: "info" | "warn" | "error"
#[tauri::command]
fn update_log(app: tauri::AppHandle, level: String, msg: String) {
    let lv = match level.as_str() {
        "warn" | "WARN" => LogLevel::Warn,
        "error" | "ERROR" => LogLevel::Error,
        _ => LogLevel::Info,
    };
    write_update_log(&app, lv, &msg);
}

/// 前端调用：获取调试日志开关状态
#[tauri::command]
fn get_debug_logging(app: tauri::AppHandle) -> Result<bool, String> {
    let enabled = app
        .try_state::<DebugLogState>()
        .map(|s| s.is_enabled())
        .unwrap_or(false);
    Ok(enabled)
}

/// 前端调用：设置调试日志开关（同时持久化到 settings.json）
#[tauri::command]
async fn set_debug_logging(
    app: tauri::AppHandle,
    state: tauri::State<'_, DebugLogState>,
    enabled: bool,
) -> Result<(), String> {
    state.set(enabled);
    // 持久化到 settings.json
    let base_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取数据目录: {}", e))?;
    storage::settings::set_setting(
        &base_dir,
        "debug_logging",
        if enabled { "true" } else { "false" },
    )
    .map_err(|e| format!("保存设置失败: {}", e))?;
    // 写一条日志标记开关变化
    write_update_log(
        &app,
        if enabled {
            LogLevel::Info
        } else {
            LogLevel::Warn
        },
        &format!("调试日志已{}", if enabled { "开启" } else { "关闭" }),
    );
    Ok(())
}

/// 前端调用：读取更新日志文件内容（用于查看日志）
#[tauri::command]
fn read_update_log(app: tauri::AppHandle) -> Result<String, String> {
    let log_path = get_update_log_path(&app).ok_or("无法获取日志文件路径")?;
    if !log_path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&log_path).map_err(|e| format!("读取日志失败: {}", e))
}

/// 前端调用：清空更新日志文件
#[tauri::command]
fn clear_update_log(app: tauri::AppHandle) -> Result<(), String> {
    let log_path = get_update_log_path(&app).ok_or("无法获取日志文件路径")?;
    if log_path.exists() {
        std::fs::write(&log_path, "").map_err(|e| format!("清空日志失败: {}", e))?;
    }
    Ok(())
}

/// 前端调用：在文件管理器中打开更新日志所在文件夹
#[tauri::command]
async fn open_update_log_folder(app: tauri::AppHandle) -> Result<(), String> {
    // 所有 I/O 移到后台线程，命令立即返回
    std::thread::spawn(move || {
        let log_path = match get_update_log_path(&app) {
            Some(p) => p,
            None => return,
        };
        if !log_path.exists() {
            if let Some(parent) = log_path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(&log_path, "");
        }
        let dir = log_path.parent().unwrap_or(std::path::Path::new("."));

        #[cfg(target_os = "windows")]
        {
            let _ = std::process::Command::new("explorer").arg(dir).spawn();
        }
        #[cfg(target_os = "macos")]
        {
            let _ = std::process::Command::new("open")
                .arg("-R")
                .arg(&log_path)
                .spawn();
        }
        #[cfg(target_os = "linux")]
        {
            let _ = std::process::Command::new("xdg-open").arg(dir).spawn();
        }
    });
    Ok(())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// 测量对指定 URL 的 HTTP 请求延迟（毫秒）。
/// 成功返回延迟 ms，失败返回 -1。超时 6 秒。
#[tauri::command]
async fn probe_url(app: tauri::AppHandle, url: String) -> i64 {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            write_update_log(
                &app,
                LogLevel::Error,
                &format!("probe_url 创建客户端失败: {} - {}", url, e),
            );
            return -1;
        }
    };

    let start = Instant::now();
    let head_ok = match client.head(&url).send().await {
        Ok(_) => true,
        Err(_) => false,
    };
    if head_ok {
        let ms = start.elapsed().as_millis() as i64;
        write_update_log(
            &app,
            LogLevel::Info,
            &format!("probe_url HEAD 成功: {} ({} ms)", url, ms),
        );
        return ms;
    }
    let start2 = Instant::now();
    match client.get(&url).send().await {
        Ok(_) => {
            let ms = start2.elapsed().as_millis() as i64;
            write_update_log(
                &app,
                LogLevel::Info,
                &format!("probe_url GET 成功: {} ({} ms)", url, ms),
            );
            ms
        }
        Err(e) => {
            write_update_log(
                &app,
                LogLevel::Warn,
                &format!("probe_url 不可达: {} - {}", url, e),
            );
            -1
        }
    }
}

/// 通过 Rust 后端获取指定 URL 的文本内容（绕过浏览器 CORS 限制）。
/// 超时 15 秒。成功返回文本，失败返回错误字符串。
#[tauri::command]
async fn fetch_url_text(app: tauri::AppHandle, url: String) -> Result<String, String> {
    write_update_log(
        &app,
        LogLevel::Info,
        &format!("fetch_url_text 开始: {}", url),
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| {
            let msg = format!("创建 HTTP 客户端失败: {}", e);
            write_update_log(
                &app,
                LogLevel::Error,
                &format!("fetch_url_text {}: {}", url, msg),
            );
            msg
        })?;

    let resp = client.get(&url).send().await.map_err(|e| {
        let msg = format!("请求失败: {}", e);
        write_update_log(
            &app,
            LogLevel::Error,
            &format!("fetch_url_text {}: {}", url, msg),
        );
        msg
    })?;

    let status = resp.status();
    if !status.is_success() {
        let msg = format!("HTTP {}", status);
        write_update_log(
            &app,
            LogLevel::Error,
            &format!("fetch_url_text {}: {}", url, msg),
        );
        return Err(msg);
    }

    let content_length = resp.content_length().unwrap_or(0);
    let text = resp.text().await.map_err(|e| {
        let msg = format!("读取响应失败: {}", e);
        write_update_log(
            &app,
            LogLevel::Error,
            &format!("fetch_url_text {}: {}", url, msg),
        );
        msg
    })?;

    write_update_log(
        &app,
        LogLevel::Info,
        &format!(
            "fetch_url_text 成功: {} (status={}, {} 字节)",
            url,
            status,
            text.len()
        ),
    );
    let _ = content_length; // 避免 unused 警告
    Ok(text)
}

/// 获取更新目录（app_data_dir/updates）
fn get_updates_dir(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let updates = dir.join("updates");
    std::fs::create_dir_all(&updates).ok()?;
    Some(updates)
}

/// 下载安装包到本地，通过事件报告进度。
/// 返回保存的文件完整路径。
#[tauri::command]
async fn download_installer(
    app: tauri::AppHandle,
    url: String,
    filename: String,
) -> Result<String, String> {
    write_update_log(
        &app,
        LogLevel::Info,
        &format!(
            "download_installer 开始: url={}, filename={}",
            url, filename
        ),
    );

    let updates_dir = get_updates_dir(&app).ok_or("无法获取更新目录")?;
    let file_path = updates_dir.join(&filename);
    write_update_log(
        &app,
        LogLevel::Info,
        &format!("download_installer 保存路径: {}", file_path.display()),
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300)) // 5 分钟超时
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| {
            let msg = format!("创建 HTTP 客户端失败: {}", e);
            write_update_log(
                &app,
                LogLevel::Error,
                &format!("download_installer: {}", msg),
            );
            msg
        })?;

    let resp = client.get(&url).send().await.map_err(|e| {
        let msg = format!("请求失败: {}", e);
        write_update_log(
            &app,
            LogLevel::Error,
            &format!("download_installer: {}", msg),
        );
        msg
    })?;

    let status = resp.status();
    if !status.is_success() {
        let msg = format!("HTTP {}", status);
        write_update_log(
            &app,
            LogLevel::Error,
            &format!("download_installer: {}", msg),
        );
        return Err(msg);
    }

    let total = resp.content_length().unwrap_or(0);
    write_update_log(
        &app,
        LogLevel::Info,
        &format!(
            "download_installer 响应: status={}, content_length={}",
            status, total
        ),
    );

    let mut file = std::fs::File::create(&file_path).map_err(|e| {
        let msg = format!("创建文件失败: {}", e);
        write_update_log(
            &app,
            LogLevel::Error,
            &format!("download_installer: {}", msg),
        );
        msg
    })?;

    use futures_util::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;
    let mut last_report = Instant::now();
    let mut chunk_count: u64 = 0;

    while let Some(chunk_result) = stream.next().await {
        let chunk = match chunk_result {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("读取数据失败: {}", e);
                write_update_log(
                    &app,
                    LogLevel::Error,
                    &format!(
                        "download_installer: {} (已下载 {} 字节, {} 块)",
                        msg, downloaded, chunk_count
                    ),
                );
                return Err(msg);
            }
        };
        if let Err(e) = std::io::Write::write_all(&mut file, &chunk) {
            let msg = format!("写入文件失败: {}", e);
            write_update_log(
                &app,
                LogLevel::Error,
                &format!("download_installer: {} (已下载 {} 字节)", msg, downloaded),
            );
            return Err(msg);
        }
        downloaded += chunk.len() as u64;
        chunk_count += 1;

        // 每 200ms 报告一次进度，避免事件洪泛
        if last_report.elapsed() > std::time::Duration::from_millis(200) {
            let pct = if total > 0 {
                (downloaded as f64 / total as f64 * 100.0) as u8
            } else {
                0
            };
            let _ = app.emit(
                "update-download-progress",
                serde_json::json!({
                    "downloaded": downloaded,
                    "total": total,
                    "pct": pct,
                }),
            );
            last_report = Instant::now();
        }
    }

    // 最终进度
    let _ = app.emit(
        "update-download-progress",
        serde_json::json!({
            "downloaded": downloaded,
            "total": if total > 0 { total } else { downloaded },
            "pct": 100,
        }),
    );

    // 同步文件到磁盘
    if let Err(e) = file.sync_all() {
        write_update_log(
            &app,
            LogLevel::Warn,
            &format!("download_installer sync_all 警告: {}", e),
        );
    }

    write_update_log(
        &app,
        LogLevel::Info,
        &format!(
            "download_installer 完成: {} ({} 字节, {} 块)",
            file_path.display(),
            downloaded,
            chunk_count
        ),
    );

    Ok(file_path.to_string_lossy().to_string())
}

/// 在文件管理器中打开指定路径所在的文件夹
#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dir = if p.is_file() {
        p.parent().unwrap_or(p)
    } else {
        p
    };

    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map_err(|e| format!("打开文件夹失败: {}", e))?;
    }
    Ok(())
}

/// 运行安装包（Windows NSIS exe 等），运行后调用方应退出当前程序
#[tauri::command]
fn run_installer(app: tauri::AppHandle, path: String) -> Result<(), String> {
    write_update_log(
        &app,
        LogLevel::Info,
        &format!("run_installer 开始: {}", path),
    );

    let p = std::path::Path::new(&path);
    if !p.exists() {
        let msg = format!("安装包文件不存在: {}", path);
        write_update_log(&app, LogLevel::Error, &format!("run_installer: {}", msg));
        return Err(msg);
    }

    #[cfg(target_os = "windows")]
    {
        if let Err(e) = std::process::Command::new(p).spawn() {
            let msg = format!("启动安装程序失败: {}", e);
            write_update_log(&app, LogLevel::Error, &format!("run_installer: {}", msg));
            return Err(msg);
        }
    }
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = std::process::Command::new("open").arg(p).spawn() {
            let msg = format!("启动安装程序失败: {}", e);
            write_update_log(&app, LogLevel::Error, &format!("run_installer: {}", msg));
            return Err(msg);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Err(e) = std::process::Command::new("xdg-open").arg(p).spawn() {
            let msg = format!("启动安装程序失败: {}", e);
            write_update_log(&app, LogLevel::Error, &format!("run_installer: {}", msg));
            return Err(msg);
        }
    }
    write_update_log(&app, LogLevel::Info, "run_installer 已启动安装程序");
    Ok(())
}

/// 检查本地是否有指定文件名的安装包，返回路径和大小（不存在返回 null）
#[tauri::command]
fn check_local_installer(app: tauri::AppHandle, filename: String) -> Option<serde_json::Value> {
    let dir = get_updates_dir(&app)?;
    let path = dir.join(&filename);
    if !path.exists() {
        return None;
    }
    let size = std::fs::metadata(&path).ok()?.len();
    Some(serde_json::json!({
        "path": path.to_string_lossy(),
        "size": size,
    }))
}

/// 删除本地安装包文件
#[tauri::command]
fn delete_local_installer(app: tauri::AppHandle, filename: String) -> Result<(), String> {
    let dir = get_updates_dir(&app).ok_or("无法获取更新目录")?;
    let path = dir.join(&filename);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("删除文件失败: {}", e))?;
    }
    Ok(())
}

/// 退出当前应用程序
#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(ssh::new_state())
        .manage(sftp::new_state())
        .manage(pty::new_state())
        .manage(storage::new_state())
        .manage(DebugLogState::new(false))
        .setup(|app| {
            // 从 settings.json 读取调试日志开关初始值
            if let Some(debug_state) = app.try_state::<DebugLogState>() {
                if let Ok(base_dir) = app.path().app_data_dir() {
                    if let Ok(val) = storage::settings::get_setting(&base_dir, "debug_logging") {
                        debug_state.set(val == "true");
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            probe_url,
            fetch_url_text,
            download_installer,
            open_folder,
            run_installer,
            check_local_installer,
            delete_local_installer,
            exit_app,
            update_log,
            read_update_log,
            clear_update_log,
            open_update_log_folder,
            get_debug_logging,
            set_debug_logging,
            local_fs::list_local_dir,
            local_fs::local_home_dir,
            local_fs::read_local_file_bytes,
            local_fs::read_local_file_chunk,
            ssh::connect_host,
            ssh::disconnect_host,
            ssh::connection_state,
            ssh::test_connection,
            ssh::exec::get_server_stats,
            sftp::sftp_list_dir,
            sftp::sftp_mkdir,
            sftp::sftp_rename,
            sftp::sftp_remove_file,
            sftp::sftp_remove_dir,
            sftp::sftp_resolve_path,
            sftp::sftp_mkdir_all,
            sftp::sftp_read_file,
            sftp::sftp_write_file,
            sftp::sftp_upload_chunk,
            sftp::sftp_download_file,
            sftp::sftp_download_dir,
            sftp::sftp_cancel_transfer,
            pty::pty_open,
            pty::pty_close,
            pty::pty_write,
            pty::pty_cd,
            pty::pty_resize,
            pty::pty_is_open,
            storage::list_hosts,
            storage::get_host,
            storage::save_host,
            storage::delete_host,
            storage::save_credential,
            storage::get_credential,
            storage::get_path_cache,
            storage::set_path_cache,
            storage::get_setting,
            storage::set_setting,
            storage::list_categories,
            storage::save_category,
            storage::delete_category,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
