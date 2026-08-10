# Tasks

> 目标：按 spec.md 将 RD 界面从单远程三栏布局迭代为五区固定式布局（顶部标签栏 + 左侧导航边栏 + 中间双栏工作区 + 右侧功能面板 + 底部终端/状态栏）。技术栈：Tauri 2.0 + Rust + React + TypeScript + Zustand。

- [x] Task 1: 布局框架重构与状态管理基础
  - 修改 `src/App.tsx`：将当前「Toolbar + sidebar + content + terminal + statusbar」结构重构为五区布局容器（顶部 TabBar 区、左侧 Sidebar 区、中间 ContentArea 双栏区、右侧 RightPanel 区、底部 Terminal + StatusBar 区），保留侧边栏/终端/右侧面板的拖拽分隔条逻辑
  - 扩展 `src/store/uiStore.ts`：新增 `activeTool`（工具菜单选中项，默认 'sftp'）、`rightPanelWidth`、`rightPanelResizing`、`tabs`（多服务器标签数组）、`activeTabId`、`terminalTabs`（每主机多终端标签 Map）等状态及对应 setter
  - 修改 `src/styles/finder.css`：新增五区布局 CSS 变量与 grid/flex 容器样式，调整 `.app-root`、`.app-body`、`.main-wrap` 以容纳右侧面板
  - 验证：应用启动后五区容器可见（即使部分区域为占位），原有连接/浏览/终端功能不回归

- [x] Task 2: 顶部全局标签栏 TabBar.tsx
  - 新增 `src/components/TabBar.tsx`：从 `Toolbar.tsx` 迁移窗口控制按钮（关闭/最小化/最大化）与 -webkit-app-region: drag 拖拽区域；新增品牌标识「RD」、多服务器标签页区域、右上角功能按钮（快速连接、布局切换、设置入口）
  - 标签页展示：服务器名称、用户名@IP、连接状态指示灯（绿=已连接/灰=未连接/红=异常）、关闭按钮；末尾「+」按钮新建连接
  - 标签交互：点击切换会话（同步主工作区/右侧面板/终端）、关闭标签（断开连接并切换相邻标签）、右键菜单（关闭当前/其他/右侧、复制连接信息、新建同主机标签）
  - 新增 `src/styles/tabbar.css`：标签栏样式（含拖拽区域、窗口控制按钮、标签项、状态指示灯）
  - 修改 `src/App.tsx`：用 `TabBar` 替换原 `Toolbar`
  - 验证：连接主机后标签栏出现对应标签，切换/关闭/右键菜单功能正常，窗口控制按钮可用

- [x] Task 3: 左侧导航边栏重构
  - 修改 `src/components/Sidebar.tsx`：在现有主机列表基础上，顶部新增「连接管理」标题区 + 搜索输入框（占位「搜索主机或IP (Ctrl+K)」）；主机列表标题改为「我的连接」；保留分组折叠能力
  - 新增工具菜单区（垂直排列，选中项高亮）：SFTP（默认）、SSH 终端、端口转发、远程命令、密钥管理、插件中心；点击切换 `uiStore.activeTool`，中间工作区据此切换功能页（端口转发/远程命令/密钥管理/插件中心本期仅占位页）
  - 新增底部「连接信息概览」区：展示当前选中主机的连接信息（主机名、连接时长、SSH版本、加密算法、压缩状态）+「会话管理」按钮（展开断开连接等操作）
  - 搜索框快捷键：Ctrl+K / Cmd+K 快速聚焦搜索框（在 App.tsx 全局快捷键中注册）
  - 修改 `src/styles/finder.css`：新增搜索框、工具菜单、连接信息概览样式
  - 验证：搜索过滤主机生效，工具菜单切换中间工作区，连接信息概览展示当前主机参数

- [x] Task 4: 本地文件栏基础（Rust 命令 + LocalFilePane.tsx）
  - 在 `src-tauri/src/` 新增本地文件操作模块（或扩展现有模块）：实现 `list_local_dir(path)` 命令，返回本地目录条目列表（名称、是否目录、大小、修改时间、类型）；实现 `local_home_dir()` 返回用户主目录
  - 在 `src-tauri/src/lib.rs` 注册新命令；在 `src-tauri/capabilities/default.json` 确认 fs 相关权限
  - 新增 `src/store/localFileStore.ts`：本地文件浏览状态（currentPath、entries、history、loading），navigate/refresh/goBack/goForward/goUp 方法（调用本地 Rust 命令）
  - 新增 `src/components/LocalFilePane.tsx`：本地文件栏 UI，含顶部工具栏（路径面包屑、前进/后退/刷新按钮）、文件列表（名称/类型/修改时间表头，虚拟滚动）、底部统计栏（文件夹数/文件数/总大小）
  - 新增 `src/styles/filebrowser.css` 中本地栏样式（与远程栏视觉一致但标识不同）
  - 验证：本地栏可浏览本地文件系统，面包屑导航/前进后退/刷新功能正常

- [x] Task 5: 远程文件栏改造（单栏化 + 表头增强）
  - 修改 `src/components/FileBrowser.tsx`：从三栏（父目录/当前目录/预览）中提取单栏远程文件视图，移除父目录列与预览列逻辑；保留 SFTP 列表/导航/新建/删除/重命名/右键菜单/下载能力
  - 远程文件列表表头增强为：名称、大小、类型、修改时间、权限、所有者；文件夹置顶排序；支持点击表头升序/降序
  - 远程栏顶部工具栏：标注「远程: 服务器名称」+ 路径面包屑 + 操作按钮组（前进/后退/刷新）；移除原 AddressBar（地址栏功能合并到面包屑，支持点击切换输入模式）
  - 远程栏底部统计栏：显示「X 个文件夹, Y 个文件 | 总大小」+ 「SFTP」标识与锁图标
  - 验证：远程栏单栏展示，表头六列完整，排序与统计功能正常，原有右键菜单/下载功能不回归

- [x] Task 6: 中间双栏文件管理器整合
  - 修改 `src/components/ContentArea.tsx`：当 `activeTool === 'sftp'` 时，渲染双栏布局（左 `LocalFilePane` + 右远程栏），区域标题「SFTP 文件管理器」；其他工具切换时渲染对应占位页（SSH 终端全屏/端口转发/远程命令/密钥管理/插件中心）
  - 双栏拖拽互传：本地栏拖拽文件到远程栏 → 上传（复用现有上传逻辑，任务进入传输队列）；远程栏拖拽文件到本地栏 → 下载（复用现有下载逻辑）
  - 双栏各自独立的面包屑导航与操作按钮
  - 修改 `src/styles/filebrowser.css`：双栏等分布局样式、拖拽高亮反馈样式
  - 验证：双栏并排显示，拖拽上传/下载功能正常，传输任务进入右侧传输队列

- [x] Task 7: 右侧功能面板 RightPanel.tsx
  - 新增 `src/components/RightPanel.tsx`：固定宽度右侧面板容器，自上而下三区块
  - 新增 `src/components/ServerInfo.tsx`（服务器信息区）：展示主机、用户、协议、端口、系统、在线时长、连接状态（绿色「已连接」+圆点）；红色「断开连接」主按钮
  - 新增 `src/components/QuickActions.tsx`（快捷操作区）：2×3 网格共6个按钮（打开终端、新建文本、上传文件、同步目录、权限设置、查找文件）；点击触发对应功能（部分功能可占位提示）
  - 新增 `src/components/TransferQueue.tsx`（传输队列常驻版）：顶部上传/下载标签切换（带任务数量角标）；任务列表显示文件名、大小、进度条、速度、暂停/取消按钮；复用 `transferStore` 数据
  - 在 `src/App.tsx` 右侧面板区渲染 `RightPanel`；移除 `Toolbar` 中的 `TransferNotification` 弹出抽屉（传输通知迁移到右侧常驻）
  - 新增 `src/styles/rightpanel.css`：右侧面板三区块样式
  - 验证：右侧面板三区块可见，服务器信息正确展示，快捷操作按钮可点击，传输队列实时更新

- [x] Task 8: 底部终端多标签
  - 修改 `src/components/TerminalPanel.tsx`：终端头部新增终端标签栏，默认一个标签「终端 + 服务器名」，支持「+」新建多个终端标签；右上角操作按钮（全屏、高度调节、更多）
  - 多终端标签：每个标签对应同一 SSH 连接上的独立 PTY 通道；切换标签切换 PTY 会话；关闭标签销毁对应 PTY 通道（不断开主连接）
  - 终端全屏：点击全屏按钮，终端区扩展占据主工作区全部高度
  - 修改 `src/store/uiStore.ts`：新增 `terminalTabs`（Record<hostId, string[]>）管理每主机的终端标签 id 列表与 `activeTerminalTab`
  - 修改 `src/styles/terminal.css`：终端标签栏样式
  - 验证：可新建多个终端标签，切换/关闭标签正常，全屏功能可用，原终端交互不回归

- [x] Task 9: 底部状态栏增强
  - 修改 `src/components/StatusBar.tsx`：左侧保留应用全局状态；右侧新增实时上传速率「↑ 上传: X MB/s」、实时下载速率「↓ 下载: Y MB/s」、网络延迟「● 延迟: Xms」（延迟>100ms 变色提示）
  - 传输速率：从 `transferStore` 聚合所有进行中任务的速度
  - 网络延迟：新增 Rust 命令 `ping_host(hostId)` 或复用 SSH keepalive 往返时间；定期（如每5秒）测量并更新
  - 修改 `src/styles/finder.css`：状态栏右侧速率/延迟样式
  - 验证：传输时状态栏显示实时速率，连接时显示延迟，延迟异常变色

- [x] Task 10: 样式整合与整体验收
  - 统一五区布局视觉风格（深色专业风格为主），调整间距、边框、配色一致性
  - 移除遗留的 `TransferNotification` 弹出抽屉相关样式与引用
  - 全链路冒烟：连接主机 → 标签栏出现标签 → 双栏浏览本地+远程 → 拖拽上传/下载 → 右侧传输队列更新 → 终端多标签 → 状态栏速率/延迟显示 → 断开连接
  - 验证：五区布局一屏可达，核心操作无崩溃，原有功能不回归

# Task Dependencies
- Task 1 为基础，Task 2/3/4/5/7/8/9 均依赖 Task 1
- Task 5 依赖 Task 1（远程栏单栏化改造）
- Task 6 依赖 Task 4、Task 5（双栏整合需本地栏与远程栏就绪）
- Task 7 依赖 Task 1（右侧面板可独立开发，传输队列复用现有 store）
- Task 8 依赖 Task 1（终端多标签可独立开发）
- Task 10 依赖 Task 2/3/6/7/8/9（整体验收需所有区域完成）
- 可并行：Task 2、Task 3、Task 4、Task 7、Task 8、Task 9 在 Task 1 完成后可并行推进
