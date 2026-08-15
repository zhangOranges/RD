pub mod forward;
pub mod import_export;
pub mod model;
pub mod status;

pub use model::{TunnelErrorCode, TunnelRuleDto, TunnelStatusDto};
pub use status::{new_state, RunningTunnel, TunnelState};

use chrono::Utc;
use tauri::{Emitter, Manager};

use crate::debug_log;
use crate::plugin::PluginState;
use crate::ssh::SshState;
use crate::LogLevel;

fn rules_path(app_data_dir: &std::path::Path) -> std::path::PathBuf {
    let dir = app_data_dir
        .join("plugin-data")
        .join("rd-native:port-forward");
    let _ = std::fs::create_dir_all(&dir);
    dir.join("rules.json")
}

fn load_rules(path: &std::path::Path) -> Result<Vec<TunnelRuleDto>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let s = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&s).map_err(|e| e.to_string())
}

fn save_rules(path: &std::path::Path, rules: &[TunnelRuleDto]) -> Result<(), String> {
    let s = serde_json::to_string_pretty(rules).map_err(|e| e.to_string())?;
    std::fs::write(path, s).map_err(|e| e.to_string())
}

fn resolve_app_data_dir(
    app: Option<&tauri::AppHandle>,
    state: Option<&tauri::State<'_, PluginState>>,
) -> Result<std::path::PathBuf, String> {
    if let Some(app_handle) = app {
        return app_handle
            .path()
            .app_data_dir()
            .map_err(|e| format!("无法获取数据目录: {}", e));
    }
    if let Some(_s) = state {
        let dir = dirs::data_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("ssh-sftp-finder");
        return Ok(dir);
    }
    Err("无法获取 app data dir".to_string())
}

async fn host_exists(ssh_state: &tauri::State<'_, SshState>, host_id: &str) -> bool {
    ssh_state.get_connection(host_id).await.is_ok()
}

pub fn validate_rule_impl(
    rule: &TunnelRuleDto,
    confirm_listen_all: bool,
    allow_remote: bool,
    host_exists: bool,
    running_ports: &[(String, u16)],
) -> Result<(), (TunnelErrorCode, String)> {
    if rule.local_port < 1 || (rule.local_port as u32) > 65535 {
        return Err((
            TunnelErrorCode::PortInvalid,
            format!("local port {} out of range 1-65535", rule.local_port),
        ));
    }

    if rule.local_addr.is_empty()
        || !rule
            .local_addr
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == ':' || c == '-')
    {
        return Err((
            TunnelErrorCode::AddrInvalid,
            format!("invalid local address {}", rule.local_addr),
        ));
    }

    let ip_check = rule.local_addr.parse::<std::net::IpAddr>();
    if ip_check.is_err() {
        let looks_like_ip = rule
            .local_addr
            .chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == ':' || c.is_ascii_hexdigit());
        if looks_like_ip
            && rule
                .local_addr
                .find(|c: char| c.is_ascii_alphabetic())
                .is_none()
        {
            return Err((
                TunnelErrorCode::AddrInvalid,
                format!("invalid local address {}", rule.local_addr),
            ));
        }
    }

    if (rule.local_addr == "0.0.0.0" || rule.local_addr == "::") && !confirm_listen_all {
        return Err((
            TunnelErrorCode::ListenOnAllNeedsConfirm,
            "listening on all interfaces (0.0.0.0/::) requires explicit confirmation".into(),
        ));
    }

    match rule.mode.as_str() {
        "local" | "remote" => {
            let ra = rule.remote_addr.as_deref().unwrap_or("");
            if ra.is_empty() {
                return Err((
                    TunnelErrorCode::AddrInvalid,
                    format!("{} mode requires remote_addr", rule.mode),
                ));
            }
            let rp = rule.remote_port.unwrap_or(0);
            if rp < 1 || (rp as u32) > 65535 {
                return Err((
                    TunnelErrorCode::PortInvalid,
                    format!("remote port {} out of range 1-65535", rp),
                ));
            }
        }
        _ => {}
    }

    if rule.mode == "dynamic" && (rule.remote_addr.is_some() || rule.remote_port.is_some()) {
        return Err((
            TunnelErrorCode::AddrInvalid,
            "dynamic mode must not specify remote addr/port".into(),
        ));
    }

    if !host_exists {
        return Err((
            TunnelErrorCode::HostNotAvailable,
            format!("host_id {} does not exist or is disconnected", rule.host_id),
        ));
    }

    if rule.mode == "remote" && !allow_remote {
        return Err((
            TunnelErrorCode::RemoteForbidden,
            "remote forwarding disabled by global switch".into(),
        ));
    }

    if running_ports
        .iter()
        .any(|(a, p)| a == &rule.local_addr && *p == rule.local_port)
    {
        return Err((
            TunnelErrorCode::PortInUse,
            format!(
                "port {} on {} already in use for this host",
                rule.local_port, rule.local_addr
            ),
        ));
    }

    Ok(())
}

fn format_validate_err(code: TunnelErrorCode, msg: String) -> String {
    format!("{}: {}", code, msg)
}

// ===== commands =====

#[tauri::command]
pub async fn tunnel_list_rules(
    host_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
) -> Result<Vec<TunnelRuleDto>, String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let rules = load_rules(&rules_path(&dir))?;
    Ok(match host_id {
        Some(id) => rules.into_iter().filter(|r| r.host_id == id).collect(),
        None => rules,
    })
}

#[tauri::command]
pub async fn tunnel_add_rule(
    rule: TunnelRuleDto,
    confirm_listen_all: Option<bool>,
    allow_remote: Option<bool>,
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    ssh_state: tauri::State<'_, SshState>,
) -> Result<TunnelRuleDto, String> {
    let host_ok = host_exists(&ssh_state, &rule.host_id).await;

    let tunnel_state = app.state::<TunnelState>();
    let running_ports: Vec<(String, u16)> = {
        let running = tunnel_state.running.lock().await;
        running
            .values()
            .filter(|t| t.host_id == rule.host_id)
            .map(|t| (t.local_addr.clone(), t.local_port))
            .collect()
    };

    if let Err((code, msg)) = validate_rule_impl(
        &rule,
        confirm_listen_all.unwrap_or(false),
        allow_remote.unwrap_or(false),
        host_ok,
        &running_ports,
    ) {
        return Err(format_validate_err(code, msg));
    }

    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let path = rules_path(&dir);
    let mut rules = load_rules(&path)?;

    if rules.iter().any(|r| r.id == rule.id) {
        return Err(format!(
            "{}: rule id {} already exists",
            TunnelErrorCode::PermissionDenied,
            rule.id
        ));
    }

    rules.push(rule.clone());
    save_rules(&path, &rules)?;

    debug_log(
        &app,
        LogLevel::Info,
        &format!("tunnel_add_rule: id={}, host={}", rule.id, rule.host_id),
    );
    Ok(rule)
}

#[tauri::command]
pub async fn tunnel_remove_rule(
    rule_id: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    tunnel_state: tauri::State<'_, TunnelState>,
) -> Result<(), String> {
    {
        let mut running = tunnel_state.running.lock().await;
        if let Some(t) = running.remove(&rule_id) {
            t.abort.abort();
        }
    }

    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let path = rules_path(&dir);
    let mut rules = load_rules(&path)?;
    let before = rules.len();
    rules.retain(|r| r.id != rule_id);
    if rules.len() == before {
        return Err(format!(
            "{}: rule id {} not found",
            TunnelErrorCode::RuleNotFound,
            rule_id
        ));
    }
    save_rules(&path, &rules)?;

    let _ = app.emit(
        "tunnel:stop",
        serde_json::json!({ "tunnelId": rule_id, "reason": "removed" }),
    );

    debug_log(
        &app,
        LogLevel::Info,
        &format!("tunnel_remove_rule: id={}", rule_id),
    );
    Ok(())
}

#[tauri::command]
pub async fn tunnel_update_rule(
    rule: TunnelRuleDto,
    confirm_listen_all: Option<bool>,
    allow_remote: Option<bool>,
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    ssh_state: tauri::State<'_, SshState>,
) -> Result<TunnelRuleDto, String> {
    let host_ok = host_exists(&ssh_state, &rule.host_id).await;

    let tunnel_state = app.state::<TunnelState>();
    let running_ports: Vec<(String, u16)> = {
        let running = tunnel_state.running.lock().await;
        running
            .values()
            .filter(|t| t.host_id == rule.host_id && t.rule_id != rule.id)
            .map(|t| (t.local_addr.clone(), t.local_port))
            .collect()
    };

    if let Err((code, msg)) = validate_rule_impl(
        &rule,
        confirm_listen_all.unwrap_or(false),
        allow_remote.unwrap_or(false),
        host_ok,
        &running_ports,
    ) {
        return Err(format_validate_err(code, msg));
    }

    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let path = rules_path(&dir);
    let mut rules = load_rules(&path)?;

    let idx = rules.iter().position(|r| r.id == rule.id).ok_or_else(|| {
        format!(
            "{}: rule id {} not found",
            TunnelErrorCode::RuleNotFound,
            rule.id
        )
    })?;

    rules[idx] = rule.clone();
    save_rules(&path, &rules)?;

    debug_log(
        &app,
        LogLevel::Info,
        &format!("tunnel_update_rule: id={}", rule.id),
    );
    Ok(rule)
}

#[tauri::command]
pub async fn tunnel_start(
    rule_id: String,
    confirm_listen_all: Option<bool>,
    allow_remote: Option<bool>,
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    ssh_state: tauri::State<'_, SshState>,
    tunnel_state: tauri::State<'_, TunnelState>,
) -> Result<TunnelStatusDto, String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let rules = load_rules(&rules_path(&dir))?;
    let rule = rules
        .iter()
        .find(|r| r.id == rule_id)
        .ok_or_else(|| {
            format!(
                "{}: rule id {} not found",
                TunnelErrorCode::RuleNotFound,
                rule_id
            )
        })?
        .clone();

    {
        let running = tunnel_state.running.lock().await;
        if let Some(t) = running.get(&rule_id) {
            return Ok(TunnelStatusDto {
                tunnel_id: rule_id,
                running: true,
                pid: None,
                error: None,
                bound_host_id: Some(t.host_id.clone()),
                accepted_conns: t.accepted_conns,
                start_time_ms: Some(t.start_time_ms),
            });
        }
    }

    let host_ok = host_exists(&ssh_state, &rule.host_id).await;

    let running_ports: Vec<(String, u16)> = {
        let running = tunnel_state.running.lock().await;
        running
            .values()
            .filter(|t| t.host_id == rule.host_id)
            .map(|t| (t.local_addr.clone(), t.local_port))
            .collect()
    };

    if let Err((code, msg)) = validate_rule_impl(
        &rule,
        confirm_listen_all.unwrap_or(false),
        allow_remote.unwrap_or(false),
        host_ok,
        &running_ports,
    ) {
        return Err(format_validate_err(code, msg));
    }

    let ssh_handle = ssh_state
        .get_connection(&rule.host_id)
        .await
        .map_err(|e| format!("{}: {}", TunnelErrorCode::HostNotAvailable, String::from(e)))?;

    let rule_clone = rule.clone();
    let handle_clone = ssh_handle;

    let abortable = async move {
        let mode = rule_clone.mode.clone();
        let la = rule_clone.local_addr.clone();
        let lp = rule_clone.local_port;
        let ra = rule_clone.remote_addr.clone();
        let rp = rule_clone.remote_port;

        let result: Result<(), (TunnelErrorCode, String)> = match mode.as_str() {
            "local" => {
                let ra_str = ra.unwrap_or_default();
                let rp_int = rp.unwrap_or(0);
                forward::run_local_forward(handle_clone, la, lp, ra_str, rp_int).await
            }
            "remote" => {
                let ra_str = ra.unwrap_or_default();
                let rp_int = rp.unwrap_or(0);
                forward::run_remote_forward(handle_clone, ra_str, rp_int, la, lp).await
            }
            "dynamic" => forward::run_dynamic_forward(handle_clone, la, lp).await,
            _ => Err((
                TunnelErrorCode::PermissionDenied,
                format!("unknown mode {}", mode),
            )),
        };

        if let Err((code, msg)) = result {
            eprintln!("[tunnel] forward error: {:?}: {}", code, msg);
        }
    };

    let join_handle = tokio::spawn(abortable);
    let abort_handle = join_handle.abort_handle();
    let start_time = Utc::now().timestamp_millis();

    let listen_check = forward::bind_listener_only(rule.local_addr.clone(), rule.local_port).await;
    match listen_check {
        Ok(listener) => {
            drop(listener);
        }
        Err((code, msg)) => {
            abort_handle.abort();
            return Err(format_validate_err(code, msg));
        }
    }

    {
        let mut running = tunnel_state.running.lock().await;
        running.insert(
            rule_id.clone(),
            RunningTunnel {
                host_id: rule.host_id.clone(),
                rule_id: rule_id.clone(),
                abort: abort_handle,
                accepted_conns: 0,
                start_time_ms: start_time,
                local_addr: rule.local_addr.clone(),
                local_port: rule.local_port,
            },
        );
    }

    let _ = app.emit(
        "tunnel:start",
        serde_json::json!({
            "tunnelId": rule_id,
            "hostId": rule.host_id,
        }),
    );

    debug_log(
        &app,
        LogLevel::Info,
        &format!(
            "tunnel_start: id={}, mode={}, {}:{}",
            rule_id, rule.mode, rule.local_addr, rule.local_port
        ),
    );

    Ok(TunnelStatusDto {
        tunnel_id: rule_id,
        running: true,
        pid: None,
        error: None,
        bound_host_id: Some(rule.host_id),
        accepted_conns: 0,
        start_time_ms: Some(start_time),
    })
}

#[tauri::command]
pub async fn tunnel_stop(
    rule_id: String,
    reason: Option<String>,
    app: tauri::AppHandle,
    tunnel_state: tauri::State<'_, TunnelState>,
) -> Result<(), String> {
    let removed = {
        let mut running = tunnel_state.running.lock().await;
        running.remove(&rule_id)
    };

    if let Some(t) = removed {
        t.abort.abort();
        let _ = app.emit(
            "tunnel:stop",
            serde_json::json!({
                "tunnelId": rule_id,
                "hostId": t.host_id,
                "reason": reason.unwrap_or_else(|| "manual".to_string()),
            }),
        );
        debug_log(
            &app,
            LogLevel::Info,
            &format!("tunnel_stop: id={}", rule_id),
        );
    }

    Ok(())
}

#[tauri::command]
pub async fn tunnel_list_statuses(
    host_id: Option<String>,
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
    tunnel_state: tauri::State<'_, TunnelState>,
) -> Result<Vec<TunnelStatusDto>, String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let rules = load_rules(&rules_path(&dir))?;
    let running = tunnel_state.running.lock().await;

    let mut result = Vec::new();

    for rule in &rules {
        if let Some(hid) = &host_id {
            if hid != &rule.host_id {
                continue;
            }
        }

        if let Some(t) = running.get(&rule.id) {
            result.push(TunnelStatusDto {
                tunnel_id: rule.id.clone(),
                running: true,
                pid: None,
                error: None,
                bound_host_id: Some(t.host_id.clone()),
                accepted_conns: t.accepted_conns,
                start_time_ms: Some(t.start_time_ms),
            });
        } else {
            result.push(TunnelStatusDto {
                tunnel_id: rule.id.clone(),
                running: false,
                pid: None,
                error: None,
                bound_host_id: None,
                accepted_conns: 0,
                start_time_ms: None,
            });
        }
    }

    Ok(result)
}

#[tauri::command]
pub async fn tunnel_stop_all_for_host(
    host_id: String,
    reason: String,
    app: tauri::AppHandle,
    tunnel_state: tauri::State<'_, TunnelState>,
) -> Result<Vec<String>, String> {
    let mut stopped_ids = Vec::new();

    {
        let mut running = tunnel_state.running.lock().await;
        let host_tunnels: Vec<String> = running
            .values()
            .filter(|t| t.host_id == host_id)
            .map(|t| t.rule_id.clone())
            .collect();

        for tid in host_tunnels {
            if let Some(t) = running.remove(&tid) {
                t.abort.abort();
                stopped_ids.push(tid);
            }
        }
    }

    for tid in &stopped_ids {
        let _ = app.emit(
            "tunnel:stop",
            serde_json::json!({
                "tunnelId": tid,
                "hostId": host_id,
                "reason": reason,
            }),
        );
    }

    debug_log(
        &app,
        LogLevel::Info,
        &format!(
            "tunnel_stop_all_for_host: host={}, count={}, reason={}",
            host_id,
            stopped_ids.len(),
            reason
        ),
    );

    Ok(stopped_ids)
}

#[tauri::command]
pub async fn tunnel_export_rules(
    rule_ids: Option<Vec<String>>,
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
) -> Result<String, String> {
    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let rules = load_rules(&rules_path(&dir))?;

    let filtered: Vec<TunnelRuleDto> = match rule_ids {
        Some(ids) => rules.into_iter().filter(|r| ids.contains(&r.id)).collect(),
        None => rules,
    };

    let file = import_export::export_rules(filtered);
    serde_json::to_string_pretty(&file).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnel_import_rules(
    json_content: String,
    on_conflict: String,
    app: tauri::AppHandle,
    state: tauri::State<'_, PluginState>,
) -> Result<Vec<TunnelRuleDto>, String> {
    let conflict_mode = match on_conflict.as_str() {
        "skip" | "overwrite" | "rename" => on_conflict.as_str(),
        _ => "skip",
    };

    let file: import_export::RdTunnelsFile =
        serde_json::from_str(&json_content).map_err(|e| format!("IMPORT_PARSE_FAILED: {}", e))?;

    let dir = resolve_app_data_dir(Some(&app), Some(&state))?;
    let path = rules_path(&dir);
    let existing = load_rules(&path)?;

    let merged = import_export::import_rules(&existing, file.rules, conflict_mode);
    save_rules(&path, &merged)?;

    debug_log(
        &app,
        LogLevel::Info,
        &format!(
            "tunnel_import_rules: count={}, conflict={}",
            merged.len(),
            conflict_mode
        ),
    );

    Ok(merged)
}
