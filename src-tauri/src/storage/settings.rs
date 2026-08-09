//! 设置存储：通用 key-value 字符串形式，前端自行解析具体值类型。
//!
//! 存储文件：`{base_dir}/settings.json`
//! 结构：`{ "key": "value", ... }`
//!
//! P0 已知设置项：
//! - `remember_dir_global`：是否全局启用路径记忆，"true"/"false"，默认 "true"。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub type Settings = HashMap<String, String>;

fn settings_file(base_dir: &Path) -> PathBuf {
    base_dir.join("settings.json")
}

/// 读取某项设置。键不存在时返回该键的默认值（无默认值则为空字符串）。
pub fn get_setting(base_dir: &Path, key: &str) -> anyhow::Result<String> {
    let settings = read_settings(base_dir)?;
    Ok(settings
        .get(key)
        .cloned()
        .unwrap_or_else(|| default_value(key)))
}

/// 写入 / 覆盖某项设置。
pub fn set_setting(base_dir: &Path, key: &str, value: &str) -> anyhow::Result<()> {
    let mut settings = read_settings(base_dir)?;
    settings.insert(key.to_string(), value.to_string());
    write_settings(base_dir, &settings)
}

fn default_value(key: &str) -> String {
    match key {
        "remember_dir_global" => "true".to_string(),
        _ => String::new(),
    }
}

fn read_settings(base_dir: &Path) -> anyhow::Result<Settings> {
    let path = settings_file(base_dir);
    if !path.exists() {
        return Ok(Settings::new());
    }
    let data = std::fs::read_to_string(&path)?;
    if data.trim().is_empty() {
        return Ok(Settings::new());
    }
    let settings: Settings = serde_json::from_str(&data)?;
    Ok(settings)
}

fn write_settings(base_dir: &Path, settings: &Settings) -> anyhow::Result<()> {
    let path = settings_file(base_dir);
    let data = serde_json::to_string_pretty(settings)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}
