<p align="center">
  <img src="src-tauri/icons/icon.png" width="96" height="96" alt="RD" style="border-radius: 20px;" />
</p>

<h1 align="center">RD</h1>

<p align="center">
  <a href="https://github.com/zhangOranges/RD/actions/workflows/ci.yml">
    <img src="https://github.com/zhangOranges/RD/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/zhangOranges/RD/releases/latest">
    <img src="https://img.shields.io/github/v/tag/zhangOranges/RD?label=latest&color=blue" alt="Release" />
  </a>
  <a href="https://github.com/zhangOranges/RD/releases">
    <img src="https://img.shields.io/github/downloads/zhangOranges/RD/total" alt="Downloads" />
  </a>
  <a href="https://github.com/zhangOranges/RD/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue" alt="License" />
  </a>
  <a href="https://github.com/zhangOranges/RD/stargazers">
    <img src="https://img.shields.io/github/stars/zhangOranges/RD?style=social" alt="Stars" />
  </a>
</p>

<p align="center">
  Cross-platform SSH/SFTP remote file manager — local·remote dual-pane · server monitoring · integrated terminal, built with <strong>Tauri 2 + Rust + React</strong>.<br>
  Free and open source, runs fully locally, no account, no telemetry.
</p>

<p align="center">
  <a href="#download">Download</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#features">Features</a> ·
  <a href="#plugin-system">Plugins</a> ·
  <a href="#security">Security</a> ·
  <a href="#tech-stack">Tech Stack</a> ·
  <a href="#build">Build</a> ·
  <a href="#testing">Testing</a>
</p>

---

## Download

Visit [GitHub Releases](https://github.com/zhangOranges/RD/releases) to download the installer for your platform.

| Platform | Format |
|---|---|
| Windows 10/11 x64 | `.exe` |
| macOS 12+ (Apple Silicon) | `.dmg` |
| Linux x64 (glibc) | `.deb` / `.AppImage` |

## Quick Start

```bash
git clone https://github.com/zhangOranges/RD.git
cd RD
npm install
npm run tauri dev
```

Requirements: Node.js 22+, Rust stable. On Linux, additionally install `libwebkit2gtk-4.1-dev` and other dependencies — see the Tauri official docs.

## Features

- **Fixed five-zone layout** — host list + local/remote dual-pane + server monitoring + transfer queue + integrated terminal, tab-based host switching
- **Smart auto-reconnect** — exponential backoff (2s→4s→8s→16s→30s, up to 10 attempts), multi-layer network detection
- **Folder compressed transfer** — upload/download auto-compress → transfer → decompress, temp files in target directory, transparent progress
- **256KB chunked streaming** — progress bar and speed shown from the first chunk
- **Server hardware info** — CPU / memory / disk / load / uptime, auto-refresh every 15s
- **PTY integrated terminal** — xterm.js, auto-sync with file browser, auto-recovery on disconnect
- **Visual themes** — 5 presets + custom palette + drag-to-position background image, zero-flicker startup
- **Per-host independent state** — each tab has its own connection / terminal / path memory
- **Auto-update** — GitHub direct + gh-proxy dual-mirror speed test, auto-select fastest source
- **i18n** — Chinese and English UI with in-app language switcher

### Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+,` / `Cmd+,` | Open settings |
| `Ctrl+\`` / `Cmd+\`` | Toggle terminal |
| `F5` / `Ctrl+R` | Refresh current directory |
| `Ctrl+S` | Save file |
| `Esc` | Close dialog / cancel edit |

## Plugin System

RD has a three-layer plugin architecture supporting third-party plugins installed from a directory or `.rdplugin` (zip) files.

- **iframe sandbox** — each plugin runs in an isolated iframe, cross-context communication via `MessageChannel`
- **Permission-based** — manifest explicitly declares 17 permission types, risk levels shown at install, revocable anytime
- **Storage quotas** — single value ≤ 256KB, total storage ≤ 8MB, single file ≤ 1MB
- **Watchdog** — 2s ping / 5s freeze detection, auto-unload if memory > 200MB

SDK capability groups: Server / Theme / UI / Storage / Network / SSH / SFTP / Tunnel / Log / Event Bus. All APIs enforce permission assertions.

Built-in plugin: **Port Forwarding** (local -L / remote -R / dynamic -D SOCKS5, rule import/export).

## Security

- **Credential isolation** — plugins cannot access host passwords/private keys, only `has_password` / `has_private_key` booleans are exposed
- **Dual-layer permission checks** — frontend `assertPermission` + Rust `plugin_assert_perm`, both return `PERMISSION_DENIED` on denial
- **Path traversal protection** — plugin IDs reject `..`, `/`, `\`, NTFS ADS colons
- **SSRF interception** — `http.request` blocks internal IPs / localhost by default
- **SSH fingerprint verification** — server SHA-256 fingerprint captured on connect
- **Log redaction** — command logs truncated to 200 bytes
- **Sensitive info masking** — IP/port/username/path can be blurred with one click

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 · TypeScript 5.8 · Vite 7 · Zustand 5 |
| Terminal | xterm.js 6 |
| Backend | Rust · Tauri 2 |
| SSH/SFTP | russh 0.45 · russh-sftp 2.0 |
| Testing | Vitest 2 · cargo test |

## Build

```bash
# Local build
npm run tauri build
# Output: src-tauri/target/release/bundle/
```

CI (GitHub Actions): `ci.yml` runs frontend tsc + build and Rust fmt/check/clippy; `release.yml` builds three-platform artifacts on tag.

## Testing

```bash
# Frontend unit tests (78 cases)
npm test

# Rust backend unit tests (56 cases)
cd src-tauri && cargo test --lib

# Type check
npx tsc --noEmit
```

Frontend test coverage: host credential redaction, XSS protection, SSRF protection, plugin permission checks, lifecycle, event isolation, path join, etc.
Rust test coverage: permission checks, manifest validation, path traversal, storage quotas, uninstall cleanup, SFTP chunking, terminal parsing, etc.

---

<p align="center">
  <a href="https://github.com/zhangOranges/RD/issues">Feedback</a> ·
  <a href="https://github.com/zhangOranges/RD/releases">Download</a> ·
  <a href="https://github.com/zhangOranges/RD">GitHub</a>
</p>

<p align="center">
  <sub>MIT License · Built with ❤️</sub>
</p>
