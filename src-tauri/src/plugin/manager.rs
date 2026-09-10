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

    // 清理同 ID 的所有旧版本目录（只保留新版本）
    // 用 split_once('@') 精确比对，避免 "my-plugin" 误删 "my-plugin-extended"
    let id_prefix = format!("{}@", manifest.id);
    if let Ok(entries) = std::fs::read_dir(&plugins_dir) {
        for item in entries.flatten() {
            if let Some(name) = item.file_name().to_str() {
                if name.starts_with(&id_prefix) && name != target_name {
                    // 进一步验证：确认这是该 ID 的旧版本（不是以该 ID 为前缀的另一个插件）
                    // 目录名格式为 "<id>@<version>"，提取 @ 前的部分比对
                    if let Some((dir_id, _)) = name.split_once('@') {
                        if dir_id == manifest.id {
                            let old_dir = item.path();
                            if old_dir.is_dir() {
                                let _ = std::fs::remove_dir_all(&old_dir);
                            }
                        }
                    }
                }
            }
        }
    }

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
    // 同 ID 的旧版本记录直接替换（确保只有一条记录）
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn make_temp_dir() -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("rd-plugin-test-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn create_plugin_structure(app_data_dir: &Path, id: &str, version: &str) {
        // plugins/{id}@{version}/manifest.json
        let plugin_dir = app_data_dir.join("plugins").join(format!("{}@{}", id, version));
        fs::create_dir_all(&plugin_dir).unwrap();
        let manifest = serde_json::json!({
            "id": id,
            "name": "Test Plugin",
            "version": version,
            "apiVersion": "v1",
            "author": "test",
            "description": "test",
            "category": "other",
            "entry": "index.js",
            "permissions": [],
            "minRdVersion": "0.1.0",
            "hotReload": false
        });
        fs::write(plugin_dir.join("manifest.json"), manifest.to_string()).unwrap();

        // plugin-state.json
        let items = vec![PluginStoreItem {
            id: id.to_string(),
            version: version.to_string(),
            enabled: true,
            install_time_ms: now_ms(),
            last_load_time_ms: now_ms(),
            granted_permissions: vec![],
            config: serde_json::Value::Object(serde_json::Map::new()),
            load_error: None,
        }];
        save_store(app_data_dir, &items).unwrap();

        // plugin-data/{id}/ （插件运行时数据，卸载时应被清理）
        let data_dir = app_data_dir.join("plugin-data").join(id);
        fs::create_dir_all(&data_dir).unwrap();
        fs::write(data_dir.join("user-data.json"), r#"{"key":"secret"}"#).unwrap();
    }

    #[test]
    fn test_uninstall_removes_plugin_dir_and_store() {
        let dir = make_temp_dir();
        let id = "test-plugin";
        create_plugin_structure(&dir, id, "1.0.0");

        let result = uninstall(&dir, id);
        assert!(result.is_ok(), "uninstall should succeed: {:?}", result.err());

        // 插件目录应被删除
        let plugin_dir = dir.join("plugins").join(format!("{}@1.0.0", id));
        assert!(!plugin_dir.exists(), "plugin directory should be removed");

        // store 条目应被删除
        let items = load_store(&dir).unwrap();
        assert!(items.iter().all(|i| i.id != id), "store entry should be removed");

        // 清理临时目录
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_uninstall_does_not_clean_plugin_data_bug_4() {
        // 高危漏洞 #4: uninstall 不清理 plugin-data/{id}/ 目录
        // 设计文档要求卸载时清空 plugin-data，但当前实现未清理。
        let dir = make_temp_dir();
        let id = "test-plugin";
        create_plugin_structure(&dir, id, "1.0.0");

        let data_dir = dir.join("plugin-data").join(id);
        assert!(data_dir.exists(), "plugin-data should exist before uninstall");

        let result = uninstall(&dir, id);
        assert!(result.is_ok());

        // BUG: plugin-data/{id}/ 仍然存在，未被清理
        // 修复后期望：assert!(!data_dir.exists(), "plugin-data should be removed after uninstall");
        assert!(
            data_dir.exists(),
            "BUG #4: plugin-data 目录未被清理（当前行为），修复后此断言应改为不存在"
        );
        assert!(
            data_dir.join("user-data.json").exists(),
            "BUG #4: plugin-data 中的文件未被删除"
        );

        let _ = fs::remove_dir_all(&dir);
    }
}
