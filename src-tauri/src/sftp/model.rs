//! Data models exposed to the frontend by the SFTP commands.

/// One entry in a remote directory listing.
///
/// Returned by [`crate::sftp::sftp_list_dir`]. Fields are deliberately
/// JSON-friendly (no `PathBuf`, no `SystemTime`) so the Tauri IPC layer
/// can serialize them without extra adapters.
#[derive(serde::Serialize, Clone, Debug)]
pub struct FileEntry {
    /// Entry name (not the full path).
    pub name: String,
    /// Convenience flag: `true` for directories, `false` for everything else
    /// (including symlinks-to-directories — see `file_type` for the precise
    /// type).
    pub is_dir: bool,
    /// File size in bytes. `0` for directories or when the server omits the
    /// size attribute.
    pub size: u64,
    /// Last modification time as a Unix timestamp (seconds). `0` when the
    /// server omits mtime.
    pub modified: i64,
    /// 9-character permission string in `rwxr-xr-x` form (no type prefix).
    /// Derived from the low 9 bits of the SFTP permissions word.
    pub permissions: String,
    /// Owner: the username when the server provides it, otherwise the numeric
    /// uid, otherwise `"0"`.
    pub owner: String,
    /// `"dir"`, `"file"`, or `"symlink"`.
    pub file_type: String,
}
