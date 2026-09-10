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
  跨平台 SSH/SFTP 远程文件管理器 — 本地·远程双面板 · 服务器监控 · 集成终端，基于 <strong>Tauri 2 + Rust + React</strong> 构建。<br>
  免费开源，纯本地运行，无账号无遥测。
</p>

<p align="center">
  <a href="#下载安装">下载</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#功能">功能</a> ·
  <a href="#插件系统">插件</a> ·
  <a href="#安全">安全</a> ·
  <a href="#技术栈">技术栈</a> ·
  <a href="#构建">构建</a> ·
  <a href="#测试">测试</a>
</p>

---

## 下载安装

前往 [GitHub Releases](https://github.com/zhangOranges/RD/releases) 下载对应平台安装包。

| 平台 | 格式 |
|---|---|
| Windows 10/11 x64 | `.exe` |
| macOS 12+（Apple Silicon） | `.dmg` |
| Linux x64（glibc） | `.deb` / `.AppImage` |

## 快速开始

```bash
git clone https://github.com/zhangOranges/RD.git
cd RD
npm install
npm run tauri dev
```

环境要求：Node.js 22+、Rust stable。Linux 需额外安装 `libwebkit2gtk-4.1-dev` 等依赖，详见 Tauri 官方文档。

## 功能

- **五区固定布局** — 主机列表 + 本地/远程双面板 + 服务器监控 + 传输队列 + 集成终端，Tab 切换主机
- **智能断线重连** — 指数退避自动重连（2s→4s→8s→16s→30s，最多 10 次），多层面网络检测
- **文件夹压缩传输** — 上传/下载自动压缩→传输→解压，临时文件位于目标目录，进度透明
- **256KB 分片流式传输** — 首片即显示进度条/速率
- **服务器硬件信息** — CPU / 内存 / 磁盘 / 负载 / 运行时长，每 15s 自动刷新
- **PTY 集成终端** — xterm.js，目录与文件浏览器自动同步，断线自动恢复
- **可视化主题** — 5 套预设 + 自定义调色板 + 背景图拖拽定位，启动零闪烁
- **多主机独立状态** — 每个 Tab 独立连接/终端/路径记忆
- **自动更新** — GitHub 直连 + gh-proxy 双镜像测速，自动选最快源

### 快捷键

| 快捷键 | 功能 |
|---|---|
| `Ctrl+,` / `Cmd+,` | 打开设置 |
| `Ctrl+\`` / `Cmd+\`` | 切换终端 |
| `F5` / `Ctrl+R` | 刷新当前目录 |
| `Ctrl+S` | 保存文件 |
| `Esc` | 关闭弹窗 / 取消编辑 |

## 插件系统

RD 内置三层插件架构，支持从目录或 `.rdplugin`（zip）安装第三方插件。

- **iframe 沙箱** — 每个插件运行在独立 iframe，跨上下文通过 `MessageChannel` 通信
- **权限声明制** — manifest 显式声明 17 类权限，安装时展示风险等级，可随时撤销
- **存储配额** — 单值 ≤ 256KB，总存储 ≤ 8MB，单文件 ≤ 1MB
- **看门狗** — 2s ping / 5s 卡死禁用，内存 > 200MB 自动卸载

SDK 能力分组：Server / Theme / UI / Storage / Network / SSH / SFTP / Tunnel / Log / 事件总线，所有 API 前置权限断言。

内置插件：**端口转发**（local -L / remote -R / dynamic -D SOCKS5，规则导入导出）。

## 安全

- **凭据隔离** — 插件无法获取主机密码/私钥，仅暴露 `has_password` / `has_private_key` 布尔值
- **双层权限校验** — 前端 `assertPermission` + Rust `plugin_assert_perm`，拒绝均返回 `PERMISSION_DENIED`
- **路径穿越防护** — 插件 ID 拒绝 `..`、`/`、`\`、NTFS ADS 冒号
- **SSRF 拦截** — `http.request` 默认拦截内网 IP / localhost
- **SSH 指纹验证** — 连接时获取服务端 SHA-256 指纹
- **日志脱敏** — 命令日志截断至 200 字节
- **敏感信息打码** — 界面 IP/端口/用户名/路径可一键 blur

## 技术栈

| 层级 | 技术 |
|---|---|
| 前端 | React 19 · TypeScript 5.8 · Vite 7 · Zustand 5 |
| 终端 | xterm.js 6 |
| 后端 | Rust · Tauri 2 |
| SSH/SFTP | russh 0.45 · russh-sftp 2.0 |
| 测试 | Vitest 2 · cargo test |

## 构建

```bash
# 本地构建
npm run tauri build
# 产物：src-tauri/target/release/bundle/
```

CI（GitHub Actions）：`ci.yml` 做前端 tsc + build 与 Rust fmt/check/clippy；`release.yml` 打 tag 后构建三平台产物。

## 测试

```bash
# 前端单元测试（78 用例）
npm test

# Rust 后端单元测试（56 用例）
cd src-tauri && cargo test --lib

# 类型检查
npx tsc --noEmit
```

前端测试覆盖：主机凭据脱敏、XSS 防护、SSRF 防护、插件权限校验、生命周期、事件隔离、路径拼接等。
Rust 测试覆盖：权限校验、清单校验、路径穿越、存储配额、卸载清理、SFTP 分块、终端解析等。

---

<p align="center">
  <a href="https://github.com/zhangOranges/RD/issues">反馈</a> ·
  <a href="https://github.com/zhangOranges/RD/releases">下载</a> ·
  <a href="https://github.com/zhangOranges/RD">GitHub</a>
</p>

<p align="center">
  <sub>MIT License · 用 ❤️ 构建</sub>
</p>
