use std::net::SocketAddr;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use super::model::TunnelErrorCode;
use crate::ssh::SharedHandle;

type TunnelResult<T> = Result<T, (TunnelErrorCode, String)>;

pub async fn run_local_forward(
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

    loop {
        let (mut incoming, _peer) = listener.accept().await.map_err(|e| {
            (
                TunnelErrorCode::SshChannelError,
                format!("accept failed: {}", e),
            )
        })?;

        let handle_clone = handle.clone();
        let remote_addr_clone = remote_addr.clone();
        tokio::spawn(async move {
            let _ = handle_local_connection(
                handle_clone,
                &mut incoming,
                &remote_addr_clone,
                remote_port,
            )
            .await;
        });
    }
}

async fn handle_local_connection(
    handle: SharedHandle,
    stream: &mut TcpStream,
    _remote_addr: &str,
    _remote_port: u16,
) -> TunnelResult<()> {
    let guard = handle.lock().await;
    let channel_res = guard.channel_open_session().await;
    let channel = match channel_res {
        Ok(c) => c,
        Err(_e) => {
            let _ = stream.shutdown().await;
            return Err((
                TunnelErrorCode::SshChannelError,
                "direct-tcpip channel open failed: RFC implementation pending".into(),
            ));
        }
    };
    drop(guard);

    drop(channel);
    let _ = stream.shutdown().await;
    Err((
        TunnelErrorCode::SshChannelError,
        "direct-tcpip: RFC implementation pending".into(),
    ))
}

pub async fn run_remote_forward(
    _handle: SharedHandle,
    _remote_addr: String,
    _remote_port: u16,
    _local_target_addr: String,
    _local_target_port: u16,
) -> TunnelResult<()> {
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    Err((
        TunnelErrorCode::SshChannelError,
        "forward-tcpip: RFC implementation pending".into(),
    ))
}

pub async fn run_dynamic_forward(
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

    loop {
        let (mut incoming, _peer) = listener.accept().await.map_err(|e| {
            (
                TunnelErrorCode::SshChannelError,
                format!("accept failed: {}", e),
            )
        })?;

        let handle_clone = handle.clone();
        tokio::spawn(async move {
            let _ = handle_dynamic_connection(handle_clone, &mut incoming).await;
        });
    }
}

async fn handle_dynamic_connection(
    handle: SharedHandle,
    stream: &mut TcpStream,
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

    let dst_addr = match atyp {
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
            format!("{}.{}.{}.{}", addr[0], addr[1], addr[2], addr[3])
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
            String::from_utf8_lossy(&domain).to_string()
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
            segs.join(":")
        }
        _ => {
            stream
                .write_all(&[5u8, 8u8, 0u8, 1u8, 0, 0, 0, 0, 0, 0])
                .await
                .ok();
            return Err((TunnelErrorCode::SshChannelError, "unsupported atyp".into()));
        }
    };

    let guard = handle.lock().await;
    let channel_res = guard.channel_open_session().await;
    let channel = match channel_res {
        Ok(c) => c,
        Err(_e) => {
            stream
                .write_all(&[5u8, 1u8, 0u8, 1u8, 0, 0, 0, 0, 0, 0])
                .await
                .ok();
            return Err((
                TunnelErrorCode::SshChannelError,
                "direct-tcpip channel open failed: RFC implementation pending".into(),
            ));
        }
    };
    drop(guard);

    drop(channel);
    let _ = dst_addr;
    stream
        .write_all(&[5u8, 1u8, 0u8, 1u8, 0, 0, 0, 0, 0, 0])
        .await
        .ok();
    let _ = stream.shutdown().await;
    Err((
        TunnelErrorCode::SshChannelError,
        "dynamic/direct-tcpip: RFC implementation pending".into(),
    ))
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
