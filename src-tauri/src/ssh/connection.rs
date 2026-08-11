//! SSH connection handle and connect/auth logic.
//!
//! A [`ConnectionHandle`] wraps a [`russh::client::Handle`] together with the
//! metadata that the rest of the app needs (host id, fingerprint, home dir).
//! The russh handle is shared via `Arc<tokio::sync::Mutex<…>>` so that future
//! SFTP / PTY modules can open channels on the same underlying SSH session
//! without having to reconnect.

use std::sync::Arc;

use russh::client::{self, Handle};
use russh::Disconnect;
use tokio::sync::Mutex;

use super::error::SshError;
use super::handler::{ClientHandler, HandlerSharedState};
use crate::{debug_log, LogLevel};

/// Shared, lockable handle to a russh client session.
///
/// Other modules (SFTP in Task 4, PTY in Task 5) obtain one of these via
/// [`SshState::get_connection`] and lock it to call `channel_open_session`
/// etc.
pub type SharedHandle = Arc<Mutex<Handle<ClientHandler>>>;

/// Connection parameters supplied by the frontend for `connect_host`.
#[derive(serde::Deserialize, Clone, Debug)]
pub struct ConnectParams {
    pub host_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// `"password"` or `"key"`.
    pub auth_type: String,
    pub password: Option<String>,
    pub private_key: Option<String>,
}

/// Result returned to the frontend from a successful `connect_host` call.
#[derive(serde::Serialize, Clone, Debug)]
pub struct ConnectResult {
    pub home_dir: String,
    pub fingerprint: String,
}

/// One active SSH connection.
pub struct ConnectionHandle {
    pub host_id: String,
    pub host_port: String,
    /// Absolute home directory resolved at connect time (falls back to `"~"`).
    pub home_dir: Option<String>,
    /// SHA-256 hex fingerprint of the server key (set during kex).
    pub fingerprint: Option<String>,
    /// `None` while the session is still being established.
    handle: Option<SharedHandle>,
    /// Shared state with the background handler (used to arm the disconnect
    /// event and to read back the fingerprint).
    shared: HandlerSharedState,
}

impl ConnectionHandle {
    /// Create a lightweight placeholder representing a "connecting" state.
    /// Used so that `connection_state` can report `"connecting"` while a real
    /// connection is being established.
    pub fn connecting(host_id: String, host_port: String) -> Self {
        ConnectionHandle {
            host_id,
            host_port,
            home_dir: None,
            fingerprint: None,
            handle: None,
            shared: HandlerSharedState::dummy(),
        }
    }

    /// Connect to a host, authenticate, resolve the home dir, and return a
    /// handle ready to be stored in [`super::SshState`].
    ///
    /// `app_handle` is used to emit `ssh://disconnected` later; pass `None`
    /// when running outside a Tauri runtime (e.g. in tests).
    pub async fn connect(
        params: &ConnectParams,
        app_handle: Option<tauri::AppHandle>,
    ) -> Result<Self, SshError> {
        let host_port = format!("{}:{}", params.host, params.port);
        let addr = (params.host.as_str(), params.port);

        if let Some(app) = &app_handle {
            debug_log(
                app,
                LogLevel::Info,
                &format!(
                    "SSH 连接开始: host_id={}, {} (auth={})",
                    params.host_id, host_port, params.auth_type
                ),
            );
        }

        // --- russh client config -------------------------------------------------
        let config = client::Config {
            keepalive_interval: Some(std::time::Duration::from_secs(15)),
            keepalive_max: 3,
            ..Default::default()
        };

        let handler = ClientHandler::new(params.host_id.clone(), host_port.clone(), app_handle.clone());
        let shared = handler.shared_state();

        // --- TCP + SSH handshake -------------------------------------------------
        let mut handle = match client::connect(Arc::new(config), addr, handler).await {
            Ok(h) => h,
            Err(e) => {
                // russh swallows the kex-stage error (it returns a generic
                // `Disconnect`). Re-surface the precise error we stashed in
                // the handler if one is present.
                if let Some(specific) = shared
                    .connect_error
                    .lock()
                    .ok()
                    .and_then(|mut guard| guard.take())
                {
                    if let Some(app) = &app_handle {
                        debug_log(
                            app,
                            LogLevel::Error,
                            &format!("SSH 连接失败: {} - {}", host_port, specific),
                        );
                    }
                    return Err(specific);
                }
                let mapped = map_connect_error(e);
                if let Some(app) = &app_handle {
                    debug_log(
                        app,
                        LogLevel::Error,
                        &format!("SSH 连接失败: {} - {}", host_port, mapped),
                    );
                }
                // Distinguish "can't reach host" from other failures.
                return Err(mapped);
            }
        };

        // If the kex stage set a specific error despite connect succeeding
        // (shouldn't normally happen), surface it now.
        if let Some(specific) = shared
            .connect_error
            .lock()
            .ok()
            .and_then(|mut guard| guard.take())
        {
            // Best-effort cleanup of the half-open session.
            let _ = handle
                .disconnect(Disconnect::ByApplication, "auth abort", "en")
                .await;
            if let Some(app) = &app_handle {
                debug_log(
                    app,
                    LogLevel::Error,
                    &format!("SSH kex 阶段错误: {} - {}", host_port, specific),
                );
            }
            return Err(specific);
        }

        if let Some(app) = &app_handle {
            debug_log(
                app,
                LogLevel::Info,
                &format!("SSH 握手成功: {}", host_port),
            );
        }

        // --- Authenticate --------------------------------------------------------
        let auth_ok = match params.auth_type.as_str() {
            "password" => {
                let password = params.password.clone().ok_or_else(|| {
                    SshError::Internal("password auth requires a password".into())
                })?;
                handle
                    .authenticate_password(&params.username, &password)
                    .await
                    .map_err(|e| {
                        if let Some(app) = &app_handle {
                            debug_log(
                                app,
                                LogLevel::Error,
                                &format!("密码认证异常: {} - {}", host_port, e),
                            );
                        }
                        SshError::Ssh(e)
                    })?
            }
            "key" => {
                let key_str = params
                    .private_key
                    .clone()
                    .ok_or_else(|| SshError::Internal("key auth requires a private_key".into()))?;
                // Passphrase (if the key is encrypted) comes from the password
                // field; otherwise None.
                let passphrase = params.password.as_deref();
                let key_pair = russh::keys::decode_secret_key(&key_str, passphrase).map_err(|e| {
                    let err = SshError::Internal(format!("failed to decode private key: {e}"));
                    if let Some(app) = &app_handle {
                        debug_log(
                            app,
                            LogLevel::Error,
                            &format!("私钥解析失败: {} - {}", host_port, err),
                        );
                    }
                    err
                })?;
                handle
                    .authenticate_publickey(&params.username, Arc::new(key_pair))
                    .await
                    .map_err(|e| {
                        if let Some(app) = &app_handle {
                            debug_log(
                                app,
                                LogLevel::Error,
                                &format!("公钥认证异常: {} - {}", host_port, e),
                            );
                        }
                        SshError::Ssh(e)
                    })?
            }
            other => {
                let _ = handle
                    .disconnect(Disconnect::ByApplication, "bad auth_type", "en")
                    .await;
                if let Some(app) = &app_handle {
                    debug_log(
                        app,
                        LogLevel::Error,
                        &format!("未知认证类型: {} - {}", host_port, other),
                    );
                }
                return Err(SshError::Internal(format!("unknown auth_type: {other}")));
            }
        };

        if !auth_ok {
            let _ = handle
                .disconnect(Disconnect::ByApplication, "auth failed", "en")
                .await;
            if let Some(app) = &app_handle {
                debug_log(
                    app,
                    LogLevel::Warn,
                    &format!("认证失败（凭据错误）: {}", host_port),
                );
            }
            return Err(SshError::AuthFailed);
        }

        if let Some(app) = &app_handle {
            debug_log(
                app,
                LogLevel::Info,
                &format!("认证成功: {} ({})", host_port, params.auth_type),
            );
        }

        // --- Resolve home dir via a throwaway SFTP channel ----------------------
        // We open a temporary SFTP channel, call realpath("."), then close it.
        // The persistent SFTP channel is established later in Task 4. If SFTP
        // is unavailable we fall back to "~" so the connect still succeeds.
        let home_dir = match resolve_home_dir(&handle).await {
            Ok(path) => {
                if let Some(app) = &app_handle {
                    debug_log(
                        app,
                        LogLevel::Info,
                        &format!("home_dir 解析成功: {} -> {}", host_port, path),
                    );
                }
                path
            }
            Err(e) => {
                if let Some(app) = &app_handle {
                    debug_log(
                        app,
                        LogLevel::Warn,
                        &format!("home_dir 解析失败，回退到 ~: {} - {}", host_port, e),
                    );
                }
                "~".to_string()
            }
        };

        let fingerprint = shared
            .fingerprint
            .lock()
            .ok()
            .and_then(|guard| guard.clone());

        let handle_arc: SharedHandle = Arc::new(Mutex::new(handle));

        if let Some(app) = &app_handle {
            debug_log(
                app,
                LogLevel::Info,
                &format!(
                    "SSH 连接就绪: {} (fingerprint={})",
                    host_port,
                    fingerprint.as_deref().unwrap_or("?")
                ),
            );
        }

        Ok(ConnectionHandle {
            host_id: params.host_id.clone(),
            host_port,
            home_dir: Some(home_dir),
            fingerprint,
            handle: Some(handle_arc),
            shared,
        })
    }

    /// Politely close the session. The background handler will fire
    /// `disconnected` and (if `emit_disconnect` was armed) emit the Tauri
    /// event.
    pub async fn disconnect(&self) -> Result<(), SshError> {
        // Disarm the emit flag so an explicit disconnect doesn't double-emit
        // if the caller is also dropping the handle.
        // (We keep it armed: the spec wants the frontend notified on *any*
        // disconnect, including explicit ones.)
        if let Some(handle) = &self.handle {
            let guard = handle.lock().await;
            let _ = guard
                .disconnect(Disconnect::ByApplication, "client closed", "en")
                .await;
        }
        Ok(())
    }

    /// `true` if we have a handle and its sender is still open.
    pub async fn is_connected(&self) -> bool {
        match &self.handle {
            Some(h) => {
                let guard = h.lock().await;
                !guard.is_closed()
            }
            None => false,
        }
    }

    /// Return a clone of the shared handle, if any. Other modules lock it and
    /// call `channel_open_session` / `channel_open_direct_tcpip` etc.
    pub fn get_handle(&self) -> Option<SharedHandle> {
        self.handle.clone()
    }

    /// `true` while the placeholder is in place but the real russh handle has
    /// not been attached yet (i.e. we are mid-connect).
    pub fn is_connecting(&self) -> bool {
        self.handle.is_none()
    }

    /// Arm the disconnect-event emitter. Called by `SshState` once the
    /// connection has been registered, so that future drops emit the event.
    pub fn arm_disconnect_event(&self) {
        self.shared
            .emit_disconnect
            .store(true, std::sync::atomic::Ordering::Release);
    }
}

/// Open a temporary SFTP channel on `handle`, resolve `realpath(".")`, and
/// close the channel again. Errors are surfaced to the caller; the connect
/// logic falls back to `"~"` on failure.
async fn resolve_home_dir(handle: &Handle<ClientHandler>) -> Result<String, SshError> {
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|e| SshError::ChannelError(format!("open session: {e}")))?;

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| SshError::ChannelError(format!("request sftp subsystem: {e}")))?;

    let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| SshError::ChannelError(format!("init sftp: {e}")))?;

    let result = sftp
        .canonicalize(".")
        .await
        .map_err(|e| SshError::ChannelError(format!("realpath: {e}")));

    // Always try to close the SFTP session, even if realpath failed.
    let _ = sftp.close().await;

    result
}

/// Map a connect-stage [`SshError`] (which wraps a [`russh::Error`]) into a
/// more specific variant where possible.
///
/// TCP / DNS / timeout failures become [`SshError::HostUnreachable`]; other
/// errors are returned unchanged.
fn map_connect_error(e: SshError) -> SshError {
    match &e {
        SshError::Ssh(russh::Error::IO(io_err)) => {
            // Connection refused / timeout / DNS failure → host unreachable.
            SshError::HostUnreachable(io_err.to_string())
        }
        _ => e,
    }
}
