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

/// 统一的权限解析逻辑（与 manager::scan 保持一致）：
/// 1. 优先从 plugin-state.json 中读取已授予的 granted_permissions；
/// 2. 若 store 中无记录（首次安装/数据异常），则扫描 plugins 目录找到对应
///    manifest，使用 manifest.permissions 作为默认值；
/// 3. 仍然找不到时返回空数组（权限拒绝）。
///
/// 所有需要做内核权限校验的命令（plugin_assert_perm、plugin_http_request 等）
/// 都必须调用此函数，避免权限回退策略不一致导致的偶发拒绝。
fn resolve_granted_permissions(dir: &Path, plugin_id: &str) -> Vec<String> {
    let items = store::load_store(dir).unwrap_or_default();
    items
        .iter()
        .find(|i| i.id == plugin_id)
        .map(|i| i.granted_permissions.clone())
        .unwrap_or_else(|| {
            if let Ok(scanned) = manager::scan(dir) {
                if let Some(p) = scanned.iter().find(|p| p.manifest.id == plugin_id) {
                    return p.manifest.permissions.clone();
                }
            }
            Vec::new()
        })
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
///
/// 同时监听两个目录：
///  1. 运行时安装目录 `app_data_dir/plugins/` — 用户侧插件、内置插件安装后的工作副本
///  2. 开发模式源目录 `{CARGO_MANIFEST_DIR}/resources/plugins/`
///     —— Cargo.toml 所在目录（src-tauri）下的 resources/plugins。
///     只在开发模式（该路径实际存在）时生效；打包后 src-tauri 目录不存在，会被跳过，
///     不会造成空目录创建失败或报错。
///
/// 前端收到 `plugin:hot-reload` 事件后可以刷新 iframe / 重新安装对应内置插件。
#[tauri::command]
pub async fn plugin_start_hot_reload(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
) -> Result<(), String> {
    debug_log(&app, LogLevel::Info, "plugin_start_hot_reload start");
    let app_data_dir = match resolve_app_data_dir(Some(&app), Some(&state)) {
        Ok(p) => p,
        Err(e) => {
            debug_log(
                &app,
                LogLevel::Error,
                &format!("plugin_start_hot_reload 解析 app_data_dir 失败: {}", e),
            );
            return Err(e);
        }
    };
    let runtime_plugins_dir = app_data_dir.join("plugins");

    // CARGO_MANIFEST_DIR 编译期解析为 Cargo.toml 绝对路径（即 .../remote/src-tauri），
    // 只在开发构建时有效；生产环境（cargo build --release）下同样会把路径写死，
    // 但我们在 start_watching 内部会检查路径存在性 → 不存在就跳过，所以不会出错。
    let dev_source_dir: Option<std::path::PathBuf> = option_env!("CARGO_MANIFEST_DIR")
        .map(std::path::PathBuf::from)
        .map(|p| p.join("resources").join("plugins"));

    let mut watch_dirs: Vec<std::path::PathBuf> = vec![runtime_plugins_dir];
    if let Some(dev) = dev_source_dir {
        watch_dirs.push(dev);
    }

    hot_reload::start_watching(&app, &watch_dirs);
    debug_log(
        &app,
        LogLevel::Info,
        &format!(
            "plugin_start_hot_reload complete: watch_dirs_count={}",
            watch_dirs.len()
        ),
    );
    Ok(())
}

/// 停止插件目录文件监听
#[tauri::command]
pub async fn plugin_stop_hot_reload(app: tauri::AppHandle) -> Result<(), String> {
    debug_log(&app, LogLevel::Info, "plugin_stop_hot_reload start");
    hot_reload::stop_watching(&app);
    debug_log(&app, LogLevel::Info, "plugin_stop_hot_reload complete");
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
    let granted = resolve_granted_permissions(&dir, &id);
    match permissions::assert_perm(&granted, &perm) {
        Ok(()) => Ok(()),
        Err(e) => {
            debug_log(
                &app,
                LogLevel::Warn,
                &format!(
                    "plugin_assert_perm 被拒: plugin={} perm={} granted=[{}] err={}",
                    id,
                    perm,
                    granted.join(","),
                    e
                ),
            );
            Err(e)
        }
    }
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

/// 首次启动注册内置插件（幂等 + 自愈 + 回滚）：
/// - 未安装 → 从应用资源目录复制内置插件目录并安装
/// - 已安装但界面入口缺失、或版本与随包资源不一致 →
///   ① 先 rename 备份旧目录 + 快照 store 条目 → ② 卸载旧版 → ③ 安装新版；
///   若 ③ 失败则把备份 rename 回来 + 恢复 store 条目，避免「升级过程中断导致内置插件彻底没入口」。
pub fn plugin_ensure_builtin(
    app: &tauri::AppHandle,
    state: &tauri::State<'_, PluginState>,
) -> Result<(), String> {
    use crate::plugin::store::{load_store, save_store, PluginStoreItem};
    use std::time::{SystemTime, UNIX_EPOCH};

    let app_dir = resolve_app_data_dir(Some(app), Some(state))?;

    let src_dir = resolve_builtin_src_dir(app)
        .ok_or_else(|| format!("内置插件目录未找到: {}", BUILTIN_PLUGIN_ID))?;
    // 随包资源里的目标版本（用于判断已安装版本是否需要升级/修复）
    let src_version = manager::parse_manifest(&src_dir.join("manifest.json"))
        .ok()
        .map(|m| m.version.clone());

    /// 升级过程中的备份元信息：rename 后的旧目录路径 + store 条目快照
    struct UpgradeBackup {
        backup_dir: PathBuf,
        original_dir: PathBuf,
        store_item: Option<PluginStoreItem>,
    }

    impl UpgradeBackup {
        /// 丢弃备份：安装成功后清理
        fn discard(self) {
            if self.backup_dir.exists() {
                let _ = std::fs::remove_dir_all(&self.backup_dir);
            }
        }
        /// 回滚：把备份目录 rename 回原名，并把 store 条目写回
        fn restore(self, app_data_dir: &Path) -> Result<(), String> {
            // 1) 若「新安装半截」导致 original_dir 存在，先移除以免 rename 冲突
            if self.original_dir.exists() {
                let _ = std::fs::remove_dir_all(&self.original_dir);
            }
            // 2) 备份目录 → 原目录
            if self.backup_dir.exists() {
                std::fs::rename(&self.backup_dir, &self.original_dir).map_err(|e| {
                    format!(
                        "回滚插件目录失败 {} -> {}: {}",
                        self.backup_dir.display(),
                        self.original_dir.display(),
                        e
                    )
                })?;
            }
            // 3) 恢复 store 条目（先移除已写入的新 id 条目，再插入旧条目快照）
            let mut items = load_store(app_data_dir).unwrap_or_default();
            items.retain(|i| i.id != BUILTIN_PLUGIN_ID);
            if let Some(s) = self.store_item {
                items.push(s);
            }
            save_store(app_data_dir, &items)?;
            Ok(())
        }
    }

    let existing = manager::scan(&app_dir)?;
    let backup: Option<UpgradeBackup> =
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

            // ===== 升级前备份（O(1) rename，不是整目录复制） =====
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let backup_dir = app_dir.join("plugins").join(format!(
                "{}@{}._backup_{}",
                p.manifest.id, p.manifest.version, ts
            ));
            let store_item_snapshot: Option<PluginStoreItem> = load_store(&app_dir)
                .ok()
                .and_then(|items| items.into_iter().find(|s| s.id == BUILTIN_PLUGIN_ID));
            if dir.exists() {
                std::fs::rename(&dir, &backup_dir).map_err(|e| {
                    format!(
                        "备份旧插件目录失败 {} -> {}: {}",
                        dir.display(),
                        backup_dir.display(),
                        e
                    )
                })?;
            }
            // 备份完后，手动移除 store 条目（不再调用 manager::uninstall，
            // 因为它会 rm -rf 目录；而目录已经被我们 rename 走了）
            {
                let mut items = load_store(&app_dir).unwrap_or_default();
                items.retain(|i| i.id != BUILTIN_PLUGIN_ID);
                save_store(&app_dir, &items)?;
            }
            Some(UpgradeBackup {
                backup_dir,
                original_dir: dir,
                store_item: store_item_snapshot,
            })
        } else {
            None
        };

    // ===== 安装新版 =====
    let install_result = manager::install_from_dir(&app_dir, &src_dir);
    match (&install_result, backup) {
        (Ok(manifest), Some(bk)) => {
            // 成功 → 丢弃备份
            bk.discard();
            debug_log(
                app,
                LogLevel::Info,
                &format!(
                    "内置插件已升级/修复: {} v{} (来源 {})",
                    manifest.id,
                    manifest.version,
                    src_dir.display()
                ),
            );
        }
        (Ok(manifest), None) => {
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
        }
        (Err(e), Some(bk)) => {
            // 失败 → 回滚
            debug_log(
                app,
                LogLevel::Error,
                &format!("内置插件安装失败，正在回滚到上一可用版本: {}", e),
            );
            if let Err(rb) = bk.restore(&app_dir) {
                debug_log(app, LogLevel::Error, &format!("内置插件回滚失败: {}", rb));
                return Err(format!(
                    "安装失败且回滚失败: install_err={}; rollback_err={}",
                    e, rb
                ));
            }
            return Err(format!("内置插件安装失败（已回滚）: {}", e));
        }
        (Err(e), None) => {
            return Err(format!("内置插件首次安装失败: {}", e));
        }
    }
    Ok(())
}

// ===== Plugin Storage Helpers =====

/// 单个 storage key 的 value 最大字节数（JSON 字符串 UTF-8 长度）。
/// 超过则在 plugin_storage_set 阶段直接拒绝，避免一个插件把整块 store.json 撑爆。
const PLUGIN_STORAGE_MAX_VALUE_BYTES: usize = 256 * 1024; // 256 KiB

/// 单个插件 store.json 总文件大小上限。
/// 超过则 set 被拒绝，让插件自己清存储，避免主程序 app_data_dir 被无限写满。
const PLUGIN_STORAGE_MAX_TOTAL_BYTES: u64 = 8 * 1024 * 1024; // 8 MiB

/// 单个插件文件存储（非 store.json，list_files 返回的那些）的单文件大小上限。
const PLUGIN_STORAGE_MAX_FILE_BYTES: u64 = 16 * 1024 * 1024; // 16 MiB

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
    // 先写临时文件 + rename，避免中途断电把 store.json 写坏（半写状态）
    let tmp_path = store_path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &json).map_err(|e| format!("写入 store.json.tmp 失败: {}", e))?;
    std::fs::rename(&tmp_path, &store_path)
        .map_err(|e| format!("rename store.json.tmp -> store.json 失败: {}", e))
}

/// 计算当前 store.json 序列化后的字节数（用于配额判断）
fn store_json_size(map: &serde_json::Map<String, serde_json::Value>) -> usize {
    serde_json::to_vec(map).map(|v| v.len()).unwrap_or(0)
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
    validate_plugin_id(&pid).map_err(|e| {
        debug_log(
            &app,
            LogLevel::Error,
            &format!("plugin_storage_set: 非法插件ID pid={} err={}", pid, e),
        );
        e
    })?;
    if k.contains("..") || k.contains('/') || k.contains('\\') {
        let e = "INVALID_KEY".to_string();
        debug_log(
            &app,
            LogLevel::Error,
            &format!("plugin_storage_set: 非法 key pid={} key={}", pid, k),
        );
        return Err(e);
    }
    // ① value 级配额：单个 value 序列化字节 ≤ 256KB
    let value_bytes = serde_json::to_vec(&v).map_err(|e| {
        let msg = format!("序列化存储值失败: {}", e);
        debug_log(
            &app,
            LogLevel::Error,
            &format!("plugin_storage_set: {} pid={} key={}", msg, pid, k),
        );
        msg
    })?;
    if value_bytes.len() > PLUGIN_STORAGE_MAX_VALUE_BYTES {
        let msg = format!(
            "STORAGE_VALUE_TOO_LARGE: key={} size={}B max={}B",
            k,
            value_bytes.len(),
            PLUGIN_STORAGE_MAX_VALUE_BYTES
        );
        debug_log(
            &app,
            LogLevel::Error,
            &format!("plugin_storage_set: {} pid={}", msg, pid),
        );
        return Err(msg);
    }
    let data_dir = plugin_data_dir(&dir, &pid)?;
    let mut map = load_store_json(&data_dir);
    let key = k.clone();
    map.insert(k, v);
    // ② total 级配额：整份 store.json ≤ 8MB（含所有 key）
    let total = store_json_size(&map) as u64;
    if total > PLUGIN_STORAGE_MAX_TOTAL_BYTES {
        let msg = format!(
            "STORAGE_QUOTA_EXCEEDED: plugin={} total={}B max={}B",
            pid, total, PLUGIN_STORAGE_MAX_TOTAL_BYTES
        );
        debug_log(
            &app,
            LogLevel::Error,
            &format!("plugin_storage_set: {}", msg),
        );
        return Err(msg);
    }
    save_store_json(&data_dir, &map).map_err(|e| {
        debug_log(
            &app,
            LogLevel::Error,
            &format!(
                "plugin_storage_set: 写入失败 pid={} key={} err={}",
                pid, key, e
            ),
        );
        e
    })
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
pub fn plugin_storage_keys(
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    pid: String,
) -> Result<Vec<String>, String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    validate_plugin_id(&pid)?;
    let data_dir = plugin_data_dir(&dir, &pid)?;
    let map = load_store_json(&data_dir);
    Ok(map.keys().cloned().collect())
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
            let entry_path = entry.path();
            if entry_path.is_file() {
                // 普通文件：检查 size 是否超过 16MB（单文件配额）；超了也列出来，
                // 但主程序可以在上传/写入路径做拦截。此处仅展示 + 打印 warning。
                if let Ok(md) = entry_path.metadata() {
                    let size = md.len();
                    if size > PLUGIN_STORAGE_MAX_FILE_BYTES {
                        debug_log(
                            &app,
                            LogLevel::Warn,
                            &format!(
                                "plugin_storage_list_files: 文件超过单文件配额 plugin={} file={} size={}B max={}B",
                                pid,
                                entry_path.display(),
                                size,
                                PLUGIN_STORAGE_MAX_FILE_BYTES
                            ),
                        );
                    }
                }
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
    let granted = resolve_granted_permissions(&dir, &id);
    permissions::assert_perm(&granted, "network.http").map_err(|e| {
        debug_log(
            &app,
            LogLevel::Warn,
            &format!(
                "plugin_http_request 权限被拒: plugin={} url={} err={}",
                id, url, e
            ),
        );
        e
    })?;

    let parsed = reqwest::Url::parse(&url).map_err(|e| {
        let msg = format!("URL_INVALID: {}", e);
        debug_log(
            &app,
            LogLevel::Error,
            &format!("plugin_http_request: plugin={} {} url={}", id, msg, url),
        );
        msg
    })?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        let e: String = "URL_INVALID: only http/https allowed".into();
        debug_log(
            &app,
            LogLevel::Error,
            &format!("plugin_http_request: plugin={} {} url={}", id, e, url),
        );
        return Err(e);
    }
    let host = parsed.host_str().unwrap_or("").to_string();
    if host.is_empty() {
        let e: String = "URL_INVALID: missing host".into();
        debug_log(
            &app,
            LogLevel::Error,
            &format!("plugin_http_request: plugin={} {} url={}", id, e, url),
        );
        return Err(e);
    }

    let allow_internal_net = allow_internal.unwrap_or(false);
    if !allow_internal_net && is_private_host(&host) {
        let e: String =
            "NETWORK_FORBIDDEN: internal network access blocked by global switch".into();
        debug_log(
            &app,
            LogLevel::Warn,
            &format!(
                "plugin_http_request: plugin={} {} host={} url={}",
                id, e, host, url
            ),
        );
        return Err(e);
    }

    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(15_000));
    let method_str = method
        .unwrap_or_else(|| "GET".to_string())
        .to_ascii_uppercase();
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| {
            let msg = format!("HTTP_CLIENT_ERROR: {}", e);
            debug_log(
                &app,
                LogLevel::Error,
                &format!(
                    "plugin_http_request: plugin={} {} method={} url={}",
                    id, msg, method_str, url
                ),
            );
            msg
        })?;

    let req_method: reqwest::Method = match method_str.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "PATCH" => reqwest::Method::PATCH,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        other => {
            let e = format!("HTTP_METHOD_INVALID: {}", other);
            debug_log(
                &app,
                LogLevel::Error,
                &format!("plugin_http_request: plugin={} {} url={}", id, e, url),
            );
            return Err(e);
        }
    };

    debug_log(
        &app,
        LogLevel::Info,
        &format!(
            "plugin_http_request 发起: plugin={} method={} url={} timeout={}ms allow_internal={}",
            id,
            method_str,
            url,
            timeout.as_millis(),
            allow_internal_net
        ),
    );

    let mut req = client.request(req_method, parsed);
    if let Some(hs) = headers {
        for (k, v) in hs {
            req = req.header(&k, &v);
        }
    }
    if let Some(b) = body {
        req = req.body(b);
    }

    let resp = req.send().await.map_err(|e| {
        let msg = format!("HTTP_REQUEST_FAILED: {}", e);
        debug_log(
            &app,
            LogLevel::Error,
            &format!(
                "plugin_http_request: plugin={} {} method={} url={}",
                id, msg, method_str, url
            ),
        );
        msg
    })?;

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

    let bytes = resp.bytes().await.map_err(|e| {
        let msg = format!("HTTP_BODY_READ_FAILED: {}", e);
        debug_log(
            &app,
            LogLevel::Error,
            &format!(
                "plugin_http_request: plugin={} {} status={} url={}",
                id, msg, status, url
            ),
        );
        msg
    })?;
    let body_val: serde_json::Value = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => serde_json::Value::String(String::from_utf8_lossy(&bytes).to_string()),
    };

    debug_log(
        &app,
        if status.is_success() {
            LogLevel::Info
        } else {
            LogLevel::Warn
        },
        &format!(
            "plugin_http_request 完成: plugin={} method={} url={} status={} body_bytes={}",
            id,
            method_str,
            url,
            status,
            bytes.len()
        ),
    );

    Ok(HttpResponseDto {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers: header_map,
        body: body_val,
        ok: status.is_success(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // =========================================================================
    // TR-1: validate_plugin_id —— 路径穿越/非法字符必须拦截
    // =========================================================================

    #[test]
    fn test_validate_plugin_id_normal_cases() {
        // ASCII 字母数字 + 常见合法分隔符：都应该放行
        assert!(validate_plugin_id("rd-native-port-forward").is_ok());
        assert!(validate_plugin_id("com.example.plugin_123").is_ok());
        assert!(validate_plugin_id("a").is_ok());
        assert!(validate_plugin_id("my-plugin_v1.0.0").is_ok());
    }

    #[test]
    fn test_validate_plugin_id_rejects_empty() {
        assert_eq!(
            validate_plugin_id(""),
            Err("INVALID_PLUGIN_ID".to_string()),
            "空字符串必须拒绝"
        );
    }

    #[test]
    fn test_validate_plugin_id_rejects_path_traversal() {
        let cases = [
            "foo/../bar",     // Unix 风格上跳
            "..",             // 纯上跳
            "prefix..suffix", // 中间含 ..（Windows 也能被误用）
            "foo\\..\\bar",   // Windows 风格上跳
        ];
        for c in cases.iter() {
            assert!(
                validate_plugin_id(c).is_err(),
                "含「..」的插件 ID 必须被拒: {}",
                c
            );
        }
    }

    #[test]
    fn test_validate_plugin_id_rejects_path_separators() {
        let cases = [
            "a/b",            // Unix 分隔符
            "a\\b\\c",        // Windows 分隔符
            "/absolute",      // 根路径起点
            "\\\\unc\\share", // UNC 前缀片段
        ];
        for c in cases.iter() {
            assert!(
                validate_plugin_id(c).is_err(),
                "含路径分隔符的插件 ID 必须被拒: {}",
                c
            );
        }
    }

    #[test]
    fn test_validate_plugin_id_rejects_colon() {
        // NTFS 冒号 = ADS（备用数据流），会导致 CreateDirectory 报 ERROR_INVALID_NAME (123)
        let cases = [
            "C:plugin",    // 盘符式
            "stream:data", // ADS 式
            "plugin:v1",   // 版本号误用
        ];
        for c in cases.iter() {
            assert!(
                validate_plugin_id(c).is_err(),
                "含冒号的插件 ID 必须被拒: {}",
                c
            );
        }
    }

    // =========================================================================
    // TR-2: 存储配额常量 —— 预期边界白盒校验
    // （plugin_storage_set 本身需 AppHandle，不便在纯 UT 里跑，
    //  这里校验其依赖的关键常量值与序列化字节数匹配，防止未来改值时偏离设计。）
    // =========================================================================

    #[test]
    fn test_storage_quota_constants_match_design() {
        // 设计值：单 key ≤ 256 KiB；整份 store.json ≤ 8 MiB；单文件 ≤ 16 MiB
        assert_eq!(PLUGIN_STORAGE_MAX_VALUE_BYTES, 256 * 1024);
        assert_eq!(PLUGIN_STORAGE_MAX_TOTAL_BYTES, 8 * 1024 * 1024);
        assert_eq!(PLUGIN_STORAGE_MAX_FILE_BYTES, 16 * 1024 * 1024);
    }

    #[test]
    fn test_storage_value_size_boundary_256kib() {
        // 构造一个长度恰好为 N 字节的 JSON Value（字符串类型）。
        // 单字符 `a`：JSON 序列化后 = "aaaaa..."（带外层引号 + 内部字符）。
        // 精确到边界：刚好低于限额 → 应能通过；超 1B → 应拒绝。
        let limit = PLUGIN_STORAGE_MAX_VALUE_BYTES;

        // 256 * 1024 - 2 = 外层引号占 2B，内部 pure ASCII 占 (limit - 2) 字节
        let len_ok = limit - 2;
        let s_ok = "a".repeat(len_ok);
        let v_ok = json!(s_ok);
        let bytes_ok = serde_json::to_vec(&v_ok).unwrap();
        assert_eq!(
            bytes_ok.len(),
            limit,
            "预期 limit 边界 Value 序列化后正好 = {}B（实际 {}B）",
            limit,
            bytes_ok.len()
        );

        // 超 1 字节：必然超过限额
        let len_bad = limit - 1;
        let s_bad = "a".repeat(len_bad);
        let v_bad = json!(s_bad);
        let bytes_bad = serde_json::to_vec(&v_bad).unwrap();
        assert!(
            bytes_bad.len() > limit,
            "超限 1B 的 Value 序列化应 > {}B（实际 {}B）",
            limit,
            bytes_bad.len()
        );
    }

    // =========================================================================
    // TR-3: resolve_granted_permissions —— 纯文件系统侧的权限解析
    // （需要临时目录 + 至少一个 store 或 manifest；没有 manifest 时返回空数组。）
    // =========================================================================

    #[test]
    fn test_resolve_granted_permissions_no_store_no_manifest_returns_empty() {
        let tmp = tempdir();
        let granted = resolve_granted_permissions(&tmp, "non-existent-plugin");
        assert!(
            granted.is_empty(),
            "既无 store 也无对应 manifest 时，应返回空数组（实际 {:?}）",
            granted
        );
    }

    #[test]
    fn test_resolve_granted_permissions_invalid_plugin_id_still_returns_empty() {
        let tmp = tempdir();
        // 非法 ID 不会被 validate 在此函数里拦住（validate 在更外层调用），
        // 但至少不会 panic，返回空数组即可
        let granted = resolve_granted_permissions(&tmp, "../bad-id");
        assert!(granted.is_empty());
    }

    // ---- helpers ----

    fn tempdir() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!(
            "rd-plugin-ut-{}-{}",
            std::process::id(),
            rand_hex()
        ));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn rand_hex() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        format!("{:x}", n)
    }
}
