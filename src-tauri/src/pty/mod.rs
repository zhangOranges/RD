//! PTY terminal channel module (Task 5 / Task 8 multi-tab).
//!
//! Provides on-demand PTY channels that ride on top of existing SSH sessions
//! managed by [`crate::ssh::SshState`]. Each host (`host_id`) can have multiple
//! terminal tabs, each identified by a `tab_id` and backed by an independent
//! PTY session. The session map key is `"{host_id}__{tab_id}"` (tab_id
//! defaults to `"default"` when `None`).
//!
//! ## Cwd sync — pwd sentinel
//!
//! Instead of parsing user-typed `cd` commands (fragile and insecure), the
//! shell is configured with a `PROMPT_COMMAND` that emits an OSC 7777 escape
//! sequence containing `$PWD` before every prompt. The background read loop
//! parses these sequences, strips them from the xterm output, and emits
//! `pty://cwd-changed` events so the file browser can track the real working
//! directory.
//!
//! ## Events
//!
//! | Event              | Payload                                  | When                         |
//! |--------------------|------------------------------------------|------------------------------|
//! | `pty://data`       | `{ host_id, tab_id, data: number[] }`    | PTY output (OSC stripped)    |
//! | `pty://cwd-changed`| `{ host_id, tab_id, path }`              | PROMPT_COMMAND cwd sequence  |
//! | `pty://closed`     | `{ host_id, tab_id }`                     | Channel closed / dropped     |

pub mod parser;
pub mod session;

use std::collections::HashMap;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::ssh::SshState;
use crate::{debug_log, LogLevel};
use session::PtySession;

// --- Event names -----------------------------------------------------------
pub const DATA_EVENT: &str = "pty://data";
pub const CWD_CHANGED_EVENT: &str = "pty://cwd-changed";
pub const CLOSED_EVENT: &str = "pty://closed";

// --- Event payloads --------------------------------------------------------

/// Payload for `pty://data`. `data` is raw bytes (serialized as a JSON array
/// of numbers) intended to be written directly to an xterm instance.
#[derive(Serialize, Clone)]
pub struct PtyDataPayload {
    pub host_id: String,
    pub tab_id: String,
    pub data: Vec<u8>,
}

/// Payload for `pty://cwd-changed`.
#[derive(Serialize, Clone)]
pub struct PtyCwdPayload {
    pub host_id: String,
    pub tab_id: String,
    pub path: String,
}

/// Payload for `pty://closed`.
#[derive(Serialize, Clone)]
pub struct PtyClosedPayload {
    pub host_id: String,
    pub tab_id: String,
}

// --- State -----------------------------------------------------------------

/// Global PTY session state, registered with Tauri via `.manage(new_state())`.
///
/// Holds one [`PtySession`] per `"{host_id}__{tab_id}"` key. Sessions are
/// created on demand by [`pty_open`] and torn down by [`pty_close`] (or
/// automatically when the underlying channel closes).
pub struct PtyState {
    sessions: Arc<tokio::sync::Mutex<HashMap<String, PtySession>>>,
}

impl PtyState {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
        }
    }
}

impl Default for PtyState {
    fn default() -> Self {
        Self::new()
    }
}

/// Constructor used by the Tauri builder: `.manage(pty::new_state())`.
pub fn new_state() -> PtyState {
    PtyState::new()
}

/// Build the session map key from `host_id` and an optional `tab_id`. When
/// `tab_id` is `None`, `"default"` is used so existing single-tab callers keep
/// working.
fn session_key(host_id: &str, tab_id: &Option<String>) -> String {
    format!(
        "{}__{}",
        host_id,
        tab_id.clone().unwrap_or_else(|| "default".to_string())
    )
}

// --- Tauri commands --------------------------------------------------------

/// Open a terminal (create PTY + shell) for `host_id` + `tab_id`.
///
/// Idempotent: if a live session already exists for this host+tab combo,
/// returns `Ok(false)` without creating a new one. If a stale (closed) session
/// exists, it is replaced. Returns `Ok(true)` when a new session was created,
/// `Ok(false)` when reused.
#[tauri::command]
pub async fn pty_open(
    host_id: String,
    tab_id: Option<String>,
    ssh_state: State<'_, SshState>,
    pty_state: State<'_, PtyState>,
    app: tauri::AppHandle,
) -> Result<bool, String> {
    let sessions = pty_state.sessions.clone();
    let key = session_key(&host_id, &tab_id);

    // Idempotent: a live session means nothing to do.
    {
        let map = sessions.lock().await;
        if let Some(session) = map.get(&key) {
            if !session.is_closed() {
                return Ok(false);
            }
        }
    }

    // Remove any stale (closed) session before creating a new one.
    {
        let mut map = sessions.lock().await;
        map.remove(&key);
    }

    // Obtain the shared SSH handle (locks SshState internally). SSH sessions
    // are still keyed by host_id only — multiple PTY tabs share one SSH pipe.
    let shared_handle = ssh_state
        .get_connection(&host_id)
        .await
        .map_err(|e| {
            let msg = e.to_string();
            debug_log(
                &app,
                LogLevel::Error,
                &format!("[PTY] pty_open 获取 SSH 连接失败: host_id={} - {}", host_id, msg),
            );
            msg
        })?;

    let tab_id_resolved = tab_id.unwrap_or_else(|| "default".to_string());

    // Create the PTY session: opens channel, requests PTY + shell, injects
    // PROMPT_COMMAND, spawns the background read loop.
    let session = PtySession::create(
        host_id.clone(),
        tab_id_resolved.clone(),
        shared_handle,
        app.clone(),
    )
    .await
    .map_err(|e| {
        debug_log(
            &app,
            LogLevel::Error,
            &format!("[PTY] pty_open 创建会话失败: host_id={} tab_id={} - {}", host_id, tab_id_resolved, e),
        );
        e
    })?;

    // Register in the state map.
    {
        let mut map = sessions.lock().await;
        map.insert(key, session);
    }

    Ok(true)
}

/// Close the terminal for `host_id` + `tab_id`, destroying the PTY channel.
/// Does not affect the underlying SSH connection or SFTP.
#[tauri::command]
pub async fn pty_close(
    host_id: String,
    tab_id: Option<String>,
    pty_state: State<'_, PtyState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let sessions = pty_state.sessions.clone();
    let key = session_key(&host_id, &tab_id);
    let session = {
        let mut map = sessions.lock().await;
        map.remove(&key)
    };
    if let Some(session) = session {
        debug_log(
            &app,
            LogLevel::Info,
            &format!("[PTY] pty_close: host_id={} tab_id={}", host_id, tab_id.unwrap_or_else(|| "default".to_string())),
        );
        session.shutdown().await;
    }
    Ok(())
}

/// Write user input (keystrokes) to the terminal.
#[tauri::command]
pub async fn pty_write(
    host_id: String,
    tab_id: Option<String>,
    data: Vec<u8>,
    pty_state: State<'_, PtyState>,
) -> Result<(), String> {
    let sessions = pty_state.sessions.clone();
    let key = session_key(&host_id, &tab_id);
    let map = sessions.lock().await;
    let session = map.get(&key).ok_or("terminal not open")?;
    session.write(data).map_err(|e| e.to_string())
}

/// Sync-switch the terminal's working directory (file browser → terminal).
///
/// 命令以空格开头（配合 HISTCONTROL=ignorespace），cd 后 clear 清屏，
/// 这样 cd 命令不会出现在终端和 history 中。
/// After the shell processes it, PROMPT_COMMAND fires and emits
/// `pty://cwd-changed` with the real path.
#[tauri::command]
pub async fn pty_cd(
    host_id: String,
    tab_id: Option<String>,
    path: String,
    pty_state: State<'_, PtyState>,
) -> Result<(), String> {
    let sessions = pty_state.sessions.clone();
    let key = session_key(&host_id, &tab_id);
    let escaped = session::shell_escape_single(&path);
    // 前导空格 + HISTCONTROL=ignorespace → 不记录到 history
    let cmd = format!(" cd {escaped}; clear\n");
    let map = sessions.lock().await;
    let session = map.get(&key).ok_or("terminal not open")?;
    session.write(cmd.into_bytes()).map_err(|e| e.to_string())
}

/// Resize the terminal (called when the frontend adjusts the xterm dimensions).
#[tauri::command]
pub async fn pty_resize(
    host_id: String,
    tab_id: Option<String>,
    cols: u32,
    rows: u32,
    pty_state: State<'_, PtyState>,
) -> Result<(), String> {
    let sessions = pty_state.sessions.clone();
    let key = session_key(&host_id, &tab_id);
    let map = sessions.lock().await;
    let session = map.get(&key).ok_or("terminal not open")?;
    session.resize(cols, rows).map_err(|e| e.to_string())
}

/// Check whether a terminal is currently open (and alive) for `host_id` + `tab_id`.
#[tauri::command]
pub async fn pty_is_open(
    host_id: String,
    tab_id: Option<String>,
    pty_state: State<'_, PtyState>,
) -> Result<bool, String> {
    let sessions = pty_state.sessions.clone();
    let key = session_key(&host_id, &tab_id);
    let map = sessions.lock().await;
    Ok(map.get(&key).map(|s| !s.is_closed()).unwrap_or(false))
}
