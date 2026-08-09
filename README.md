<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" height="128" alt="RD Logo" />
</p>

<h1 align="center">RD — SSH/SFTP 远程文件管理器</h1>

<p align="center">
  一款受 macOS Finder 启发的 SSH/SFTP 远程文件管理器，内置集成终端，基于 Tauri 2 + React 19 + Rust 构建。
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> ·
  <a href="#技术栈">技术栈</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#构建">构建</a> ·
  <a href="#ci--发布">CI / 发布</a> ·
  <a href="#项目结构">项目结构</a> ·
  <a href="#许可证">许可证</a>
</p>

---

## 功能特性

### SSH 连接管理
- 多主机管理，支持自定义分类分组（拖拽排序）
- 密码认证与私钥认证
- 凭证存储：Windows 下使用 base64 编码的本地文件，keyring 作为备选方案
- 实时连接状态跟踪与指示
- 主机复制功能，每个主机拥有独立的目录记忆（`path_cache_id`）

### SFTP 文件浏览器（Finder 风格）
- **三栏布局**：侧边栏（主机列表）· 文件浏览器 · 文件信息面板
- **面包屑导航**：支持前进/后退/上一级，路径历史记录，任意层级跳转
- **地址栏**：双击进入编辑模式，支持绝对路径跳转、`cmd`/`terminal` 命令唤起终端、直接输入 shell 命令
- **右键上下文菜单**：
  - 空白区域：新建文件夹 / 新建文件（内联输入，回车确认，ESC 取消）
  - 文件：查看 / 编辑 / 重命名 / 删除 / 下载
  - 文件夹：重命名 / 删除 / 下载
- **拖拽上传**：分片传输（256KB/片），即使上传大文件也不会卡住界面
- **双击行为**：点击文件名文字触发重命名；点击非文字区域打开文本文件查看器
- **文本文件查看器/编辑器**：只读查看模式，一键切换编辑，`Ctrl+S` 保存，关闭时未保存变更提示
- **目录记忆**：每个主机独立记忆上次访问的目录
- 虚拟化文件列表（`@tanstack/react-virtual`），数千条目流畅滚动

### 集成终端
- 基于 PTY 的完整终端（`xterm.js`），Shell 会话持久化
- 每个主机独立的终端面板开关（状态按 `hostId` 分别存储）
- 自动同步工作目录与文件浏览器（`pty_cd`）
- **右键直接粘贴**（无菜单，直接写入剪贴板内容），选中即复制
- 拖拽手柄调整终端面板大小，自动适配终端尺寸
- Shell 历史记录清洁：内部命令以空格前缀 + `HISTCONTROL=ignorespace` 排除
- 面板隐藏时保留终端快照（CSS `display: none`，不卸载 xterm 实例）

### 文件传输
- **上传**：从本地拖拽文件/文件夹到远程（递归目录上传）
- **下载**：右键任意文件或文件夹，选择本地存储位置下载
- **传输通知中心**：工具栏图标 + 徽标显示活跃/完成任务数
  - 实时进度条、百分比、已传大小、传输速度（EMA 平滑）、耗时
  - 可取消进行中的传输（Rust 端取消令牌机制）
  - 下载完成后提供"打开所在文件夹"按钮（含文件存在性检查 + 降级提示）
  - 传输中状态显示红点提醒
- 分块上传（256KB/片），Rust 后端逐片上报进度事件

### 自定义窗口
- 无边框窗口，自定义 macOS Sonoma 风格标题栏
- 14×14px 圆形交通灯按钮（关闭/最小化/最大化）
- 工具栏通过 `-webkit-app-region: drag` 实现拖动（交互元素标记 `no-drag`）
- 地址栏空白区域同样支持拖动窗口

### UI / 用户体验
- macOS Finder 风格视觉设计，毛玻璃效果（`backdrop-filter`）
- 蓝青色渐变点缀、终端霓虹边缘、径向环境光
- 支持 `prefers-color-scheme` 浅色/深色模式
- Toast 通知（成功/错误/警告/信息）
- 自定义滚动条（Finder 风格细条覆盖式）
- 全局 cubic-bezier 缓动动画

### 快捷键
| 快捷键 | 功能 |
|---|---|
| `Ctrl+,` / `Cmd+,` | 打开设置 |
| `Ctrl+`` ` / `Cmd+`` ` | 切换终端 |
| `F5` / `Ctrl+R` / `Cmd+R` | 刷新当前目录 |
| `Ctrl+S` / `Cmd+S` | 保存文件（文本编辑器中） |
| `Esc` | 关闭弹窗 / 取消编辑 |
| `Enter` | 确认重命名 / 新建文件夹名 |

---

## 技术栈

| 层级 | 技术 |
|---|---|
| **前端** | React 19, TypeScript 5.8, Vite 7, Zustand 5 |
| **终端** | xterm.js 6（`@xterm/xterm` + `@xterm/addon-fit`） |
| **UI 图标** | lucide-react |
| **虚拟化列表** | @tanstack/react-virtual |
| **后端** | Rust（edition 2021）, Tauri 2 |
| **SSH 协议** | russh 0.45 |
| **SFTP 协议** | russh-sftp 2.0 |
| **异步运行时** | Tokio（full features） |
| **Tauri 插件** | dialog, fs, clipboard-manager, opener |
| **加密/编码** | sha2, base64（凭证哈希/编码） |

---

## 快速开始

### 环境要求

- [Node.js](https://nodejs.org/) 22+
- [Rust](https://www.rust-lang.org/tools/install)（stable 工具链）
- 各平台依赖：

<details>
<summary>Windows</summary>

- WebView2 Runtime（Windows 10/11 已预装）
- MSVC 构建工具（`x86_64-pc-windows-msvc` 目标）
</details>

<details>
<summary>Linux（Ubuntu/Debian）</summary>

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  libappindicator3-dev \
  librsvg2-dev \
  patchelf \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev
```
</details>

<details>
<summary>macOS</summary>

- Xcode Command Line Tools：`xcode-select --install`
</details>

### 安装与运行

```bash
# 克隆仓库
git clone https://github.com/your-username/rd.git
cd rd

# 安装 npm 依赖
npm install

# 启动开发服务器（自动打开 Tauri 开发窗口）
npm run tauri dev
```

---

## 构建

### 本地构建

```bash
# 构建当前平台的生产版本
npm run tauri build

# 安装包和可执行文件输出目录：
#   src-tauri/target/release/bundle/
```

### 交叉编译

交叉编译由 GitHub Actions 处理（见下文）。本地构建可指定目标平台：

```bash
# Windows
npm run tauri -- build --target x86_64-pc-windows-msvc

# Linux
npm run tauri -- build --target x86_64-unknown-linux-gnu

# macOS（Apple Silicon）
npm run tauri -- build --target aarch64-apple-darwin
```

---

## CI / 发布

本项目包含两个 GitHub Actions 工作流：

### CI（`.github/workflows/ci.yml`）
在 push/PR 到 `main` 分支时触发：
- **前端**：`tsc --noEmit` 类型检查 + `vite build` 构建
- **Rust（Linux）**：`cargo fmt --check` + `cargo check --locked` + `cargo clippy -D warnings`
- **Rust（Windows）**：在 `x86_64-pc-windows-msvc` 目标上执行 `cargo check`

### 发布（`.github/workflows/release.yml`）
在推送 `v*` 标签时触发：
- **三平台矩阵并行构建**（`fail-fast: false`，互不影响）：

| 平台 | Runner | 编译目标 | 产物 |
|---|---|---|---|
| Windows x64 | `windows-latest` | `x86_64-pc-windows-msvc` | `.msi`、`.exe`（NSIS 安装器）、portable `.exe` |
| Linux x64 | `ubuntu-22.04` | `x86_64-unknown-linux-gnu` | `.deb`、`.rpm`、`.AppImage` |
| macOS ARM | `macos-latest` | `aarch64-apple-darwin` | `.dmg`、`.app.tar.gz` |

- 自动创建 GitHub Release 并生成变更日志
- 标签名包含 `-`（如 `v0.1.0-beta`）自动标记为预发布
- 可选的 Tauri 更新签名（通过 `TAURI_SIGNING_PRIVATE_KEY` 密钥配置）

```bash
# 创建发布
git tag v0.1.0
git push origin v0.1.0
# → GitHub Actions 自动构建三平台产物并发布 Release
```

---

## 项目结构

```
rd/
├── src/                          # 前端（React + TypeScript）
│   ├── components/
│   │   ├── AddressBar.tsx        # 面包屑导航 + 路径编辑 + 复制路径
│   │   ├── ContentArea.tsx       # 主内容区编排
│   │   ├── FileBrowser.tsx       # SFTP 文件列表、右键菜单、拖拽上传
│   │   ├── HostDialog.tsx        # 新增/编辑主机配置
│   │   ├── SettingsDialog.tsx    # 应用设置
│   │   ├── Sidebar.tsx           # 主机列表 + 分类管理
│   │   ├── StatusBar.tsx         # 底部状态栏（版本号、主机数、路径）
│   │   ├── TerminalPanel.tsx     # xterm.js 终端 + PTY
│   │   ├── TextEditorDialog.tsx  # 文件查看器/编辑器
│   │   ├── Toolbar.tsx           # 顶部工具栏（导航、地址栏、窗口控制）
│   │   ├── TransferNotification.tsx  # 上传/下载进度通知中心
│   │   └── Toast.tsx             # Toast 通知系统
│   ├── store/
│   │   ├── fileStore.ts          # SFTP 文件操作（Zustand）
│   │   ├── hostStore.ts          # SSH 主机/连接状态
│   │   ├── transferStore.ts      # 传输任务跟踪 + 进度事件
│   │   └── uiStore.ts            # UI 状态（面板尺寸、可见性）
│   ├── styles/
│   │   ├── finder.css            # 全局 + 工具栏 + 状态栏 + 弹窗样式
│   │   ├── filebrowser.css       # 文件浏览器 + 地址栏样式
│   │   ├── terminal.css          # 终端面板样式
│   │   └── transfer.css          # 传输通知样式
│   └── types/
│       └── index.ts              # 共享 TypeScript 类型定义
├── src-tauri/                    # 后端（Rust + Tauri）
│   ├── src/
│   │   ├── ssh/                  # SSH 连接（russh）
│   │   ├── sftp/                 # SFTP 操作（russh-sftp）
│   │   │   ├── mod.rs            # 命令：列表、读取、写入、分片上传、
│   │   │   │                     #   下载文件/目录、取消传输等
│   │   │   ├── error.rs          # SFTP 错误类型 + 映射
│   │   │   └── model.rs          # SFTP 会话状态管理
│   │   ├── pty/                  # PTY 终端会话
│   │   │   ├── mod.rs            # pty_open、pty_write、pty_cd 命令
│   │   │   ├── session.rs        # Shell 会话生命周期
│   │   │   └── parser.rs         # 输出解析（cwd 检测）
│   │   ├── storage/              # 本地持久化
│   │   │   ├── hosts.rs          # HostConfig 增删改查
│   │   │   ├── credentials.rs    # 凭证存储（base64 文件）
│   │   │   ├── categories.rs     # 主机分类管理
│   │   │   ├── path_cache.rs     # 目录记忆（按主机）
│   │   │   └── settings.rs       # 应用设置持久化
│   │   ├── lib.rs                # Tauri 命令注册 + 插件初始化
│   │   └── main.rs               # 入口
│   ├── capabilities/
│   │   └── default.json          # Tauri 2 权限配置
│   ├── icons/                    # 应用图标（全平台）
│   ├── Cargo.toml                # Rust 依赖
│   ├── tauri.conf.json           # Tauri 配置
│   └── build.rs                  # Tauri 构建脚本
├── .github/workflows/
│   ├── ci.yml                    # CI：类型检查 + cargo check + clippy
│   └── release.yml               # 发布：三平台矩阵构建
├── .gitignore
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md
```

---

## 许可证

本项目基于 MIT 许可证开源 — 详见 [LICENSE](LICENSE) 文件。
