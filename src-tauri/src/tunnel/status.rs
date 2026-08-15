use std::collections::HashMap;
use tokio::sync::Mutex;

pub struct RunningTunnel {
    pub host_id: String,
    pub rule_id: String,
    pub abort: tokio::task::AbortHandle,
    pub accepted_conns: u32,
    pub start_time_ms: i64,
    pub local_addr: String,
    pub local_port: u16,
}

pub struct TunnelState {
    pub running: Mutex<HashMap<String, RunningTunnel>>,
}

impl TunnelState {
    pub fn new() -> Self {
        Self {
            running: Mutex::new(HashMap::new()),
        }
    }
}

impl Default for TunnelState {
    fn default() -> Self {
        Self::new()
    }
}

pub fn new_state() -> TunnelState {
    TunnelState::new()
}
