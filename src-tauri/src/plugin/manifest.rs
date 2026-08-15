use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: String,
    pub author: String,
    pub description: String,
    pub category: String,
    pub entry: String,
    pub index_html: Option<String>,
    pub config_schema: Option<String>,
    pub icon: Option<String>,
    pub permissions: Vec<String>,
    pub conflict: Option<Vec<String>>,
    pub requires: Option<Vec<String>>,
    pub min_rd_version: String,
    pub hot_reload: bool,
}

const VALID_CATEGORIES: &[&str] = &[
    "connection",
    "command",
    "file",
    "terminal",
    "monitor",
    "notify",
    "tunnel",
    "other",
];

fn is_kebab_case(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn is_semver_format(s: &str) -> bool {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    parts
        .iter()
        .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

pub fn validate_manifest(m: &PluginManifest) -> Result<(), String> {
    if !is_kebab_case(&m.id) {
        return Err(format!("id 必须是非空 kebab-case 格式 (a-z0-9-): {}", m.id));
    }
    if !is_semver_format(&m.version) {
        return Err(format!("version 必须是 semver 格式 (x.y.z): {}", m.version));
    }
    if m.api_version != "v1" {
        return Err(format!("api_version 必须等于 \"v1\": {}", m.api_version));
    }
    if !VALID_CATEGORIES.contains(&m.category.as_str()) {
        return Err(format!(
            "category 必须是以下之一: {:?}, 实际: {}",
            VALID_CATEGORIES, m.category
        ));
    }
    if m.min_rd_version.is_empty() {
        return Err("min_rd_version 不能为空".to_string());
    }
    for perm in &m.permissions {
        if !crate::plugin::permissions::is_valid_permission(perm) {
            return Err(format!("未知权限: {}", perm));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_minimal() -> PluginManifest {
        PluginManifest {
            id: "my-plugin".to_string(),
            name: "My Plugin".to_string(),
            version: "1.0.0".to_string(),
            api_version: "v1".to_string(),
            author: "dev".to_string(),
            description: "desc".to_string(),
            category: "other".to_string(),
            entry: "index.js".to_string(),
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

    #[test]
    fn test_valid_minimal() {
        let m = make_minimal();
        assert!(validate_manifest(&m).is_ok(), "最小字段应通过校验");
    }

    #[test]
    fn test_valid_full_fields() {
        let mut m = make_minimal();
        m.id = "full-featured-plugin".to_string();
        m.index_html = Some("ui/index.html".to_string());
        m.config_schema = Some("{}".to_string());
        m.icon = Some("icon.png".to_string());
        m.permissions = vec!["network.http".to_string(), "storage.read".to_string()];
        m.conflict = Some(vec!["other-plugin".to_string()]);
        m.requires = Some(vec!["dep-plugin".to_string()]);
        m.hot_reload = true;
        assert!(validate_manifest(&m).is_ok(), "全字段应通过校验");
    }

    #[test]
    fn test_valid_high_risk_permissions() {
        let mut m = make_minimal();
        m.permissions = vec![
            "network.http".to_string(),
            "file.local.read".to_string(),
            "file.local.write".to_string(),
            "ssh.run".to_string(),
            "sftp.operate".to_string(),
            "server.manage".to_string(),
            "tunnel.manage".to_string(),
        ];
        assert!(validate_manifest(&m).is_ok(), "高危权限白名单内的应通过");
    }

    #[test]
    fn test_invalid_empty_id() {
        let mut m = make_minimal();
        m.id = String::new();
        let r = validate_manifest(&m);
        assert!(r.is_err(), "空 id 应失败");
        assert!(
            r.unwrap_err().contains("kebab-case"),
            "错误信息应提及 kebab-case"
        );
    }

    #[test]
    fn test_invalid_api_version_v2() {
        let mut m = make_minimal();
        m.api_version = "v2".to_string();
        let r = validate_manifest(&m);
        assert!(r.is_err(), "api_version=v2 应失败");
        assert!(r.unwrap_err().contains("v1"), "错误信息应提及 v1");
    }

    #[test]
    fn test_invalid_unknown_permission() {
        let mut m = make_minimal();
        m.permissions = vec!["system.root".to_string()];
        let r = validate_manifest(&m);
        assert!(r.is_err(), "未知权限应失败");
        assert!(
            r.unwrap_err().contains("system.root"),
            "错误信息应提及未知权限名"
        );
    }
}
