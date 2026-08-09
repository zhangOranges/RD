use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// 主机配置（非敏感，与前端及 SSH 模块共享）。
///
/// 注意：本结构体不包含密码 / 私钥等敏感字段，敏感凭据请使用
/// `credentials` 模块通过系统密钥链存储。
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub struct HostConfig {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// 认证类型："password" | "key"
    pub auth_type: String,
    /// 是否为该主机的路径缓存开启记忆
    pub remember_dir: bool,
    /// 备注
    pub remark: String,
    /// 所属分类 id，默认 "default"
    #[serde(default = "default_category_id")]
    pub category_id: String,
    /// 路径记忆专用唯一 ID：新加主机 / 复制主机时自动生成新 ID，
    /// 编辑主机时保留不变。用于确保复制出来的主机拥有独立的路径缓存键，
    /// 即便两台指向同一物理机也不会串扰记住的目录。
    /// （空字符串时在读写 path_cache 时回退到 host.id，兼容旧数据。）
    #[serde(default)]
    pub path_cache_id: String,
}

fn default_category_id() -> String {
    "default".to_string()
}

/// 生成一个不依赖第三方 crate 的唯一 ID：
/// 时间戳（纳秒 since epoch，十六进制） + 原子计数器（十六进制）。
pub fn gen_path_cache_id() -> String {
    static CNT: AtomicU32 = AtomicU32::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let c = CNT.fetch_add(1, Ordering::Relaxed);
    format!("pc_{:x}_{:x}", nanos, c)
}

fn hosts_file(base_dir: &Path) -> PathBuf {
    base_dir.join("hosts.json")
}

/// 读取全部主机配置。文件不存在或为空时返回空集合，不报错。
pub fn list_hosts(base_dir: &Path) -> anyhow::Result<Vec<HostConfig>> {
    let path = hosts_file(base_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read_to_string(&path)?;
    if data.trim().is_empty() {
        return Ok(Vec::new());
    }
    let hosts: Vec<HostConfig> = serde_json::from_str(&data)?;
    Ok(hosts)
}

/// 按 id 查找主机配置。
pub fn get_host(base_dir: &Path, id: &str) -> anyhow::Result<Option<HostConfig>> {
    let hosts = list_hosts(base_dir)?;
    Ok(hosts.into_iter().find(|h| h.id == id))
}

/// 保存（新增或更新）一条主机配置。仅写非敏感字段，不影响凭据。
///
/// 新增主机且 `path_cache_id` 为空时，自动分配新的唯一缓存键；
/// 更新主机且传入 `path_cache_id` 为空时，保留原记录中的缓存键（不改动），
/// 从而保证「编辑时记忆目录不丢，复制/新增主机时独立。」
pub fn save_host(base_dir: &Path, host: HostConfig) -> anyhow::Result<()> {
    let mut hosts = list_hosts(base_dir)?;
    if let Some(existing) = hosts.iter_mut().find(|h| h.id == host.id) {
        // 更新：空 path_cache_id 时沿用原记录的值，否则接受传入值
        let host = if host.path_cache_id.is_empty() {
            HostConfig {
                path_cache_id: existing.path_cache_id.clone(),
                ..host
            }
        } else {
            host
        };
        *existing = host;
    } else {
        // 新增：空 path_cache_id 时生成一个全新的唯一键，确保复制的主机也能独立
        let host = if host.path_cache_id.is_empty() {
            HostConfig {
                path_cache_id: gen_path_cache_id(),
                ..host
            }
        } else {
            host
        };
        hosts.push(host);
    }
    write_hosts(base_dir, &hosts)
}

/// 按 id 删除主机配置（不删凭据 / 路径缓存，由调用方负责级联）。
pub fn delete_host(base_dir: &Path, id: &str) -> anyhow::Result<()> {
    let mut hosts = list_hosts(base_dir)?;
    let before = hosts.len();
    hosts.retain(|h| h.id != id);
    if hosts.len() == before {
        // 没有 match 项也算成功，保持幂等
        return Ok(());
    }
    write_hosts(base_dir, &hosts)
}

fn write_hosts(base_dir: &Path, hosts: &[HostConfig]) -> anyhow::Result<()> {
    let path = hosts_file(base_dir);
    let data = serde_json::to_string_pretty(hosts)?;
    // 先写临时文件再重命名，降低写一半崩掉导致文件损坏的概率
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}
