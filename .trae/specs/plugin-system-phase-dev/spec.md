# RD 插件系统 v1.0 - 产品需求文档 (PRD)

## Overview
- **Summary**: 为 RD 跨平台 SSH/SFTP 远程文件管理器（v0.1.89）构建一套完整的插件系统，包含 SDK 类型定义、iframe 安全沙箱、事件总线桥接、权限白名单、插件管理 UI、热加载机制、端口转发内核实现，以及完整的 6 阶段落地迭代路线图。
- **Purpose**: 解决 RD 功能扩展性受限问题，允许第三方开发者通过标准化 `@rd/plugin-sdk` 扩展连接层、终端、SFTP、运维工具、通知、网络隧道等能力，同时通过沙箱隔离 + 权限白名单 + 凭据脱敏三层机制保障安全。
- **Target Users**: 
  - RD 终端用户：通过插件市场扩展个性化运维能力
  - 插件开发者：基于 SDK 开发官方/第三方业务插件
  - 安全运维人员：对插件行为有审计、权限撤销、全局开关控制能力

## Goals
- 构建 100% 对齐现有代码的三层插件架构（内核层 → 调度层 → 扩展层）
- 提供标准化 `@rd/plugin-sdk` 单包，类型完全复用 `src/types/index.ts`
- 实现 iframe 沙箱 + postMessage 桥接，插件不得直接访问 RD 内部模块
- 完成 6 个 Phase 开发，每个 Phase 对应一个 RD 小版本（v0.1.90 - v0.1.94 + v1.0）
- 交付官方端口转发插件作为首个参考实现，完全遵守第十一章专项规范
- 建立插件安全沙箱：凭据永不外露、内网 HTTP 默认阻止、4 项高危权限红色确认

## Non-Goals (Out of Scope)
- v1 不支持自定义 React 组件注入设置子 Tab（仅支持 `config.schema.json` 自动渲染）
- v1 不支持 WebSocket API（v2 再议）
- v1 不实现插件市场（GitHub Pages + ed25519 签名校验放在 Phase 6 长期）
- 不引入 deno_core / V8 独立运行时（避免二进制体积膨胀 20MB+）
- 不允许插件 `eval()` 动态执行代码（`allowEval` v1 强制 false）
- 不允许插件绕过 SDK 新建独立 SSH 进程（必须复用 hostStore 连接池）

## Background & Context
### 现有能力复用（设计文档 §1.1）
- **主机配置 & 分类**：`src/types/index.ts` `HostConfig` / `CategoryConfig` + Rust `credentials.rs`（base64 本地存储）
- **连接状态机**：4 态（disconnected/connecting/connected/reconnecting）+ 5 层网络检测 + 指数退避重连
- **连接管理**：`src/store/hostStore.ts`（连接池、cancelReconnect、ConnectResult 指纹返回）
- **SSH 终端**：`src/components/TerminalPanel.tsx` + `@xterm/xterm 6.0`（多标签 PTY、重连自动恢复）
- **SFTP 双栏**：`src/components/FileBrowser.tsx` + `ContentArea.tsx`（临时文件→rename 协议）
- **传输队列**：`src/store/transferStore.ts` + `TransferTask`（实时速率、进度事件）
- **多主题**：`src/theme/palette.ts` + `themeStore`（6 套主题 CSS 变量）
- **设置对话框**：`src/components/SettingsDialog.tsx` 7 个 Tab，「插件」Tab 插入「调试」前（第 7 位）
- **日志持久化**：`src/utils/log.ts` → Rust `update_log` 命令（`%APPDATA%\rd-app\updates\update.log`）

### 技术约束
- 技术栈锁定：Tauri 2.0 · React 19 · TypeScript 5.8 · Vite 7 · Zustand 5 · Rust 后端
- 构建目标：macOS ARM64 · Windows x64 NSIS .exe · Linux x64 glibc（deb + AppImage）
- 应用 ID：`rd-app`，存储路径 `%APPDATA%\rd-app` / `~/Library/Application Support/rd-app` / `~/.config/rd-app`

## Functional Requirements
### FR-1：插件标准规范（Phase 1）
- `.rdplugin` 标准 zip 包格式，目录结构对齐 §3.1
- `manifest.json` 强 schema 校验（18 字段，含 permissions/conflict/requires）
- 插件生命周期 5 态：`init → enable → disable → uninstall → onConfigChange`
- `config.schema.json` JSON Schema 子集自动渲染配置面板（6 种字段类型）

### FR-2：插件管理器核心（Phase 1）
- Rust 侧 `plugin/*.rs` 模块：manifest/manager/permissions/store/bridge/hot_reload
- 前端 `pluginStore.ts`：扫描 / 列表 / 启用禁用 / 持久化到 `plugin-state.json`
- Tauri Commands 16 条（列表、安装、配置、权限、热重载）
- `PluginSandbox.tsx`：iframe sandbox + postMessage 桥接 + MessageChannel 返回
- SettingsDialog 「插件」Tab 插入（调试与关于之间），含 3 个子 Tab 空框架

### FR-3：事件总线 Bridge + 基础 SDK（Phase 2）
- 7 大类 43 个事件完整映射（连接/终端/SFTP/主机/UI/隧道/系统），owner 机制支持 disable 一键解绑
- storage API：隔离 `plugin-data/${id}/`，key 前缀 `plugin:${id}:`
- ui.notify / confirm / prompt + ToolbarButton 注册
- log API：`[plugin:${id}]` 前缀桥接 Rust update_log
- 权限校验框架：声明制 + 安装确认 + 4 高危权限红标复选框
- 开发者控制台日志视图（插件筛选 + 级别过滤）

### FR-4：业务 SDK 完整 API（Phase 3）
- `SshApi.runCommand`：复用连接池 + classifyConnectFailure 友好错误
- `SftpApi`：list/stat/mkdir/remove/rename/readText/writeText + upload/download 接入 transferQueue + 临时文件协议
- `ServerApi`：listAll（HostConfigSafe 脱敏，has_password 布尔标记，永不返回原文）/ add/update/remove + getConnectionState
- `ThemeApi`：主题事件 + CSS var 同步到 iframe（`--text-primary` 等自动跟随）
- 权限撤销功能 + 3 个全局开关（禁止 SSH 命令 / 禁止主机修改 / 禁止远程转发）
- `maskMode` 凭据打码对插件展示自动生效

### FR-5：热重载 + 安装体验（Phase 4）
- 文件监听：Rust notify crate，500ms 防抖，完整 reload 流程对齐 §10.1
- `.rdplugin` zip 打包 + 本地拖拽安装 + 安装确认弹窗（风险条 + 权限清单 + 我理解风险复选框）
- 沙箱卡死检测：500ms watchdog + 200MB 内存上限 + 200ms 单次调用超时
- 资源限制：CPU requestIdleCallback 节流 + performance.memory 轮询

### FR-6：端口转发内核 + 官方插件（Phase 5）
- Rust `tunnel/*.rs` 底层：local (-L) / remote (-R) / dynamic (-D, SOCKS5) 三种模式
- `TunnelApi`：规则 CRUD + 启停 + 导入导出 `.rd-tunnels.json`
- 11 项内核强制校验（端口范围、0.0.0.0 二次确认、远程转发全局开关等）
- 会话绑定：SSH close/reconnect 内核自动关闭隧道，杜绝残留
- 官方端口转发插件：Toolbar 入口 + 表格列 + 高危提示条 + 导入导出
- 云主机导入插件模板仓库（阿里云/腾讯云参考实现）

### FR-7：安全沙箱（贯穿所有 Phase）
- iframe `sandbox="allow-scripts allow-popups"`（故意不设 allow-same-origin → opaque origin）
- 权限白名单 17 项：声明制 + 授权制 + 可撤回 + 拦截制
- 文件访问隔离：永久黑名单 `~/.ssh`、凭据目录、`/etc`、其他插件目录
- 网络限制：内网 RFC1918 + localhost 默认阻止，域名级黑名单
- 进程拦截：禁止 Tauri shell open/spawn，所有命令只能走 `ssh.runCommand`
- 异常隔离：每个插件独立 error boundary，崩溃只影响自身 iframe

## Non-Functional Requirements
- **NFR-1（安全）**：`ServerApi.listAll()` 在任何权限组合下永不返回 password/privateKey 原文，仅返回 `has_password` / `has_private_key` 布尔标记（代码级硬编码约束）
- **NFR-2（兼容性）**：SDK `apiVersion` 版本化，v2 引入时保留 v1 兼容分支；`minRdVersion` 版本检查
- **NFR-3（可观测性）**：插件所有 SDK 调用、权限拒绝、异常崩溃均以 `[plugin:${id}]` 前缀写入 update_log
- **NFR-4（性能）**：热重载毫秒级（< 500ms 重建 iframe）；插件单实例 JS Heap < 200MB；SDK 调用超时 200ms 强制打断
- **NFR-5（主题一致性）**：插件所有注入 UI 必须使用 CSS 变量（`--text-primary / --accent / --radius-lg` 等），切换主题 0 代码改动
- **NFR-6（可审计）**：`ssh.run / tunnel.manage / server.write / sftp.operate` 4 项高危操作强制写入审计日志，支持调试 Tab 过滤查看
- **NFR-7（CI 兼容）**：所有新增 Rust 代码通过 `cargo fmt + check + clippy -D warnings`；TypeScript 通过 `tsc --noEmit`；不影响现有 release.yml 三平台构建

## Constraints
- **Technical**：
  - 沙箱选型固定为 iframe + postMessage，不引入 deno_core/V8（避免 20MB+ 二进制膨胀）
  - SDK 类型 100% 复用 `src/types/index.ts`，不发明第二套类型
  - 文件夹上传/下载必须遵守「临时压缩包 → rename → 解压 → 删临时」协议
  - Tauri Commands 必须同时兼容 Windows/macOS/Linux 三平台
- **Business**：
  - 每个 Phase 对应 RD 一个小版本（v0.1.90 - v0.1.94），需同步更新 CHANGELOG.md
  - GitHub Actions CI workflow（Ubuntu-latest）通过语法检查，不做 release 构建
  - Release workflow 构建三平台产物，不新增目标平台
- **Dependencies**：
  - Rust：`serde` / `serde_json` / `jsonschema` / `notify` / `anyhow` / `thiserror`
  - 前端：`@tauri-apps/plugin-fs` / `@tauri-apps/plugin-dialog` / `@tauri-apps/plugin-opener`
  - 类型：`lucide-react`（图标名称对齐 UiApi.icon 字段）

## Assumptions
- 插件开发者具备 React + TypeScript 基础能力，能看懂 `@rd/plugin-sdk` 类型定义
- 用户授予权限时已经理解风险，不会恶意授权所有高危权限
- 生产模式下 `hotReload: false` 的签名插件不会被篡改（Phase 6 引入 ed25519 校验）
- 开发者在 `disable()` 中正确释放所有事件监听、定时器、UI 注册（内核兜底删除插件注册项）
- Phase 6 插件市场基于 GitHub Issue 列表 + PR 审核流程，无需独立后端服务器

## Acceptance Criteria

### AC-1：基础骨架可运行（Phase 1）
- **Given**：RD v0.1.90 启动，`${appDataDir}/plugins/` 目录下放置一个符合 manifest 规范的最小插件（仅 init + enable 返回 void）
- **When**：用户打开设置 → 插件 → 已安装插件
- **Then**：插件列表正确显示图标/名称/版本/状态，点击启用按钮后调用 init → enable 生命周期，点击禁用调用 disable
- **Verification**：`programmatic`（tsc --noEmit + cargo check + 手动生命周期日志验证）

### AC-2：凭据脱敏约束生效
- **Given**：插件声明了 `server.read` 最高权限
- **When**：插件调用 `ctx.server.listAll()` 或 `ctx.server.get(hostId)`
- **Then**：返回的 HostConfigSafe 不含 `password` / `private_key` 字段，仅含 `has_password: boolean` / `has_private_key: boolean`
- **Verification**：`programmatic`（SDK 桥接层单测 + 运行时字段断言）

### AC-3：权限拦截有效
- **Given**：插件 manifest 未声明 `ssh.run` 权限
- **When**：插件调用 `ctx.ssh.runCommand(hostId, 'ls')`
- **Then**：SDK 抛出 `PERMISSION_DENIED` 错误，日志写入 `[plugin:${id}] PERMISSION_DENIED ssh.run`，RD 主程序不受影响
- **Verification**：`programmatic`（桥接层权限校验单测 + 日志断言）

### AC-4：沙箱 DOM 隔离
- **Given**：插件运行在 iframe sandbox 内（无 allow-same-origin）
- **When**：插件尝试执行 `parent.window.document.querySelector` 或访问 `window.__TAURI_INTERNALS__`
- **Then**：抛出跨域 SecurityError 或 undefined，无法读取 RD 主窗 DOM
- **Verification**：`programmatic`（iframe sandbox 属性断言 + 恶意代码运行测试）

### AC-5：事件总线 reconnect 事件流
- **Given**：已连接主机，手动断网触发被动 disconnect
- **When**：自动重连流程依次经过 reconnecting → reconnect-attempt × N → reconnect-success / reconnect-aborted
- **Then**：插件通过 `bus.on('connection:reconnecting'...)` 等监听器按顺序收到全部事件，事件参数字段与文档 §5.2.A 完全一致
- **Verification**：`programmatic`（模拟断网场景 + 事件顺序 & 参数断言）

### AC-6：SFTP 遵守临时文件协议
- **Given**：插件调用 `ctx.sftp.upload()` 上传本地文件夹
- **When**：传输进行中 + 完成后
- **Then**：目标目录先出现 `.tmp<pid>` 临时压缩包 → 传输完成 rename 为正式 zip → 解压 → 删除临时文件，与 transferStore 内置行为一致
- **Verification**：`human-judgment`（传输过程查看目标目录文件状态变化序列）

### AC-7：插件管理 Tab UI 对齐 RD 风格
- **Given**：设置对话框打开到「插件」Tab
- **When**：查看左侧列表 + 右侧详情 + 子 Tab 切换
- **Then**：使用 CSS 变量与 finder.css / SettingsDialog 现有组件风格一致（圆角 14px、`.switch` 开关、分组卡片、徽章颜色、字体层级）
- **Verification**：`human-judgment`（UI 截图对比现有 SettingsDialog 其他 Tab 风格）

### AC-8：热重载毫秒级切换
- **Given**：开发模式下启用了对插件 A 的目录监听
- **When**：修改插件 A 的 `main.js` 并保存文件
- **Then**：500ms 防抖后自动 disable 旧实例 → 销毁 iframe → 创建新 iframe → init → enable，Toast 显示「插件 A 已热重载」
- **Verification**：`programmatic`（文件时间戳触发 + 状态机切换计时 < 1s）

### AC-9：安装确认弹窗高危权限红色标
- **Given**：本地安装声明了 `ssh.run` + `tunnel.manage` 的插件
- **When**：安装确认弹窗显示权限清单
- **Then**：`ssh.run` / `tunnel.manage` / `server.write` / `sftp.operate` 4 项高危权限显示红色边框卡片 + 后果说明，底部「我已阅读并理解以上风险」复选框未勾选时确认按钮禁用
- **Verification**：`human-judgment`（弹窗视觉验证 + 复选框交互测试）

### AC-10：隧道绑定 SSH 会话自动关闭
- **Given**：主机 H1 已连接，启动了一条 local 模式隧道 T1，状态 running
- **When**：手动 `disconnect(H1)` 或网络被动断开触发 reconnecting
- **Then**：内核层（非插件层）立即执行 stop(T1)，emit `tunnel:stop` 事件 reason=host-close / host-reconnecting，T1 本地监听端口被释放
- **Verification**：`programmatic`（netstat 端口占用断言 + 事件顺序断言）

### AC-11：远程转发全局开关拦截
- **Given**：设置 → 插件 → 全局开关「禁止所有插件远程端口转发 (-R)」= true
- **When**：插件调用 `ctx.tunnel.createRule({ mode: 'remote', ... })` 或 `startTunnel()` 远程模式隧道
- **Then**：返回 `TunnelErrorCode.REMOTE_FORBIDDEN`，隧道不启动，日志写入 `[tunnel:${id}] REMOTE_FORBIDDEN`
- **Verification**：`programmatic`（开关开启/关闭两组断言）

### AC-12：0.0.0.0 监听二次确认
- **Given**：插件创建隧道规则 `localAddr = '0.0.0.0'`
- **When**：调用 `startTunnel()`
- **Then**：SDK 先返回 `LISTEN_ON_ALL_NEEDS_CONFIRM`，主程序弹二次确认对话框，用户确认后才真正启动；取消则不启动
- **Verification**：`human-judgment`（弹窗交互测试 + 确认前后端口状态）

### AC-13：CI / 构建零破坏
- **Given**：提交所有插件系统代码
- **When**：GitHub CI workflow 执行（tsc --noEmit + vite build + cargo fmt/check/clippy -D warnings）
- **Then**：CI 全绿，无新增 warning；Release workflow 三平台构建产物完整
- **Verification**：`programmatic`（GitHub Actions 结果）

### AC-14：CHANGELOG 同步记录
- **Given**：每个 Phase 完成后
- **When**：发布对应 RD 小版本（v0.1.90 / v0.1.91 等）
- **Then**：CHANGELOG.md 按 Keep a Changelog 格式记录该 Phase 的新增/变更/修复条目
- **Verification**：`human-judgment`（CHANGELOG.md 格式与内容审查）

## Open Questions
- [ ] `@rd/plugin-sdk` 发布形式：独立 npm 包？还是 RD 主仓库 `packages/plugin-sdk` monorepo？（影响 phase 1 脚手架搭建）
- [ ] Phase 6 插件市场是否需要独立后端服务？文档推荐 GitHub Issue + PR，但搜索/分类体验可能受限
- [ ] v1 插件 UI 是否允许有限的自定义 React 组件注入 RightPanel？文档规定 v1 仅 schema，但实践中可能需要少量自定义
- [ ] `tunnel.manage` 权限的 dynamic (-D SOCKS5) 模式是否纳入极高风险组？文档目前与 local/remote 同组，但 SOCKS5 代理能力更强
- [ ] 插件卸载时 `plugin-data/${id}/` 目录清空是同步还是异步？如果用户数据较大，是否需要进度提示？
