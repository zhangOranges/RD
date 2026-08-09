// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
pub mod ssh;
pub mod sftp;
pub mod pty;
mod storage;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(ssh::new_state())
        .manage(sftp::new_state())
        .manage(pty::new_state())
        .manage(storage::new_state())
        .invoke_handler(tauri::generate_handler![
            greet,
            ssh::connect_host,
            ssh::disconnect_host,
            ssh::connection_state,
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
