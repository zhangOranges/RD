use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::manifest::{validate_manifest, PluginManifest};
use super::store::{load_store, save_store, PluginStoreItem};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    pub manifest: PluginManifest,
    pub install_time_ms: i64,
    pub last_load_time_ms: i64,
    pub enabled: bool,
    pub granted_permissions: Vec<String>,
    pub config: serde_json::Value,
    pub load_error: Option<String>,
}

pub struct PluginManager {
    #[allow(dead_code)]
    cache: Vec<PluginInfo>,
    #[allow(dead_code)]
    loaded: HashMap<String, PluginManifest>,
}

impl Default for PluginManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PluginManager {
    pub fn new() -> Self {
        PluginManager {
            cache: Vec::new(),
            loaded: HashMap::new(),
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn parse_manifest(manifest_path: &Path) -> Result<PluginManifest, String> {
    let content = std::fs::read_to_string(manifest_path)
        .map_err(|e| format!("读取 manifest.json 失败 {}: {}", manifest_path.display(), e))?;
    let manifest: PluginManifest = serde_json::from_str(&content)
        .map_err(|e| format!("解析 manifest.json 失败 {}: {}", manifest_path.display(), e))?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

pub fn scan(app_data_dir: &Path) -> Result<Vec<PluginInfo>, String> {
    let plugins_dir = app_data_dir.join("plugins");
    if !plugins_dir.exists() {
        std::fs::create_dir_all(&plugins_dir)
            .map_err(|e| format!("创建 plugins 目录失败: {}", e))?;
        return Ok(Vec::new());
    }

    let store_items = load_store(app_data_dir).unwrap_or_default();
    let store_map: HashMap<String, &PluginStoreItem> = store_items
        .iter()
        .map(|item| (item.id.clone(), item))
        .collect();

    let mut result: Vec<PluginInfo> = Vec::new();

    let read_dir =
        std::fs::read_dir(&plugins_dir).map_err(|e| format!("读取 plugins 目录失败: {}", e))?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let entry_path = entry.path();
        if !entry_path.is_dir() {
            continue;
        }

        let manifest_path: PathBuf = entry_path.join("manifest.json");
        if !manifest_path.exists() {
            continue;
        }

        let manifest = match parse_manifest(&manifest_path) {
            Ok(m) => m,
            Err(e) => {
                let dir_name = entry_path
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                let (plugin_id, version) = parse_dir_name(&dir_name);
                result.push(PluginInfo {
                    manifest: dummy_manifest(&plugin_id, &version),
                    install_time_ms: 0,
                    last_load_time_ms: 0,
                    enabled: false,
                    granted_permissions: vec![],
                    config: serde_json::Value::Null,
                    load_error: Some(e),
                });
                continue;
            }
        };

        let store_item = store_map.get(&manifest.id);
        let info = PluginInfo {
            manifest: manifest.clone(),
            install_time_ms: store_item.map(|s| s.install_time_ms).unwrap_or_else(now_ms),
            last_load_time_ms: store_item
                .map(|s| s.last_load_time_ms)
                .unwrap_or_else(now_ms),
            enabled: store_item.map(|s| s.enabled).unwrap_or(true),
            granted_permissions: store_item
                .map(|s| s.granted_permissions.clone())
                .unwrap_or_else(|| manifest.permissions.clone()),
            config: store_item
                .map(|s| s.config.clone())
                .unwrap_or(serde_json::Value::Object(serde_json::Map::new())),
            load_error: None,
        };
        result.push(info);
    }

    Ok(result)
}

fn parse_dir_name(name: &str) -> (String, String) {
    if let Some(idx) = name.find('@') {
        let id = &name[..idx];
        let ver = &name[idx + 1..];
        (id.to_string(), ver.to_string())
    } else {
        (name.to_string(), "0.0.0".to_string())
    }
}

fn dummy_manifest(id: &str, version: &str) -> PluginManifest {
    PluginManifest {
        id: if id.is_empty() {
            "unknown".to_string()
        } else {
            id.to_string()
        },
        name: "Unknown".to_string(),
        version: if version.is_empty() {
            "0.0.0".to_string()
        } else {
            version.to_string()
        },
        api_version: "v1".to_string(),
        author: String::new(),
        description: String::new(),
        category: "other".to_string(),
        entry: String::new(),
        index_html: None,
        config_schema: None,
        icon: None,
        permissions: vec![],
        conflict: None,
        requires: None,
        min_rd_version: "0.1.0".to_string(),
        hot_reload: false,
    }
}

#[allow(dead_code)]
pub fn install(_app_data_dir: &Path, _manifest: &PluginManifest) -> Result<(), String> {
    Ok(())
}

pub fn uninstall(app_data_dir: &Path, id: &str) -> Result<(), String> {
    let mut items = load_store(app_data_dir).unwrap_or_default();
    items.retain(|i| i.id != id);
    save_store(app_data_dir, &items)?;

    let plugins_dir = app_data_dir.join("plugins");
    if plugins_dir.exists() {
        let read_dir =
            std::fs::read_dir(&plugins_dir).map_err(|e| format!("读取 plugins 目录失败: {}", e))?;
        for entry in read_dir.flatten() {
            let entry_path = entry.path();
            if !entry_path.is_dir() {
                continue;
            }
            let dir_name = entry_path
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let matches = dir_name == id || dir_name.starts_with(&format!("{}@", id));
            if matches {
                std::fs::remove_dir_all(&entry_path)
                    .map_err(|e| format!("删除插件目录失败 {}: {}", entry_path.display(), e))?;
            }
        }
    }
    Ok(())
}

pub fn install_from_dir(app_data_dir: &Path, src_dir: &Path) -> Result<PluginManifest, String> {
    let manifest_path = src_dir.join("manifest.json");
    let manifest = parse_manifest(&manifest_path)?;

    let plugins_dir = app_data_dir.join("plugins");
    std::fs::create_dir_all(&plugins_dir).map_err(|e| format!("创建 plugins 目录失败: {}", e))?;

    let target_name = format!("{}@{}", manifest.id, manifest.version);
    let target_dir = plugins_dir.join(&target_name);

    if target_dir.exists() {
        std::fs::remove_dir_all(&target_dir).map_err(|e| format!("删除旧插件目录失败: {}", e))?;
    }
    std::fs::create_dir_all(&target_dir).map_err(|e| format!("创建插件目标目录失败: {}", e))?;

    fn copy_dir(src: &Path, dst: &Path) -> Result<(), String> {
        for entry in std::fs::read_dir(src).map_err(|e| format!("读取源目录失败: {}", e))? {
            let entry = entry.map_err(|e| format!("读取条目失败: {}", e))?;
            let src_path = entry.path();
            let dst_path = dst.join(entry.file_name());
            if src_path.is_dir() {
                std::fs::create_dir_all(&dst_path).map_err(|e| format!("创建子目录失败: {}", e))?;
                copy_dir(&src_path, &dst_path)?;
            } else {
                std::fs::copy(&src_path, &dst_path).map_err(|e| {
                    format!(
                        "复制文件失败 {} → {}: {}",
                        src_path.display(),
                        dst_path.display(),
                        e
                    )
                })?;
            }
        }
        Ok(())
    }
    copy_dir(src_dir, &target_dir)?;

    let mut items = load_store(app_data_dir).unwrap_or_default();
    let now = now_ms();
    let granted = manifest.permissions.clone();
    let store_item = PluginStoreItem {
        id: manifest.id.clone(),
        version: manifest.version.clone(),
        enabled: true,
        install_time_ms: now,
        last_load_time_ms: now,
        granted_permissions: granted,
        config: serde_json::Value::Object(serde_json::Map::new()),
        load_error: None,
    };
    if let Some(pos) = items.iter().position(|x| x.id == store_item.id) {
        items[pos] = store_item;
    } else {
        items.push(store_item);
    }
    save_store(app_data_dir, &items)?;

    Ok(manifest)
}

pub fn enable_disable(app_data_dir: &Path, id: &str, enabled: bool) -> Result<(), String> {
    let mut items = load_store(app_data_dir).unwrap_or_default();
    let now = now_ms();
    let mut found = false;
    for item in items.iter_mut() {
        if item.id == id {
            item.enabled = enabled;
            item.last_load_time_ms = now;
            found = true;
            break;
        }
    }
    if !found {
        items.push(PluginStoreItem {
            id: id.to_string(),
            version: "0.0.0".to_string(),
            enabled,
            install_time_ms: now,
            last_load_time_ms: now,
            granted_permissions: vec![],
            config: serde_json::Value::Object(serde_json::Map::new()),
            load_error: None,
        });
    }
    save_store(app_data_dir, &items)
}
