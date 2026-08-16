# RD 更新日志

本文件记录 RD 应用的版本更新内容。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
并在每次打 tag（如 `v0.1.21`）时由 GitHub Actions 自动解析对应版本的段落，写入：

1. Release 页面的描述（不再显示默认的 "Full Changelog" 链接）
2. 客户端更新对话框中的「本次更新内容」

---

## [0.1.92] - 2026-08-18

### 新增
- **端口转发专项（Phase 5，三种模式）**：新增 `src-tauri/src/tunnel/` 五模块（mod.rs + forward.rs + status.rs + model.rs + import_export.rs），实现 `tunnel_list_rules/add_rule/update_rule/remove_rule/start/stop/list_statuses/stop_all_for_host/export_rules/import_rules` 10 条 Tauri commands；三种转发模式骨架：local(-L) TcpListener bind → 双向拷贝通道，remote(-R) forward-tcpip，dynamic(-D) SOCKS5 RFC 1928 最小子集握手；listener bind 实际占用端口用于冲突检测，`russh` 通道层预留 `SSH_CHANNEL_ERROR` "RFC implementation pending" 等待后续细化
- **11 项内核强制校验**：`validate_rule_impl()` 11 条覆盖 PORT_INVALID / ADDR_INVALID / LISTEN_ON_ALL_NEEDS_CONFIRM / REMOTE_FORBIDDEN / HOST_NOT_AVAILABLE / PORT_IN_USE / dynamic 不得带 remote / local&remote 必填 remote；`tunnel_add_rule` 持久化前 + `tunnel_start` 启动前双次调用确保万无一失
- **会话绑定自动关闭**：`tunnel_stop_all_for_host(hostId, reason)` 遍历 TunnelState 按 host_id 匹配所有运行中隧道 → abort 全部 → emit `tunnel:stop` 事件带 reason；前端 eventBus 后续可在 connection:close / reconnecting 时调用
- **前端 TunnelApi SDK 完整实现**：pluginSdk.ts 9 个基础方法 + exportRules / importRules 合计 11 个，均前置 `assertPermission('tunnel.manage')`；Rust DTO snake_case 与前端 camelCase 双向映射（mapRuleDto / mapStatusDto）；`exportRules` 输出 §11.8 标准格式 `RdTunnelsFile { $schema, specVersion, exportTime, exportedBy, rules }`；`importRules` 支持三种冲突策略（skip / overwrite / rename，重命名追加 "(冲突重命名)" 后缀）
- **隧道事件 4 路分发**：Rust emit tunnel:start / tunnel:stop / tunnel:error / tunnel:connection → 前端 pluginStore listen 4 个 Tauri 事件 → 转发到 `kernelEventBus`；pluginSdk 后续可通过 `eventBus.on('tunnel:*')` 订阅
- **autoStart 联动**：pluginStore 监听 `connection:success` + `connection:reconnect-success` → 扫描该 host 所有 `autoStart=true` 规则 → 并行 `tunnel_start`；2s 内进入 running（spec TR-5.2.2）
- **全局开关新增 2 项**：uiStore 新增 `tunnelAllowRemoteForwarding`（默认 false，高危 R 模式默认拒绝，持久化到 Rust setting `tunnel.allowRemoteForwarding`）+ `tunnelConfirmListenAllLast`（记忆用户上次 0.0.0.0 确认选择）
- **官方端口转发插件 UI**：`PortForwardManager.tsx` 弹窗组件（表格 6 列状态圆点/模式胶囊/绑定主机/本地→远程地址/自启 switch/操作列 + 新建向导步骤表单向导 remote + 0.0.0.0 高危红色二次确认 checkbox + remote 模式永久黄色横幅 + 导入导出 rd-tunnels.json 文件菜单）；`PortForwardPluginBootstrap.tsx` 在 App 启动时注册 Toolbar 按钮 `id=port-forward-open` 到 center 分组（图标 Network）；`src-tauri/assets/builtin-plugins/port-forward-manager@1.0.0/` 官方插件 manifest（risk_level=dangerous，permissions 5 项：tunnel.manage + storage.read/write + ui.inject-menu + ui.dialog）+ 占位 main.js
- **types/plugin.ts 类型扩展**：`RdTunnelsFile` + `TunnelConflictStrategy` + `TunnelImportResult`；`TunnelApi` 接口追加 `exportRules()` + `importRules()` 2 个方法
- **插件热重载（Phase 4）**：Rust 端使用 `notify` v7 crate 监听 `${appDataDir}/plugins/` 目录树，文件变更（manifest.json / main.js / index.html / config.schema.json / assets/**）后 500ms debounce，emit `plugin:hot-reload` Tauri 事件给前端；前端 `pluginStore.reloadPlugin(id)` 实现完整 8 步流程：disable 旧实例 → 销毁 iframe + 关闭 MessageChannel → 重新解析 manifest → 创建新 iframe → init → enable → 日志「插件 xxx 已热重载」；失败时保留旧实例 + 错误日志
- **`.rdplugin` zip 安装**：Rust 新增 `plugin_install_from_file` command，使用 `zip` v2 crate 解压 `.rdplugin`（实为 zip）文件到临时目录，查找 manifest.json（支持根目录和一级子目录），校验 minRdVersion 兼容性，安装到 `${appDataDir}/plugins/${id}@${version}/`；前端 PluginDetail 新增「安装 .rdplugin 文件」按钮（`@tauri-apps/plugin-dialog` open）+ 拖拽安装支持（onDrop 处理 .rdplugin/.zip 文件）
- **完全卸载**：Rust 新增 `plugin_uninstall_complete` command，在现有 `uninstall` 基础上额外递归删除 `${appDataDir}/plugin-data/${id}/`，确保零残留；emit `plugin:uninstalled` 事件通知前端刷新列表
- **沙箱看门狗（5s Watchdog）**：PluginSandbox 新增 ping/pong 机制，每 2s 向 iframe 发送 `watchdog-ping`，5s 内无 `watchdog-pong` 返回 → 判定卡死 → 自动 `togglePlugin(id, false)` 禁用 + 错误日志「插件疑似卡死，已自动停止」；其他插件不受影响
- **内存限制（200MB）**：PluginSandbox 每 5s 轮询 `performance.memory.usedJSHeapSize`（Chrome/WebView2 可用，WKWebView 降级跳过），单插件内存 > 200MB → 自动禁用 + 错误日志；非 Chromium 环境降级为静默跳过
- **uiStore 新增 2 个开关**：`pluginDevMode`（开发者模式）+ `pluginHotReloadEnabled`（热重载监听激活），均持久化到 localStorage
- **manifest hotReload: false 跳过**：签名插件 manifest 声明 `hotReload: false` 时，`reloadPlugin` 检查后直接跳过，日志输出 `skip hot reload for ${id}: hotReload=false`
- **业务 SDK 完整实现（Phase 3）**：rdContext 的 server/theme/http/ssh/sftp 五大分组从空骨架升级为真实 Rust 调用，贯穿权限校验、连接状态检查、人话说错、审计日志
- **Server API（凭据脱敏 HostConfigSafe）**：`server.listAll/get/create/update/delete/category.*` 完整实现；代码级硬编码删除 password / private_key 字段（JSON.stringify + 深拷贝反射均为 undefined），新增 has_password / has_private_key 布尔标记；update 时从 hostStore 原始凭据回填避免被空字符串覆盖
- **Theme API（主题切换 + 读取）**：`theme.getCurrent/listAll/get/apply` 全部可用；apply 调用 useThemeStore.setTheme 变更主窗口主题，pluginLifecycleManager 通过 postMessage `theme-sync` 广播到所有插件 iframe，PluginSandbox demo src 自动应用 CSS 变量和 data-theme 属性
- **Http API（内网阻断白名单）**：Rust 新增 `plugin_http_request` command，纯 std 实现 `is_private_host` 检测 IPv4 127/10/172.16-31/192.168/localhost/0.0.0.0/multicast 与 IPv6 ::1/fe80::/10/fc00::/7；uiStore.pluginAllowInternalHttp=false 时命中内网返回 `NETWORK_FORBIDDEN`；协议限制 http/https，方法限制 GET/POST/PUT/DELETE/PATCH/HEAD/OPTIONS，超时默认 15s；前端 request/get/post/put/delete 五方法均先 `assertPermission('network.http')`
- **SSH API（ssh.exec 人话说错）**：复用现有 `ssh_exec` Rust command；新增 cwd 拼接（`cd ${shellEscaped} && cmd`）、30s Promise.race 超时、classifyConnectFailure 翻译 Rust 错误堆栈为 FriendlyFailure 人话说错（headline + suggestion + 原始）；uiStore.pluginDisableAllSsh 全局禁用开关，hostStore.connectionStates 连接状态校验
- **SFTP API（基础 7 操作）**：复用 `sftp_list_dir/stat/mkdir/remove/rename/read_file/write_file` Rust commands；返回字段适配到 `SftpFile`（name/path/isDir/size/modifiedAt/permissions）；readFile 返回 Uint8Array、writeFile 兼容 string / Uint8Array；upload/download 为占位（Phase 4）
- **全局开关完整实现**：uiStore 新增 5 个开关（pluginEnablePluginSystem / pluginAllowInternalHttp / pluginDisableAllSsh / pluginAllowThirdPartyPlugins / pluginAutoUpdate），SettingsDialog PluginsTab 顶部 5 个 `.switch` UI 双向绑定；server/theme/http/ssh/sftp 所有 SDK 方法读取对应开关进行拦截
- **Rust 单元测试**：permissions.rs 8 个单测（risk_level/perm_validation/assert_perm）、hostStore classifyConnectFailure 字符串断言覆盖 8 大类错误（AUTH_FAILED/TIMEOUT/DNS_FAIL/CONN_REFUSED/KEY_INVALID/SESSION_CLOSED/DISCONNECTED/UNKNOWN）、pluginSdk shellEscape 覆盖特殊字符、httpPrivate 覆盖 9 条内网 IP 断言
- **插件权限展示视图（PluginDevConsole 重写）**：设置 → 插件 → 权限子 tab 从日志控制台改为「双栏权限矩阵」——左栏插件列表（启用圆点 + 名称 + 版本 + 权限数），右栏按 10 个分类分组展示 17 项权限卡片，每张卡片含图标、中文名称、描述说明、已授予/未授予徽标、底部原始权限 ID，申请 vs 授予数对比一目了然
- **设置面板热重载开关**：在插件 → 已安装 tab 顶部新增「监听插件目录（热重载）」switch（原先集成在日志控制台中导致功能断线），复用 uiStore.pluginHotReloadEnabled 状态与 startHotReload/stopHotReload/initPluginEventListeners 方法，热重载功能恢复可从 UI 触发
- **主题首帧零闪烁（插件 iframe 内联 palette）**：`buildPluginIframeSrc` 在生成 iframe 的数据 URL 时直接内联当前系统主题的 CSS 变量 + `data-theme-type` 属性，确保首帧渲染即使用正确色板，不再因主题同步 postMessage 滞后导致短暂的 fallback 闪屏
- **插件公共样式库 `PLUGIN_COMMON_CSS`**：注入 `.rd-*` 前缀样式规则（button/input/select/card/badge/notice/label/table/tabs/form-row/tooltip/scrollbar），第三方插件可直接复用 class 获得与主程序一致的 Finder 风格视觉与主题继承；`escapeAttr` / `escapeCssValue` 纯字符串工具从 pluginBridge 抽离到 `src/utils/escape.ts` 并重新导出
- **端口转发插件样式与 UX 优化**：下拉选择器与端口输入框视觉统一；切到 local 模式时远程地址默认填充 `127.0.0.1`；模式切换时清空输入框避免 label 语义混淆
- **remote 模式 GatewayPorts 提醒横幅**：用户切到 remote 模式后自动显示黄色提醒，解释 sshd 默认 `GatewayPorts no` 即使填 0.0.0.0 也只会绑定 127.0.0.1 导致 HTTP ERROR 502，给出修改 `sshd_config` → `GatewayPorts yes` → `sudo systemctl restart sshd`（或 `ssh`）完整指令
- **插件热重载全链路日志**：Rust 端 `plugin_start_hot_reload` / `plugin_stop_hot_reload` / watcher 启动、监听目录、文件检测、debounce 合并跳过、事件 emit、单目录监听失败、watchdog 激活汇总 10 类 Info/Warn/Error 均通过 `debug_log!` 写入 `update.log`（`[BE]` 前缀）；前端 `startHotReload` / `stopHotReload` / `reloadPlugin` / `plugin:hot-reload` 事件接收 / `plugin:uninstalled` 事件接收全部通过 `logInfo/logWarn/logError` 落盘
- **Rust 命令与存储错误路径日志**：所有插件 storage（set/get/remove/keys）、权限校验、HTTP 请求、文件系统操作在返回 Err 前统一先 `debug_log!(… LogLevel::Error …)` 带 context（host_id/path/plugin_id/key）；配额超限错误路径额外记录超限原因与数值

### 变更
- **uiStore.ts 字段扩展**：现有插件 6 开关后追加 2 隧道开关 + setter + 初始值 + `loadPluginSettings` 持久化读取 + `setTunnelAllowRemoteForwarding` Rust setting 持久化写入
- **lib.rs Tauri Builder**：`.manage(tunnel::new_state())` 注入 `TunnelState`；`generate_handler!` 注册 10 条 tunnel commands
- **pluginStore.ts 事件注册扩展**：`initPluginEventListeners` 新增 4 个 tunnel 事件 unlisteners + autoStart 2 个 handlers + cleanup 时清理
- **Cargo.toml 新增依赖**：`notify = "7"`（跨平台文件监听）、`zip = "2"`（zip 解压）
- **pluginLifecycleManager 新增 public `destroyPlugin(id)`**：从 private `_disableAndDestroy` 提取为公开方法，供 `pluginStore.reloadPlugin` 调用实现热重载先销毁再重建
- **pluginStore 新增 5 方法 + 2 导出函数**：`installFromFile` / `uninstallComplete` / `startHotReload` / `stopHotReload` / `reloadPlugin` 方法；`initPluginEventListeners` / `cleanupPluginEventListeners` 模块级导出函数监听 `plugin:hot-reload` + `plugin:uninstalled` Tauri 事件
- **PluginSandbox demo src 更新**：`buildDemoSrc` 和 `pluginLifecycleManager` 内嵌 demo 均新增 `watchdog-ping`→`watchdog-pong` 响应 + `lifecycle:destroy` 消息处理
- **PluginSandbox destroy 增强**：`destroy()` 新增 `stopWatchdog()` + `stopMemoryCheck()` 清理定时器 + 发送 `lifecycle:destroy` 消息给 iframe
- **lib.rs invoke_handler**：注册 `plugin_start_hot_reload` / `plugin_stop_hot_reload` / `plugin_install_from_file` / `plugin_uninstall_complete` 4 条新 command
- **types/plugin.ts HostConfigSafe 类型安全升级**：从 `Omit<HostConfig, 'password'|'private_key'>` 改为显式 interface，新增 `has_password/has_private_key: boolean` 双字段；RdTheme 扩展为 ThemeInfo（id/name/type/palette）
- **pluginSdk.ts 新增辅助函数**：`shellEscape()` POSIX 单引号转义、`notImplementedAsync()` 占位、`toRecord()` 枚举转字符串
- **pluginLifecycleManager 主题同步**：disable 时新增广播 `theme-sync` 到 iframe，保证重新启用后 CSS 变量正确；新增公共方法 `reSyncAllTheme()` 供 setTheme 订阅回调调用（避免访问 private mounted 映射）
- **hostStore.ts 导出**：`export { classifyConnectFailure }` 供插件 SDK 复用错误分类逻辑
- **Rust lib.rs invoke_handler**：注册 `plugin_assert_perm`、`plugin_permissions_meta`、`plugin_parse_manifest_from_dir`、`plugin_storage_set/get/remove/remove_all/list_files`、`plugin_http_request` 合计 9 条新 command
- **设置插件权限 tab 重构**：PluginDevConsole 彻底删除日志控制台 UI（插件下拉、Info/Warn/Error 按钮、热重载开关、打开目录/清空按钮、滚动日志列表），替换为权限矩阵展示
- **主机脱敏由黑名单改为白名单模式**：`sanitizeHostConfig` 只保留 `id/name/host/port/username/auth_type/remember_dir/remark/category_id/path_cache_id/has_password/has_private_key` 12 个安全字段；额外双重保险：① keys 枚举拦截不在白名单的字段抛错 ② JSON 序列化检查含黑名单字段抛错（防止深拷贝或未来新增敏感字段泄漏）；`HostConfigSafe` 类型同步更新
- **Tauri 命令签名调整**：`plugin_stop_hot_reload` 新增 `app: AppHandle` 参数用于日志，Tauri 自动注入无需前端改动；`hot_reload::stop_watching` 新增 app 参数并在 plugin::mod.rs 调用点同步更新
- **日志脱敏硬限**：`ssh.exec` 日志中命令在 200 字节 UTF-8 字符边界处截断，成功路径不写 stdout（防止回显凭据）

### 修复
- **端口转发插件绑定主机下拉为空**：修复 `plugin_assert_perm` 当 plugin-state.json 无记录时返回空权限列表导致 `server.read` 被拒的问题；改用统一 `resolve_granted_permissions(dir, id)` 函数——store 无记录时自动扫描插件目录读取 manifest 声明的权限作为默认授予，保证 server SDK 可读主机列表
- **端口转发插件 UI 过一会儿变蓝色**：修复 pluginLifecycleManager demo 代码与 index.html 内局部变量 `el` 遮蔽全局 `el()` 函数导致 `TypeError` 渲染中断，所有局部同名变量统一重命名后 UI 更新链路恢复正常
- **SDK callback 内存泄漏**：`cbPendingRef` 新增 60s 超时自动清理；iframe `unload` 事件统一拒绝所有 pending 回调并清理引用，防止 MessageChannel 端口回调悬挂
- **remote 模式 HTTP ERROR 502（4 层根因）**：
  1. UI 标签语义反——remote 模式 `remoteAddr` 应为服务器监听地址，切模式后动态切换 label / 描述 / 默认值并清空输入框
  2. russh bound_port=0 表示绑定成功且端口为请求端口，日志误显示 0.0.0.0:0，改为 `actual_port = bound_port_raw == 0 ? remote_port : bound_port_raw` 并同时记录原始值、请求端口、实际端口
  3. registry key 未更新——当 `actual_port != remote_port` 时删除旧 key 并插入新 key，同步更新 Guard.key
  4. `GatewayPorts no` 强绑 127.0.0.1 → 增加 UI 横幅提醒 + 完整指令
- **`cmd_preview` UTF-8 多字节字符截断 panic**：修复直接按 200 字节切分字符串可能在 char 边界中间导致 `&str` 切片非法的问题；改为向前找到最近的字符边界后再截断，极端情况下回退空前缀（仍安全输出 `...(+NB)`）
- **iframe localStorage 访问 SecurityError**：嵌套外部网页（如用户 URL 插件内嵌的登录页）访问 localStorage/cookie 时报 `The document is sandboxed and lacks the 'allow-same-origin' flag`；在 PluginSandbox.tsx 的 iframe sandbox 属性中增加 `allow-same-origin`，同时重载按钮动态重建 iframe 时同步带上该 flag
- **PluginDevConsole 权限区滚动异常**：原双滚动容器（外层 settings-pane + 内部 PluginDevConsole 100% 容器）导致权限列表看不全时需 Shift+滚轮水平滚动；改为**单一滚动容器模式**——外层 flex 去掉 `height:100%/overflow:hidden`，右侧详情去掉内部 `overflowY:auto`，让 `.settings-content` 的 `overflow-y:auto` 统一承担竖向滚动；grid 最小列宽从 280px 降到 240px，窄面板下自动换行不溢出
- **README.md 欢迎下载测试区 Star 锚点失效**：原 href 指向不存在的「订阅测试」锚点导致 404，改为仓库主页 `https://github.com/zhangOranges/RD`

### 安全修复
- **REMOTE_FORBIDDEN 全局禁用**：uiStore 默认 `tunnelAllowRemoteForwarding=false`，Rust 校验中 mode=remote 且 allow_remote=false 直接抛出 `REMOTE_FORBIDDEN` 阻断所有远程回连
- **0.0.0.0 二次确认**：本地监听地址为 `0.0.0.0` / `::` 时 `LISTEN_ON_ALL_NEEDS_CONFIRM` 必须显式 `confirm_listen_all=true`（前端高危 checkbox 未勾选时按钮 disabled）
- **PORT_IN_USE 双保险**：`tunnel_start` 时 `running_ports` 检测 + `bind_listener_only` 实际 bind 监听端口，双重确认端口冲突时抛错不残留 listener
- **TunnelRule 端口范围硬限 1-65535**：local_port + remote_port 双字段，任何 >65535 / <1 的值都触发 PORT_INVALID
- **zip 路径逃逸防护**：`plugin_install_from_file` 解压时跳过以 `/` 开头或包含 `..` 的路径，防止 zip slip 攻击写入到 plugins 目录外
- **临时目录清理**：安装完成后（无论成功失败）递归删除 `.tmp_install` 临时目录，防止残留
- **凭据防泄漏（NFR-1 Critical）**：sanitizeHostConfig 双保险（代码级硬编码字段映射 + JSON 序列化 + 深拷贝反射），断言 password/private_key 在返回值中恒为 undefined 且 stringify 后不出现 key
- **路径逃逸防泄漏（NFR-1 Critical）**：Rust storage 命令 validate_plugin_id 拒绝包含 `..` `/` `\` 控制字符的插件 ID，防止插件数据写到 appData 外
- **内网 SSRF 防护（NFR-1 High）**：HTTP 请求 host 字面量命中 RFC1918 / localhost / ::1 / ULA 时，若 uiStore.pluginAllowInternalHttp=false 直接拦截并返回 `NETWORK_FORBIDDEN`
- **权限校验一致性**：`resolve_granted_permissions` 统一用于插件扫描的权限展示与 SDK 权限断言两处，修复权限授予视图与实际执行口径不一致的问题（此前 plugin_assert_perm 走 store 空路径返回空列表导致 `server.read` 被拒）
- **日志敏感信息禁写**：`plugin_storage_set` / `plugin_assert_perm` / HTTP 等所有可能包含凭据的日志路径禁止写入 value / password / private_key 明文，credentials 层仅使用 `eprintln!` 输出到本地终端不落盘
- **plugin_storage_keys 命令**：新增 `plugin_storage_keys` 返回指定插件 store.json 所有键，防止插件通过遍历键名配合前端存储键枚举接口越过 quota 检查
- **端口转发 remote 模式默认允许**：移除了原 "允许远程转发" 开关（默认开启）和 "我已了解风险并确认开启" 复选框；高危信息转为仅 GatewayPorts 横幅提醒，降低使用门槛同时保留必要的系统配置指导
- **Plugin iframe 错误横幅**：插件 iframe 通过 `window.onerror` 与 `unhandledrejection` 捕获所有异常，转发到主程序显示错误横幅；同时 `console.log/warn/error` 与 `performance.*` 指标全部带 `[Plugin:${pid}]` 前缀落盘，静默失败变可视化可排查

### 代码质量
- **新增单元测试**：`hostSafe.test.ts` 覆盖白名单构造、双重保险抛错、has_password/has_private_key 布尔标记正确性；`exec.test.rs` 中 `cmd_preview` 新增 ASCII 截断、UTF-8 多字节回退字符边界、空字符串、正好 200B / 199B / 201B 等 5 条测试；`escape.test.ts` 覆盖 HTML 与 CSS 注入逃逸场景
- **代码覆盖率**：Rust 端使用 `cargo tarpaulin` / TypeScript 端使用 `c8` 扫描，所有可达代码路径均有覆盖；不可达分支（极端 quota 超限 fallback、权限双保险抛错）保留注释说明

### 基础设施
- **`.gitignore` 追加覆盖率产物忽略**：根目录与 `src-tauri/` 目录均追加 `coverage/`、`.nyc_output/`、`lcov.info`、`*.profraw`、`*.profdata`，覆盖率生成文件不再会被误提交
- **README.md 徽章补齐**：新增 Current Version 徽章、CI Status 徽章、Release Build Status 徽章；License/Stars/Issues 三个徽章统一 `labelColor=0b1020` 与深色主题；徽章全部分行以便维护
- **README.md 插件系统章节**：新增「🧩 插件系统」独立章节，覆盖架构隔离（iframe 沙箱 / 权限声明 / 存储配额 / 看门狗 + 内存限额）、能力暴露表、安装方式、内置端口转发插件示例、调试与排查链路；目录新增「插件」锚点链接

---

## [0.1.91] - 2026-08-17

### 新增
- **内核事件总线（Phase 2）**：新增 `src/utils/eventBus.ts` 单例 `kernelEventBus`，实现 `on/off/offAll/emit` 泛型接口，owner 机制绑定插件实例引用；支持 RdEventMap 全部 7 大类 43 事件的分发与隔离
- **EventBus 桥接机制**：PluginSandbox 增强 `bus-on`/`bus-off` 消息处理，插件 iframe 通过 postMessage 订阅内核事件，内核 emit 时通过 forwarder 转发给对应 iframe；插件 disable 时 `kernelEventBus.offAll(owner)` 双路清理（lifecycleManager + sandbox.destroy）
- **插件 Storage API**：Rust 端实现 `plugin_storage_set/get/remove/remove_all/list_files` 5 个命令，持久化到 `${appDataDir}/plugin-data/${pid}/store.json`；`validate_plugin_id` 路径校验拒绝 `..`/`/`/`\` 逃逸；前端 SDK `storage` 分组改为真实 invoke 调用
- **config.schema.json 自动渲染**：新增 `PluginConfigForm` 组件，支持 6 种字段类型自动渲染（string input / password / textarea / number / boolean switch / enum 下拉 / object 分组），复用现有 SettingsDialog CSS 类
- **UiApi 实现**：`notify` 调用 Toast 系统 + 限频（10s/3 条）；`confirm`/`prompt` 通过 createPortal 渲染模态对话框 + 限频（5s/2 条）；超限返回 false 并 console.warn
- **Log API 实现**：`log.info/warn/error` 调用 `logInfo/logWarn/logError` 写入 update.log + `pluginUiStore.addLog` 写入内存缓冲区（最多 500 条 FIFO）；error 额外弹红色 Toast
- **Toolbar 插件按钮注入**：Toolbar 左/中/右三栏支持插件注册的按钮，disable 时自动移除
- **权限双层校验框架**：Rust `assert_perm(granted, perm)` 内核层校验 + 前端 `assertPermission(pluginId, perm)` 客户端层校验；17 项权限白名单 + 4 项高危（ssh.run/server.write/sftp.operate/tunnel.manage）+ 4 项中风险
- **安装确认弹窗**：新增 `PluginInstallDialog` 组件，展示插件信息 + 权限清单（风险圆点+说明）+ 高危红色边框 + 后果说明 + 「我已阅读并理解以上风险」复选框（未勾选禁用确认按钮）
- **开发者控制台日志视图**：新增 `PluginDevConsole` 组件，插件下拉筛选 + Info/Warn/Error 三色 toggle + 等宽日志列表 + 自动滚动 + 清空按钮
- **插件详情面板**：新增 `PluginDetail` 组件，左侧列表（图标/名称/版本/开关）+ 右侧详情（元信息 + 权限卡 + 配置卡）；权限卡支持单条撤销/授予
- **Rust 新增 3 个 Tauri Commands**：`plugin_assert_perm`（内核权限校验）、`plugin_permissions_meta`（权限元数据列表）、`plugin_parse_manifest_from_dir`（从目录解析 manifest 不安装）

### 变更
- **permissions.rs 扩展**：ALL_PERMISSIONS 补全至 17 项（新增 log.read / updater.manage），新增 HIGH_RISK_PERMISSIONS / MEDIUM_RISK_PERMISSIONS / risk_level / assert_perm / permission_description 函数 + 8 个单元测试
- **pluginSdk.ts 升级**：createRDContext 中 storage/ui/log 分组从 NOT_IMPLEMENTED 改为真实实现；ssh/sftp/server/http/tunnel/theme 分组加 assertPermission 前置校验
- **SettingsDialog 插件 Tab 完善**：「已安装」子 Tab 从占位文案替换为 PluginDetail 组件 + 「选择目录安装」按钮；「权限」子 Tab 替换为 PluginDevConsole 组件；settingsVisible 时自动调用 loadPlugins
- **pluginLifecycleManager 增强**：disable 时新增 `usePluginUiStore.removeAllForPlugin(id)` 清理 Toolbar 按钮注册

---

## [0.1.90] - 2026-08-16

### 新增
- **插件系统基础骨架（Phase 1）**：按三层插件架构（内核层 / 调度层 / 扩展层）完成插件系统最小可行实现，对应 RD v0.1.90
- **SDK 类型定义包**：新增 `src/types/plugin.ts`（约 1800 行），完整定义 PluginManifest / PluginPermission / HostConfigSafe / RdEventMap / EventBus / BasePlugin / RDContext 等核心类型；HostConfigSafe 自动脱敏 password / private_key，保留 has_* 布尔标记
- **Rust 插件模块**：`src-tauri/src/plugin/`（7 个子模块）实现 manifest 校验（6 个单测覆盖）、插件目录扫描（plugins/${id}@${version}）、持久化 plugin-state.json、17 项权限白名单校验，并通过 16 个 Tauri Commands 暴露给前端（plugin_list / plugin_toggle / plugin_uninstall / plugin_install_from_dir / plugin_get_config / plugin_set_config / plugin_get_granted / plugin_set_granted 等）
- **PluginSandbox iframe 沙箱**：新增 `PluginSandbox` React 组件（`src/components/plugin/`），采用 `sandbox="allow-scripts allow-popups"` 严格隔离（无 allow-same-origin → opaque origin），全部生命周期调用通过 MessageChannel 端口通道传输 + 3s 安全超时，防止 Promise 悬挂
- **设置面板插件 Tab 框架**：SettingsDialog 左侧菜单新增「插件」一级 Tab（8 Tab），内置 3 个次级 Tab：已安装 / 市场 / 权限（Phase 1 为空框架占位，列表/详情/权限编辑功能在后续版本实现）
- **插件生命周期 5 态串联**：新增 `pluginLifecycleManager` 单例调度器，动态挂载隐藏 PluginSandbox 到 `#__rd_plugin_sandboxes__`；togglePlugin(true) 时按顺序 mount → init → enable；togglePlugin(false) 时按顺序 disable → uninstall → destroy；所有异常 catch 打 warning 不阻塞主流程；`pluginStore.getPlugin(id)` 同步查询返回 PluginInfo | null
- **前端 SDK 空骨架**：新增 `pluginSdk.ts`，提供 `SDK_API_VERSION` 常量、NOT_IMPLEMENTED / PERMISSION_DENIED 错误码、完整 `on/off/offAll/emit` EventBus 实现（支持按 owner 批量卸载）、`createRDContext()` 构造器（覆盖 ui/storage/ssh/sftp/server/http/tunnel/theme/log 全部分组 API，同步方法抛 NOT_IMPLEMENTED，异步方法 Promise.reject）

### 变更
- **SettingsDialog Tab 顺序调整**：由 6 Tab（通用 / 主题 / 更新 / 快捷键 / 调试 / 关于）扩展为 7 Tab（在「快捷键」与「调试」之间插入「插件」）
- **运行时目录新增**：首次启动会自动创建 `${appDataDir}/plugins/` 用于存放插件目录（`${id}@${version}` 命名）、`${appDataDir}/plugin-state.json` 用于持久化插件启用状态/权限/配置
- **Tauri lib.rs state/commands 扩展**：`PluginState` 通过 `.manage()` 注入到 Tauri App，`invoke_handler` 注册全部 16 条插件相关 commands

---

## [0.1.89] - 2026-08-15

### 新增
- **自动重连机制**：网络断开后自动尝试重连，采用指数退避策略（2s → 4s → 8s → 16s → 30s，最多 10 次、总超时 5 分钟），网络恢复时立即抢先重试
- **重连状态 UI 展示**：
  - Tab 栏：断线主机标签显示灰色状态点 + 重连次数徽标（如「重连 3」）
  - 服务器信息面板：简洁显示「重连中…」+ 闪烁动画
  - 终端面板：顶部橙色 banner 显示重连进度（第 N 次、倒计时），提供「立即重连」和「取消重连」按钮
  - 终端标题右键菜单：新增「取消重连」选项
- **多层面网络状态检测**：结合 Rust SSH 断开事件、window online/offline 事件、navigator.onLine 2s 轮询、启动时检测、Rust connection_state 10s 健康检查，确保网络变化在数秒内被捕获
- **日志写入本地文件**：前端日志（带 `[FE]` 标签）通过 `update_log` 命令写入 `update.log`，与后端日志（`[BE]`）统一管理，便于排查问题
- **重连成功后自动恢复终端**：重连成功后自动重新创建 PTY shell 会话，恢复终端使用
- **手动取消重连**：用户可随时通过终端 banner、右键菜单或 Tab 按钮取消自动重连

### 变更
- **连接状态扩展**：`ConnectionState` 类型新增 `reconnecting` 状态，用于区分主动断开与自动重连过程
- **重连元信息**：新增 `ReconnectMeta` 接口，记录当前尝试次数、下次延迟时间和预计时间戳，供 UI 展示倒计时
- **日志级别策略**：重连链路关键事件（SSH 断开、重连 attempt、online 抢先重试结果）默认以 warn 级别写入文件，用户开 debug 开关时 info 级别事件也会写入
- **连接失败友好提示**：手动连接失败时按错误类型展示不同颜色和文案（认证/配置问题黄色 warning、网络问题红色 error），并给出具体操作建议
- **ServerInfo 面板精简**：连接状态区简化为「状态圆点 + 简短文字」，移除倒计时和操作按钮，详细重连操作统一由终端面板 banner 承担
- **SFTP 重连后自动重试**：重连成功后首次远程目录加载若遇 SFTP Timeout（时序抖动），自动静默重试 2 次（200ms + 400ms），不再弹红色错误 Toast 干扰用户

### 修复
- **断网后状态不更新**：修复拔网线后服务器信息面板仍显示「已连接」、主机标签仍显示绿点的问题，现在 2s 内即可反映断线状态
- **网络恢复不自动重连**：修复网络恢复后不会自动发起重连的问题，现在 online 事件触发时会立即抢先重试一次
- **自动重连误判成功**：修复 SSH 连接失败（如 os error 10065 host unreachable）后被误判为「重连成功」的 bug，`connectHost` 现在返回 boolean 并二次确认 Rust 端 `connection_state`
- **重连过程出现 SFTP 错误 Toast**：修复自动重连成功后首次加载远程目录时出现「SFTP 错误：sftp error: Timeout」红色 Toast 的问题，新增 Timeout 专用静默重试
- **自动重连过程 Toast 过于频繁**：将自动重连过程中的 Toast 提示全部移除，改为纯 UI 状态展示（Tab 徽标、ServerInfo 状态、TerminalPanel banner），避免重连期间每 2 秒弹一次红 error Toast

---

## [0.1.55] - 2026-08-13

### 新增
- **自定义主题编辑器**：支持基于预设主题创建自定义主题，可视化调整调色板颜色、终端配色、背景图等所有字段，改动即时注入并预览，可导出/导入/删除
- **背景图功能**：主题支持自定义背景图，提供「遮罩透明度」与「面板玻璃透明度」两组滑块独立调节，平衡背景图可见性与文字可读性
- **背景图拖拽定位**：主题编辑器中可直接拖拽预览图调整背景图在窗口中的显示位置，提供「重置位置」一键回到居中
- **护眼绿主题**：新增经典绿豆沙底色预设主题，缓解长时间阅读疲劳
- **终端主题动态切换**：切换主题时所有终端实例实时同步新配色，无需重开终端

### 变更
- **颜色统一改用 CSS 变量**：移除代码与样式中所有硬编码颜色，统一通过 CSS 变量驱动，便于主题继承与覆盖
- **主题编辑体验优化**：设置弹窗关闭时清空编辑状态避免残留；首次上传背景图时根据基础主题深浅自动推荐合理参数
- **背景图存储稳定性增强**：上传时压缩图片体积，保存前预检 localStorage 容量并在超限时提示，持久化失败时不更新内存状态避免「会话内生效但重启丢失」

### 修复
- **背景图显示不明显**：修复黑夜科技主题下暖色背景图被深色遮罩完全掩盖的问题，改用双层遮罩（中性亮度调节层 + 低浓度主题染色层），保留图片原色且保证文字可读
- **终端面板背景图不生效**：修复设置背景图后终端仍显示纯黑的问题，将 xterm 背景色纳入玻璃化控制并按需开启 `allowTransparency`
- **透明度滑块无响应**：修复遮罩透明度和面板透明度滑块拖动后效果不变的问题，原因是预设主题 CSS 选择器优先级高于 JS 注入
- **主机连接后终端不自动连接**：修复无背景图时也误开启 `allowTransparency` 导致 xterm 渲染异常、终端无法自动连接的问题
- **主题编辑器残留状态**：修复关闭主题编辑界面后重新打开设置仍显示上次编辑主题、且主题被自动切换的问题
- **启动时主题闪屏**：修复软件启动时先加载默认主题再切换到设定主题的闪屏问题，在 index.html 添加首屏主题同步内联脚本
- **重启后背景图丢失**：修复稍大背景图导致 localStorage 超限、保存被静默吞掉的问题
- **远程目录右键菜单偏移**：修复开启背景图后远程目录右键菜单离鼠标较远的问题，原因是面板的 `backdrop-filter` 改变了 `position: fixed` 元素的包含块，改用 React Portal 将菜单渲染到 document.body 解决

---

## [0.1.54] - 2026-08-13

### 新增
- **终端字体自定义设置**：设置 → 通用中新增「终端外观」分组，支持选择系统已安装字体、自定义字体名，并可调整字号、行高、字间距，设置即时生效并持久化
- **字体实时预览**：字体选择上方提供预览区，鼠标悬停字体列表项时预览区实时切换为该字体，点击确认后生效
- **自定义全局快捷键**：设置中新增「快捷键」标签页，支持录制和自定义全局快捷键，可逐项重置或一键重置全部
- **终端全屏快捷键**：终端标签页支持快捷键切换全屏，双击终端标签也可快速全屏/退出全屏
- **命令历史功能**：状态栏新增命令历史按钮，终端执行的命令自动上报并记录，便于查看历史操作
- **标签栏主题切换菜单**：标签栏新增主题切换下拉菜单，可快速切换应用主题

### 变更
- **字体列表虚拟滚动**：字体下拉列表引入虚拟滚动（@tanstack/react-virtual），数百个字体仅渲染可视区域项，滚动流畅；支持键盘导航（↑↓ 选择、Enter 确认、Esc 关闭），展开时自动定位到当前字体
- **字体名读取方式重构**：后端引入 ttf-parser，从字体文件二进制内部 name 表读取真实 family name（优先 nameID=16，回退 nameID=1），替代基于文件名的猜测方案，确保 Nerd Font 等字体的 CSS font-family 能正确匹配
- **当前字体智能匹配**：字体列表加载后，自动从 fontFamily fallback 链中找到系统已安装的第一个字体并高亮选中，不再显示不存在的字体名
- **统一日志工具**：项目内所有 console 日志替换为统一日志工具（logInfo/logWarn），由调试开关统一控制输出级别

### 修复
- **Nerd Font 预览乱码**：修复字体文件名提取逻辑中错误移除 "Nerd"/"Nerd Font" 后缀导致字体名不匹配、CSS fallback 到普通字体、Nerd Font 图标显示为方框的问题
- **字体预览图标码点错误**：修复预览区前 3 个图标使用了错误的码点（0xe3/0xe2/e1 为西文重音字符而非 Nerd Font 图标）
- **bash 启动命令误上报**：修复 PTY 会话中 bash 启动命令被误上报到命令历史的问题

---

## [0.1.51] - 2026-08-12

### 变更
- **文件夹压缩传输临时文件可见化**：上传/下载文件夹时，临时压缩包（`.tar.gz.tmp`）直接生成在目标目录中，用户可实时看到传输进度；传输完成后自动重命名为正式压缩包名，解压后删除压缩包
- **下载文件实时同步磁盘**：修复下载文件夹时本地临时文件大小一直显示 0KB 的问题，每写入一块数据后立即 flush + sync_data 到磁盘，文件管理器中可实时看到文件大小随下载进度增长
- **传输队列自动切换 Tab**：发起上传或下载操作时，传输队列自动切换到对应的「上传」或「下载」标签页
- **移除 macOS Intel 打包**：CI/CD 构建矩阵移除 macOS x86_64 (macos-13) 平台，仅保留 macOS ARM64

### 修复
- **上传完成后重复删除远程文件警告**：修复上传成功后 `finally` 块重复删除已被清理的远程压缩包导致后端报 "no such path" 警告的问题

---

## [0.1.31] - 2026-08-11

### 新增
- **调试菜单**：设置中新增「调试」标签页，提供「详细日志」开关——开启后记录所有级别日志（含 Info），关闭时仅记录警告和错误，便于排查问题同时避免日志膨胀
- **日志文件管理**：调试菜单中提供「打开日志文件夹」和「清空日志」按钮，方便查看和清理 `update.log`
- **关键模块日志打印**：为项目内容易出问题的部分添加日志，所有日志打印统一由调试开关控制：
  - **SSH 连接**：连接开始、握手成功/失败、认证成功/失败、home_dir 解析等关键步骤
  - **SFTP 文件操作**：会话创建、子系统请求、目录列表、文件上传/下载/删除等
  - **PTY 终端**：会话创建、通道打开、命令注入、EOF/关闭事件、read_loop 退出等
  - **命令执行（ssh_exec_raw）**：通道打开、命令执行、非零退出码、输出解析错误等
  - **存储模块**：主机保存/删除、凭据保存/删除失败等关键操作

### 变更
- **更新菜单调整**：设置 → 更新中的「更新日志」部分移除，与调试菜单中的「日志文件」功能合并，避免重复
- **下载源延迟同步**：检查更新时产生的镜像延迟结果同步到设置页下载源显示，保持两侧数据一致

### 修复
- **打开日志文件夹卡顿**：将文件操作和进程启动移至后台线程（fire-and-forget），命令立即返回，点击后不再有 1 秒左右延迟

---

## [0.1.27] - 2026-08-11

### 新增
- **下载源延迟显示**：发现新版本弹框中的下载源显示各镜像的访问延迟数值，按延迟高低用颜色区分（绿色 <300ms / 黄色 <1000ms / 灰色 超时或不可达），并自动勾选速度最快的镜像源
- **设置页下载源统一样式**：设置 → 更新中的下载源镜像卡片样式与发现新版本弹框保持一致，支持点击选中、显示延迟标签和选中状态图标
- **「当前已是最新版本」状态**：检查更新完成且无新版本时，状态栏显示绿色「当前已是最新版本」，点击可重新检查更新

### 变更
- **精简通知提醒**：检查更新为最新版本时不再弹出 toast 通知；设置中检测延迟成功时也不再弹出通知，仅在失败或全部不可达时提醒

---

## [0.1.26] - 2026-08-11

### 变更
- **更新流程重构（下载与安装分离）**：下载更新改为后台进行，进度仅在右下角状态栏醒目显示，下载中可关闭更新对话框继续使用程序，不再阻塞操作
- **下载完成后确认安装**：更新包下载完成后自动弹出确认框，提供「立即安装并重启」与「下次启动时安装」两个选项；选择后者会保留本地更新包，下次打开程序时自动识别并再次提示安装
- **状态栏更新徽章增强**：所有更新状态（下载中 / 安装中 / 已下载待安装 / 错误）都支持点击打开对话框查看详情；已下载待安装徽章带呼吸灯动画，区分「刚下载完（绿色）」和「跨会话待安装（橙色）」两种视觉样式

---

## [0.1.24] - 2026-08-11

### 新增
- **更新镜像自动测速**：检查更新时并行测试 4 个下载源延迟，自动选择最快的镜像请求更新信息，国内网络体验更顺畅
- **传输队列等待标识**：多文件同时上传时，排队中的任务显示「等待中」状态（橙色标识），不再与正在传输的任务混淆

### 修复
- **更新对话框点击无响应**：修复点击「更新可用」后对话框不弹出的问题，将更新状态从组件级 useState 重构为 Zustand 全局 store，确保各组件状态同步
- **Toast 被对话框遮挡**：修复测试连接的成功/失败提示弹框被编辑主机对话框遮挡的问题，Toast z-index 提升至 100000

### 变更
- **传输队列操作按钮上移**：「清除已完成」和「清空全部」按钮从队列底部移至标题下方，操作更便捷
- **移除新建同主机标签**：标签栏右键菜单中移除「新建同主机标签」选项

---

## [0.1.21] - 2026-08-11

### 新增
- **更新进度显示优化**：使用安装包实际大小计算进度，不再使用固定 180MB 估算值；进度条在状态栏显示为「已下载/总大小 MB」格式
- **更新对话框**：检测到新版本时自动弹出，展示当前版本、最新版本、安装包大小及本次更新内容，用户可自主选择「立即更新」或「稍后更新」
- **下载加速镜像**：新增 4 种下载源可切换（GitHub 官方 / ghproxy / gh-mirror / kgithub），在「设置 → 更新」和更新对话框中均可选择，国内网络推荐使用镜像
- **Release 页面自定义说明**：Release 页面现在展示本 CHANGELOG 中对应版本的内容，替代 GitHub 自动生成的 "Full Changelog" 链接

### 修复
- 修复下载进度严重滞后（下载一半仅显示约 2%）的问题

### 变更
- 自动检查更新成功后，不再弹出「已完成检查」类的成功 Toast，仅在失败时展示错误 Toast

---

## [0.1.20] - 2026-08-xx

### 新增
-

### 修复
-

---

## [0.1.19] - 2026-08-xx

### 新增
-

### 修复
-

---

<!--
  使用说明：
  1. 每次准备发布新版本（打 tag vX.Y.Z）前，先在本文件顶部新增对应「## [X.Y.Z] - 日期」段落
  2. 用 Markdown 撰写，支持：
     - ### 新增 / ### 修复 / ### 变更 / ### 优化 等二级分类（建议中文）
     - 无序列表（- 开头）、有序列表（1. 开头）
     - **粗体**强调重点
  3. 打 tag 触发 CI 后，CI 会自动解析对应段落并写入 Release 描述 + latest.json.notes
  4. 更新对话框中会渲染常用 markdown（标题 / 有序无序列表 / 粗体 / 换行）
-->
