//! SFTP module error types.
//!
//! Errors are mapped from the underlying [`russh_sftp::client::error::Error`]
//! and [`crate::ssh::SshError`] into a small set of frontend-actionable
//! variants. Each variant stringifies with a stable code prefix
//! (`"NoSuchPath: ..."`, `"PermissionDenied: ..."`, etc.) so the UI can
//! switch on the code to show targeted messages.

use russh_sftp::client::error::Error as SftpLibError;
use russh_sftp::protocol::StatusCode;

use crate::ssh::SshError;

/// Errors raised by the SFTP module.
#[derive(Debug, thiserror::Error)]
pub enum SftpError {
    /// No active SSH session for the given host id (or the session died).
    #[error("not connected")]
    NotConnected,

    /// The authenticated user lacks permission for the operation.
    #[error("permission denied: {0}")]
    PermissionDenied(String),

    /// The referenced path does not exist on the remote filesystem.
    #[error("no such path: {0}")]
    NoSuchPath(String),

    /// A path that was expected to be a directory is not one.
    #[error("not a directory: {0}")]
    NotADirectory(String),

    /// A file or directory with the target name already exists.
    #[error("already exists: {0}")]
    AlreadyExists(String),

    /// Transfer was cancelled by the user before completion.
    #[error("cancelled by user")]
    Cancelled,

    /// Any other SFTP / transport failure not covered above.
    #[error("sftp error: {0}")]
    Sftp(String),
}

impl From<SshError> for SftpError {
    fn from(e: SshError) -> Self {
        match e {
            SshError::NotConnected => SftpError::NotConnected,
            other => SftpError::Sftp(other.to_string()),
        }
    }
}

impl From<SftpLibError> for SftpError {
    fn from(e: SftpLibError) -> Self {
        match &e {
            SftpLibError::Status(status) => {
                let msg = status.error_message.clone();
                match status.status_code {
                    StatusCode::NoSuchFile => SftpError::NoSuchPath(msg),
                    StatusCode::PermissionDenied => SftpError::PermissionDenied(msg),
                    StatusCode::ConnectionLost | StatusCode::NoConnection => {
                        SftpError::NotConnected
                    }
                    StatusCode::Failure => {
                        let lower = msg.to_lowercase();
                        if lower.contains("not empty")
                            || lower.contains("directory not empty")
                            || lower.contains("file not found")
                        {
                            SftpError::Sftp(msg)
                        } else if lower.contains("exist") || lower.contains("already") {
                            SftpError::AlreadyExists(msg)
                        } else if lower.contains("not a dir") {
                            SftpError::NotADirectory(msg)
                        } else if lower.contains("permission") {
                            SftpError::PermissionDenied(msg)
                        } else {
                            SftpError::Sftp(msg)
                        }
                    }
                    _ => SftpError::Sftp(msg),
                }
            }
            // Check error string for "session closed" / IO errors that indicate
            // the underlying SFTP channel is no longer usable.
            other => {
                let msg = other.to_string();
                let lower = msg.to_lowercase();
                if lower.contains("session closed")
                    || lower.contains("session is closed")
                    || lower.contains("no connection")
                    || lower.contains("connection lost")
                    || lower.contains("io error")
                {
                    SftpError::NotConnected
                } else {
                    SftpError::Sftp(msg)
                }
            }
        }
    }
}

/// `AsyncWriteExt::write_all` returns `std::io::Error`; wrap it so the call
/// site in `sftp_write_file` can unify the error handling path.
impl From<std::io::Error> for SftpError {
    fn from(e: std::io::Error) -> Self {
        use std::io::ErrorKind;
        let msg = e.to_string();
        match e.kind() {
            ErrorKind::NotFound => SftpError::NoSuchPath(msg),
            ErrorKind::PermissionDenied => SftpError::PermissionDenied(msg),
            ErrorKind::AlreadyExists => SftpError::AlreadyExists(msg),
            ErrorKind::NotADirectory => SftpError::NotADirectory(msg),
            _ => {
                let lower = msg.to_lowercase();
                if lower.contains("session closed")
                    || lower.contains("connection lost")
                    || lower.contains("no connection")
                {
                    SftpError::NotConnected
                } else {
                    SftpError::Sftp(msg)
                }
            }
        }
    }
}

/// Returns `true` if the error indicates the SFTP channel has closed and
/// the cached session should be evicted and rebuilt.
pub fn is_session_closed(e: &SftpError) -> bool {
    if matches!(e, SftpError::NotConnected) {
        return true;
    }
    if let SftpError::Sftp(ref msg) = e {
        let lower = msg.to_lowercase();
        return lower.contains("session closed")
            || lower.contains("session is closed")
            || lower.contains("no connection")
            || lower.contains("connection lost")
            || lower.contains("io error");
    }
    false
}

/// Tauri command handlers return `Result<T, String>`. We stringify with a
/// stable code prefix so the frontend can branch on it:
/// `"NoSuchPath: ..."`, `"PermissionDenied: ..."`, etc.
impl From<SftpError> for String {
    fn from(e: SftpError) -> String {
        let code = match &e {
            SftpError::NotConnected => "NotConnected",
            SftpError::PermissionDenied(_) => "PermissionDenied",
            SftpError::NoSuchPath(_) => "NoSuchPath",
            SftpError::NotADirectory(_) => "NotADirectory",
            SftpError::AlreadyExists(_) => "AlreadyExists",
            SftpError::Cancelled => "Cancelled",
            SftpError::Sftp(_) => "SftpError",
        };
        format!("{}: {}", code, e)
    }
}
