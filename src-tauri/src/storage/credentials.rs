//! 凭据存储：文件-based 方案（base64 编码，非明文）。
//!
//! 文件存储路径：{base_dir}/credentials.json
//! cred_type 取值 "password" 或 "private_key"。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::Engine;

fn validate_cred_type(cred_type: &str) -> anyhow::Result<()> {
    match cred_type {
        "password" | "private_key" => Ok(()),
        other => Err(anyhow::anyhow!(
            "invalid cred_type: {} (expected \"password\" or \"private_key\")",
            other
        )),
    }
}

fn cred_file_path(base_dir: &Path) -> PathBuf {
    base_dir.join("credentials.json")
}

fn read_file_store(base_dir: &Path) -> HashMap<String, String> {
    let path = cred_file_path(base_dir);
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn write_file_store(base_dir: &Path, store: &HashMap<String, String>) -> anyhow::Result<()> {
    let path = cred_file_path(base_dir);
    let content = serde_json::to_string_pretty(store)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, content)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn file_key(host_id: &str, cred_type: &str) -> String {
    format!("{}:{}", host_id, cred_type)
}

fn base_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("ssh-sftp-finder")
}

/// 写入 / 覆盖一条凭据。
pub fn save_credential(host_id: &str, cred_type: &str, value: &str) -> anyhow::Result<()> {
    validate_cred_type(cred_type)?;
    let dir = base_dir();
    std::fs::create_dir_all(&dir)?;
    let mut store = read_file_store(&dir);
    let encoded = Engine::encode(&base64::engine::general_purpose::STANDARD, value);
    store.insert(file_key(host_id, cred_type), encoded);
    write_file_store(&dir, &store)?;
    eprintln!("[credentials] saved {}:{}", host_id, cred_type);
    Ok(())
}

/// 读取一条凭据。条目不存在时返回 `Ok(None)`。
pub fn get_credential(host_id: &str, cred_type: &str) -> anyhow::Result<Option<String>> {
    validate_cred_type(cred_type)?;
    let dir = base_dir();
    let store = read_file_store(&dir);
    match store.get(&file_key(host_id, cred_type)) {
        Some(encoded) => {
            let decoded = Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
                .map_err(|e| anyhow::anyhow!("base64 decode failed: {}", e))?;
            eprintln!("[credentials] found {}:{}", host_id, cred_type);
            Ok(Some(String::from_utf8(decoded)?))
        }
        None => {
            eprintln!("[credentials] NOT found {}:{}", host_id, cred_type);
            Ok(None)
        }
    }
}

/// 删除一条凭据。条目不存在视为成功（幂等）。
pub fn delete_credential(host_id: &str, cred_type: &str) -> anyhow::Result<()> {
    validate_cred_type(cred_type)?;
    let dir = base_dir();
    let mut store = read_file_store(&dir);
    store.remove(&file_key(host_id, cred_type));
    write_file_store(&dir, &store)?;
    Ok(())
}
