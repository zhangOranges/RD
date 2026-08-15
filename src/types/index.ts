// 主机配置（不含敏感凭据，对应 Rust 的 HostConfig）
export interface HostConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: 'password' | 'key';
  remember_dir: boolean;
  remark: string;
  category_id: string;
  // 路径记忆专用唯一 ID：新建/复制主机时 Rust 端自动生成新值，
  // 编辑时保持不变；复制出来的主机因此拥有独立的记住目录。
  // 老数据可能为空，此时 Rust 端会回退使用 id 字段，兼容不破坏。
  path_cache_id?: string;
}

// 分类配置（对应 Rust 的 CategoryConfig）
export interface CategoryConfig {
  id: string;
  name: string;
  order: number;
}

// 认证方式
export type AuthType = 'password' | 'key';

// 凭据类型（与 Rust 端 credType 字段对应，必须与 Rust validate_cred_type 一致）
export type CredentialType = 'password' | 'private_key';

// 连接状态
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

// 重连相关元信息（断线后自动重连期间展示）
export interface ReconnectMeta {
  /** 当前第几次尝试（从 1 开始计数） */
  attempt: number;
  /** 下一次尝试前的等待（毫秒） */
  nextDelayMs: number;
  /** 下次尝试的预计时间戳（Date.now），UI 可做倒计时展示 */
  nextAt: number;
}

// connect_host 命令的入参（前端 camelCase，Tauri 自动转 snake_case）
export interface ConnectParams {
  host_id: string;
  host: string;
  port: number;
  username: string;
  auth_type: string;
  password: string | null;
  private_key: string | null;
}

// connect_host 命令的返回值
export interface ConnectResult {
  home_dir: string;
  fingerprint: string;
}

// HostDialog 表单值
export interface HostFormValues {
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  password: string;
  private_key: string;
  remember_dir: boolean;
  remark: string;
  category_id: string;
}

// Toast 类型
export type ToastKind = 'info' | 'success' | 'error' | 'warning';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

// ============================================================
// 传输任务（上传 / 下载）进度追踪
// ============================================================

export type TransferKind = 'upload' | 'download';
export type TransferStatus = 'queued' | 'running' | 'completed' | 'error' | 'canceled';

/** 与 Rust `TransferProgressEvent` 一一对应的入站事件。 */
export interface TransferProgressPayload {
  taskId: string;
  kind: TransferKind;
  name: string;
  bytesTransferred: number;
  totalBytes: number;
  status: 'running' | 'completed' | 'error' | 'canceled';
  message?: string;
}

/** Store 内部的任务运行时详情。 */
export interface TransferTask {
  id: string;
  kind: TransferKind;
  hostId: string;
  /** 展示用名字（文件名 / 目录名） */
  name: string;
  /** 远程路径 */
  remotePath: string;
  /** 本地路径（文件或目录） */
  localPath: string;
  status: TransferStatus;
  bytesTransferred: number;
  totalBytes: number;
  /** 速度计算：瞬时速率（bytes/s） */
  speedBytesPerSec: number;
  /** 启动时间戳（ms） */
  startedAt: number;
  /** 完成时间戳（ms），未完成为 0 */
  finishedAt: number;
  /** 最近一次错误信息 */
  errorMessage?: string;
}
