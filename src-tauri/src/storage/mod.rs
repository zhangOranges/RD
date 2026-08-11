//! 本地持久化层：主机配置、凭据、路径缓存、设置。
//!
//! - 主机配置（非敏感）：`{base_dir}/hosts.json`
//! - 凭据（敏感）：系统密钥链，service = "ssh-sftp-finder"
//! - 路径缓存：`{base_dir}/path_cache.json`
//! - 设置：`{base_dir}/settings.json`
//!
//! `base_dir = dirs::data_dir()/ssh-sftp-finder`。
//! 文件读写用同步 IO（配置文件很小），Tauri 命令声明为 async 以便
//! 在线程池执行、不阻塞 UI 线程。

pub mod categories;
pub mod credentials;
pub mod hosts;
pub mod path_cache;
pub mod settings;

pub use categories::CategoryConfig;
pub use hosts::HostConfig;

use std::path::{Path, PathBuf};
use tauri::State;

use crate::{debug_log, LogLevel};

const APP_DIR_NAME: &str = "ssh-sftp-finder";

/// 持有本地存储基础目录的 Tauri 状态。
#[derive(Clone)]
pub struct StorageState {
    base_dir: PathBuf,
}

impl StorageState {
    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }
}

/// 创建 StorageState 并确保基础目录存在。
/// 优先使用 `dirs::data_dir()`，不可用时回退到系统临时目录。
pub fn new_state() -> StorageState {
    let base_dir = dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join(APP_DIR_NAME);
    let _ = std::fs::create_dir_all(&base_dir);
    StorageState { base_dir }
}

// ===== Tauri 命令 =====
// State<'_, StorageState> 的借用在 clone base_dir 后即结束，
// 后续无 await，async 仅为把命令放到线程池执行。

#[tauri::command]
pub async fn list_hosts(state: State<'_, StorageState>) -> Result<Vec<HostConfig>, String> {
    let base_dir = state.base_dir().to_path_buf();
    hosts::list_hosts(&base_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_host(
    id: String,
    state: State<'_, StorageState>,
) -> Result<Option<HostConfig>, String> {
    let base_dir = state.base_dir().to_path_buf();
    hosts::get_host(&base_dir, &id).map_err(|e| e.to_string())
}

/// 仅保存非敏感配置；敏感凭据请使用 `save_credential`。
#[tauri::command]
pub async fn save_host(
    host: HostConfig,
    state: State<'_, StorageState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let base_dir = state.base_dir().to_path_buf();
    let host_id = host.id.clone();
    let host_name = host.name.clone();
    hosts::save_host(&base_dir, host).map_err(|e| {
        let msg = e.to_string();
        debug_log(
            &app,
            LogLevel::Error,
            &format!(
                "save_host 失败: host_id={} name={} - {}",
                host_id, host_name, msg
            ),
        );
        msg
    })
}

/// 删除主机，同时级联删除其凭据（password / private_key）与路径缓存。
/// 主机配置与路径缓存先删；凭据若平台不可用会返回错误，但前两项已生效。
/// 路径缓存会同时清理「host.id 前缀」和「path_cache_id 前缀」，
/// 避免新旧格式的缓存残留。
#[tauri::command]
pub async fn delete_host(
    id: String,
    state: State<'_, StorageState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let base_dir = state.base_dir().to_path_buf();
    debug_log(
        &app,
        LogLevel::Info,
        &format!("delete_host 开始: id={}", id),
    );
    // 先取出可能存在的 path_cache_id，删完主机配置后就拿不到了
    let cache_key = hosts::get_host(&base_dir, &id)
        .ok()
        .flatten()
        .and_then(|h| {
            if h.path_cache_id.is_empty() {
                None
            } else {
                Some(h.path_cache_id)
            }
        });
    hosts::delete_host(&base_dir, &id).map_err(|e| {
        let msg = e.to_string();
        debug_log(
            &app,
            LogLevel::Error,
            &format!("delete_host 删除主机配置失败: id={} - {}", id, msg),
        );
        msg
    })?;
    // 删除 host.id 前缀的路径缓存（旧格式或未分配 path_cache_id 的主机）
    path_cache::delete_host_paths(&base_dir, &id).map_err(|e| {
        let msg = e.to_string();
        debug_log(
            &app,
            LogLevel::Error,
            &format!("delete_host 删除路径缓存失败: id={} - {}", id, msg),
        );
        msg
    })?;
    // 删除 path_cache_id 前缀的路径缓存（新格式），若与 id 相同则为幂等重复
    if let Some(ref k) = cache_key {
        if k != &id {
            path_cache::delete_host_paths(&base_dir, k).map_err(|e| {
                let msg = e.to_string();
                debug_log(
                    &app,
                    LogLevel::Error,
                    &format!("delete_host 删除路径缓存失败: cache_key={} - {}", k, msg),
                );
                msg
            })?;
        }
    }
    for cred_type in ["password", "private_key"] {
        if let Err(e) = credentials::delete_credential(&id, cred_type) {
            let msg = format!(
                "删除凭据失败 ({}): {}；主机配置与路径缓存已删除。",
                cred_type, e
            );
            debug_log(
                &app,
                LogLevel::Error,
                &format!("delete_host {}: id={} - {}", cred_type, id, e),
            );
            return Err(msg);
        }
    }
    debug_log(
        &app,
        LogLevel::Info,
        &format!("delete_host 完成: id={}", id),
    );
    Ok(())
}

#[tauri::command]
pub async fn save_credential(
    host_id: String,
    cred_type: String,
    value: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    credentials::save_credential(&host_id, &cred_type, &value).map_err(|e| {
        let msg = e.to_string();
        debug_log(
            &app,
            LogLevel::Error,
            &format!(
                "save_credential 失败: host_id={} type={} - {}",
                host_id, cred_type, msg
            ),
        );
        msg
    })
}

#[tauri::command]
pub async fn get_credential(
    host_id: String,
    cred_type: String,
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    credentials::get_credential(&host_id, &cred_type).map_err(|e| {
        let msg = e.to_string();
        debug_log(
            &app,
            LogLevel::Error,
            &format!(
                "get_credential 失败: host_id={} type={} - {}",
                host_id, cred_type, msg
            ),
        );
        msg
    })
}

/// 把「前端传入的 host_id」解析成真正用于 path_cache 查询的键：
/// 优先使用 HostConfig.path_cache_id（新加主机时生成的独立唯一 ID），
/// 查不到主机或字段为空时回退到 host.id，兼容老数据和不存在的主机。
fn resolve_cache_key(base_dir: &Path, host_id: &str) -> String {
    if let Ok(Some(host)) = hosts::get_host(base_dir, host_id) {
        if !host.path_cache_id.is_empty() {
            return host.path_cache_id;
        }
    }
    host_id.to_string()
}

#[tauri::command]
pub async fn get_path_cache(
    host_id: String,
    tab_id: String,
    state: State<'_, StorageState>,
) -> Result<Option<String>, String> {
    let base_dir = state.base_dir().to_path_buf();
    let key = resolve_cache_key(&base_dir, &host_id);
    path_cache::get_path(&base_dir, &key, &tab_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_path_cache(
    host_id: String,
    tab_id: String,
    path: String,
    state: State<'_, StorageState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let base_dir = state.base_dir().to_path_buf();
    let key = resolve_cache_key(&base_dir, &host_id);
    path_cache::set_path(&base_dir, &key, &tab_id, &path).map_err(|e| {
        let msg = e.to_string();
        debug_log(
            &app,
            LogLevel::Error,
            &format!(
                "set_path_cache 失败: host_id={} tab_id={} path={} - {}",
                host_id, tab_id, path, msg
            ),
        );
        msg
    })
}

/// 读取设置。键不存在时返回该键的默认值（无默认值则为空字符串）。
#[tauri::command]
pub async fn get_setting(key: String, state: State<'_, StorageState>) -> Result<String, String> {
    let base_dir = state.base_dir().to_path_buf();
    settings::get_setting(&base_dir, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_setting(
    key: String,
    value: String,
    state: State<'_, StorageState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let base_dir = state.base_dir().to_path_buf();
    settings::set_setting(&base_dir, &key, &value).map_err(|e| {
        let msg = e.to_string();
        debug_log(
            &app,
            LogLevel::Error,
            &format!("set_setting 失败: key={} value={} - {}", key, value, msg),
        );
        msg
    })
}

// ===== 分类（分组）CRUD =====

#[tauri::command]
pub async fn list_categories(
    state: State<'_, StorageState>,
) -> Result<Vec<CategoryConfig>, String> {
    let base_dir = state.base_dir().to_path_buf();
    categories::list_categories(&base_dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_category(
    cat: CategoryConfig,
    state: State<'_, StorageState>,
) -> Result<(), String> {
    let base_dir = state.base_dir().to_path_buf();
    categories::save_category(&base_dir, cat).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_category(id: String, state: State<'_, StorageState>) -> Result<(), String> {
    let base_dir = state.base_dir().to_path_buf();
    categories::delete_category(&base_dir, &id).map_err(|e| e.to_string())
}
