//! PTY session lifecycle: channel creation, background read loop, and
//! write/resize/close operations.
//!
//! A [`PtySession`] owns a russh session channel (PTY + shell) and runs a
//! background tokio task that continuously reads channel output. Output is
//! scanned by [`OscParser`](super::parser::OscParser) to detect cwd-reporting
//! OSC sequences; the cleaned bytes are emitted to the frontend via the
//! `pty://data` event, and detected paths via `pty://cwd-changed`.
//!
//! Frontend input and resize requests are forwarded to the channel through an
//! unbounded mpsc channel; the read loop drains them in a `select!` alongside
//! `channel.wait()`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use russh::client::Msg;
use russh::{Channel, ChannelMsg};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::task::JoinHandle;

use super::parser::OscParser;
use super::{
    PtyClosedPayload, PtyCwdPayload, PtyDataPayload, CLOSED_EVENT, CWD_CHANGED_EVENT, DATA_EVENT,
};
use crate::{debug_log, LogLevel};

/// Commands sent from the foreground (Tauri commands) to the background read
/// loop. The loop owns the russh `Channel` and is the only place that calls
/// `channel.data()` / `channel.window_change()`, avoiding `&self` / `&mut self`
/// borrow conflicts with `channel.wait()`.
#[derive(Debug)]
enum PtyCommand {
    Write(Vec<u8>),
    Resize { cols: u32, rows: u32 },
}

/// One active PTY session for a host.
pub struct PtySession {
    cmd_tx: UnboundedSender<PtyCommand>,
    closed: Arc<AtomicBool>,
    task_handle: Option<JoinHandle<()>>,
}

impl PtySession {
    /// Open a PTY channel on the existing SSH session, request a shell,
    /// inject the PROMPT_COMMAND cwd-reporting hook, and spawn the background
    /// read loop.
    pub async fn create(
        host_id: String,
        tab_id: String,
        shared_handle: crate::ssh::SharedHandle,
        app: AppHandle,
    ) -> Result<Self, String> {
        debug_log(
            &app,
            LogLevel::Info,
            &format!("[PTY] 创建会话: host_id={} tab_id={}", host_id, tab_id),
        );

        // --- Open channel + request PTY + shell -------------------------------
        let channel = {
            let handle = shared_handle.lock().await;
            handle.channel_open_session().await.map_err(|e| {
                let msg = format!("open session channel: {e}");
                debug_log(
                    &app,
                    LogLevel::Error,
                    &format!(
                        "[PTY] 打开 channel 失败: host_id={} tab_id={} - {}",
                        host_id, tab_id, msg
                    ),
                );
                msg
            })?
        };

        // Use want_reply=false — some SSH servers don't send SSH_MSG_CHANNEL_SUCCESS
        // for pty/shell requests, causing want_reply=true to hang/fail.
        channel
            .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .map_err(|e| {
                let msg = format!("request pty: {e}");
                debug_log(
                    &app,
                    LogLevel::Error,
                    &format!(
                        "[PTY] 请求 PTY 失败: host_id={} tab_id={} - {}",
                        host_id, tab_id, msg
                    ),
                );
                msg
            })?;

        channel.request_shell(false).await.map_err(|e| {
            let msg = format!("request shell: {e}");
            debug_log(
                &app,
                LogLevel::Error,
                &format!(
                    "[PTY] 请求 shell 失败: host_id={} tab_id={} - {}",
                    host_id, tab_id, msg
                ),
            );
            msg
        })?;

        // --- Inject PROMPT_COMMAND -------------------------------------------
        // Wait longer for the shell to fully start before sending PROMPT_COMMAND.
        tokio::time::sleep(Duration::from_millis(300)).await;
        // 使用 raw 字符串（r#...#）保留字面量反斜杠，让 shell printf 自行解析
        // \033（八进制 ESC）和 \007（八进制 BEL）是 shell printf 的转义格式。
        //
        // history 隔离方案：先设置 HISTCONTROL=ignorespace，之后所有以空格开头的
        // 命令都不会被记录到 history 中。set +o history 的问题是它对自己无效
        // （执行前就已经被记录了）。最后 history -c 清掉第一行（设置 HISTCONTROL
        // 本身），clear 清空屏幕，只留下干净的提示符。
        let init = r#"export HISTCONTROL="${HISTCONTROL:+$HISTCONTROL:}ignorespace"
 export PROMPT_COMMAND='printf "\033]7777;cwd;%s\007" "$PWD"'
 history -c
 clear
"#;
        channel.data(init.as_bytes()).await.map_err(|e| {
            let msg = format!("send prompt_command: {e}");
            debug_log(
                &app,
                LogLevel::Error,
                &format!(
                    "[PTY] 注入 PROMPT_COMMAND 失败: host_id={} tab_id={} - {}",
                    host_id, tab_id, msg
                ),
            );
            msg
        })?;

        // --- Spawn read loop --------------------------------------------------
        let (cmd_tx, cmd_rx) = tokio::sync::mpsc::unbounded_channel();
        let closed = Arc::new(AtomicBool::new(false));

        let task_handle = tokio::spawn(read_loop(
            host_id.clone(),
            tab_id.clone(),
            channel,
            cmd_rx,
            app.clone(),
            closed.clone(),
        ));
        debug_log(
            &app,
            LogLevel::Info,
            &format!("[PTY] 会话就绪: host_id={} tab_id={}", host_id, tab_id),
        );

        Ok(Self {
            cmd_tx,
            closed,
            task_handle: Some(task_handle),
        })
    }

    /// Send user input (keystrokes) to the PTY.
    pub fn write(&self, data: Vec<u8>) -> Result<(), String> {
        if self.is_closed() {
            return Err("terminal closed".to_string());
        }
        self.cmd_tx
            .send(PtyCommand::Write(data))
            .map_err(|_| "terminal closed".to_string())
    }

    /// Request a PTY window-size change.
    pub fn resize(&self, cols: u32, rows: u32) -> Result<(), String> {
        if self.is_closed() {
            return Err("terminal closed".to_string());
        }
        self.cmd_tx
            .send(PtyCommand::Resize { cols, rows })
            .map_err(|_| "terminal closed".to_string())
    }

    /// `true` if the background read loop has exited (channel closed).
    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    /// Shut down the session: signal the read loop to stop and wait for it.
    /// Consumes `self` — the session should already be removed from the state
    /// map by the caller.
    pub async fn shutdown(mut self) {
        // Dropping cmd_tx causes cmd_rx.recv() to return None in the read
        // loop, which triggers a clean channel close.
        drop(self.cmd_tx);
        if let Some(handle) = self.task_handle.take() {
            // Bound the wait so a stuck channel can't hang the command.
            let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
        }
    }
}

/// Background read loop. Owns the russh `Channel` and multiplexes:
/// - `channel.wait()`: incoming PTY output (stdout/stderr/EOF/close).
/// - `cmd_rx`: write/resize requests from the foreground.
///
/// When the channel closes (EOF, Close, or `wait()` returns `None`), the loop
/// sets the shared `closed` flag and emits `pty://closed`.
async fn read_loop(
    host_id: String,
    tab_id: String,
    mut channel: Channel<Msg>,
    mut cmd_rx: UnboundedReceiver<PtyCommand>,
    app: AppHandle,
    closed: Arc<AtomicBool>,
) {
    let mut parser = OscParser::new();

    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { ref data }) => {
                        handle_output(&host_id, &tab_id, &app, &mut parser, data);
                    }
                    Some(ChannelMsg::ExtendedData { ref data, .. }) => {
                        handle_output(&host_id, &tab_id, &app, &mut parser, data);
                    }
                    Some(ChannelMsg::Eof) => {
                        debug_log(
                            &app,
                            LogLevel::Info,
                            &format!("[PTY] 收到 EOF: host_id={} tab_id={}", host_id, tab_id),
                        );
                        break;
                    }
                    Some(ChannelMsg::Close) => {
                        debug_log(
                            &app,
                            LogLevel::Info,
                            &format!("[PTY] 收到 CLOSE: host_id={} tab_id={}", host_id, tab_id),
                        );
                        break;
                    }
                    None => {
                        debug_log(
                            &app,
                            LogLevel::Warn,
                            &format!("[PTY] channel.wait() 返回 None: host_id={} tab_id={}", host_id, tab_id),
                        );
                        break;
                    }
                    other => {
                        debug_log(
                            &app,
                            LogLevel::Info,
                            &format!("[PTY] channel 消息: {:?} host_id={} tab_id={}", std::mem::discriminant(&other), host_id, tab_id),
                        );
                    }
                }
            }
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(PtyCommand::Write(data)) => {
                        if let Err(e) = channel.data(&data[..]).await {
                            debug_log(
                                &app,
                                LogLevel::Error,
                                &format!("[PTY] 写入失败: host_id={} tab_id={} - {}", host_id, tab_id, e),
                            );
                            break;
                        }
                    }
                    Some(PtyCommand::Resize { cols, rows }) => {
                        let _ = channel.window_change(cols, rows, 0, 0).await;
                    }
                    None => {
                        debug_log(
                            &app,
                            LogLevel::Info,
                            &format!("[PTY] cmd_tx 已关闭，正在退出: host_id={} tab_id={}", host_id, tab_id),
                        );
                        let _ = channel.eof().await;
                        let _ = channel.close().await;
                        break;
                    }
                }
            }
        }
    }

    debug_log(
        &app,
        LogLevel::Info,
        &format!(
            "[PTY] read_loop 已退出: host_id={} tab_id={}",
            host_id, tab_id
        ),
    );
    closed.store(true, Ordering::Release);
    let _ = app.emit(
        CLOSED_EVENT,
        &PtyClosedPayload {
            host_id: host_id.clone(),
            tab_id: tab_id.clone(),
        },
    );
}

/// Feed a chunk of PTY output through the OSC parser, emit the cleaned bytes
/// as `pty://data`, and emit `pty://cwd-changed` for each detected path.
#[inline]
fn handle_output(
    host_id: &str,
    tab_id: &str,
    app: &AppHandle,
    parser: &mut OscParser,
    data: &[u8],
) {
    if data.is_empty() {
        return;
    }
    let (clean, paths) = parser.feed(data);
    if !clean.is_empty() {
        let _ = app.emit(
            DATA_EVENT,
            &PtyDataPayload {
                host_id: host_id.to_string(),
                tab_id: tab_id.to_string(),
                data: clean,
            },
        );
    }
    for path in paths {
        let _ = app.emit(
            CWD_CHANGED_EVENT,
            &PtyCwdPayload {
                host_id: host_id.to_string(),
                tab_id: tab_id.to_string(),
                path,
            },
        );
    }
}

/// Escape a string for safe use inside POSIX single quotes.
///
/// `it's here` → `'it'\''s here'` (close quote, escaped quote, reopen quote).
pub(crate) fn shell_escape_single(input: &str) -> String {
    let mut result = String::with_capacity(input.len() + 2);
    result.push('\'');
    for c in input.chars() {
        if c == '\'' {
            result.push_str("'\\''");
        } else {
            result.push(c);
        }
    }
    result.push('\'');
    result
}

#[cfg(test)]
mod tests {
    use super::shell_escape_single;

    #[test]
    fn simple_path() {
        assert_eq!(shell_escape_single("/home/user"), "'/home/user'");
    }

    #[test]
    fn path_with_single_quote() {
        assert_eq!(shell_escape_single("it's here"), "'it'\\''s here'");
    }

    #[test]
    fn empty_string() {
        assert_eq!(shell_escape_single(""), "''");
    }
}
