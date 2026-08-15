pub mod bridge;
pub mod hot_reload;
pub mod manager;
pub mod manifest;
pub mod permissions;
pub mod store;

pub use manager::PluginInfo;
pub use manager::PluginManager;

use tauri::{Emitter, Manager};

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::{debug_log, LogLevel};

pub struct PluginState {
    base_dir: Mutex<PathBuf>,
}

impl PluginState {
    fn new() -> Self {
        let base_dir = dirs::data_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("ssh-sftp-finder");
        let _ = std::fs::create_dir_all(&base_dir);
        PluginState {
            base_dir: Mutex::new(base_dir),
        }
    }

    fn base_dir(&self) -> PathBuf {
        self.base_dir
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

pub fn new_state() -> PluginState {
    PluginState::new()
}

fn resolve_app_data_dir(
    app: Option<&tauri::AppHandle>,
    state: Option<&tauri::State<'_, PluginState>>,
) -> Result<PathBuf, String> {
    if let Some(app_handle) = app {
        return app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("无法获取数据目录: {}", e));
    }
    if let Some(s) = state {
        return Ok(s.base_dir());
    }
    Err("无法获取 app data dir".to_string())
}

// ===== Tauri Commands =====

#[tauri::command]
pub fn plugin_list(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
) -> Result<Vec<PluginInfo>, String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    manager::scan(&dir)
}

#[tauri::command]
pub fn plugin_toggle(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    manager::enable_disable(&dir, &id, enabled)
}

#[tauri::command]
pub fn plugin_uninstall(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    id: String,
) -> Result<(), String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    manager::uninstall(&dir, &id)
}

/// 卸载插件并完全清理（包括 plugin-data/${id}/）
#[tauri::command]
pub async fn plugin_uninstall_complete(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    id: String,
) -> Result<(), String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;

    // 1. 调用现有 uninstall 清理 plugins 目录 + store
    manager::uninstall(&dir, &id)?;

    // 2. 清理 plugin-data/${id}/
    let plugin_data_dir = dir.join("plugin-data").join(&id);
    if plugin_data_dir.exists() {
        std::fs::remove_dir_all(&plugin_data_dir)
            .map_err(|e| format!("CLEANUP_PLUGIN_DATA_FAILED: {}", e))?;
    }

    // 3. emit uninstall 事件给前端
    let _ = app.emit("plugin:uninstalled", &id);

    Ok(())
}

#[tauri::command]
pub fn plugin_install_from_dir(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    dir_path: String,
) -> Result<PluginInfo, String> {
    let app_dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let src_dir = std::path::Path::new(&dir_path);
    let manifest = manager::install_from_dir(&app_dir, src_dir)?;

    let items = store::load_store(&app_dir).unwrap_or_default();
    let store_item = items
        .iter()
        .find(|i| i.id == manifest.id)
        .ok_or_else(|| "安装后未找到 store 记录".to_string())?;

    Ok(PluginInfo {
        manifest,
        install_time_ms: store_item.install_time_ms,
        last_load_time_ms: store_item.last_load_time_ms,
        enabled: store_item.enabled,
        granted_permissions: store_item.granted_permissions.clone(),
        config: store_item.config.clone(),
        load_error: None,
    })
}

/// 启动插件目录文件监听（热重载）
#[tauri::command]
pub async fn plugin_start_hot_reload(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
) -> Result<(), String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let plugins_dir = dir.join("plugins");
    hot_reload::start_watching(&app, plugins_dir);
    Ok(())
}

/// 停止插件目录文件监听
#[tauri::command]
pub async fn plugin_stop_hot_reload() -> Result<(), String> {
    hot_reload::stop_watching();
    Ok(())
}

/// 从 .rdplugin zip 文件安装插件
#[tauri::command]
pub async fn plugin_install_from_file(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    zip_path: String,
) -> Result<serde_json::Value, String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;

    // 1. 校验文件后缀
    if !zip_path.ends_with(".rdplugin") && !zip_path.ends_with(".zip") {
        return Err("INVALID_FILE: file must be .rdplugin or .zip".into());
    }

    // 2. 打开 zip 文件
    let file = std::fs::File::open(&zip_path).map_err(|e| format!("OPEN_FILE_FAILED: {}", e))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("ZIP_READ_FAILED: {}", e))?;

    // 3. 解压到临时目录
    let temp_dir = dir.join("plugins").join(".tmp_install");
    if temp_dir.exists() {
        std::fs::remove_dir_all(&temp_dir).map_err(|e| format!("CLEANUP_TEMP_FAILED: {}", e))?;
    }
    std::fs::create_dir_all(&temp_dir).map_err(|e| format!("CREATE_TEMP_FAILED: {}", e))?;

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("ZIP_ENTRY_READ_FAILED: {}", e))?;
        let entry_name = entry.name().to_string();

        // 安全：跳过绝对路径和 .. 逃逸
        if entry_name.starts_with('/') || entry_name.contains("..") {
            continue;
        }

        let out_path = temp_dir.join(&entry_name);
        if entry.is_dir() {
            std::fs::create_dir_all(&out_path)
                .map_err(|e| format!("CREATE_DIR_FAILED: {} - {}", entry_name, e))?;
        } else {
            if let Some(parent) = out_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("CREATE_PARENT_DIR_FAILED: {}", e))?;
            }
            let mut out_file = std::fs::File::create(&out_path)
                .map_err(|e| format!("CREATE_FILE_FAILED: {} - {}", entry_name, e))?;
            std::io::copy(&mut entry, &mut out_file)
                .map_err(|e| format!("WRITE_FILE_FAILED: {} - {}", entry_name, e))?;
        }
    }

    // 4. 读取并校验 manifest
    let manifest_path = find_manifest_in_dir(&temp_dir)
        .ok_or_else(|| "MANIFEST_NOT_FOUND: no manifest.json in archive".to_string())?;

    let manifest =
        manager::parse_manifest(&manifest_path).map_err(|e| format!("MANIFEST_INVALID: {}", e))?;

    // 5. 检查 minRdVersion
    let current_version = env!("CARGO_PKG_VERSION");
    if !is_version_compatible(current_version, &manifest.min_rd_version) {
        // 清理临时目录
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(format!(
            "VERSION_INCOMPATIBLE: plugin requires RD >= {}, current is {}",
            manifest.min_rd_version, current_version
        ));
    }

    // 6. 安装到正式目录
    let result = manager::install_from_dir(&dir, manifest_path.parent().unwrap())
        .map_err(|e| format!("INSTALL_FAILED: {}", e))?;

    // 7. 清理临时目录
    let _ = std::fs::remove_dir_all(&temp_dir);

    // 8. 返回安装信息
    Ok(serde_json::json!({
        "id": result.id,
        "name": result.name,
        "version": result.version,
        "permissions": result.permissions,
    }))
}

/// 在目录中递归查找 manifest.json
fn find_manifest_in_dir(dir: &std::path::Path) -> Option<PathBuf> {
    // 先检查根目录
    let direct = dir.join("manifest.json");
    if direct.exists() {
        return Some(direct);
    }
    // 检查一级子目录（zip 可能有顶层目录）
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                let manifest = path.join("manifest.json");
                if manifest.exists() {
                    return Some(manifest);
                }
            }
        }
    }
    None
}

/// 版本兼容性检查：current >= required 的最低版本
fn is_version_compatible(current: &str, required: &str) -> bool {
    let parse = |s: &str| -> Vec<u32> {
        s.split('.')
            .map(|p| p.parse::<u32>().unwrap_or(0))
            .collect()
    };
    let cur = parse(current);
    let req = parse(required);
    for i in 0..req.len().max(cur.len()) {
        let c = cur.get(i).copied().unwrap_or(0);
        let r = req.get(i).copied().unwrap_or(0);
        if c > r {
            return true;
        }
        if c < r {
            return false;
        }
    }
    true // 完全相等
}

#[tauri::command]
pub fn plugin_get_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    id: String,
) -> Result<serde_json::Value, String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let items = store::load_store(&dir).unwrap_or_default();
    items
        .iter()
        .find(|i| i.id == id)
        .map(|i| i.config.clone())
        .ok_or_else(|| format!("插件不存在: {}", id))
}

#[tauri::command]
pub fn plugin_set_config(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    id: String,
    config: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let mut items = store::load_store(&dir).unwrap_or_default();
    let mut found = false;
    for item in items.iter_mut() {
        if item.id == id {
            item.config = config.clone();
            found = true;
            break;
        }
    }
    if !found {
        return Err(format!("插件不存在: {}", id));
    }
    store::save_store(&dir, &items)?;
    Ok(config)
}

#[tauri::command]
pub fn plugin_get_granted(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    id: String,
) -> Result<Vec<String>, String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let items = store::load_store(&dir).unwrap_or_default();
    items
        .iter()
        .find(|i| i.id == id)
        .map(|i| i.granted_permissions.clone())
        .ok_or_else(|| format!("插件不存在: {}", id))
}

#[tauri::command]
pub fn plugin_set_granted(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    id: String,
    perms: Vec<String>,
) -> Result<Vec<String>, String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let filtered: Vec<String> = perms
        .into_iter()
        .filter(|p| permissions::is_valid_permission(p))
        .collect();
    let mut items = store::load_store(&dir).unwrap_or_default();
    let mut found = false;
    for item in items.iter_mut() {
        if item.id == id {
            item.granted_permissions = filtered.clone();
            found = true;
            break;
        }
    }
    if !found {
        return Err(format!("插件不存在: {}", id));
    }
    store::save_store(&dir, &items)?;
    Ok(filtered)
}

#[tauri::command]
pub fn plugin_reload(_id: String) -> Result<PluginInfo, String> {
    Err("Phase 4 实现".to_string())
}

#[tauri::command]
pub fn plugin_dev_watch(_id: String, _watch: bool) -> Result<bool, String> {
    Ok(false)
}

/// 内核层权限校验命令：检查指定插件是否被授予了 perm 权限。
/// 供前端 SDK 在调用敏感 API 前进行二次校验（双层校验）。
#[tauri::command]
pub fn plugin_assert_perm(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    id: String,
    perm: String,
) -> Result<(), String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let items = store::load_store(&dir).unwrap_or_default();
    let granted: Vec<String> = items
        .iter()
        .find(|i| i.id == id)
        .map(|i| i.granted_permissions.clone())
        .unwrap_or_default();
    permissions::assert_perm(&granted, &perm)
}

/// 返回所有权限的元数据（id / risk / description），供前端渲染权限列表。
#[tauri::command]
pub fn plugin_permissions_meta() -> Vec<serde_json::Value> {
    permissions::ALL_PERMISSIONS
        .iter()
        .map(|p| {
            serde_json::json!({
                "id": p,
                "risk": permissions::risk_level(p),
                "description": permissions::permission_description(p),
            })
        })
        .collect()
}

/// 只解析指定目录下的 manifest.json，不执行安装。
/// 用于安装前预览插件信息与权限请求。
#[tauri::command]
pub fn plugin_parse_manifest_from_dir(
    dir_path: String,
) -> Result<manifest::PluginManifest, String> {
    let dir = std::path::Path::new(&dir_path);
    let manifest_path = dir.join("manifest.json");
    manager::parse_manifest(&manifest_path)
}

/// 读取插件的 index.html（manifest.indexHtml 指向的界面入口）原始内容。
/// 插件视图宿主注入 SDK 桥脚本后转为 data URL 作为 iframe 的 src。
/// 插件文件位于 `app_data_dir/plugins/<id>@<version>/<indexHtml>`。
#[tauri::command]
pub fn plugin_resolve_src(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    plugin_id: String,
) -> Result<String, String> {
    let app_dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let plugins_dir = app_dir.join("plugins");
    let entries =
        std::fs::read_dir(&plugins_dir).map_err(|e| format!("读取插件目录失败: {}", e))?;

    for entry in entries.flatten() {
        let dir_path = entry.path();
        if !dir_path.is_dir() {
            continue;
        }
        let dir_name = dir_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if dir_name != plugin_id && !dir_name.starts_with(&format!("{}@", plugin_id)) {
            continue;
        }
        let manifest_path = dir_path.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }
        let manifest = manager::parse_manifest(&manifest_path)?;
        let index_file = manifest
            .index_html
            .unwrap_or_else(|| manifest.entry.clone());
        let html_path = dir_path.join(&index_file);
        let bytes = std::fs::read(&html_path)
            .map_err(|e| format!("读取插件界面失败 {}: {}", html_path.display(), e))?;
        let html =
            String::from_utf8(bytes).map_err(|e| format!("插件界面不是合法 UTF-8 文本: {}", e))?;
        return Ok(html);
    }
    Err(format!("PLUGIN_NOT_FOUND: {}", plugin_id))
}

/// 内置端口转发插件 ID（随应用打包，首次启动自动注册）。
pub const BUILTIN_PLUGIN_ID: &str = "rd-native-port-forward";

/// 定位内置插件的资源源目录（打包后 → 开发调试）：
/// 1. `resource_dir/plugins/<id>`（tauri bundle.resources 映射的目标）
/// 2. `resource_dir/resources/plugins/<id>`（部分环境未映射时的兜底）
/// 3. 开发模式：`src-tauri/resources/plugins/<id>`（源码目录）
fn resolve_builtin_src_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(res) = app.path().resource_dir() {
        candidates.push(res.join("plugins").join(BUILTIN_PLUGIN_ID));
        candidates.push(
            res.join("resources")
                .join("plugins")
                .join(BUILTIN_PLUGIN_ID),
        );
    }
    #[cfg(debug_assertions)]
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        candidates.push(
            PathBuf::from(manifest_dir)
                .join("resources")
                .join("plugins")
                .join(BUILTIN_PLUGIN_ID),
        );
    }
    candidates
        .into_iter()
        .find(|c| c.join("manifest.json").exists())
}

/// 首次启动注册内置插件（幂等 + 自愈）：
/// - 未安装 → 从应用资源目录复制内置插件目录并安装
/// - 已安装但界面入口缺失、或版本与随包资源不一致 → 卸载后重新安装
///   （覆盖早期资源 glob 未拷贝嵌套目录导致的安装不完整，以及插件随版本升级）
pub fn plugin_ensure_builtin(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, PluginState>,
) -> Result<(), String> {
    let app_dir = resolve_app_data_dir(Some(app), Some(state))?;

    let src_dir = resolve_builtin_src_dir(app).ok_or_else(|| {
        format!("内置插件目录未找到: {}", BUILTIN_PLUGIN_ID)
    })?;
    // 随包资源里的目标版本（用于判断已安装版本是否需要升级/修复）
    let src_version = manager::parse_manifest(&src_dir.join("manifest.json"))
        .ok()
        .map(|m| m.version.clone());

    let existing = manager::scan(&app_dir)?;
    if let Some(p) = existing.iter().find(|p| p.manifest.id == BUILTIN_PLUGIN_ID) {
        let entry = p
            .manifest
            .index_html
            .clone()
            .unwrap_or_else(|| p.manifest.entry.clone());
        let dir = app_dir
            .join("plugins")
            .join(format!("{}@{}", p.manifest.id, p.manifest.version));
        let entry_ok = dir.join(&entry).exists();
        let version_ok = src_version
            .as_ref()
            .map(|v| v == &p.manifest.version)
            .unwrap_or(true);
        if entry_ok && version_ok {
            return Ok(());
        }
        debug_log(
            app,
            LogLevel::Warn,
            &format!(
                "内置插件需更新/修复（entry_ok={}, installed_v={}, src_v={:?}），重新安装",
                entry_ok, p.manifest.version, src_version
            ),
        );
        manager::uninstall(&app_dir, BUILTIN_PLUGIN_ID)?;
    }

    let manifest = manager::install_from_dir(&app_dir, &src_dir)?;
    debug_log(
        app,
        LogLevel::Info,
        &format!(
            "内置插件已注册: {} v{} (来源 {})",
            manifest.id,
            manifest.version,
            src_dir.display()
        ),
    );
    Ok(())
}

// ===== Plugin Storage Helpers =====

fn validate_plugin_id(pid: &str) -> Result<(), String> {
    // 冒号是 Windows NTFS 保留字符（ADS 分隔符），目录名含冒号会导致 os error 123
    if pid.is_empty()
        || pid.contains("..")
        || pid.contains('/')
        || pid.contains('\\')
        || pid.contains(':')
    {
        return Err("INVALID_PLUGIN_ID".to_string());
    }
    Ok(())
}

fn plugin_data_dir(app_data_dir: &Path, pid: &str) -> Result<PathBuf, String> {
    validate_plugin_id(pid)?;
    let dir = app_data_dir.join("plugin-data").join(pid);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建插件数据目录失败: {}", e))?;
    Ok(dir)
}

fn load_store_json(dir: &Path) -> serde_json::Map<String, serde_json::Value> {
    let store_path = dir.join("store.json");
    if !store_path.exists() {
        return serde_json::Map::new();
    }
    let content = std::fs::read_to_string(&store_path).unwrap_or_default();
    if content.trim().is_empty() {
        return serde_json::Map::new();
    }
    match serde_json::from_str::<serde_json::Value>(&content) {
        Ok(serde_json::Value::Object(map)) => map,
        _ => serde_json::Map::new(),
    }
}

fn save_store_json(
    dir: &Path,
    map: &serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let store_path = dir.join("store.json");
    let json =
        serde_json::to_string_pretty(map).map_err(|e| format!("序列化 store.json 失败: {}", e))?;
    std::fs::write(&store_path, json).map_err(|e| format!("写入 store.json 失败: {}", e))
}

// ===== Plugin Storage Commands =====

#[tauri::command]
pub fn plugin_storage_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    pid: String,
    k: String,
    v: serde_json::Value,
) -> Result<(), String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    validate_plugin_id(&pid)?;
    if k.contains("..") || k.contains('/') || k.contains('\\') {
        return Err("INVALID_KEY".to_string());
    }
    let data_dir = plugin_data_dir(&dir, &pid)?;
    let mut map = load_store_json(&data_dir);
    map.insert(k, v);
    save_store_json(&data_dir, &map)
}

#[tauri::command]
pub fn plugin_storage_get(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    pid: String,
    k: String,
) -> Result<Option<serde_json::Value>, String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let data_dir = plugin_data_dir(&dir, &pid)?;
    let map = load_store_json(&data_dir);
    Ok(map.get(&k).cloned())
}

#[tauri::command]
pub fn plugin_storage_remove(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    pid: String,
    k: String,
) -> Result<(), String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let data_dir = plugin_data_dir(&dir, &pid)?;
    let mut map = load_store_json(&data_dir);
    map.remove(&k);
    save_store_json(&data_dir, &map)
}

#[tauri::command]
pub fn plugin_storage_remove_all(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    pid: String,
) -> Result<(), String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    validate_plugin_id(&pid)?;
    let data_dir = dir.join("plugin-data").join(pid);
    if data_dir.exists() {
        std::fs::remove_dir_all(&data_dir).map_err(|e| format!("删除插件数据目录失败: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn plugin_storage_list_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    pid: String,
) -> Result<Vec<String>, String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let data_dir = plugin_data_dir(&dir, &pid)?;
    let mut files = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(&data_dir) {
        for entry in read_dir.flatten() {
            if entry.path().is_file() {
                if let Some(name) = entry.file_name().to_str() {
                    files.push(name.to_string());
                }
            }
        }
    }
    Ok(files)
}

fn is_private_host(host: &str) -> bool {
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    let cleaned = host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = cleaned.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(v4) => {
                let o = v4.octets();
                if o[0] == 127 {
                    return true;
                }
                if o[0] == 10 {
                    return true;
                }
                if o[0] == 172 && (16..=31).contains(&o[1]) {
                    return true;
                }
                if o[0] == 192 && o[1] == 168 {
                    return true;
                }
                if o == [0, 0, 0, 0] {
                    return true;
                }
                if v4.is_multicast() || v4.is_broadcast() || v4.is_unspecified() {
                    return true;
                }
                return false;
            }
            std::net::IpAddr::V6(v6) => {
                if v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() {
                    return true;
                }
                let segs = v6.segments();
                if (segs[0] & 0xffc0) == 0xfe80 {
                    return true;
                }
                if (segs[0] & 0xfe00) == 0xfc00 {
                    return true;
                }
                return false;
            }
        }
    }
    false
}

#[derive(serde::Serialize)]
pub struct HttpResponseDto {
    status: u16,
    status_text: String,
    headers: std::collections::HashMap<String, String>,
    body: serde_json::Value,
    ok: bool,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn plugin_http_request(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    id: String,
    url: String,
    method: Option<String>,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
    timeout_ms: Option<u64>,
    allow_internal: Option<bool>,
) -> Result<HttpResponseDto, String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let items = store::load_store(&dir).unwrap_or_default();
    let granted = items
        .iter()
        .find(|i| i.id == id)
        .map(|i| i.granted_permissions.clone())
        .unwrap_or_default();
    permissions::assert_perm(&granted, "network.http")?;

    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("URL_INVALID: {}", e))?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("URL_INVALID: only http/https allowed".into());
    }
    let host = parsed.host_str().unwrap_or("").to_string();
    if host.is_empty() {
        return Err("URL_INVALID: missing host".into());
    }

    let allow_internal_net = allow_internal.unwrap_or(false);
    if !allow_internal_net && is_private_host(&host) {
        return Err("NETWORK_FORBIDDEN: internal network access blocked by global switch".into());
    }

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(15_000));
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("HTTP_CLIENT_ERROR: {}", e))?;

    let method_str = method
        .unwrap_or_else(|| "GET".to_string())
        .to_ascii_uppercase();
    let req_method: reqwest::Method = match method_str.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "PATCH" => reqwest::Method::PATCH,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        other => return Err(format!("HTTP_METHOD_INVALID: {}", other)),
    };

    let mut req = client.request(req_method, parsed);
    if let Some(hs) = headers {
        for (k, v) in hs {
            req = req.header(&k, &v);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| format!("HTTP_REQUEST_FAILED: {}", e))?;

    let status = resp.status();
    let mut header_map = std::collections::HashMap::new();
    for (k, v) in resp.headers() {
        let v_str = v.to_str().unwrap_or("").to_string();
        header_map
            .entry(k.as_str().to_string())
            .and_modify(|existing| {
                *existing = format!("{}, {}", existing, v_str);
            })
            .or_insert(v_str);
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("HTTP_BODY_READ_FAILED: {}", e))?;
    let body_val: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => serde_json::Value::String(String::from_utf8_lossy(&bytes).to_string()),
    };

    Ok(HttpResponseDto {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers: header_map,
        body: body_val,
        ok: status.is_success(),
    })
}
