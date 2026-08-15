use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Serialize, Deserialize, Clone)]
pub struct PluginStoreItem {
    pub id: String,
    pub version: String,
    pub enabled: bool,
    pub install_time_ms: i64,
    pub last_load_time_ms: i64,
    pub granted_permissions: Vec<String>,
    pub config: serde_json::Value,
    pub load_error: Option<String>,
}

const STORE_FILE: &str = "plugin-state.json";

pub fn load_store(app_data_dir: &Path) -> Result<Vec<PluginStoreItem>, String> {
    let path = app_data_dir.join(STORE_FILE);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取 plugin-state.json 失败: {}", e))?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&content).map_err(|e| format!("解析 plugin-state.json 失败: {}", e))
}

pub fn save_store(app_data_dir: &Path, items: &[PluginStoreItem]) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| format!("创建数据目录失败: {}", e))?;
    let path = app_data_dir.join(STORE_FILE);
    let json = serde_json::to_string_pretty(items)
        .map_err(|e| format!("序列化 plugin-state.json 失败: {}", e))?;
    std::fs::write(&path, json).map_err(|e| format!("写入 plugin-state.json 失败: {}", e))
}
