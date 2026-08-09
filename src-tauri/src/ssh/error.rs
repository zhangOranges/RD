//! SSH module error types.

/// Errors that can occur during SSH connection management.
#[derive(Debug, thiserror::Error)]
pub enum SshError {
    /// Authentication failed (wrong password / key rejected by server).
    #[error("authentication failed")]
    AuthFailed,

    /// Could not reach the host (DNS / TCP / timeout).
    #[error("host unreachable: {0}")]
    HostUnreachable(String),

    /// Server public key fingerprint does not match the trusted value.
    #[error("server fingerprint mismatch")]
    FingerprintMismatch,

    /// No active connection for the given host id.
    #[error("not connected")]
    NotConnected,

    /// A channel-level operation failed (open / subsystem / io).
    #[error("channel error: {0}")]
    ChannelError(String),

    /// Underlying russh error.
    #[error("ssh error: {0}")]
    Ssh(#[from] russh::Error),

    /// JSON (de)serialization error for known_hosts.json.
    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    /// Catch-all for internal logic failures (missing data dir, etc.).
    #[error("internal error: {0}")]
    Internal(String),
}

impl SshError {
    /// Wrap an arbitrary [`std::io::Error`] into an [`SshError`].
    ///
    /// We go through [`russh::Error`] so that the wire-level context is
    /// preserved when relevant, falling back to a generic internal error
    /// for IO that is not part of the SSH transport itself.
    pub fn from_io(e: std::io::Error) -> Self {
        // russh::Error implements From<std::io::Error>; reuse it when possible.
        let ssh_err: russh::Error = e.into();
        SshError::Ssh(ssh_err)
    }
}

// Manual From<std::io::Error> so that `?` works on io operations inside the ssh
// module. This does NOT conflict with the `#[from] russh::Error` above because
// the source types differ.
impl From<std::io::Error> for SshError {
    fn from(e: std::io::Error) -> Self {
        Self::from_io(e)
    }
}

/// Tauri command handlers return `Result<T, String>`, so we provide a cheap
/// conversion that stringifies the error for the frontend.
impl From<SshError> for String {
    fn from(e: SshError) -> String {
        e.to_string()
    }
}
