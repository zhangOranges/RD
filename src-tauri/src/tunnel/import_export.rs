use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::model::TunnelRuleDto;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RdTunnelsFile {
    #[serde(rename = "$schema")]
    pub schema: String,
    pub spec_version: String,
    pub export_time: i64,
    pub exported_by: String,
    pub rules: Vec<TunnelRuleDto>,
}

pub fn export_rules(rules: Vec<TunnelRuleDto>) -> RdTunnelsFile {
    RdTunnelsFile {
        schema: "https://rd-app.dev/schemas/tunnels-v1.json".to_string(),
        spec_version: "1.0".to_string(),
        export_time: Utc::now().timestamp_millis(),
        exported_by: "rd-app 0.1.94".to_string(),
        rules,
    }
}

fn random_suffix() -> String {
    let now_ms = Utc::now().timestamp_millis();
    format!("{}", now_ms % 100000)
}

pub fn import_rules(
    existing_rules: &[TunnelRuleDto],
    imported: Vec<TunnelRuleDto>,
    on_conflict: &str,
) -> Vec<TunnelRuleDto> {
    let mut result: Vec<TunnelRuleDto> = existing_rules.to_vec();

    for rule in imported {
        let existing_idx = result.iter().position(|r| r.id == rule.id);

        match (existing_idx, on_conflict) {
            (Some(_), "skip") => continue,
            (Some(idx), "overwrite") => {
                result[idx] = rule;
            }
            (Some(_), "rename") => {
                let suffix = random_suffix();
                let mut renamed = rule;
                renamed.id = format!("{}_{}", renamed.id, suffix);
                if let Some(c) = renamed.comment.as_mut() {
                    c.push_str(" (冲突重命名)");
                } else {
                    renamed.comment = Some("(冲突重命名)".to_string());
                }
                result.push(renamed);
            }
            (None, _) => {
                result.push(rule);
            }
            (Some(_), _) => continue,
        }
    }

    result
}
