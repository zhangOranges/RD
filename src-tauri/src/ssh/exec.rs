//! SSH exec command: execute a command on the remote server and return stdout.

use russh::ChannelMsg;
use serde::Serialize;

use super::{SshError, SshState};
use crate::{debug_log, LogLevel};

/// 日志脱敏：把命令截断到 200 字节内（避免 echo $PASSWORD、token 参数等泄漏到日志）。
fn cmd_preview(cmd: &str) -> String {
    const MAX_CMD_LEN: usize = 200;
    if cmd.len() <= MAX_CMD_LEN {
        return cmd.to_string();
    }
    // 在字节预算内找到最近的 UTF-8 char 边界（向回退 floor），避免在多字节字符中间切分导致 panic
    let mut cut = MAX_CMD_LEN;
    while cut > 0 && !cmd.is_char_boundary(cut) {
        cut -= 1;
    }
    // 极端情况：如果前 200B 全是同一个字符的尾字节（几乎不会发生），退化为 cut=0，
    // 此时 "前缀...(+NB)" 中的前缀为空字符串，仍然安全且不 panic。
    let extra = cmd.len() - cut;
    format!("{}...(+{}B)", &cmd[..cut], extra)
}

/// Execute a command on the remote server and return its stdout.
/// Intended for short-lived commands (server stats, etc.).
pub async fn ssh_exec_raw(
    state: &SshState,
    host_id: &str,
    command: &str,
    app_handle: Option<&tauri::AppHandle>,
) -> Result<String, SshError> {
    let handle = state.get_connection(host_id).await?;

    let mut channel = {
        let h = handle.read().await;
        h.channel_open_session().await.map_err(|e| {
            let err = SshError::ChannelError(format!("open exec channel: {e}"));
            if let Some(app) = app_handle {
                debug_log(
                    app,
                    LogLevel::Error,
                    &format!(
                        "ssh_exec_raw 打开 channel 失败: host_id={} - {}",
                        host_id, err
                    ),
                );
            }
            err
        })?
    };

    channel.exec(true, command).await.map_err(|e| {
        let err = SshError::ChannelError(format!("exec: {e}"));
        if let Some(app) = app_handle {
            debug_log(
                app,
                LogLevel::Error,
                &format!(
                    "ssh_exec_raw exec 失败: host_id={} cmd={} - {}",
                    host_id,
                    cmd_preview(command),
                    err
                ),
            );
        }
        err
    })?;

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
        let err = SshError::ChannelError(format!("command exited with code {exit_code}"));
        if let Some(app) = app_handle {
            debug_log(
                app,
                LogLevel::Warn,
                &format!(
                    "ssh_exec_raw 非零退出: host_id={} cmd={} - code {}",
                    host_id,
                    cmd_preview(command),
                    exit_code
                ),
            );
        }
        return Err(err);
    }

    Ok(String::from_utf8_lossy(&output).to_string())
}

/// Tauri command: execute a command on the remote server and return stdout.
/// Used for folder compression/decompression during transfer.
#[tauri::command]
pub async fn ssh_exec(
    host_id: String,
    command: String,
    state: tauri::State<'_, SshState>,
    app: tauri::AppHandle,
) -> Result<String, String> {
    ssh_exec_raw(&state, &host_id, &command, Some(&app))
        .await
        .map_err(|e| e.to_string())
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
        .map(|s| s.parse::<u64>().unwrap_or_default())
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
    app: tauri::AppHandle,
) -> Result<ServerStats, String> {
    // CPU model + cores
    let cpu_out = ssh_exec_raw(
        &state,
        &host_id,
        "cat /proc/cpuinfo | grep 'model name' | head -1; echo '---'; nproc",
        Some(&app),
    )
    .await
    .unwrap_or_default();
    let mut cpu_parts = cpu_out.split("---");
    let cpu_model = cpu_parts
        .next()
        .unwrap_or("")
        .trim()
        .replace("model name\t: ", "")
        .to_string();
    let cpu_cores: u32 = cpu_parts.next().unwrap_or("1").trim().parse().unwrap_or(1);

    // CPU 占用率：采样两次 /proc/stat，间隔 500ms，按 (total-idle)/total 差值计算
    let cpu_usage: f64 = {
        let s1 = ssh_exec_raw(&state, &host_id, "head -n1 /proc/stat", Some(&app))
            .await
            .unwrap_or_default();
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        let s2 = ssh_exec_raw(&state, &host_id, "head -n1 /proc/stat", Some(&app))
            .await
            .unwrap_or_default();
        match (
            parse_proc_stat_first_line(&s1),
            parse_proc_stat_first_line(&s2),
        ) {
            (Some((t1, i1)), Some((t2, i2))) => {
                let dt = t2.saturating_sub(t1) as f64;
                let di = i2.saturating_sub(i1) as f64;
                if dt > 0.0 {
                    ((dt - di) / dt * 100.0).clamp(0.0, 100.0)
                } else {
                    0.0
                }
            }
            _ => 0.0,
        }
    };

    // Memory: parse /proc/meminfo
    let mem_out = ssh_exec_raw(&state, &host_id, "cat /proc/meminfo", Some(&app))
        .await
        .unwrap_or_default();
    let mut mem_total_kb: u64 = 0;
    let mut mem_available_kb: u64 = 0;
    for line in mem_out.lines() {
        if line.starts_with("MemTotal:") {
            mem_total_kb = line
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
        }
        if line.starts_with("MemAvailable:") {
            mem_available_kb = line
                .split_whitespace()
                .nth(1)
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
        }
    }
    let mem_total_mb = mem_total_kb / 1024;
    let mem_used_mb = if mem_total_mb > 0 {
        mem_total_mb - mem_available_kb / 1024
    } else {
        0
    };

    // Disk: df -B1 /
    let disk_out = ssh_exec_raw(&state, &host_id, "df -B1 / | tail -1", Some(&app))
        .await
        .unwrap_or_default();
    let disk_parts: Vec<&str> = disk_out.split_whitespace().collect();
    let disk_total_bytes: u64 = disk_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let disk_used_bytes: u64 = disk_parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    let disk_total_gb = disk_total_bytes as f64 / 1_073_741_824.0;
    let disk_used_gb = disk_used_bytes as f64 / 1_073_741_824.0;

    // Load average
    let load_out = ssh_exec_raw(
        &state,
        &host_id,
        "cat /proc/loadavg | awk '{print $1}'",
        Some(&app),
    )
    .await
    .unwrap_or_default();
    let load_avg: f64 = load_out.trim().parse().unwrap_or(0.0);

    // OS info
    let os_out = ssh_exec_raw(
        &state,
        &host_id,
        "cat /etc/os-release 2>/dev/null | grep '^PRETTY_NAME=' | cut -d= -f2- | tr -d '\"' || uname -s",
        Some(&app),
    )
    .await
    .unwrap_or_default();
    let os_info = os_out.trim().to_string();

    // Uptime
    let up_out = ssh_exec_raw(
        &state,
        &host_id,
        "cat /proc/uptime | awk '{print $1}'",
        Some(&app),
    )
    .await
    .unwrap_or_default();
    let uptime_secs: u64 = up_out
        .trim()
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    Ok(ServerStats {
        cpu_model: if cpu_model.is_empty() {
            "Unknown".to_string()
        } else {
            cpu_model
        },
        cpu_cores,
        cpu_usage,
        mem_total_mb,
        mem_used_mb,
        disk_total_gb,
        disk_used_gb,
        load_avg,
        os_info: if os_info.is_empty() {
            "Linux".to_string()
        } else {
            os_info
        },
        uptime_secs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // =========================================================================
    // TR-E1: cmd_preview —— 日志脱敏：短命令原样、长命令截断到 200 字节
    // =========================================================================

    #[test]
    fn test_cmd_preview_short_unchanged() {
        // 空命令也安全
        assert_eq!(cmd_preview(""), "");
        // 短命令：原样
        assert_eq!(cmd_preview("ls -la"), "ls -la");
        // 恰好 199B：原样
        let s199 = "a".repeat(199);
        assert_eq!(cmd_preview(&s199), s199);
        // 恰好 200B：原样（边界）
        let s200 = "x".repeat(200);
        assert_eq!(cmd_preview(&s200), s200);
    }

    #[test]
    fn test_cmd_preview_truncation_201_bytes() {
        // 超过 200B 1B：格式 "prefix...(+NB)"
        let s201 = "b".repeat(201);
        let out = cmd_preview(&s201);
        assert!(
            out.ends_with("...(+1B)"),
            "超 1B 应该尾加 ...(+1B)，实际尾={}",
            &out[out.len().saturating_sub(10)..]
        );
        assert_eq!(out.len(), 200 + 8); // prefix 200B + "...(+1B)" = 8
        assert_eq!(&out[..200], "b".repeat(200));
    }

    #[test]
    fn test_cmd_preview_truncation_large() {
        // 一个典型敏感场景：echo 超长 token / 密码
        let secret = "SENSITIVE_PASSWORD_TOKEN_XYZ";
        // 在 200 字节之后再拼 secret，确保 secret 段完全落在截断区之外
        let prefix = "echo ".to_string() + &"A".repeat(195); // prefix 199B
        let mut big = prefix;
        big.push(' '); // 200
        big.push_str(secret); // 200+
        let out = cmd_preview(&big);
        // 前缀部分仍在：必须以 "echo " 开头（200B 内）
        assert!(out.starts_with("echo "), "前缀应该保留: {}", &out[..50]);
        // secret 不应出现在最终日志预览里（如果出了就是截断边界错了）
        assert!(
            !out.contains(secret),
            "截断后的预览不应包含 200B 之后的敏感段。out={}",
            out
        );
        // 超出字节数必须与实际差值匹配
        assert!(
            out.contains(&format!("(+{}B)", big.len() - 200)),
            "超出字节数声明应精确。out={}",
            out
        );
    }

    #[test]
    fn test_cmd_preview_non_ascii_multibyte_uses_byte_length() {
        // 中文 3B/char：cmd_preview 必须正确处理，不能在 char 中间切分导致 panic。
        let zh = "中".repeat(100); // 100 chars × 3B = 300B
        let out = cmd_preview(&zh);
        // ① 不 panic 就已经过了核心测试（之前该 UT 因 panic 失败）
        // ② 因为 200B 正好落在第 67 个「中」的中间（66 完整 × 3B = 198B，第 67 个 中: 198..201），
        //    所以 floor 到 198B，extra = 300 - 198 = 102
        assert!(
            out.contains("(+102B)"),
            "非 ASCII floor 切分后的 extra 声明应精确。out={}",
            out
        );
        // ③ 前缀应该恰好由 66 个完整的「中」字组成（198B），不能出现乱码或替换字符
        let prefix: Vec<&str> = out.splitn(2, "...(+").collect();
        assert_eq!(prefix.len(), 2);
        assert_eq!(
            prefix[0].chars().count(),
            66,
            "前缀 chars 数应恰为 66 个完整中文字符"
        );
        assert!(
            prefix[0].chars().all(|c| c == '中'),
            "前缀字符应全部为「中」，实际前缀={}",
            prefix[0]
        );
    }
}
