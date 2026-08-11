//! SSH connection management module.
//!
//! This module owns the lifecycle of all active SSH sessions:
//! - [`connect_host`] establishes a new session (password or key auth),
//!   verifies the server fingerprint (first-trust policy), and registers it
//!   in [`SshState`].
//! - [`disconnect_host`] tears a session down.
//! - [`connection_state`] reports `"connected"` / `"disconnected"` /
//!   `"connecting"` for a given host id.
//!
//! When an established session is torn down (network drop, server-side
//! disconnect, or explicit [`disconnect_host`]), the russh handler emits a
//! `ssh://disconnected` Tauri event with the `host_id` as payload.
//!
//! Future SFTP (Task 4) and PTY (Task 5) modules obtain the underlying russh
//! handle via [`SshState::get_connection`].

pub mod connection;
pub mod error;
pub mod exec;
pub mod handler;

use std::collections::HashMap;

pub use connection::{ConnectParams, ConnectResult, ConnectionHandle, SharedHandle};
pub use error::SshError;
pub use exec::{get_server_stats, ServerStats};
pub use handler::{ClientHandler, HandlerSharedState, DISCONNECTED_EVENT};

use crate::{debug_log, LogLevel};

/// Global SSH connection state, registered with Tauri via `.manage(new_state())`.
pub struct SshState {
    connections: tokio::sync::Mutex<HashMap<String, ConnectionHandle>>,
}

impl SshState {
    pub fn new() -> Self {
        Self {
            connections: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Look up an active connection and return a clone of its shared russh
    /// handle. Future SFTP / PTY modules use this to open channels on the
    /// existing session.
    pub async fn get_connection(&self, host_id: &str) -> Result<SharedHandle, SshError> {
        let map = self.connections.lock().await;
        let conn = map.get(host_id).ok_or(SshError::NotConnected)?;
        conn.get_handle().ok_or(SshError::NotConnected)
    }

    /// Return the home directory for a connected host (if known). Useful for
    /// SFTP / path-cache modules that need a default starting directory.
    pub async fn get_home_dir(&self, host_id: &str) -> Option<String> {
        let map = self.connections.lock().await;
        map.get(host_id).and_then(|c| c.home_dir.clone())
    }

    /// Return the trusted fingerprint for a connected host (if known).
    pub async fn get_fingerprint(&self, host_id: &str) -> Option<String> {
        let map = self.connections.lock().await;
        map.get(host_id).and_then(|c| c.fingerprint.clone())
    }
}

impl Default for SshState {
    fn default() -> Self {
        Self::new()
    }
}

/// Constructor used by the Tauri builder: `.manage(ssh::new_state())`.
pub fn new_state() -> SshState {
    SshState::new()
}

/// Establish an SSH connection to `params.host` and register it in state.
///
/// If a connection for `params.host_id` already exists, it is closed first
/// (one connection per host). Returns the resolved home directory and the
/// trusted server fingerprint on success.
#[tauri::command]
pub async fn connect_host(
    params: ConnectParams,
    state: tauri::State<'_, SshState>,
    app: tauri::AppHandle,
) -> Result<ConnectResult, String> {
    let host_id = params.host_id.clone();
    let host_port = format!("{}:{}", params.host, params.port);

    // Close any pre-existing connection for this host id, then insert a
    // "connecting" placeholder so `connection_state` reports "connecting".
    {
        let mut map = state.connections.lock().await;
        if let Some(old) = map.remove(&host_id) {
            // Drop old connection outside the map lock.
            drop(map);
            let _ = old.disconnect().await;
            let mut map = state.connections.lock().await;
            map.insert(
                host_id.clone(),
                ConnectionHandle::connecting(host_id.clone(), host_port.clone()),
            );
        } else {
            map.insert(
                host_id.clone(),
                ConnectionHandle::connecting(host_id.clone(), host_port.clone()),
            );
        }
    }

    // Perform the actual connect + auth (outside the map lock).
    let result = ConnectionHandle::connect(&params, Some(app.clone())).await;

    match result {
        Ok(conn) => {
            let connect_result = ConnectResult {
                home_dir: conn.home_dir.clone().unwrap_or_else(|| "~".to_string()),
                fingerprint: conn.fingerprint.clone().unwrap_or_default(),
            };
            // Arm the disconnect emitter *before* registering so we don't miss
            // a drop between insert and arm.
            conn.arm_disconnect_event();
            let mut map = state.connections.lock().await;
            map.insert(host_id, conn);
            Ok(connect_result)
        }
        Err(e) => {
            let err_str: String = e.into();
            // Remove the placeholder on failure.
            let mut map = state.connections.lock().await;
            map.remove(&host_id);
            debug_log(
                &app,
                LogLevel::Error,
                &format!("connect_host 注册失败: host_id={} {} - {}", host_id, host_port, err_str),
            );
            Err(err_str)
        }
    }
}

/// Close the SSH session for `host_id` and remove it from state.
#[tauri::command]
pub async fn disconnect_host(
    host_id: String,
    state: tauri::State<'_, SshState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    debug_log(&app, LogLevel::Info, &format!("disconnect_host: host_id={}", host_id));
    let removed = {
        let mut map = state.connections.lock().await;
        map.remove(&host_id)
    };
    if let Some(conn) = removed {
        conn.disconnect().await.map_err(|e| {
            let msg = String::from(e);
            debug_log(
                &app,
                LogLevel::Warn,
                &format!("disconnect_host 断开失败: host_id={} - {}", host_id, msg),
            );
            msg
        })?;
    }
    Ok(())
}

/// Report the current state of `host_id`: `"connected"`, `"disconnected"`,
/// or `"connecting"`.
#[tauri::command]
pub async fn connection_state(
    host_id: String,
    state: tauri::State<'_, SshState>,
) -> Result<String, String> {
    let map = state.connections.lock().await;
    match map.get(&host_id) {
        Some(conn) => {
            if conn.is_connecting() {
                // Placeholder, real handle not yet attached.
                return Ok("connecting".to_string());
            }
            // Need to release the map lock before awaiting is_connected, which
            // locks the inner handle mutex.
            let handle_clone = conn.get_handle();
            drop(map);
            match handle_clone {
                Some(h) => {
                    let guard = h.lock().await;
                    if guard.is_closed() {
                        Ok("disconnected".to_string())
                    } else {
                        Ok("connected".to_string())
                    }
                }
                None => Ok("disconnected".to_string()),
            }
        }
        None => Ok("disconnected".to_string()),
    }
}

/// Test an SSH connection without registering it in state.
///
/// Connects, authenticates, resolves the home dir, then immediately
/// disconnects. Used by the "Test Connection" button in the host dialog.
#[tauri::command]
pub async fn test_connection(
    params: ConnectParams,
) -> Result<ConnectResult, String> {
    let result = ConnectionHandle::connect(&params, None).await;
    match result {
        Ok(conn) => {
            let connect_result = ConnectResult {
                home_dir: conn.home_dir.clone().unwrap_or_else(|| "~".to_string()),
                fingerprint: conn.fingerprint.clone().unwrap_or_default(),
            };
            // Immediately disconnect — we only wanted to verify connectivity.
            conn.disconnect().await.ok();
            Ok(connect_result)
        }
        Err(e) => Err(e.into()),
    }
}
