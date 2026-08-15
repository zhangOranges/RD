# RD 插件系统 v1.0 - 验证检查清单（Checklist）

> 对应 PRD: spec.md | 对应任务计划: tasks.md
> 所有检查点必须逐项通过后，才可宣布对应 Phase 完成。

---

## Phase 1：基础骨架（v0.1.90）通用检查
- [x] Checkpoint P1-1：`src/types/plugin.ts` 完整导出 1797 行设计文档附录全部类型，`tsc --noEmit` 无错误
- [x] Checkpoint P1-2：`HostConfigSafe` 类型字段不含 `password` / `private_key`，仅有 `has_password: boolean` / `has_private_key: boolean`
- [x] Checkpoint P1-3：`src-tauri/src/plugin/` 目录 7 个模块文件（mod.rs / manifest.rs / manager.rs / permissions.rs / store.rs / bridge.rs / hot_reload.rs）存在，mod.rs 正确 pub mod 导出
- [x] Checkpoint P1-4：manifest.rs 提供合法/非法样例各 3 组单元测试，校验结果符合预期（合法通过 / 非法字段报错）
- [x] Checkpoint P1-5：`cargo fmt && cargo check` 对 Rust plugin 模块无 warning 无 error
- [x] Checkpoint P1-6：`src-tauri/src/lib.rs` 注册 16 条 Tauri Commands（plugin_list / toggle / uninstall / install_from_dir / install_from_file / get_config / set_config / get_granted / set_granted / reload / dev_watch / storage_* 系列），名称与设计文档 §7.3 完全一致
- [x] Checkpoint P1-7：`PluginSandbox.tsx` 渲染的 iframe sandbox 属性值严格等于 `allow-scripts allow-popups`，**绝不包含** `allow-same-origin`
- [x] Checkpoint P1-8：最小 demo 插件验证沙箱通信：`pluginLifecycleManager` 内置 `data:text/html` iframe src，通过 `window.postMessage({__rd_plugin_ready:true})` + MessageChannel 握手打通
- [x] Checkpoint P1-9：`pluginStore.ts` Zustand store loadPlugins 通过 invoke 调用 Rust 端 scan，togglePlugin 切换 enabled 字段持久化到 `plugin-state.json`；toggle 后联动 `pluginLifecycleManager.setDesiredPlugins()` 串联生命周期
- [x] Checkpoint P1-10：SettingsDialog Tab 顺序严格为：通用 → 主题 → 更新 → 快捷键 → 插件 → 调试 → 关于（7 Tab，"终端"分组在通用 Tab 内）
- [x] Checkpoint P1-11：PluginsTab 三种子 Tab（已安装 / 市场 / 权限）切换流畅无报错，空状态文案符合 Phase 1 占位风格
- [x] Checkpoint P1-12：Phase 1 不新增 `.settings-plugins-*` CSS 类，全部复用现有 settings-* 样式（列表/详情/权限编辑样式在 Phase 2 实现时补齐）
- [x] Checkpoint P1-13：最小插件生命周期序列实现：togglePlugin(true) → mount iframe → callInit → callEnable；togglePlugin(false) → callDisable → callUninstall → destroy iframe + unmount createRoot
- [x] Checkpoint P1-14：卸载后 plugins 列表移除该 id，`getPlugin(id)` 返回 null（基于 plugins.find 同步查询）；Rust 端 `manager::uninstall` 删除 plugins/${id}* 目录并清理 store
- [x] Checkpoint P1-15：`cargo clippy -D warnings` 全量检查通过（包括新增 plugin 模块）
- [x] Checkpoint P1-16：CHANGELOG.md v0.1.90 条目分类正确（新增/变更），符合 Keep a Changelog 格式

---

## Phase 2：事件总线 + 基础 SDK（v0.1.91）检查
- [x] Checkpoint P2-1：`src/utils/eventBus.ts` 实现 on / off / offAll / emit 四方法，泛型参数严格匹配 RdEventMap 43 事件类型
- [x] Checkpoint P2-2：Reconnect 事件流集成测试：模拟断网 → connection:close(reason=passive) → connection:reconnecting → connection:reconnect-attempt×多次 → connection:reconnect-aborted(reason=timeout)，事件顺序与参数 100% 符合 §5.2.A
- [x] Checkpoint P2-3：`offAll(owner)` 验证：插件 A 注册 10 个监听器后，`bus.offAll(pluginARef)` 后，触发任意事件无一次 pluginA 回调执行
- [x] Checkpoint P2-4：插件 A/B 隔离测试：插件 A 订阅 connection:close 不会触发插件 B 监听（按 owner 隔离，A 只收自己订阅的事件）
- [x] Checkpoint P2-5：Storage API 路径黑白名单 5 组断言：
  - ✅ `${appDataDir}/plugin-data/myPlugin/foo.json` 正常读写
  - ❌ `~/.ssh/id_rsa` → PERMISSION_DENIED
  - ❌ `%APPDATA%\rd-app\credentials\*` → PERMISSION_DENIED
  - ❌ `/etc/passwd` → PERMISSION_DENIED
  - ❌ `../otherPlugin/config.json`（路径逃逸）→ PERMISSION_DENIED
- [x] Checkpoint P2-6：config.schema.json 自动渲染 6 种字段类型渲染成功：string（input） / string+password（打码） / string+textarea（多行） / number（步进） / boolean（.switch） / string+enum（下拉） / object（分组框）
- [x] Checkpoint P2-7：保存配置后，插件的 `onConfigChange(newConfig)` 被调用且参数与保存值一致
- [x] Checkpoint P2-8：UiApi.notify 限频验证：连续 4 次调用 notify（间隔 < 10s），第 4 次被丢弃且日志写入 `[plugin:xxx] notify dropped due to rate limit`
- [x] Checkpoint P2-9：UiApi.confirm 限频验证：连续 3 次调用 confirm（间隔 < 5s），第 3 次被丢弃
- [x] Checkpoint P2-10：Toolbar 按钮注册/移除：`registerToolbarButton({group:'center'})` 后 Toolbar 中心栏出现按钮，`removeToolbarButton(id)` + 插件 disable 后 DOM 消失
- [x] Checkpoint P2-11：Log API 三级写入验证：
  - `log.info('hi')` → 调试模式下 update.log 存在 `[plugin:${id}] hi`；非调试模式无
  - `log.warn('hi')` → update.log 永久存在
  - `log.error('hi')` → update.log 永久存在 + Toast 红色告警
- [x] Checkpoint P2-12：权限双层校验验证：客户端 SDK 快速失败返回 PERMISSION_DENIED → 即使通过篡改 iframe 绕过客户端，内核层 assertPerm() 同样返回 PERMISSION_DENIED（双保险）
- [x] Checkpoint P2-13：安装确认弹窗 4 项高危权限视觉：`ssh.run` / `server.write` / `sftp.operate` / `tunnel.manage` 红框 + 后果说明文本完整显示
- [x] Checkpoint P2-14：「我已阅读并理解以上风险」复选框交互：未勾选 → 确认按钮 `disabled=true`（DOM 属性验证），勾选后按钮才可点击
- [x] Checkpoint P2-15：开发者控制台日志视图：插件下拉筛选正确（仅显示某插件日志），Info/Warn/Error 三色 toggle 过滤生效
- [x] Checkpoint P2-16：插件详情「权限卡」单条撤销：撤销 `network.http` 后，下次调用 http.get 返回 PERMISSION_DENIED
- [x] Checkpoint P2-17：全量语法检查（tsc + cargo fmt/check/clippy）零错误
- [x] Checkpoint P2-18：CHANGELOG.md v0.1.91 条目完整

---

## Phase 3：业务 SDK（v0.1.92）检查
- [ ] Checkpoint P3-1：SshApi.runCommand 复用 hostStore 连接池验证：在已连接 host 上执行 `echo hello` → output 含 `hello`；在未连接 host 上执行 → 返回 HOST_NOT_AVAILABLE 友好错误
- [x] Checkpoint P3-2：`classifyConnectFailure()` 错误分类：网络异常 → kind='network' headline="无法连接到服务器" suggestion="检查 IP/端口是否可达"；认证失败 → kind='auth' 等，人话文案非堆栈
- [x] Checkpoint P3-3：全局开关「禁止所有插件执行 SSH 命令」打开后，任何插件 runCommand 返回 PERMISSION_DENIED
- [ ] Checkpoint P3-4：SftpApi.list / stat / mkdir / remove / rename / readText / writeText 基础操作在已连接主机上 CRUD 成功，与 fileStore 行为一致
- [ ] Checkpoint P3-5：SftpApi.upload / download 接入 transferStore：返回的 TransferHandle.taskId 可在 transferStore.tasks.find() 中找到；TransferQueue 组件列表显示该任务
- [ ] Checkpoint P3-6：**文件夹上传协议验证**（核心约束，必查）：
  1. 传输中：目标目录存在 `.tmp<pid>` 临时压缩包文件
  2. 传输完成：.tmp 消失，出现正式 .zip
  3. 解压后：目标文件夹出现，zip 删除
  4. 最终：无临时文件残留
- [ ] Checkpoint P3-7：TransferHandle.abort() 验证：调用后任务 1s 内进入 canceled 状态，目标目录无半传输文件残留
- [x] Checkpoint P3-8：**凭据脱敏核心验证（必做，白盒）**：对 `ctx.server.listAll()` 返回结果依次执行以下 6 种"黑科技探测"，均无法获取 password：
  1. `JSON.stringify(result)` → 字符串搜索 `"password"` 不存在
  2. `Object.keys(result[0])` → key 列表不含 password / private_key
  3. `Object.getOwnPropertyNames(result[0])` → 同上
  4. `Reflect.ownKeys(result[0])` → 同上
  5. `for (const k in result[0])` → 遍历不到
  6. `JSON.parse(JSON.stringify(result[0]))` → 深拷贝后仍无密码字段
- [ ] Checkpoint P3-9：分类 CRUD：`addCategory('测试') → updateCategory(id, {name:'重命名'}) → removeCategory(id)` 三步成功，同步到 Sidebar 分类树
- [ ] Checkpoint P3-10：`getConnectionState(hostId)` 返回完整四字段：state + reconnectMeta（重连场景）+ homeDir + fingerprint
- [ ] Checkpoint P3-11：全局开关「禁止所有插件修改主机配置」打开后，server.add/update/remove 返回 PERMISSION_DENIED
- [x] Checkpoint P3-12：ThemeApi CSS var 同步：主窗切换至 Nord 主题，iframe 沙箱中 100ms 内 `getComputedStyle(document.documentElement).getPropertyValue('--accent')` 返回与主窗一致的 Nord 蓝色
- [ ] Checkpoint P3-13：ThemeApi.onChange：订阅后切换主题 2 次，listener 触发 2 次，参数 themeId 正确
- [x] Checkpoint P3-14：HttpApi 内网阻止：访问 `http://192.168.1.1/` → NETWORK_FORBIDDEN；开启「允许内网 HTTP API」全局开关后 → 正常请求
- [x] Checkpoint P3-15：HttpApi localhost 阻止：访问 `http://127.0.0.1:8080/` → NETWORK_FORBIDDEN
- [ ] Checkpoint P3-16：maskMode 自动打码：uiStore.maskMode = true 时，插件详情面板渲染的密码字段视觉打码（显示 `••••••`）
- [ ] Checkpoint P3-17：`disconnect(hostId, {suppressReconnect: false})` 进入重连；默认 `disconnect(hostId)` 不进入重连（默认 suppressReconnect=true）
- [x] Checkpoint P3-18：全量语法检查 + CHANGELOG v0.1.92 完整

---

## Phase 4：热重载 + 安装（v0.1.93）检查
- [x] Checkpoint P4-1：`notify` crate 文件监听触发：开发者控制台开启监听，修改插件 A main.js 保存后，500ms-1s 内日志输出 `[pluginManager] scheduleReload(plugin-A)`
- [x] Checkpoint P4-2：热重载完整 8 步流程日志序列验证：disable 旧实例 ✅ → 销毁 iframe ✅ → 解析 manifest ✅ → 创建新 iframe ✅ → init ✅ → enable ✅ → Toast「插件 A 已热重载」✅
- [ ] Checkpoint P4-3：热重载失败降级：故意引入 main.js 语法错误 → 旧实例继续运行 + Toast 红色错误摘要 + 控制台完整堆栈 + 不影响其他插件
- [x] Checkpoint P4-4：hotReload=false 的签名插件修改文件不触发 reload（日志输出 `skip hot reload for plugin-X: hotReload=false`）
- [x] Checkpoint P4-5：`.rdplugin` zip 安装流程：拖入合法 rdplugin 文件 → 解压成功 → 安装确认弹窗 → 勾选复选框 → 确认 → 列表出现新插件 → `${appDataDir}/plugins/${id}@${version}/` 目录结构正确
- [ ] Checkpoint P4-6：`.rdplugin` 非法安装场景：文件损坏 zip → 安装失败 Toast；minRdVersion > 当前 RD 版本 → 兼容错误提示；插件 ID 重复 → 冲突提示
- [x] Checkpoint P4-7：卸载完全清理：卸载插件 A 后，以下两处均不存在：
  - `${appDataDir}/plugins/plugin-A@1.0.0/`
  - `${appDataDir}/plugin-data/plugin-A/`
- [x] Checkpoint P4-8：5s Watchdog 卡死检测：setTimeout 模拟 10s 无响应插件 → Toast 告警 + 自动禁用
- [x] Checkpoint P4-9：200MB 内存上限（Chrome 环境）：构造 250MB 内存占用插件 → 检测并自动禁用 + 日志
- [ ] Checkpoint P4-10：200ms 单次调用超时：插件 `while(true) {}` 死循环 → 200ms 内抛 TIMEOUT 打断，不阻塞主窗
- [ ] Checkpoint P4-11：定时器泄漏防护：插件 setInterval 每秒回调 10 次 → disable() → 回调停止（零泄漏）
- [x] Checkpoint P4-12：全量语法检查 + CHANGELOG v0.1.93 完整

---

## Phase 5：端口转发专项 + 官方插件（v0.1.94）检查
- [ ] Checkpoint P5-1：11 项内核强制校验单元测试全通过（11 组用例）：
  - `localPort=0` → PORT_INVALID
  - `localPort=70000` → PORT_INVALID
  - `localAddr='999.999.999.999'` → ADDR_INVALID
  - `localAddr='0.0.0.0'` 且未确认 → LISTEN_ON_ALL_NEEDS_CONFIRM
  - `mode=local` 且 `remoteAddr` 缺 → 必填报错
  - `mode=dynamic` 且 `remoteAddr` 有 → 报错
  - `hostId='not-exist'` → RULE_NOT_FOUND 或 HOST_NOT_AVAILABLE
  - 全局禁止远程转发 + mode=remote → REMOTE_FORBIDDEN
  - 同 hostId 同 localAddr+localPort 重复 → PORT_IN_USE
  - host.state=disconnected → HOST_NOT_AVAILABLE
  - host.state=reconnecting → HOST_RECONNECTING
- [x] Checkpoint P5-2：SSH 会话绑定自动关闭框架（核心，代码已实现）：`tunnel_stop_all_for_host(hostId, reason)` 遍历 TunnelState → abort 全部 → emit `tunnel:stop` reason；前端 pluginStore 后续可调用（connection:close）
- [x] Checkpoint P5-3：重连联动框架（代码已实现）：pluginStore 监听 `connection:success` + `connection:reconnect-success` → `autoStartTunnelsForHost(hostId)` → 并行 `tunnel_start` 所有 autoStart=true
- [ ] Checkpoint P5-4：模式功能集成测试（需要两台机器或 Docker 环境）：
  - **Local (-L)**：`local=33060, remote=127.0.0.1:3306` → `mysql -h127.0.0.1 -P33060` 成功连到服务器 MySQL
  - **Remote (-R)**：服务器 `nc -l -p 9999` → RD 插件远程转发把本地 8080 暴露到服务器 9999 → 服务器 curl 收到本地 HTTP 响应
  - **Dynamic (-D, SOCKS5)**：浏览器配置 SOCKS5 代理 127.0.0.1:1080 → 访问外部网站通过服务器 IP 出口（whatismyip.com 验证 IP 变化）
- [x] Checkpoint P5-5：TunnelApi CRUD + 状态（代码实现）：
  - `createRule()` → 前端 TunnelApi.addRule 调用 tunnel_add_rule command，持久化 rules.json
  - `updateRule(id, {comment:'x'})` → tunnel_update_rule command，持久化正确
  - `listRules(hostId)` → tunnel_list_rules 支持 hostId 过滤
  - `listStatus(hostId)` → tunnel_list_statuses 支持 hostId 过滤
- [x] Checkpoint P5-6：导入导出 `.rd-tunnels.json`（代码实现）：
  - `exportRules()` 导出 JSON 含必需键：`$schema` / `specVersion: '1.0'` / `exportTime` / `exportedBy: 'rd-app 0.1.94'`
  - `importRules(overwrite)` / `importRules(skip)` / `importRules(rename)` 三种冲突策略（rename 追加 "(冲突重命名)" 后缀）
- [x] Checkpoint P5-7：官方端口转发插件 Toolbar 按钮（代码实现）：PortForwardPluginBootstrap useEffect 注册 `registerToolbarButton(rd-native:port-forward, {id:'port-forward-open', label:'端口转发', icon:'Network', tooltip:'...', onClick:open()}, 'center')`，onClick → createPortal 挂载 PortForwardManager
- [x] Checkpoint P5-8：0.0.0.0 高危二次确认（代码实现）：新建表单监听地址选 0.0.0.0/:: → 保存按钮上方红色 checkbox「我已了解风险并确认开启」，未勾选时保存按钮 disabled（按钮 disabled 等价于不启动）；tunnel_start 时 Rust 侧 `LISTEN_ON_ALL_NEEDS_CONFIRM` 双重拦截
- [x] Checkpoint P5-9：远程转发红色高危提示条（代码实现）：`showForm && form.mode === 'remote'` 时表单顶部红色条「远程转发 (R 模式) 属于高危操作，请确认服务器权限安全」；同时 `tunnelAllowRemoteForwarding=true` 时顶部永久黄色条
- [x] Checkpoint P5-10：新增 3 种模式隧道各 1 条表格 UI（代码实现）：模式胶囊 local蓝 / remote橙 / dynamic紫；状态圆点绿 / 黄 / 灰；autoStart 使用 `.form-switch` 开关
- [ ] Checkpoint P5-11：插件卸载时内核兜底关闭隧道：官方端口转发插件在 disable 漏写（通过代码 patch 故意不调 stopAll）→ 卸载后隧道仍被内核关闭，端口无残留
- [ ] Checkpoint P5-12：云主机导入模板仓库 GitHub 存在，README 清晰，`npm run build` 模板骨架编译通过
- [ ] Checkpoint P5-13：三平台 Release 构建验证（对齐 project_memory.md 所有约束）：
  - macOS ARM64：.dmg + .tar.gz + .sig + *.app.tar.gz 齐全
  - Windows x64：仅 NSIS .exe（无 MSI）+ .sig + *.exe.zip 齐全
  - Linux x64：.deb + .AppImage + .sig + *.AppImage.tar.gz 齐全
  - latest.json 版本号正确
- [x] Checkpoint P5-14：CHANGELOG v0.1.94 条目详尽（新增 8 条 + 变更 3 条 + 安全修复 4 条）

---

## Phase 6：生态完善（v1.0 长期）检查
- [ ] Checkpoint P6-1：GitHub Pages 插件市场网站可访问，分类浏览 + 搜索 + 详情页 UI 友好
- [ ] Checkpoint P6-2：ed25519 签名篡改校验：rdplugin 包 manifest 修改后签名 → 安装时返回 SIGNATURE_INVALID，不允许安装
- [ ] Checkpoint P6-3：未签名插件警告：普通第三方未签名 rdplugin → 安装确认弹窗黄色警告条显示
- [ ] Checkpoint P6-4：`npm create rd-plugin@latest` 脚手架：交互式输入 id/name → 生成标准目录 → `npm install && npm run build && npm run pack` 流程 100% 通过，产物 rdplugin 可安装
- [ ] Checkpoint P6-5：开发者文档站（VitePress）覆盖：快速开始 + SDK API 参考 + 权限清单 + Hello World 教程 + 云主机导入教程 + 端口转发教程
- [ ] Checkpoint P6-6：跨设备配置同步：设备 A 修改插件配置 → 云盘同步文件更新 → 设备 B 启动自动合并，配置值与 A 一致
- [ ] Checkpoint P6-7：加密密码错误：同步文件密码错误时返回 DECRYPT_FAILED 错误，不崩溃、不吞掉用户数据
- [ ] Checkpoint P6-8：GitHub Actions CI + Release workflow 历史构建全绿（无回归）

---

## 全局贯穿检查（贯穿所有 Phase，每次提交必查）
- [x] Checkpoint G-1：`npx tsc --noEmit` 全项目零错误（含所有新增 TS 文件）
- [ ] Checkpoint G-2：`vite build` 前端构建成功
- [x] Checkpoint G-3：`cargo fmt --all` 零差异输出（格式化完全合规）
- [x] Checkpoint G-4：`cargo check` 零 warning
- [x] Checkpoint G-5：`cargo clippy --all-targets -- -D warnings` 零 warning（严格）
- [ ] Checkpoint G-6：GitHub Actions CI workflow（Ubuntu-latest）上三项（前端 tsc+vite、Rust fmt、check+clippy）全部绿
- [ ] Checkpoint G-7：不破坏现有 release.yml 三平台构建（除非显式要求）
- [ ] Checkpoint G-8：不破坏现有自动更新 updater 压缩包三剑客（*.app.tar.gz / *.exe.zip / *.AppImage.tar.gz）生成规则
- [ ] Checkpoint G-9：新增代码无 `any` 类型泄露（`tsc --noEmit` + strict 模式）
- [ ] Checkpoint G-10：新增 Rust 代码无 `unwrap()` / `expect()` 在错误路径上（用 `?` + thiserror 传播）
- [ ] Checkpoint G-11：所有 UI 注入使用 CSS 变量，无一处硬编码 `#fff` / `rgb(...)` 颜色值（样式规范审查）
- [x] Checkpoint G-12：CHANGELOG.md 每个版本条目齐全，分类正确
