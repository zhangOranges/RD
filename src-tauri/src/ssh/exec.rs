//! SSH exec command: execute a command on the remote server and return stdout.

use russh::ChannelMsg;
use serde::Serialize;

use super::{SshState, SshError};

/// Execute a command on the remote server and return its stdout.
/// Intended for short-lived commands (server stats, etc.).
pub async fn ssh_exec_raw(
    state: &SshState,
    host_id: &str,
    command: &str,
) -> Result<String, SshError> {
    let handle = state.get_connection(host_id).await?;

    let mut channel = {
        let h = handle.lock().await;
        h.channel_open_session()
            .await
            .map_err(|e| SshError::ChannelError(format!("open exec channel: {e}")))?
    };

    channel
        .exec(true, command)
        .await
        .map_err(|e| SshError::ChannelError(format!("exec: {e}")))?;

    let mut output = Vec::new();
    let mut exit_code: i32 = 0;

    loop {
        match channel.wait().await {
            Some(ChannelMsg::Data { data }) => {
                output.extend_from_slice(&data);
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                // stderr — ignore for stats purposes
                let _ = data;
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => {
                exit_code = exit_status as i32;
            }
            Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                break;
            }
            _ => {}
        }
    }

    if exit_code != 0 {
        return Err(SshError::ChannelError(format!(
            "command exited with code {exit_code}"
        )));
    }

    Ok(String::from_utf8_lossy(&output).to_string())
}

/// Server hardware stats returned to the frontend.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServerStats {
    /// CPU 型号（取第一个核心的 model name）
    pub cpu_model: String,
    /// CPU 核心数
    pub cpu_cores: u32,
    /// CPU 占用率（百分比，0-100）
    pub cpu_usage: f64,
    /// 内存总量（MB）
    pub mem_total_mb: u64,
    /// 内存已用（MB）
    pub mem_used_mb: u64,
    /// 根分区总量（GB）
    pub disk_total_gb: f64,
    /// 根分区已用（GB）
    pub disk_used_gb: f64,
    /// 系统负载（1分钟）
    pub load_avg: f64,
    /// 操作系统信息
    pub os_info: String,
    /// 系统运行时间（秒）
    pub uptime_secs: u64,
}

/// 解析 /proc/stat 第一行（aggregate CPU），返回 (total, idle) jiffies。
/// total = user+nice+system+idle+iowait+irq+softirq+steal
/// idle  = idle+iowait
fn parse_proc_stat_first_line(out: &str) -> Option<(u64, u64)> {
    let line = out.lines().next()?;
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 5 || parts[0] != "cpu" {
        return None;
    }
    let nums: Vec<u64> = parts[1..]
        .iter()
        .map(|s| s.parse::<u64>().unwrap_or(0))
        .collect();
    // nums: [user, nice, system, idle, iowait, irq, softirq, steal, ...]
    let idle = nums.get(3).copied().unwrap_or(0) + nums.get(4).copied().unwrap_or(0);
    let total: u64 = nums.iter().take(8).sum();
    Some((total, idle))
}

/// Tauri command: fetch server hardware stats via SSH exec.
#[tauri::command]
pub async fn get_server_stats(
    host_id: String,
    state: tauri::State<'_, SshState>,
) -> Result<ServerStats, String> {
    // CPU model + cores
    let cpu_out = ssh_exec_raw(&state, &host_id, "cat /proc/cpuinfo | grep 'model name' | head -1; echo '---'; nproc").await
        .unwrap_or_default();
    let mut cpu_parts = cpu_out.split("---");
    let cpu_model = cpu_parts.next().unwrap_or("").trim().replace("model name\t: ", "").to_string();
    let cpu_cores: u32 = cpu_parts.next().unwrap_or("1").trim().parse().unwrap_or(1);

    // CPU 占用率：采样两次 /proc/stat，间隔 500ms，按 (total-idle)/total 差值计算
    let cpu_usage: f64 = {
        let s1 = ssh_exec_raw(&state, &host_id, "head -n1 /proc/stat").await.unwrap_or_default();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let s2 = ssh_exec_raw(&state, &host_id, "head -n1 /proc/stat").await.unwrap_or_default();
        match (parse_proc_stat_first_line(&s1), parse_proc_stat_first_line(&s2)) {
            (Some((t1, i1)), Some((t2, i2))) => {
                let dt = t2.saturating_sub(t1) as f64;
                let di = i2.saturating_sub(i1) as f64;
                if dt > 0.0 { ((dt - di) / dt * 100.0).max(0.0).min(100.0) } else { 0.0 }
            }
            _ => 0.0,
        }
    };

    // Memory: parse /proc/meminfo
    let mem_out = ssh_exec_raw(&state, &host_id, "cat /proc/meminfo").await.unwrap_or_default();
    let mut mem_total_kb: u64 = 0;
    let mut mem_available_kb: u64 = 0;
    for line in mem_out.lines() {
        if line.starts_with("MemTotal:") {
            mem_total_kb = line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        }
        if line.starts_with("MemAvailable:") {
            mem_available_kb = line.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        }
    }
    let mem_total_mb = mem_total_kb / 1024;
    let mem_used_mb = if mem_total_mb > 0 { mem_total_mb - mem_available_kb / 1024 } else { 0 };

    // Disk: df -B1 /
    let disk_out = ssh_exec_raw(&state, &host_id, "df -B1 / | tail -1").await.unwrap_or_default();
    let disk_parts: Vec<&str> = disk_out.split_whitespace().collect();
    let disk_total_bytes: u64 = disk_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let disk_used_bytes: u64 = disk_parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let disk_total_gb = disk_total_bytes as f64 / 1_073_741_824.0;
    let disk_used_gb = disk_used_bytes as f64 / 1_073_741_824.0;

    // Load average
    let load_out = ssh_exec_raw(&state, &host_id, "cat /proc/loadavg | awk '{print $1}'").await.unwrap_or_default();
    let load_avg: f64 = load_out.trim().parse().unwrap_or(0.0);

    // OS info
    let os_out = ssh_exec_raw(&state, &host_id, "cat /etc/os-release 2>/dev/null | grep '^PRETTY_NAME=' | cut -d= -f2- | tr -d '\"' || uname -s").await.unwrap_or_default();
    let os_info = os_out.trim().to_string();

    // Uptime
    let up_out = ssh_exec_raw(&state, &host_id, "cat /proc/uptime | awk '{print $1}'").await.unwrap_or_default();
    let uptime_secs: u64 = up_out.trim().split('.').next().and_then(|s| s.parse().ok()).unwrap_or(0);

    Ok(ServerStats {
        cpu_model: if cpu_model.is_empty() { "Unknown".to_string() } else { cpu_model },
        cpu_cores,
        cpu_usage,
        mem_total_mb,
        mem_used_mb,
        disk_total_gb,
        disk_used_gb,
        load_avg,
        os_info: if os_info.is_empty() { "Linux".to_string() } else { os_info },
        uptime_secs,
    })
}
