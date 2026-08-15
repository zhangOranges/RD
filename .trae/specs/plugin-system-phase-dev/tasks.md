# RD 插件系统 v1.0 - 分阶段实施计划（任务清单）

> 对应 RD 版本：v0.1.90（Phase 1）→ v0.1.91（Phase 2）→ v0.1.92（Phase 3）→ v0.1.93（Phase 4）→ v0.1.94（Phase 5）→ v1.0（Phase 6）
> 参考规范文档：`插件开发设计.md` §12 落地迭代路线图

---

## ================================================
## Phase 1：基础骨架（RD v0.1.90）
## ================================================

### [x] Task 1.1：SDK 类型定义包
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 新建 `src/types/plugin.ts`（或独立 packages/plugin-sdk 目录，视 Open Question 结果）
  - 将设计文档 §13 附录 1797 行完整类型定义迁移为 `.d.ts` + TS 源码
  - 类型 100% 对齐 `src/types/index.ts`：复用 HostConfig/CategoryConfig/ConnectionState/ReconnectMeta/ConnectResult/TransferTask/SftpFile/FriendlyFailure 等
  - 导出 BasePlugin 抽象类骨架、RDContext 接口、RdEventMap 事件映射、17 项 PluginPermission 联合类型
  - HostConfigSafe 需特别标记：`password?` 和 `private_key?` 字段不存在，只有 has_password/has_private_key boolean
- **Acceptance Criteria Addressed**: AC-1, AC-2, NFR-2
- **Test Requirements**:
  - `programmatic` TR-1.1.1: `tsc --noEmit` 全量类型检查通过，无 `any` 泄露
  - `programmatic` TR-1.1.2: `HostConfigSafe` 类型断言：`keyof HostConfigSafe` 不包含 `'password' | 'private_key'`
  - `human-judgement` TR-1.1.3: 字段命名与 `src/types/index.ts` 完全一致，无第二套命名体系
- **Notes**: 不实现逻辑，只定义类型。如果采用 monorepo，plugin-sdk 作为独立 workspace package。

---

### [x] Task 1.2：Rust 插件模块骨架（manifest + manager + store）
- **Priority**: high
- **Depends On**: Task 1.1
- **Description**:
  - 新建 `src-tauri/src/plugin/` 目录及 mod.rs 导出
  - `manifest.rs`: `#[derive(Serialize, Deserialize)] struct PluginManifest` 对齐 JSON 字段 18 项；jsonschema crate 校验
  - `manager.rs`: `PluginManager::scan(app_data_dir)` 扫描 `${appDataDir}/plugins/*`，`parse_manifest(path)` → `validate(manifest)` → `install/uninstall/enable_disable` 方法
  - `store.rs`: `PluginStoreItem`（id/version/enabled/install_time_ms/last_load_time_ms/granted_permissions/config/load_error）持久化到 `${appDataDir}/plugin-state.json`
  - `permissions.rs`: 权限列表 17 项枚举 + check(plugin_id, perm) 基础骨架
  - `bridge.rs`: 空文件占位，Phase 2 实现
  - `hot_reload.rs`: 空文件占位，Phase 4 实现
  - 在 `src-tauri/src/lib.rs` 注册 Tauri Commands：plugin_list / plugin_toggle / plugin_uninstall / plugin_install_from_dir / plugin_get_config / plugin_set_config / plugin_get_granted / plugin_set_granted
- **Acceptance Criteria Addressed**: AC-1, FR-1, FR-2
- **Test Requirements**:
  - `programmatic` TR-1.2.1: `cargo fmt && cargo check` 无 warning
  - `programmatic` TR-1.2.2: 提供合法/非法 manifest.json 各 3 组测试样例，jsonschema 校验结果正确
  - `programmatic` TR-1.2.3: scan() 能正确解析 2 个模拟插件目录并返回 PluginInfo 列表
- **Notes**: 暂时不做 plugin_install_from_file（zip 解压），Phase 4 实现。

---

### [x] Task 1.3：前端 PluginSandbox + postMessage 桥接雏形
- **Priority**: high
- **Depends On**: Task 1.1, 1.2
- **Description**:
  - 新建 `src/components/plugin/PluginSandbox.tsx`：
    - 渲染 `<iframe sandbox="allow-scripts allow-popups" src={pluginIndexHtml} />`
    - `window.addEventListener('message')` 监听 `__rd_plugin_call` 消息
    - 通过 `MessageChannel` port 返回结果（一次性端口，避免串话）
    - 暴露 `callSdk(method, args)` → `postMessage` 工具方法
  - 新建 `src/store/pluginStore.ts`（Zustand）：
    - `state: { plugins: PluginInfo[] }`
    - `actions: { loadPlugins, togglePlugin, uninstallPlugin, getConfig, setConfig }`
    - 调用 Tauri invoke 对应命令
    - `subscribe` 机制：插件列表变化通知各 UI 组件
  - 新建 `src/utils/pluginSdk.ts`（空骨架）：Phase 2 实现权限校验 + 逻辑分发
- **Acceptance Criteria Addressed**: AC-1, AC-4
- **Test Requirements**:
  - `programmatic` TR-1.3.1: `tsc --noEmit` 通过
  - `programmatic` TR-1.3.2: iframe sandbox 属性包含 `allow-scripts allow-popups`，**不包含** `allow-same-origin`
  - `human-judgement` TR-1.3.3: 最小插件 index.html + main.js 在沙箱中加载无跨域错误
- **Notes**: 先用一个硬编码 demo 插件（无业务逻辑）验证沙箱通信。

---

### [x] Task 1.4：SettingsDialog「插件」Tab 插入 + 3 个子 Tab 空框架
- **Priority**: high
- **Depends On**: Task 1.3
- **Description**:
  - 修改 `src/components/SettingsDialog.tsx` 的 TABS 常量与 tab 渲染逻辑：
    - 原顺序：通用→终端→主题→自动更新→快捷键→调试→关于
    - 新顺序：通用→终端→主题→自动更新→快捷键→调试→**插件**→关于
  - 新建 `src/components/settings/PluginsTab.tsx`：
    - 子 Tab 1「已安装插件」：左右分栏占位骨架（左 list/右 detail，`display:flex` + 分隔线），显示"暂无已安装插件"空态
    - 子 Tab 2「本地安装」：400×240 虚线圆角大拖拽框（`.drag-drop-zone` 样式对齐 Finder 风格），选择文件按钮占位
    - 子 Tab 3「开发者控制台」：顶部工具条下拉 + 级别过滤按钮占位 + 底部日志区等宽字体容器
  - 新建对应 `.settings-plugins-*` CSS 类写入 `src/styles/finder.css`，使用 CSS 变量，6 套主题切换视觉一致
- **Acceptance Criteria Addressed**: AC-7
- **Test Requirements**:
  - `programmatic` TR-1.4.1: `tsc --noEmit` 通过
  - `human-judgement` TR-1.4.2: 8 个 Tab 顺序正确，「插件」在「调试」与「关于」之间，3 个子 Tab 切换流畅
  - `human-judgement` TR-1.4.3: 切换 6 套主题，颜色、圆角、分隔线完全跟随现有风格
- **Notes**: 列表/详情/日志功能在 Phase 2 实现，本任务只出空框架 + 样式对齐。

---

### [x] Task 1.5：生命周期实现（init/enable/disable/uninstall）
- **Priority**: high
- **Depends On**: Task 1.3, 1.4
- **Description**:
  - PluginSandbox 新增生命周期方法：
    - `sandbox.callInit(ctx, bus)` → postMessage 调用插件 `new PluginClass().init(ctx, bus)`
    - `sandbox.callEnable()` / `sandbox.callDisable()` / `sandbox.callUninstall()`
  - 内核 RDContext 构造：注入 pluginId、manifest 副本、各 API 模块占位对象（返回 NOT_IMPLEMENTED）
  - pluginStore 串联：togglePlugin(true) = invoke Tauri + loadPlugins + 对每个 enabled=true 的插件创建 PluginSandbox 实例 → init → enable；togglePlugin(false) = disable + 销毁 iframe
  - 插件 `disable()` 调用后，内核记录的该插件注册 UI 列表（空数组占位）全部清空
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `programmatic` TR-1.5.1: 编写最小插件 BasePlugin 子类，init/enable/disable/uninstall 各打日志，切换开关按正确顺序输出
  - `programmatic` TR-1.5.2: 插件卸载后，`pluginStore.getPlugin(id)` 返回 null
  - `human-judgement` TR-1.5.3: 开关切换无白屏、无 console.error 异常
- **Notes**: bus 事件总线使用空实现占位，Phase 2 接入真实 EventBus。

---

### [x] Task 1.6：CHANGELOG.md v0.1.90 记录 & 语法检查
- **Priority**: medium
- **Depends On**: Task 1.1 - 1.5
- **Description**:
  - CHANGELOG.md 顶部新增 `## [0.1.90] - 2026-XX-XX` 条目
  - 「新增」：插件系统基础骨架、@rd/plugin-sdk 类型定义、Rust plugin 模块、PluginSandbox iframe 沙箱、Settings 插件 Tab 框架、生命周期 5 态
  - 「变更」：SettingsDialog Tab 顺序调整（8 Tab）、新增 `${appDataDir}/plugins/` 与 `plugin-state.json` 运行时文件
  - 运行全量语法检查：`npx tsc --noEmit` + `cargo fmt && cargo check && cargo clippy -D warnings`
- **Acceptance Criteria Addressed**: AC-13, AC-14
- **Test Requirements**:
  - `programmatic` TR-1.6.1: 三项语法检查零错误零 warning
  - `human-judgement` TR-1.6.2: CHANGELOG 格式符合 Keep a Changelog，分类正确

---

## ================================================
## Phase 2：事件总线 + 基础 SDK（RD v0.1.91）
## ================================================

### [x] Task 2.1：EventBus Bridge 内核事件分发
- **Priority**: high
- **Depends On**: Task 1.5
- **Description**:
  - 新建 `src/utils/eventBus.ts`（或复用 hostStore 已有事件机制）：实现 `on/off/offAll/emit` 泛型接口，owner 参数绑定插件实例引用
  - 实现 RdEventMap 全部 7 大类 43 事件的 Bridge：
    - A. 连接 & 重连 11 个事件（重点 reconnect 6 事件：reconnecting / reconnect-attempt / reconnect-success / reconnect-failed / reconnect-aborted + batch-start/finish）
    - B. 终端 6 事件
    - C. SFTP 10 事件
    - D. 主机分类 6 事件
    - E. UI/主题/设置 8 事件
    - F. 隧道 4 事件（Phase 5 实现后才真正 emit）
    - G. 自动更新/日志 4 事件
  - PluginSandbox 将内核 emit 的事件通过 postMessage 转发给对应插件的 bus.on 监听器；插件 off/on 同样桥接回内核
  - `bus.offAll(owner)` 在插件 disable 时被内核自动调用
- **Acceptance Criteria Addressed**: AC-5, NFR-3
- **Test Requirements**:
  - `programmatic` TR-2.1.1: reconnect 事件流按 §5.2.A 顺序触发，参数类型断言通过
  - `programmatic` TR-2.1.2: `offAll(owner)` 后，该 owner 绑定的所有监听器不再被触发
  - `programmatic` TR-2.1.3: 插件 A 的事件不会传递给插件 B（分发隔离）
- **Notes**: 隧道 4 事件先定义空占位，Phase 5 真正 emit。优先实现 reconnect 系列。

---

### [x] Task 2.2：Storage API + config.schema.json 自动渲染
- **Priority**: high
- **Depends On**: Task 2.1
- **Description**:
  - `src/utils/pluginSdk.ts` 实现 PluginStorage：
    - 读写 `${appDataDir}/plugin-data/${pluginId}/store.json`（或 sqlite）
    - `set/get/remove/removeAll`：key 自动前缀 `plugin:${id}:`
    - `writeFile/readFile/listFiles`：大文件二进制/文本，严格限制在 `${appDataDir}/plugin-data/${pluginId}/` 子树
    - 永久黑名单：禁止路径包含 `~/.ssh`、`%USERPROFILE%\.ssh`、`${appDataDir}/credentials`、`/etc`、`../` 逃逸
  - Rust 侧新增 Tauri Command `plugin_storage_*`，前端通过 invoke 调用
  - 实现 config.schema.json 自动渲染引擎：
    - 6 种字段类型：string / string+password / string+textarea / number / boolean / string+enum / object 分组
    - 组件类名对齐 `.settings-input` / `.settings-textarea` / `.switch` / `.settings-select`
    - 保存时写 `config.json` 并触发插件 `onConfigChange(newConfig)`
- **Acceptance Criteria Addressed**: FR-2, FR-3, AC-2
- **Test Requirements**:
  - `programmatic` TR-2.2.1: storage API 黑白名单路径拒绝断言（5 组黑名单路径全部返回 PERMISSION_DENIED）
  - `programmatic` TR-2.2.2: config schema 6 种字段渲染后能保存 + 读回原值
  - `human-judgement` TR-2.2.3: 渲染风格与 SettingsDialog 现有组件 100% 视觉一致
- **Notes**: 密码类型字段 `format: password` 渲染为打码输入框，存储值为明文（插件自保护），但写入日志时强制脱敏。

---

### [x] Task 2.3：基础 UI API + Log API
- **Priority**: high
- **Depends On**: Task 2.2
- **Description**:
  - UiApi 实现：
    - `notify(title, message, kind, durationMs)` → 调用 uiStore Toast，限频 10s/插件最多 3 条
    - `confirm(message, title?)` → 调用 Confirm 对话框，限频 5s/插件最多 2 条
    - `prompt(message, defaultValue?, title?)` → 同理
    - `registerToolbarButton(opt) / removeToolbarButton(id)` → 在 Toolbar.tsx 的对应 group（left/center/right）注入按钮；disable 时全部移除
  - Log API：`info/warn/error` 三个级别 → 调用 `src/utils/log.ts` writeLog，行前缀固定 `[plugin:${id}]`；info 仅调试模式写文件，warn/error 永久写
  - Toolbar.tsx 修改：左/中/右三栏添加 plugin buttons 插槽，按注册时间排序
- **Acceptance Criteria Addressed**: FR-3, NFR-3, NFR-5
- **Test Requirements**:
  - `programmatic` TR-2.3.1: 连续 4 次 notify，第 4 次被丢弃返回限频错误
  - `programmatic` TR-2.3.2: disable() 调用后，已注册的 Toolbar 按钮从 DOM 消失
  - `programmatic` TR-2.3.3: log.error 日志行前缀正确，且 update.log 文件中存在
- **Notes**: ui.inject-menu 权限此时生效，未声明则调用抛 PERMISSION_DENIED。

---

### [x] Task 2.4：权限校验框架 + 4 高危权限安装红标
- **Priority**: high
- **Depends On**: Task 2.3
- **Description**:
  - Rust `plugin/permissions.rs` + 前端 `src/utils/pluginSdk.ts` 双层校验：
    - 客户端校验（插件 SDK 内快速失败，仅体验优化）
    - 内核校验（`assertPerm(pluginId, perm)`，安全真实拦截，不可绕过）
  - 安装确认弹窗完整实现（Phase 1 本地安装子 Tab 补充）：
    - 插件图标/名称/版本/作者（头部）
    - 风险提示条（背景 `--bg-danger-soft`）
    - 权限清单分组展示：低风险绿点 / 中风险黄点 / 高风险红点
    - `ssh.run` / `server.write` / `sftp.operate` / `tunnel.manage` 4 项显示红色边框 + 后果说明大卡片
    - 「我已阅读并理解以上风险」复选框，未勾选确认按钮禁用
    - 点击「确认授予权限并安装」后写入 `granted_permissions` 到 plugin-state.json
- **Acceptance Criteria Addressed**: AC-3, AC-9
- **Test Requirements**:
  - `programmatic` TR-2.4.1: 未声明权限调用 → 内核层返回 PERMISSION_DENIED，日志写入
  - `programmatic` TR-2.4.2: 复选框未勾选时，按钮 DOM `disabled = true`
  - `human-judgement` TR-2.4.3: 高危权限视觉红色边框显著，后果说明文案完整
- **Notes**: 安装流程（zip 解压）Phase 4 做，本期 UI 可以用「选择插件目录」方式触发安装确认弹窗验证流程。

---

### [x] Task 2.5：开发者控制台日志视图 + 权限详情 Tab 完善
- **Priority**: medium
- **Depends On**: Task 2.4
- **Description**:
  - PluginsTab 子 Tab 3「开发者控制台」：
    - 顶部下拉选插件（默认全部），Info/Warn/Error 三枚 toggle 按钮
    - 日志区：等宽字体，插件 ID 彩色前缀（hash 颜色），时间戳；Warn 橙色 Error 红色 + 图标
    - 清空日志按钮 / 全部热重载按钮占位 / 打开插件根目录按钮（Tauri opener 打开 `${appDataDir}/plugins`）
  - 子 Tab 1「已安装插件」左侧列表 + 右侧详情填充：
    - 列表行：图标 56×56 圆角 14px + 名称 + 分类徽章 + 版本 + 作者 + 状态标签 + .switch 开关 + 三图标按钮（配置/权限/卸载）
    - 右侧详情：96×96 大图 + 名称版本胶囊 + 元信息卡片 + 权限卡（每行权限 + 说明 + 风险圆点 + 单条撤销复选）+ 配置卡（若有 schema 直接内嵌渲染）
- **Acceptance Criteria Addressed**: AC-7, FR-3
- **Test Requirements**:
  - `programmatic` TR-2.5.1: 日志按级别过滤 toggle 生效，插件筛选下拉生效
  - `programmatic` TR-2.5.2: 单条权限撤销后，下次调用对应 SDK 返回 PERMISSION_DENIED
  - `human-judgement` TR-2.5.3: 列表/详情布局对齐设计文档 §8.2 描述
- **Notes**: 性能区（CPU/内存实时图）v2 再议，v1 不做。

---

### [x] Task 2.6：CHANGELOG.md v0.1.91 & 语法检查
- **Priority**: medium
- **Depends On**: Task 2.1 - 2.5
- **Description**:
  - CHANGELOG.md 新增 v0.1.91 条目
  - 「新增」：EventBus 43 事件分发、Storage API、config.schema.json 自动表单、UiApi notify/confirm/prompt、Toolbar 按钮注册、Log API 桥接、权限校验框架、安装确认弹窗高危权限红标、开发者控制台日志视图
  - 「变更」：PluginSandbox postMessage 协议加入事件桥接
  - 语法检查：tsc + cargo fmt/check/clippy
- **Acceptance Criteria Addressed**: AC-13, AC-14
- **Test Requirements**:
  - `programmatic` TR-2.6.1: 三项语法检查零错误零 warning
  - `human-judgement` TR-2.6.2: CHANGELOG 条目完整

---

## ================================================
## Phase 3：业务 SDK（RD v0.1.92）
## ================================================

### [x] Task 3.1：SshApi.runCommand + 友好错误
- **Priority**: high
- **Depends On**: Task 2.6
- **Description**:
  - 前端 SshApi 桥接层实现：复用 hostStore 连接池（绝对禁止新建独立 SSH 进程）
  - `runCommand(hostId, cmd, {timeoutMs, cwd})` → 调用 Rust SSH exec 模块（`src-tauri/src/ssh/exec.rs`）
  - 失败错误通过 `classifyConnectFailure()` 映射为 FriendlyFailure（network/auth/config/unknown）返回人话文案
  - `onTerminalOutput(terminalId, listener)` → 订阅 terminalStore 输出流，返回 off 函数
  - `ssh.run` 权限校验：未声明/全局开关禁止 → PERMISSION_DENIED；审计日志写入
- **Acceptance Criteria Addressed**: FR-4, NFR-6
- **Test Requirements**:
  - `programmatic` TR-3.1.1: 全局开关「禁止所有插件执行 SSH 命令」= true 时，所有 runCommand 返回 PERMISSION_DENIED
  - `programmatic` TR-3.1.2: 连 hostStore.getConnectionState(hostId) = connected 才允许执行，否则返回 HOST_NOT_AVAILABLE
  - `human-judgement` TR-3.1.3: 命令失败时，friendly.headline + friendly.suggestion 是人话（非 Rust panic 堆栈）
- **Notes**: 严禁插件直接访问 hostStore，只能通过 SDK 桥接层。

---

### [x] Task 3.2：SftpApi 完整实现 + transferQueue 接入
- **Priority**: high
- **Depends On**: Task 3.1
- **Description**:
  - 基础操作：`list/stat/mkdir/remove/rename/readText/writeText` → 通过 Rust sftp 模块，复用 fileStore 已有 SFTP 会话
  - 大文件传输：`upload(localPath, remotePath)` / `download(remotePath, localPath)`：
    - 内部调用 `transferStore.addTask()` 生成 TransferHandle
    - TransferHandle 暴露 `taskId / abort() / onProgress() / finished()`
    - **严格遵守文件夹传输协议**：目标目录先出现临时压缩包（`.tmp<pid>` 后缀）→ rename 为正式 zip → 解压 → 删除临时文件
    - 传输任务出现在 TransferQueue 组件列表中，与用户手动上传/下载一致
  - `sftp.operate` 权限校验 + 审计日志
- **Acceptance Criteria Addressed**: AC-6, NFR-1
- **Test Requirements**:
  - `programmatic` TR-3.2.1: upload/download 产生的 TransferTask 出现在 transferStore.tasks 列表
  - `human-judgement` TR-3.2.2: 文件夹上传时，目标目录文件变化序列符合「临时→rename→解压→删临时」4 步
  - `programmatic` TR-3.2.3: abort() 调用后，传输任务状态变为 canceled，文件被清理
- **Notes**: 必须使用 transferStore，不能另起炉灶。

---

### [x] Task 3.3：ServerApi 脱敏返回 + 连接控制
- **Priority**: hard
- **Depends On**: Task 3.2
- **Description**:
  - `listAll()` / `get(hostId)`：返回 HostConfigSafe，**代码级硬编码删除 password / private_key 字段**，添加 has_password / has_private_key boolean 标记
  - `add(item)` / `update(hostId, patch)` / `remove(hostId)`：允许插件传 password/private_key（新增场景），但返回值同样脱敏
  - 分类 CRUD：`listCategories / addCategory / updateCategory / removeCategory`
  - 连接状态 & 控制：`getConnectionState(hostId)`（返回 state/reconnectMeta/homeDir/fingerprint）、`connect(hostId)`、`disconnect(hostId, {suppressReconnect?})`、`cancelReconnect(hostId)`
  - 权限分层：`server.read`（listAll/get/listCategories/getConnectionState）vs `server.write`（add/update/remove）vs `server.manage`（connect/disconnect/cancelReconnect）
  - `server.write` 全局开关：禁止所有插件修改主机配置
- **Acceptance Criteria Addressed**: AC-2, AC-3, FR-4
- **Test Requirements**:
  - `programmatic` TR-3.3.1: `JSON.stringify(serverApi.listAll()[0])` 字符串中不出现 `password` 或 `private_key` 子串
  - `programmatic` TR-3.3.2: 插件无法通过任何"技巧"（`getOwnPropertyNames`/`Reflect`/`JSON.parse(JSON.stringify())`）获取密码原文
  - `programmatic` TR-3.3.3: `server.write` 全局开关开启时，add/update/remove 全被拒绝
- **Notes**: 这是 NFR-1 最关键的安全防线，必须白盒测试 + 代码审查双重保证。

---

### [x] Task 3.4：ThemeApi + HttpApi 网络限制
- **Priority**: high
- **Depends On**: Task 3.3
- **Description**:
  - ThemeApi：
    - `getCurrent()` → 返回 themeStore 当前 {id, name, cssVars}（从 `theme/palette.ts` 全量 token）
    - `onChange(listener)` → 订阅 `ui:theme-change` 事件
    - `syncToIframe(win)` → 在 iframe 的 `document.documentElement` 上设置全部 CSS var style 属性
  - HttpApi（受控网络请求，Rust reqwest 代理）：
    - `request/get/post` 方法，白名单域名默认允许
    - **内网 RFC1918 网段阻止**：10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、127.0.0.0/8、localhost，返回 NETWORK_FORBIDDEN
    - 用户可在「插件设置 → 允许插件访问内网 HTTP API」全局开关开启后放行
    - `network.http` 权限校验
- **Acceptance Criteria Addressed**: FR-4, NFR-5
- **Test Requirements**:
  - `programmatic` TR-3.4.1: iframe 沙箱内 `getComputedStyle(document.documentElement).getPropertyValue('--text-primary')` 返回非空，与主窗一致
  - `programmatic` TR-3.4.2: 切换主题后，iframe 中 CSS var 在 100ms 内同步完成
  - `programmatic` TR-3.4.3: 访问 `http://192.168.1.1:8080/api` 返回 NETWORK_FORBIDDEN，开启全局开关后允许
- **Notes**: DNS rebinding 防护：IP 解析后再次检查是否在内网段（Phase 4 加固）。

---

### [x] Task 3.5：全局开关完整实现 + maskMode 自动打码
- **Priority**: medium
- **Depends On**: Task 3.4
- **Description**:
  - PluginsTab 顶部区域增加 5 个大 `.switch` 全局开关（对齐设计文档 §6.3）：
    1. 🔒 禁止所有插件执行 SSH 命令（对应 ssh.run 全局拦截）
    2. 🔒 禁止所有插件修改主机配置（server.write 拦截）
    3. 🔒 禁止远程端口转发（-R 模式）（tunnel.manage 子模式，Phase 5 生效）
    4. ⚙️ 允许插件访问内网 HTTP API（默认关，network.http）
    5. ⚙️ 隐藏插件日志（调试 Tab 过滤）
  - `uiStore.maskMode` 联动：插件渲染主机卡片时，SDK 提供 `ui.mask()` 工具函数；若 maskMode=true，插件显示的密码字段/密钥提示文案等自动打码
- **Acceptance Criteria Addressed**: FR-4, AC-11
- **Test Requirements**:
  - `programmatic` TR-3.5.1: 开关 1-4 各自的拦截逻辑按 AC 断言正确
  - `human-judgement` TR-3.5.2: maskMode 开启后，插件详情的密码字段视觉打码
- **Notes**: 开关 3 的远程转发 Phase 5 才真正拦截，本任务先在 UI 上开关并持久化到设置。

---

### [x] Task 3.6：CHANGELOG.md v0.1.92 & 语法检查
- **Priority**: medium
- **Depends On**: Task 3.1 - 3.5
- **Description**:
  - CHANGELOG 新增 v0.1.92：SshApi、SftpApi + 临时文件协议、ServerApi 脱敏返回、ThemeApi CSS var 同步、HttpApi 内网阻止、5 个全局开关、maskMode 打码
  - 语法检查全量
- **Acceptance Criteria Addressed**: AC-13, AC-14
- **Test Requirements**:
  - `programmatic` TR-3.6.1: 三项语法检查零错误零 warning

---

## ================================================
## Phase 4：热重载 + 安装（RD v0.1.93）
## ================================================

### [x] Task 4.1：Rust notify 文件监听 + 500ms 防抖热重载
- **Priority**: high
- **Depends On**: Task 3.6
- **Description**:
  - `src-tauri/src/plugin/hot_reload.rs`：使用 `notify` crate 监听 `${appDataDir}/plugins/${id}@${version}/` 目录
  - 触发文件：manifest.json / config.schema.json / index.html / main.js / assets/**
  - 500ms debounce（相同目录多次变更合并）
  - 热加载流程实现（对齐 §10.1 完整 8 步）：
    1. scheduleReload(pluginId)
    2. disable() 旧实例 → 释放 UI + 事件 + 定时器 + RightPanel
    3. 销毁 iframe + 关闭 MessageChannel port
    4. 重新解析 manifest + 冲突校验
    5. 创建新 iframe + 注入桥接
    6. init → enabled=true 则 enable
    7. Toast「插件 xxx 已热重载」
    8. 失败：保留旧实例 + Toast 错误摘要 + 控制台完整堆栈
  - 开发模式开关：开发者控制台「监听插件目录」全局选项，生产模式默认关闭
  - manifest `hotReload: false` 的插件跳过（签名插件）
- **Acceptance Criteria Addressed**: AC-8, FR-5
- **Test Requirements**:
  - `programmatic` TR-4.1.1: 修改 main.js 后，0.5s - 1s 内触发 reload，日志序列正确
  - `programmatic` TR-4.1.2: hotReload: false 的插件修改文件不触发 reload
  - `programmatic` TR-4.1.3: reload 失败（语法错误）时旧实例继续运行，无白屏
- **Notes**: 文件写入（如编辑器 auto-save）会产生多次事件，debounce 必须可靠。

---

### [x] Task 4.2：.rdplugin zip 打包格式 + 本地拖拽/选择文件安装
- **Priority**: high
- **Depends On**: Task 4.1
- **Description**:
  - Rust plugin_install_from_file(zip_path: String) 实现：
    - 校验文件后缀 `.rdplugin`（实际为 zip）
    - 解压至临时目录 → 读取并校验 manifest → 检查 id/version/minRdVersion
    - 目标路径 `${appDataDir}/plugins/${pluginId}@${version}/`
    - 若目录存在，冲突处理（覆盖/取消/重命名）
    - 解压完成 → 触发安装确认弹窗（Phase 2 已实现 UI）
  - 前端 PluginsTab 子 Tab 2「本地安装」：
    - 拖入 `.rdplugin` 文件 → 获取路径 → invoke install
    - 「选择文件」按钮 → Tauri plugin-dialog open，filter `*.rdplugin`
    - 安装进度条 + 成功/失败 Toast
  - 插件卸载：`plugin_uninstall(id)` → 停止所有隧道（Phase 5）→ 清理 `plugin-data/${id}/`（递归删除）→ 移除 plugins 目录 → 更新列表
- **Acceptance Criteria Addressed**: FR-5
- **Test Requirements**:
  - `programmatic` TR-4.2.1: 合法 `.rdplugin` zip 安装后目录结构符合 §3.1
  - `programmatic` TR-4.2.2: 卸载后 `${appDataDir}/plugins/${id}@${version}/` 与 `${appDataDir}/plugin-data/${id}/` 均不存在
  - `human-judgement` TR-4.2.3: 安装确认弹窗权限清单 / 风险条 / 复选框交互正确
- **Notes**: Tauri 协议 `rd-plugin://` 双击安装（注册 URL scheme）作为扩展可选。

---

### [x] Task 4.3：沙箱卡死检测 + 资源限制（看门狗）
- **Priority**: medium
- **Depends On**: Task 4.2
- **Description**:
  - 500ms watchdog：PluginSandbox 定期 ping 插件 iframe，5s 内无 pong 返回 → 判定卡死 → Toast「插件 xxx 疑似卡死，已自动停止」+ 禁用
  - 内存限制：Chrome 特有 `performance.memory.usedJSHeapSize` 轮询（每 2s），单插件 > 200MB → 自动禁用 + Toast
  - 死循环检测：单次 SDK 调用 + setInterval 回调运行时长 > 200ms → 强制打断（`setTimeout + throw TIMEOUT`）
  - setInterval / setTimeout 跟踪：SDK 内部维护 timer 表，disable 时全部 clearInterval / clearTimeout，杜绝泄漏
- **Acceptance Criteria Addressed**: NFR-4
- **Test Requirements**:
  - `programmatic` TR-4.3.1: 模拟插件 `while(true) {}`，200ms 内被打断抛 TIMEOUT
  - `programmatic` TR-4.3.2: disable() 后，所有 setInterval 不再触发
  - `human-judgement` TR-4.3.3: 卡死场景 Toast 提示文案友好，其他插件不受影响
- **Notes**: 内存限制非 Chrome 环境（Safari/WebView2 某些版本）降级为警告日志。

---

### [x] Task 4.4：CHANGELOG.md v0.1.93 & 语法检查
- **Priority**: medium
- **Depends On**: Task 4.1 - 4.3
- **Description**: CHANGELOG + 语法检查。
- **Acceptance Criteria Addressed**: AC-13, AC-14
- **Test Requirements**:
  - `programmatic` TR-4.4.1: 三项语法检查全绿

---

## ================================================
## Phase 5：端口转发专项 + 官方插件（RD v0.1.94）
## ================================================

### [x] Task 5.1：Rust tunnel/*.rs 底层实现
- **Priority**: high
- **Depends On**: Task 4.4
- **Description**:
  - 新建 `src-tauri/src/tunnel/` 模块（mod.rs + forward.rs + status.rs + import_export.rs）
  - 实现三种模式底层（基于 SSH 模块 russh 的 forward-tcpip / direct-tcpip channel）：
    - local (-L)：本地 TCP listen → 数据转发到 remote_addr:port 通过 SSH 通道
    - remote (-R)：SSH 服务端监听 → 数据转发到本地端口
    - dynamic (-D, SOCKS5)：本地 TCP listen，解析 SOCKS5 握手 → 通过 SSH 通道直连目标
  - 11 项内核强制校验（§11.3）：端口范围 1-65535 / 0.0.0.0 LISTEN_ON_ALL_NEEDS_CONFIRM / local/remote 必填 / dynamic 不得带 / hostId 存在 / REMOTE_FORBIDDEN 全局开关 / hostId 下重复端口
  - 会话绑定自动关闭：
    - connection:close / connection:reconnecting → 内核 stop 所有该 hostId 隧道 → emit tunnel:stop reason=host-close / host-reconnecting
    - 插件卸载 → 内核 stop 其所有隧道
- **Acceptance Criteria Addressed**: AC-10, AC-11, AC-12, FR-6
- **Test Requirements**:
  - `programmatic` TR-5.1.1: 11 项校验各自命中 → 返回对应 TunnelErrorCode
  - `programmatic` TR-5.1.2: 主机断开后，1 秒内 netstat 确认所有该 hostId 监听端口释放
  - `programmatic` TR-5.1.3: 远程转发全局开关开 → REMOTE_FORBIDDEN
- **Notes**: 这是 Phase 5 核心工作量。SOCKS5 实现需符合 RFC 1928 最小子集。

---

### [x] Task 5.2：TunnelApi + 隧道事件 + 导入导出
- **Priority**: high
- **Depends On**: Task 5.1
- **Description**:
  - 前端 SDK TunnelApi 实现：
    - 规则 CRUD：createRule / removeRule / listRules / updateRule → 持久化到 `${appDataDir}/plugin-data/rd-native.port-forward/rules.json`（Windows 目录名不允许冒号，用点号代替）
    - 运行控制：startTunnel / stopTunnel / listStatus
    - 导入导出：exportRules → `.rd-tunnels.json` 格式 §11.8；importRules → onConflict: skip/overwrite/rename
  - 隧道事件 emit：tunnel:start / tunnel:stop / tunnel:error / tunnel:connection 触发对应 RdEventMap 分发
  - autoStart 联动：connection:success → 扫描 autoStart=true 规则并行 startTunnel；connection:reconnect-success → 重新 autoStart
- **Acceptance Criteria Addressed**: FR-6, AC-5, AC-10
- **Test Requirements**:
  - `programmatic` TR-5.2.1: importRules 三种冲突策略行为正确
  - `programmatic` TR-5.2.2: connection:success 后 2s 内 autoStart 规则进入 running
  - `programmatic` TR-5.2.3: export JSON 符合 §11.8 schema（specVersion/exportTime/exportedBy/rules 四键必备）
- **Notes**: `tunnel.manage` 权限校验 + 审计日志 + 4 高危权限红色标记。

---

### [x] Task 5.3：官方端口转发插件 UI
- **Priority**: high
- **Depends On**: Task 5.2
- **Description**:
  - 创建官方内置插件 `rd-plugin-port-forward`（随 RD 发行，路径 `${appDataDir}/plugins/port-forward-manager@1.0.0/`）：
    - manifest.json 对齐 §11.9：id=port-forward-manager，category=tunnel，permissions=[tunnel.manage, storage.read/write, ui.inject-menu, ui.dialog]
    - 入口类 `PortForwardPlugin extends BasePlugin`
  - UI 交互（对齐 §11.10）：
    - Toolbar 按钮注册 `ui.registerToolbarButton({ id:'port-forward-open', label:'端口转发', icon:'Network', group:'center' })`
    - 点击打开弹窗表格：状态圆点（绿/黄/灰）+ 模式胶囊（local 蓝/remote 橙/dynamic 紫）+ 绑定主机名 +「本地→远程」地址行 + autoStart .switch + 操作列（启停/编辑/删除）
    - 新增表单向导顺序：绑定主机 → 转发模式 → 本地监听地址 → 本地端口 → 远程地址/端口（条件显示）→ autoStart → tags → 备注
    - 高危提示：mode=remote 顶部红色条；localAddr=0.0.0.0 二次确认弹窗
    - 顶部菜单：导入 `.rd-tunnels.json` / 导出
  - 6 套主题 CSS var 跟随
- **Acceptance Criteria Addressed**: AC-11, AC-12, NFR-5
- **Test Requirements**:
  - `programmatic` TR-5.3.1: 新建 3 种模式隧道各 1 条，数据库规则正确保存
  - `programmatic` TR-5.3.2: 0.0.0.0 不确认 → 不启动，确认 → 启动
  - `human-judgement` TR-5.3.3: remote 模式红色提示条视觉显著
- **Notes**: 此插件为官方插件，走 `rd-native:*` 保留前缀，权限在 RD 安装时默认授予。

---


### [x] Task 5.4：CHANGELOG.md v0.1.94 & 语法检查 & 三平台 Release 构建
- **Priority**: high
- **Depends On**: Task 5.1 - 5.3
- **Description**:
  - CHANGELOG v0.1.94 详细记录端口转发功能
  - 全量语法检查
  - 本地或 Actions 验证 release.yml 三平台构建成功：macOS ARM64（dmg + tar.gz + sig）、Windows x64 NSIS exe + sig、Linux x64（deb + AppImage + sig）+ updater 压缩包三剑客（*.app.tar.gz / *.exe.zip / *.AppImage.tar.gz）
- **Acceptance Criteria Addressed**: AC-13, AC-14
- **Test Requirements**:
  - `programmatic` TR-5.5.1: CI + release 构建全绿（project_memory.md 约束全部遵守）
  - `programmatic` TR-5.5.2: Release artifact 清单完整，签名文件齐全

---

## ================================================
## Phase 6：生态完善（RD v1.0 长期）
## ================================================

### [ ] Task 6.1：GitHub Pages 插件市场（基于 GitHub Issue 列表）
- **Priority**: low
- **Depends On**: Task 5.5
- **Description**:
  - 新建仓库 `RD-plugins-market`：GitHub Pages + VitePress
  - Issue 模板：每个 Issue 对应一个插件提交（名称/ID/仓库链接/README/权限声明/截图）
  - 官方审核：PR 合入主分支 → 自动发布到市场页面
  - 「RD 官方插件」徽章 SVG 生成
- **Acceptance Criteria Addressed**: FR-6 (Phase 6)
- **Test Requirements**:
  - `human-judgement` TR-6.1.1: 市场页面分类浏览 + 搜索 + 插件详情页 UI 友好

---

### [ ] Task 6.2：ed25519 签名校验 + 未签名警告
- **Priority**: low
- **Depends On**: Task 6.1
- **Description**:
  - 官方 ed25519 密钥对（pub 内置 RD 主程序二进制）
  - `.rdplugin` 包增加 `signature.sig` 文件，解压时校验 manifest SHA256 + 签名
  - 未签名插件安装弹窗：「该插件未通过 RD 官方签名，存在风险，请确认来源」黄色警告条
- **Acceptance Criteria Addressed**: FR-6 (Phase 6)
- **Test Requirements**:
  - `programmatic` TR-6.2.1: 被篡改的签名包安装返回 SIGNATURE_INVALID
  - `human-judgement` TR-6.2.2: 未签名插件警告条显示正确

---

### [ ] Task 6.3：开发者文档站（Vitepress）+ 脚手架
- **Priority**: low
- **Depends On**: Task 6.2
- **Description**:
  - Vitepress 插件开发者文档站：快速开始 / SDK API 参考 / 权限清单 / 3 个示例教程（Hello World / 云主机导入 / 端口转发）
  - `npm create rd-plugin@latest` 脚手架：生成标准目录 + manifest + BasePlugin 模板 + README
- **Acceptance Criteria Addressed**: FR-6 (Phase 6)
- **Test Requirements**:
  - `human-judgement` TR-6.3.1: `npm create rd-plugin@latest` 生成的项目 `npm run build` 成功 + `npm run pack` 生成合法 `.rdplugin`

---

### [ ] Task 6.4：插件跨设备配置同步（加密文件云盘）
- **Priority**: low
- **Depends On**: Task 6.3
- **Description**:
  - 用户选择本地同步文件夹（OneDrive / iCloud / Dropbox 通用）
  - AES-256 加密插件配置 + 主机列表 JSON 备份
  - 配置变更时自动同步（debounce 30s），启动时自动合并
- **Acceptance Criteria Addressed**: FR-6 (Phase 6)
- **Test Requirements**:
  - `programmatic` TR-6.4.1: 加密文件密码错误时返回 DECRYPT_FAILED，不崩溃
  - `human-judgement` TR-6.4.2: 跨设备同步后的插件配置项正确

---
