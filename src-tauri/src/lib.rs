// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
pub mod local_fs;
pub mod pty;
pub mod sftp;
pub mod ssh;
mod storage;

use std::time::Instant;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// 测量对指定 URL 的 HTTP 请求延迟（毫秒）。
/// 成功返回延迟 ms，失败返回 -1。超时 6 秒。
/// 在 Rust 侧发起请求，完全绕过浏览器 CORS 限制。
/// 用 async + reqwest 异步客户端，不阻塞主线程（避免窗口"未响应"）。
#[tauri::command]
async fn probe_url(url: String) -> i64 {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(6))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
    {
        Ok(c) => c,
        Err(_) => return -1,
    };

    let start = Instant::now();
    // 优先 HEAD（轻量），失败则 fallback GET
    let head_ok = match client.head(&url).send().await {
        Ok(_) => true,
        Err(_) => false,
    };
    if head_ok {
        return start.elapsed().as_millis() as i64;
    }
    let start2 = Instant::now();
    match client.get(&url).send().await {
        Ok(_) => start2.elapsed().as_millis() as i64,
        Err(_) => -1,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .manage(ssh::new_state())
        .manage(sftp::new_state())
        .manage(pty::new_state())
        .manage(storage::new_state())
        .invoke_handler(tauri::generate_handler![
            greet,
            probe_url,
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
