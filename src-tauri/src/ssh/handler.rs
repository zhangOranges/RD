//! Implementation of [`russh::client::Handler`] for the SSH-SFTP finder.
//!
//! The handler is responsible for:
//! - Verifying the server public key fingerprint against `known_hosts.json`
//!   (first-trust policy).
//! - Emitting a `ssh://disconnected` Tauri event when an established connection
//!   is torn down by the network or the remote peer.
//!
//! Shared state (fingerprint, connect-time error, emit flag) is communicated
//! back to the connect logic through `Arc`-wrapped cells because russh moves
//! the handler into a background tokio task before [`russh::client::connect`]
//! returns.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use russh::client::{DisconnectReason, Handler, Msg, Session};
use russh::keys::key::PublicKey;
use russh::keys::PublicKeyBase64;
use russh::Channel;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use super::error::SshError;
use crate::{debug_log, LogLevel};

/// Name of the Tauri event emitted when an established connection drops.
pub const DISCONNECTED_EVENT: &str = "ssh://disconnected";

/// Subdirectory under the OS data dir where we keep app state files.
const APP_DATA_SUBDIR: &str = "ssh-sftp-finder";
/// File holding the trusted host fingerprints.
const KNOWN_HOSTS_FILE: &str = "known_hosts.json";

/// Local target of a remote (`-R`) port-forward.
///
/// When an SSH server with an active `tcpip-forward` accepts a TCP
/// connection, it opens a channel back to the client and russh calls
/// [`Handler::server_channel_open_forwarded_tcpip`]. The handler looks up the
/// local target registered by the tunnel task and bridges the two ends.
#[derive(Clone, Debug)]
pub struct RemoteForwardTarget {
    pub local_addr: String,
    pub local_port: u16,
}

/// Registry shared between the tunnel module (which registers/removes
/// targets) and the [`ClientHandler`] (which consumes them in
/// `server_channel_open_forwarded_tcpip`). Keyed by `(remote_addr,
/// remote_port)` as requested by the tunnel rule.
pub type RemoteForwardRegistry = Arc<Mutex<HashMap<(String, u32), RemoteForwardTarget>>>;

/// russh client handler.
///
/// Holds shared state that needs to cross the boundary between the foreground
/// `connect` future and the background session task.
pub struct ClientHandler {
    /// Logical host id used in the frontend / state map. Used as the event
    /// payload so the frontend knows *which* host dropped.
    pub host_id: String,
    /// `host:port` key used inside `known_hosts.json`.
    pub host_port: String,
    /// Tauri app handle used to emit the disconnect event. `None` means we
    /// are running without a Tauri runtime (e.g. in unit tests).
    pub app_handle: Option<AppHandle>,
    /// Fingerprint computed during `check_server_key`, shared with the caller
    /// of `connect` so it can be returned in `ConnectResult`.
    pub fingerprint: Arc<Mutex<Option<String>>>,
    /// A specific error set during `check_server_key` (e.g.
    /// `FingerprintMismatch`). russh converts most kex failures into a generic
    /// `Disconnect` error by the time `connect` returns, so we stash the real
    /// reason here and re-surface it from our connect logic.
    pub connect_error: Arc<Mutex<Option<SshError>>>,
    /// Only emit `ssh://disconnected` once the connection has been fully
    /// established and registered. Set to `true` by the caller *after* a
    /// successful connect.
    pub emit_disconnect: Arc<AtomicBool>,
    /// Active remote port-forwards for this connection. Written by the tunnel
    /// module, read by `server_channel_open_forwarded_tcpip`.
    pub remote_forwards: RemoteForwardRegistry,
}

impl ClientHandler {
    /// Construct a new handler with empty shared state.
    pub fn new(host_id: String, host_port: String, app_handle: Option<AppHandle>) -> Self {
        Self {
            host_id,
            host_port,
            app_handle,
            fingerprint: Arc::new(Mutex::new(None)),
            connect_error: Arc::new(Mutex::new(None)),
            emit_disconnect: Arc::new(AtomicBool::new(false)),
            remote_forwards: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Clone the shared cells so the connect logic can read the fingerprint /
    /// error after `connect` returns.
    pub fn shared_state(&self) -> HandlerSharedState {
        HandlerSharedState {
            fingerprint: self.fingerprint.clone(),
            connect_error: self.connect_error.clone(),
            emit_disconnect: self.emit_disconnect.clone(),
            remote_forwards: self.remote_forwards.clone(),
        }
    }
}

/// Handles shared between the [`ClientHandler`] (running in russh's background
/// task) and the foreground connect logic.
pub struct HandlerSharedState {
    pub fingerprint: Arc<Mutex<Option<String>>>,
    pub connect_error: Arc<Mutex<Option<SshError>>>,
    pub emit_disconnect: Arc<AtomicBool>,
    pub remote_forwards: RemoteForwardRegistry,
}

impl HandlerSharedState {
    /// Construct a dummy shared state for placeholder `ConnectionHandle`s
    /// that have not yet been wired up to a real russh handler.
    pub fn dummy() -> Self {
        Self {
            fingerprint: Arc::new(Mutex::new(None)),
            connect_error: Arc::new(Mutex::new(None)),
            emit_disconnect: Arc::new(AtomicBool::new(false)),
            remote_forwards: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

#[async_trait]
impl Handler for ClientHandler {
    type Error = SshError;

    /// Verify the server's public key.
    ///
    /// - First time we see this `host:port`: compute its SHA-256 fingerprint
    ///   (hex), persist it to `known_hosts.json`, and trust it.
    /// - Subsequent connections: compare the computed fingerprint with the
    ///   stored one. Mismatch → [`SshError::FingerprintMismatch`].
    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        let fingerprint = compute_fingerprint(key);

        let mut known_hosts = match load_known_hosts() {
            Ok(h) => h,
            Err(e) => {
                // We could not read the trust DB. Fail closed.
                let msg = e.to_string();
                *self
                    .connect_error
                    .lock()
                    .expect("connect_error mutex poisoned") = Some(SshError::Internal(msg.clone()));
                return Err(SshError::Internal(msg));
            }
        };

        match known_hosts.get(&self.host_port) {
            Some(trusted) if trusted == &fingerprint => {
                // Trusted and matches.
                *self.fingerprint.lock().expect("fingerprint mutex poisoned") =
                    Some(fingerprint.clone());
                Ok(true)
            }
            Some(_other) => {
                // Fingerprint changed — possible MITM.
                *self
                    .connect_error
                    .lock()
                    .expect("connect_error mutex poisoned") = Some(SshError::FingerprintMismatch);
                Err(SshError::FingerprintMismatch)
            }
            None => {
                // First contact — trust on first use.
                known_hosts.insert(self.host_port.clone(), fingerprint.clone());
                if let Err(e) = save_known_hosts(&known_hosts) {
                    // Persisting the trust DB failed; treat as fatal so we
                    // don't silently re-prompt next time.
                    let msg = e.to_string();
                    *self
                        .connect_error
                        .lock()
                        .expect("connect_error mutex poisoned") =
                        Some(SshError::Internal(msg.clone()));
                    return Err(SshError::Internal(msg));
                }
                *self.fingerprint.lock().expect("fingerprint mutex poisoned") = Some(fingerprint);
                Ok(true)
            }
        }
    }

    /// Called by russh when the session terminates for any reason.
    ///
    /// Only emits the disconnect event if the connection had been fully
    /// established (i.e. `emit_disconnect` was armed by the caller). This
    /// avoids spurious events during a failed initial connect.
    async fn disconnected(
        &mut self,
        reason: DisconnectReason<Self::Error>,
    ) -> Result<(), Self::Error> {
        if self.emit_disconnect.load(Ordering::Acquire) {
            if let Some(app) = &self.app_handle {
                // Best-effort emit; ignore failures (e.g. shutting down).
                let _ = app.emit(DISCONNECTED_EVENT, &self.host_id);
            }
        }
        match reason {
            DisconnectReason::ReceivedDisconnect(_) => Ok(()),
            DisconnectReason::Error(e) => Err(e),
        }
    }

    /// Called by russh when the SSH server opens a channel for a remote
    /// (`-R`) port-forward connection.
    ///
    /// Looks up the local target registered by the tunnel task and bridges the
    /// two ends with a bidirectional copy. Channels with no matching forward
    /// are dropped (the server-side connection then sees EOF).
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        connected_address: &str,
        connected_port: u32,
        originator_address: &str,
        originator_port: u32,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let target = {
            let reg = self
                .remote_forwards
                .lock()
                .expect("remote_forwards mutex poisoned");
            // Prefer an exact (address, port) match; fall back to port-only
            // because servers may report "localhost" / "127.0.0.1" / "::1"
            // interchangeably for the same bound address.
            reg.get(&(connected_address.to_string(), connected_port))
                .cloned()
                .or_else(|| {
                    reg.iter()
                        .find(|((_, p), _)| *p == connected_port)
                        .map(|(_, t)| t.clone())
                })
        };

        let Some(target) = target else {
            return Ok(());
        };

        let app = self.app_handle.clone();
        let local_addr = target.local_addr.clone();
        let local_port = target.local_port;
        let origin = format!("{}:{}", originator_address, originator_port);

        tokio::spawn(async move {
            match tokio::net::TcpStream::connect((local_addr.as_str(), local_port)).await {
                Ok(mut tcp) => {
                    let mut chan_stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut tcp, &mut chan_stream).await;
                }
                Err(e) => {
                    if let Some(app) = &app {
                        debug_log(
                            app,
                            LogLevel::Error,
                            &format!(
                                "tunnel_forward remote 连接本地目标失败: {}:{} (origin {}) - {}",
                                local_addr, local_port, origin, e
                            ),
                        );
                    }
                }
            }
        });

        Ok(())
    }
}

/// Compute the SHA-256 fingerprint of a server public key as a lowercase hex
/// string (matching the OpenSSH `SHA256:` base64 form but hex-encoded per the
/// project spec).
pub fn compute_fingerprint(key: &PublicKey) -> String {
    let bytes = key.public_key_bytes();
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    hex::encode(hasher.finalize())
}

/// Resolve the path to `known_hosts.json`, creating the parent directory if
/// needed.
pub fn known_hosts_path() -> Result<PathBuf, SshError> {
    let data_dir = dirs::data_dir()
        .ok_or_else(|| SshError::Internal("no OS data directory available".into()))?;
    let dir = data_dir.join(APP_DATA_SUBDIR);
    if !dir.exists() {
        std::fs::create_dir_all(&dir)?;
    }
    Ok(dir.join(KNOWN_HOSTS_FILE))
}

/// Load the known-hosts map. Missing file → empty map (not an error).
pub fn load_known_hosts() -> Result<HashMap<String, String>, SshError> {
    let path = known_hosts_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let contents = std::fs::read_to_string(&path)?;
    if contents.trim().is_empty() {
        return Ok(HashMap::new());
    }
    let map: HashMap<String, String> = serde_json::from_str(&contents)?;
    Ok(map)
}

/// Persist the known-hosts map atomically (write to temp + rename).
pub fn save_known_hosts(map: &HashMap<String, String>) -> Result<(), SshError> {
    let path = known_hosts_path()?;
    let contents = serde_json::to_string_pretty(map)?;
    // Write to a sibling temp file then rename to avoid partial writes.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}
