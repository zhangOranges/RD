//! 路径缓存：记录每个「主机 ID + 标签 ID」上次访问的远程目录，
//! 便于下次打开时恢复位置。P0 阶段 tab_id 固定为 "default"。
//!
//! 存储文件：`{base_dir}/path_cache.json`
//! 结构：`{ "host_id:tab_id": "/abs/path", ... }`

use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub type PathCache = HashMap<String, String>;

fn cache_file(base_dir: &Path) -> PathBuf {
    base_dir.join("path_cache.json")
}

fn make_key(host_id: &str, tab_id: &str) -> String {
    format!("{}:{}", host_id, tab_id)
}

/// 读取某个主机 + 标签的缓存路径。键不存在返回 `Ok(None)`。
pub fn get_path(base_dir: &Path, host_id: &str, tab_id: &str) -> anyhow::Result<Option<String>> {
    let cache = read_cache(base_dir)?;
    Ok(cache.get(&make_key(host_id, tab_id)).cloned())
}

/// 写入 / 覆盖某个主机 + 标签的缓存路径。
pub fn set_path(base_dir: &Path, host_id: &str, tab_id: &str, path: &str) -> anyhow::Result<()> {
    let mut cache = read_cache(base_dir)?;
    cache.insert(make_key(host_id, tab_id), path.to_string());
    write_cache(base_dir, &cache)
}

/// 删除某主机下所有标签的缓存路径（用于删除主机时级联清理）。
pub fn delete_host_paths(base_dir: &Path, host_id: &str) -> anyhow::Result<()> {
    let mut cache = read_cache(base_dir)?;
    let prefix = format!("{}:", host_id);
    let before = cache.len();
    cache.retain(|k, _| !k.starts_with(&prefix));
    if cache.len() == before {
        return Ok(()); // 没有命中，幂等返回
    }
    write_cache(base_dir, &cache)
}

fn read_cache(base_dir: &Path) -> anyhow::Result<PathCache> {
    let path = cache_file(base_dir);
    if !path.exists() {
        return Ok(PathCache::new());
    }
    let data = std::fs::read_to_string(&path)?;
    if data.trim().is_empty() {
        return Ok(PathCache::new());
    }
    let cache: PathCache = serde_json::from_str(&data)?;
    Ok(cache)
}

fn write_cache(base_dir: &Path, cache: &PathCache) -> anyhow::Result<()> {
    let path = cache_file(base_dir);
    let data = serde_json::to_string_pretty(cache)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}
