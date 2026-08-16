use std::net::SocketAddr;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::model::TunnelErrorCode;
use crate::debug_log;
use crate::ssh::{RemoteForwardRegistry, RemoteForwardTarget, SharedHandle};
use crate::LogLevel;

type TunnelResult<T> = Result<T, (TunnelErrorCode, String)>;

pub async fn run_local_forward(
    app: &tauri::AppHandle,
    handle: SharedHandle,
    local_addr: String,
    local_port: u16,
    remote_addr: String,
    remote_port: u16,
) -> TunnelResult<()> {
    let bind_addr: SocketAddr = format!("{}:{}", local_addr, local_port)
        .parse()
        .map_err(|e| {
            (
                TunnelErrorCode::AddrInvalid,
                format!("bind address parse failed: {}", e),
            )
        })?;

    let listener = TcpListener::bind(bind_addr).await.map_err(|e| {
        (
            TunnelErrorCode::PortInUse,
            format!("bind port {} failed: {}", local_port, e),
        )
    })?;

    debug_log(
        app,
        LogLevel::Info,
        &format!(
            "tunnel_forward local 已监听: {}:{} -> 目标 {}:{} (direct-tcpip)",
            local_addr, local_port, remote_addr, remote_port
        ),
    );

    loop {
        let (incoming, peer) = listener.accept().await.map_err(|e| {
            (
                TunnelErrorCode::SshChannelError,
                format!("accept failed: {}", e),
            )
        })?;

        debug_log(
            app,
            LogLevel::Info,
            &format!(
                "tunnel_forward local 收到连接: peer={}, 目标 {}:{}",
                peer, remote_addr, remote_port
            ),
        );

        let handle_clone = handle.clone();
        let remote_addr_clone = remote_addr.clone();
        let app_clone = app.clone();
        tokio::spawn(async move {
            let _ = handle_local_connection(
                &app_clone,
                handle_clone,
                incoming,
                &remote_addr_clone,
                remote_port,
            )
            .await;
        });
    }
}

async fn handle_local_connection(
    app: &tauri::AppHandle,
    handle: SharedHandle,
    mut stream: TcpStream,
    remote_addr: &str,
    remote_port: u16,
) -> TunnelResult<()> {
    let (origin, origin_port) = match stream.peer_addr() {
        Ok(p) => (p.ip().to_string(), p.port() as u32),
        Err(_) => ("127.0.0.1".to_string(), 0),
    };

    // Open a direct-tcpip channel: the SSH server connects to the target on
    // our behalf, and the channel streams the raw bytes both ways.
    // 读锁：channel_open_* 是 &self 操作，可与 SFTP/PTY 的通道打开并发，
    // 不会在服务器连接目标端口期间阻塞整个 SSH 会话。
    let guard = handle.read().await;
    let channel = guard
        .channel_open_direct_tcpip(
            remote_addr.to_string(),
            remote_port as u32,
            origin,
            origin_port,
        )
        .await
        .map_err(|e| {
            debug_log(
                app,
                LogLevel::Error,
                &format!(
                    "tunnel_forward local direct-tcpip 通道打开失败: 目标 {}:{} - {}",
                    remote_addr, remote_port, e
                ),
            );
            (
                TunnelErrorCode::SshChannelError,
                format!("direct-tcpip channel open failed: {}", e),
            )
        })?;
    drop(guard);

    debug_log(
        app,
        LogLevel::Info,
        &format!(
            "tunnel_forward local 转发已建立: 目标 {}:{}",
            remote_addr, remote_port
        ),
    );

    let mut chan_stream = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut stream, &mut chan_stream).await;

    debug_log(
        app,
        LogLevel::Info,
        &format!(
            "tunnel_forward local 连接结束: 目标 {}:{}",
            remote_addr, remote_port
        ),
    );

    Ok(())
}

pub async fn run_remote_forward(
    app: &tauri::AppHandle,
    handle: SharedHandle,
    registry: RemoteForwardRegistry,
    remote_addr: String,
    remote_port: u16,
    local_target_addr: String,
    local_target_port: u16,
) -> TunnelResult<()> {
    // Register the local target first so the handler can route forwarded
    // connections the moment the server accepts the tcpip-forward request.
    let key = (remote_addr.clone(), remote_port as u32);
    let target = RemoteForwardTarget {
        local_addr: local_target_addr.clone(),
        local_port: local_target_port,
    };
    {
        let mut reg = registry.lock().expect("remote_forwards mutex poisoned");
        reg.insert(key.clone(), target.clone());
    }

    debug_log(
        app,
        LogLevel::Info,
        &format!(
            "tunnel_forward remote 已注册目标: 请求服务器 {}:{} -> 本地 {}:{}",
            remote_addr, remote_port, local_target_addr, local_target_port
        ),
    );

    // Ask the SSH server to listen on remote_addr:remote_port and forward
    // accepted connections back to us over forwarded-tcpip channels.
    // tcpip_forward 是 &mut self 操作 → 写锁（一次性、耗时短）。
    let mut guard = handle.write().await;
    let bound_port_raw = guard
        .tcpip_forward(remote_addr.clone(), remote_port as u32)
        .await
        .map_err(|e| {
            // The server rejecting a tcpip-forward request is almost always a
            // server-side condition, not a client bug — surface the likely
            // causes so the user can fix the server instead of retrying blind.
            let hint = if matches!(&e, russh::Error::RequestDenied) {
                "；服务器拒绝了该请求：可能是 sshd_config 禁用了转发 (AllowTcpForwarding no / PermitOpen 限制)，或服务器端口已被其他会话/进程占用"
            } else {
                ""
            };
            debug_log(
                app,
                LogLevel::Error,
                &format!(
                    "tunnel_forward remote tcpip_forward 失败: {}:{} - {}{}",
                    remote_addr, remote_port, e, hint
                ),
            );
            (
                TunnelErrorCode::SshChannelError,
                format!("tcpip_forward failed: {}{}", e, hint),
            )
        })?;
    drop(guard);

    // SSH 协议：tcpip_forward 返回的 bound_port
    //   - 如果客户端请求 port != 0，服务器通常返回同一个端口作为确认；
    //     部分 russh / 服务器实现返回 0，表示"绑定成功，端口 = 请求端口"。
    //   - 如果客户端请求 port == 0（动态分配），服务器返回实际分配的端口。
    // 统一归约：bound_port_raw == 0 时视为等于 remote_port。
    let actual_port = if bound_port_raw == 0 {
        remote_port as u32
    } else {
        bound_port_raw
    };

    // 如果服务器实际分配的端口 != 请求端口（动态分配 or 服务器换了），
    // 必须更新 registry 的 key，否则 handler 收到 connected_port 匹配不上。
    // 同时更新 RemoteForwardGuard 的 key，确保 cancel/cleanup 也用正确端口。
    let guard_key = if actual_port != remote_port as u32 {
        let old_key = key;
        let new_key = (remote_addr.clone(), actual_port);
        {
            let mut reg = registry.lock().expect("remote_forwards mutex poisoned");
            reg.remove(&old_key);
            reg.insert(new_key.clone(), target);
        }
        debug_log(
            app,
            LogLevel::Info,
            &format!(
                "tunnel_forward remote 端口重映射: 请求 {} -> 实际绑定 {}",
                remote_port, actual_port
            ),
        );
        new_key
    } else {
        key.clone()
    };

    // Removes the registry entry and best-effort cancels the server-side
    // listener when this task ends (including on abort).
    // 注意：guard_key 用于后续 cancel（cancel_tcpip_forward 传的是实际端口）；
    //       registry 清理也用同一个 guard_key。
    let _guard = RemoteForwardGuard {
        registry: registry.clone(),
        handle: handle.clone(),
        key: guard_key,
    };

    debug_log(
        app,
        LogLevel::Info,
        &format!(
            "tunnel_forward remote 已监听: 服务器 {}:{} (请求端口={}, bound_port_raw={}) -> 本地 {}:{}",
            remote_addr, actual_port, remote_port, bound_port_raw, local_target_addr, local_target_port
        ),
    );

    // Keep the task alive until it is aborted (tunnel stop / host close).
    std::future::pending::<()>().await;

    Ok(())
}

/// RAII guard that cleans up a remote forward when its task ends (including
/// on abort): removes the registry entry and best-effort cancels the
/// server-side listener.
struct RemoteForwardGuard {
    registry: RemoteForwardRegistry,
    handle: SharedHandle,
    key: (String, u32),
}

impl Drop for RemoteForwardGuard {
    fn drop(&mut self) {
        {
            let mut reg = self
                .registry
                .lock()
                .expect("remote_forwards mutex poisoned");
            reg.remove(&self.key);
        }
        // Best-effort cancel of the server-side listener (ignored if the
        // connection is already gone).
        let handle = self.handle.clone();
        let addr = self.key.0.clone();
        let port = self.key.1;
        tokio::spawn(async move {
            let guard = handle.read().await;
            let _ = guard.cancel_tcpip_forward(addr, port).await;
        });
    }
}

pub async fn run_dynamic_forward(
    app: &tauri::AppHandle,
    handle: SharedHandle,
    local_addr: String,
    local_port: u16,
) -> TunnelResult<()> {
    let bind_addr: SocketAddr = format!("{}:{}", local_addr, local_port)
        .parse()
        .map_err(|e| {
            (
                TunnelErrorCode::AddrInvalid,
                format!("bind address parse failed: {}", e),
            )
        })?;

    let listener = TcpListener::bind(bind_addr).await.map_err(|e| {
        (
            TunnelErrorCode::PortInUse,
            format!("bind port {} failed: {}", local_port, e),
        )
    })?;

    debug_log(
        app,
        LogLevel::Info,
        &format!(
            "tunnel_forward dynamic 已监听: {}:{} (SOCKS5)",
            local_addr, local_port
        ),
    );

    loop {
        let (incoming, peer) = listener.accept().await.map_err(|e| {
            (
                TunnelErrorCode::SshChannelError,
                format!("accept failed: {}", e),
            )
        })?;

        debug_log(
            app,
            LogLevel::Info,
            &format!("tunnel_forward dynamic 收到连接: peer={}", peer),
        );

        let handle_clone = handle.clone();
        let app_clone = app.clone();
        tokio::spawn(async move {
            let _ = handle_dynamic_connection(&app_clone, handle_clone, incoming).await;
        });
    }
}

async fn handle_dynamic_connection(
    app: &tauri::AppHandle,
    handle: SharedHandle,
    mut stream: TcpStream,
) -> TunnelResult<()> {
    let mut buf = [0u8; 2];
    stream.read_exact(&mut buf).await.map_err(|e| {
        (
            TunnelErrorCode::SshChannelError,
            format!("socks5 read ver/nmethods failed: {}", e),
        )
    })?;
    let ver = buf[0];
    let nmethods = buf[1];
    if ver != 5 {
        return Err((
            TunnelErrorCode::SshChannelError,
            "unsupported socks version".into(),
        ));
    }
    let mut methods = vec![0u8; nmethods as usize];
    stream.read_exact(&mut methods).await.map_err(|e| {
        (
            TunnelErrorCode::SshChannelError,
            format!("socks5 read methods failed: {}", e),
        )
    })?;

    stream.write_all(&[5u8, 0u8]).await.map_err(|e| {
        (
            TunnelErrorCode::SshChannelError,
            format!("socks5 auth resp failed: {}", e),
        )
    })?;

    let mut req_hdr = [0u8; 4];
    stream.read_exact(&mut req_hdr).await.map_err(|e| {
        (
            TunnelErrorCode::SshChannelError,
            format!("socks5 read req hdr failed: {}", e),
        )
    })?;
    let cmd = req_hdr[1];
    let atyp = req_hdr[3];
    if cmd != 1 {
        stream
            .write_all(&[5u8, 7u8, 0u8, 1u8, 0, 0, 0, 0, 0, 0])
            .await
            .ok();
        return Err((
            TunnelErrorCode::SshChannelError,
            "only CONNECT cmd supported".into(),
        ));
    }

    let (dst_addr, dst_port) = match atyp {
        1 => {
            let mut addr = [0u8; 4];
            stream.read_exact(&mut addr).await.map_err(|e| {
                (
                    TunnelErrorCode::SshChannelError,
                    format!("socks5 read v4 addr failed: {}", e),
                )
            })?;
            let mut port = [0u8; 2];
            stream.read_exact(&mut port).await.map_err(|e| {
                (
                    TunnelErrorCode::SshChannelError,
                    format!("socks5 read port failed: {}", e),
                )
            })?;
            (
                format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3]),
                u16::from_be_bytes(port),
            )
        }
        3 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await.map_err(|e| {
                (
                    TunnelErrorCode::SshChannelError,
                    format!("socks5 read domain len failed: {}", e),
                )
            })?;
            let mut domain = vec![0u8; len[0] as usize];
            stream.read_exact(&mut domain).await.map_err(|e| {
                (
                    TunnelErrorCode::SshChannelError,
                    format!("socks5 read domain failed: {}", e),
                )
            })?;
            let mut port = [0u8; 2];
            stream.read_exact(&mut port).await.map_err(|e| {
                (
                    TunnelErrorCode::SshChannelError,
                    format!("socks5 read port failed: {}", e),
                )
            })?;
            (
                String::from_utf8_lossy(&domain).to_string(),
                u16::from_be_bytes(port),
            )
        }
        4 => {
            let mut addr = [0u8; 16];
            stream.read_exact(&mut addr).await.map_err(|e| {
                (
                    TunnelErrorCode::SshChannelError,
                    format!("socks5 read v6 addr failed: {}", e),
                )
            })?;
            let mut port = [0u8; 2];
            stream.read_exact(&mut port).await.map_err(|e| {
                (
                    TunnelErrorCode::SshChannelError,
                    format!("socks5 read port failed: {}", e),
                )
            })?;
            let segs: Vec<String> = (0..8)
                .map(|i| format!("{:x}", u16::from_be_bytes([addr[i * 2], addr[i * 2 + 1]])))
                .collect();
            (segs.join(":"), u16::from_be_bytes(port))
        }
        _ => {
            stream
                .write_all(&[5u8, 8u8, 0u8, 1u8, 0, 0, 0, 0, 0, 0])
                .await
                .ok();
            return Err((TunnelErrorCode::SshChannelError, "unsupported atyp".into()));
        }
    };

    debug_log(
        app,
        LogLevel::Info,
        &format!(
            "tunnel_forward dynamic SOCKS5 握手完成: 目标 {}:{}",
            dst_addr, dst_port
        ),
    );

    let (origin, origin_port) = match stream.peer_addr() {
        Ok(p) => (p.ip().to_string(), p.port() as u32),
        Err(_) => ("127.0.0.1".to_string(), 0),
    };

    let guard = handle.read().await;
    let channel = match guard
        .channel_open_direct_tcpip(dst_addr.clone(), dst_port as u32, origin, origin_port)
        .await
    {
        Ok(c) => c,
        Err(e) => {
            debug_log(
                app,
                LogLevel::Error,
                &format!(
                    "tunnel_forward dynamic direct-tcpip 通道打开失败: 目标 {}:{} - {}",
                    dst_addr, dst_port, e
                ),
            );
            stream
                .write_all(&[5u8, 1u8, 0u8, 1u8, 0, 0, 0, 0, 0, 0])
                .await
                .ok();
            return Err((
                TunnelErrorCode::SshChannelError,
                format!("direct-tcpip channel open failed: {}", e),
            ));
        }
    };
    drop(guard);

    // SOCKS5 success reply (BND.ADDR/BND.PORT unused).
    stream
        .write_all(&[5u8, 0u8, 0u8, 1u8, 0, 0, 0, 0, 0, 0])
        .await
        .map_err(|e| {
            (
                TunnelErrorCode::SshChannelError,
                format!("socks5 reply failed: {}", e),
            )
        })?;

    debug_log(
        app,
        LogLevel::Info,
        &format!(
            "tunnel_forward dynamic 转发已建立: 目标 {}:{}",
            dst_addr, dst_port
        ),
    );

    let mut chan_stream = channel.into_stream();
    let _ = tokio::io::copy_bidirectional(&mut stream, &mut chan_stream).await;

    debug_log(
        app,
        LogLevel::Info,
        &format!(
            "tunnel_forward dynamic 连接结束: 目标 {}:{}",
            dst_addr, dst_port
        ),
    );

    Ok(())
}

pub async fn bind_listener_only(local_addr: String, local_port: u16) -> TunnelResult<TcpListener> {
    let bind_addr: SocketAddr = format!("{}:{}", local_addr, local_port)
        .parse()
        .map_err(|e| {
            (
                TunnelErrorCode::AddrInvalid,
                format!("bind address parse failed: {}", e),
            )
        })?;

    TcpListener::bind(bind_addr).await.map_err(|e| {
        (
            TunnelErrorCode::PortInUse,
            format!("bind port {} failed: {}", local_port, e),
        )
    })
}
