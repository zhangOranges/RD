use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TunnelErrorCode {
    RuleNotFound,
    HostNotAvailable,
    HostReconnecting,
    PortInUse,
    PortInvalid,
    AddrInvalid,
    RemoteForbidden,
    PermissionDenied,
    ListenOnAllNeedsConfirm,
    SshChannelError,
}

impl std::fmt::Display for TunnelErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = match self {
            TunnelErrorCode::RuleNotFound => "RULE_NOT_FOUND",
            TunnelErrorCode::HostNotAvailable => "HOST_NOT_AVAILABLE",
            TunnelErrorCode::HostReconnecting => "HOST_RECONNECTING",
            TunnelErrorCode::PortInUse => "PORT_IN_USE",
            TunnelErrorCode::PortInvalid => "PORT_INVALID",
            TunnelErrorCode::AddrInvalid => "ADDR_INVALID",
            TunnelErrorCode::RemoteForbidden => "REMOTE_FORBIDDEN",
            TunnelErrorCode::PermissionDenied => "PERMISSION_DENIED",
            TunnelErrorCode::ListenOnAllNeedsConfirm => "LISTEN_ON_ALL_NEEDS_CONFIRM",
            TunnelErrorCode::SshChannelError => "SSH_CHANNEL_ERROR",
        };
        f.write_str(s)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelRuleDto {
    pub id: String,
    pub host_id: String,
    pub mode: String,
    pub local_addr: String,
    pub local_port: u16,
    pub remote_addr: Option<String>,
    pub remote_port: Option<u16>,
    pub auto_start: bool,
    pub tags: Option<Vec<String>>,
    pub comment: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatusDto {
    pub tunnel_id: String,
    pub running: bool,
    pub pid: Option<u32>,
    pub error: Option<String>,
    pub bound_host_id: Option<String>,
    pub accepted_conns: u32,
    pub start_time_ms: Option<i64>,
}
