# Tasks

> 目标：按 spec.md 交付 P0 MVP。技术栈：Tauri 2.0 + Rust（russh / russh-sftp / keyring / tokio）+ React + TypeScript + Vite + Xterm.js。

- [x] Task 1: 初始化项目骨架
  - 在 `c:\Users\Administrator\Desktop\remote` 创建 Tauri 2.0 + React + TS 项目（Vite 模板）
  - 添加前端依赖（@xterm/xterm、zustand 等）与 Rust 依赖（russh、russh-sftp、keyring、tokio、serde 等）
  - 验证：`npm run tauri dev` 能启动并显示占位主界面

- [x] Task 2: Rust SSH 连接管理模块（依赖 Task 1）
  - 基于 russh 实现客户端连接：密码认证与 Ed25519/RSA 私钥认证
  - 服务器指纹首次信任：本地保存指纹，指纹变化时告警
  - 每主机维持唯一连接句柄，keepalive 保活，断开时通过事件通知前端
  - Tauri 命令：`connect_host`、`disconnect_host`、`connection_state`

- [ ] Task 3: 本地持久化层（依赖 Task 1，可与 Task 2 并行）
  - 应用数据目录 JSON 存储主机非敏感配置；keyring 系统密钥链存储密码/私钥
  - 路径缓存：键为「主机ID+标签ID」，提供读写接口
  - 设置存储：目录记忆全局开关等
  - Tauri 命令：主机 CRUD、凭据读写、路径缓存读写、设置读写

- [ ] Task 4: SFTP 通道与基础文件操作（依赖 Task 2）
  - 基于 russh-sftp 在同一条 SSH 连接上创建常驻 SFTP 通道
  - 实现：list_dir（名称/大小/mtime/权限/用户/类型）、mkdir、rename、remove_file、remove_dir、获取家目录、相对路径解析
  - 统一错误码映射：权限不足、路径不存在等，前端可据此给出明确提示

- [x] Task 5: PTY 终端通道（依赖 Task 2）
  - 按需创建 session 通道 + PTY + shell；关闭终端仅销毁该通道，不断开主连接
  - PTY 输出经 Tauri 事件流推送前端；前端输入经命令写入 PTY
  - 实现 pwd 获取机制：命令结束后经哨兵标记解析服务端真实路径，推送 `cwd-changed` 事件（禁止解析用户命令文本）
  - 提供 `cd <path>` 下发接口，供文件浏览器同步调用

- [x] Task 6: 前端主框架与主机管理 UI（依赖 Task 1）
  - Finder 风格整体布局：侧边栏 + 顶部工具栏 + 内容区 + 底部状态，macOS 简约样式
  - 侧边栏主机列表：连接/断开操作、连接状态展示
  - 主机新增/编辑/删除对话框：名称、地址、端口、用户名、密码或私钥、目录记忆开关、备注

- [ ] Task 7: 三栏视图文件浏览器（依赖 Task 4、Task 6）
  - 三栏联动（上级/当前/子目录预览），双击进入、返回上级、前进/后退历史、刷新
  - 面包屑地址栏：每级可点击跳转；点击进入路径输入模式；相对路径自动补全；非法路径标红不跳转
  - 新建文件夹、删除二次确认弹窗、重命名交互
  - 千级文件列表虚拟滚动

- [x] Task 8: 终端面板与地址栏唤起（依赖 Task 5、Task 6）
  - Xterm.js 集成，底部滑出式终端面板，支持收起/展开、拖拽调整高度
  - 地址栏输入 `cmd`/`terminal` 唤起终端，并自动 cd 至当前浏览目录
  - 地址栏输入非路径内容时作为命令投递终端执行（终端未打开则先打开）

- [x] Task 9: 双向目录同步与目录记忆（依赖 Task 3、Task 5、Task 7、Task 8）
  - 文件浏览器切换目录 → PTY 下发 cd；终端 `cwd-changed` 事件 → 前端刷新地址栏与文件列表（做去重/回环防护）
  - 连接成功后读取路径缓存：开关开启且目录有效 → 自动进入缓存目录；目录失效 → 降级家目录并轻量提示；开关关闭 → 家目录
  - 任何目录变更后实时写入路径缓存

- [x] Task 10: 设置页与整体验收（依赖 Task 9）
  - 设置页（Ctrl+, 打开）：目录记忆全局开关，修改即时生效
  - 全链路冒烟：连接 → 目录浏览 → 唤起终端 → 双向同步 → 新建/删除/重命名 → 重启恢复目录

# Task Dependencies
- Task 2、Task 3、Task 6 依赖 Task 1，三者可并行
- Task 4、Task 5 依赖 Task 2，两者可并行
- Task 7 依赖 Task 4、Task 6；Task 8 依赖 Task 5、Task 6，两者可并行
- Task 9 依赖 Task 3、Task 5、Task 7、Task 8
- Task 10 依赖 Task 9
