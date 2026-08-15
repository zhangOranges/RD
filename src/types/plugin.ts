import type {
  HostConfig as _HostConfig,
  CategoryConfig,
  ConnectionState,
  ReconnectMeta,
  ConnectResult,
  TransferKind,
  TransferStatus,
  TransferTask,
  ToastKind,
} from './index';

export type {
  CategoryConfig,
  ConnectionState,
  ReconnectMeta,
  ConnectResult,
  TransferKind,
  TransferStatus,
  TransferTask,
  ToastKind,
};

export type HostConfig = _HostConfig;

export type PluginPermission =
  | 'network.http'
  | 'storage.read'
  | 'storage.write'
  | 'file.local.read'
  | 'file.local.write'
  | 'server.read'
  | 'server.write'
  | 'server.manage'
  | 'ssh.run'
  | 'sftp.operate'
  | 'ui.notification'
  | 'ui.dialog'
  | 'ui.inject-menu'
  | 'theme.read'
  | 'tunnel.manage'
  | 'log.read'
  | 'updater.manage';

export type PluginCategory =
  | 'connection'
  | 'file'
  | 'terminal'
  | 'theme'
  | 'security'
  | 'automation'
  | 'devops'
  | 'utility';

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: 'v1';
  author: string;
  description: string;
  category: PluginCategory;
  entry: string;
  indexHtml: string;
  configSchema?: Record<string, unknown>;
  icon?: string;
  permissions: PluginPermission[];
  conflict?: string[];
  requires?: string[];
  minRdVersion: string;
  hotReload: boolean;
  homepage?: string;
  license?: string;
}

export interface SftpFile {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: number;
  permissions?: string;
}

export type FriendlyFailureKind = 'network' | 'auth' | 'config' | 'unknown';

export interface FriendlyFailure {
  kind: FriendlyFailureKind;
  headline: string;
  suggestion: string;
}

export interface CommandResult {
  success: boolean;
  output: string;
  exitCode: number;
}

export interface BatchResult {
  batchId: string;
  total: number;
  success: number;
  fail: number;
  results: Record<string, CommandResult>;
}

export interface HostConfigSafe {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_type: 'password' | 'key';
  remember_dir: boolean;
  remark: string;
  category_id: string;
  path_cache_id?: string;
  has_password: boolean;
  has_private_key: boolean;
}

export type TunnelMode = 'local' | 'remote' | 'dynamic';

export interface TunnelRule {
  id: string;
  hostId: string;
  mode: TunnelMode;
  localAddr: string;
  localPort: number;
  remoteAddr?: string;
  remotePort?: number;
  autoStart: boolean;
  tags?: string[];
  comment?: string;
  createdAt: number;
}

export interface TunnelStatus {
  tunnelId: string;
  running: boolean;
  pid?: number;
  error?: string;
  boundHostId?: string;
  acceptedConns: number;
  startTimeMs?: number;
}

export type TunnelErrorCode =
  | 'RULE_NOT_FOUND'
  | 'HOST_NOT_AVAILABLE'
  | 'HOST_RECONNECTING'
  | 'PORT_IN_USE'
  | 'PORT_INVALID'
  | 'ADDR_INVALID'
  | 'REMOTE_FORBIDDEN'
  | 'PERMISSION_DENIED'
  | 'LISTEN_ON_ALL_NEEDS_CONFIRM'
  | 'SSH_CHANNEL_ERROR';

export interface RdEventMap {
  'connection:before-connect': [host: _HostConfig];
  'connection:success': [hostId: string, result: ConnectResult];
  'connection:error': [hostId: string, friendly: FriendlyFailure, rawError: string];
  'connection:close': [hostId: string, reason: 'user' | 'passive'];
  'connection:reconnecting': [hostId: string, meta: ReconnectMeta];
  'connection:reconnect-attempt': [hostId: string, attempt: number, nextDelayMs: number];
  'connection:reconnect-success': [hostId: string, result: ConnectResult];
  'connection:reconnect-failed': [hostId: string, attempt: number, nextAt: number];
  'connection:reconnect-aborted': [hostId: string, reason: 'canceled' | 'timeout' | 'user-disconnected'];
  'connection:batch-start': [batchId: string, hostIds: string[]];
  'connection:batch-finish': [batchId: string, results: BatchResult];

  'terminal:new-tab': [terminalId: string, hostId?: string];
  'terminal:output': [terminalId: string, data: Uint8Array];
  'terminal:input': [terminalId: string, input: string];
  'terminal:resize': [terminalId: string, cols: number, rows: number];
  'terminal:closed': [terminalId: string];
  'terminal:theme-change': [themeId: string, palette: Record<string, string>];

  'sftp:list-finish': [hostId: string, path: string, files: SftpFile[]];
  'sftp:navigate': [hostId: string, oldPath: string, newPath: string];
  'sftp:upload-start': [task: TransferTask];
  'sftp:upload-progress': [taskId: string, bytesTransferred: number, totalBytes: number];
  'sftp:upload-finish': [task: TransferTask];
  'sftp:download-start': [task: TransferTask];
  'sftp:download-progress': [taskId: string, bytesTransferred: number, totalBytes: number];
  'sftp:download-finish': [task: TransferTask];
  'sftp:file-delete': [hostId: string, path: string, isDir: boolean];
  'sftp:file-rename': [hostId: string, oldPath: string, newPath: string];

  'host:added': [host: HostConfigSafe];
  'host:updated': [hostId: string, patch: Partial<HostConfigSafe>];
  'host:removed': [hostId: string];
  'category:added': [category: CategoryConfig];
  'category:updated': [category: CategoryConfig];
  'category:removed': [category: CategoryConfig];

  'ui:theme-change': [themeId: string];
  'ui:mask-mode-change': [masked: boolean];
  'ui:settings-change': [changed: Record<string, unknown>];
  'ui:tab-change': [tabId: string, tabType: 'sftp' | 'terminal'];
  'ui:notification': [kind: ToastKind, message: string];
  'ui:window-blur': [windowId: string];
  'ui:window-focus': [windowId: string];
  'config:sync': [timestamp: number];

  'tunnel:start': [tunnelId: string, status: TunnelStatus];
  'tunnel:stop': [tunnelId: string, reason: 'manual' | 'host-close' | 'host-reconnecting' | 'uninstall'];
  'tunnel:error': [tunnelId: string, code: TunnelErrorCode, msg: string];
  'tunnel:connection': [tunnelId: string, peerAddr: string, peerPort: number];

  'updater:check-finished': [found: boolean, version?: string];
  'updater:downloading': [bytes: number, total: number];
  'updater:ready-to-install': [version: string, sigVerified: boolean];
  'log:write': [level: 'info' | 'warn' | 'error' | 'debug', tag: string, msg: string];
}

export interface EventBus {
  on<K extends keyof RdEventMap>(
    event: K,
    listener: (...args: RdEventMap[K]) => void,
    owner?: object
  ): void;
  off<K extends keyof RdEventMap>(
    event: K,
    listener: (...args: RdEventMap[K]) => void
  ): void;
  offAll(owner: object): void;
  emit<K extends keyof RdEventMap>(event: K, ...args: RdEventMap[K]): void;
}

export interface ToolbarButtonOption {
  id: string;
  label: string;
  icon?: string;
  tooltip?: string;
  disabled?: boolean;
  onClick: () => void | Promise<void>;
}

export type SidebarLocation = 'category-header' | 'host-item-menu' | 'sidebar-footer';

export interface SidebarActionContext {
  hostId?: string;
  categoryId?: string;
}

export interface SidebarActionOption {
  id: string;
  location: SidebarLocation;
  label: string;
  icon?: string;
  order?: number;
  onClick: (ctx: SidebarActionContext) => void | Promise<void>;
}

export type FileContextScope = 'local' | 'remote' | 'both';
export type FileContextKind = 'file' | 'dir' | 'both';

export interface FileContextMenuContext {
  scope: 'local' | 'remote';
  hostId?: string;
  path: string;
  isDir: boolean;
  selectedPaths?: string[];
}

export interface FileContextMenuOption {
  id: string;
  scope: FileContextScope;
  kinds: FileContextKind;
  label: string;
  icon?: string;
  order?: number;
  onClick: (ctx: FileContextMenuContext) => void | Promise<void>;
}

export type SettingsGroup =
  | 'general'
  | 'appearance'
  | 'connection'
  | 'terminal'
  | 'sftp'
  | 'security'
  | 'advanced'
  | 'plugins';

export interface SettingsSubTabOption {
  id: string;
  group: SettingsGroup;
  label: string;
  icon?: string;
  order?: number;
  render: () => unknown;
}

export interface RightPanelOption {
  id: string;
  title: string;
  icon?: string;
  order?: number;
  render: () => unknown;
}

export interface UiApi {
  registerToolbarButton(option: ToolbarButtonOption): void;
  removeToolbarButton(id: string): void;
  registerSidebarAction(option: SidebarActionOption): void;
  removeSidebarAction(id: string): void;
  registerFileContextMenu(option: FileContextMenuOption): void;
  removeFileContextMenu(id: string): void;
  registerSettingsSubTab(option: SettingsSubTabOption): void;
  removeSettingsSubTab(id: string): void;
  registerRightPanel(option: RightPanelOption): void;
  removeRightPanel(id: string): void;
  notify(kind: ToastKind, message: string): void;
  confirm(title: string, message: string): Promise<boolean>;
  prompt(title: string, message: string, defaultValue?: string): Promise<string | null>;
  openPluginConfig(pluginId?: string): void;
  focusHost(hostId: string): void;
  focusTerminal(terminalId: string): void;
  openRightPanel(id: string, initialData?: unknown): void;
  closeRightPanel(id: string): void;
}

export interface StorageApi {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

export interface SshExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  pty?: boolean;
}

export interface SshApi {
  exec(hostId: string, command: string, options?: SshExecOptions): Promise<CommandResult>;
  startShell(hostId: string, cols?: number, rows?: number): Promise<string>;
  writeToTerminal(terminalId: string, data: string | Uint8Array): Promise<void>;
  resizeTerminal(terminalId: string, cols: number, rows: number): Promise<void>;
  closeTerminal(terminalId: string): Promise<void>;
}

export interface TransferHandle {
  readonly taskId: string;
  abort(): void;
  onProgress(listener: (bytesTransferred: number, totalBytes: number) => void): void;
  finished(): Promise<'completed' | 'error' | 'canceled'>;
}

export interface SftpApi {
  list(hostId: string, path: string): Promise<SftpFile[]>;
  stat(hostId: string, path: string): Promise<SftpFile>;
  mkdir(hostId: string, path: string, recursive?: boolean): Promise<void>;
  remove(hostId: string, path: string, recursive?: boolean): Promise<void>;
  rename(hostId: string, oldPath: string, newPath: string): Promise<void>;
  readFile(hostId: string, path: string): Promise<Uint8Array>;
  writeFile(hostId: string, path: string, data: Uint8Array | string): Promise<void>;
  upload(
    hostId: string,
    localPath: string,
    remotePath: string,
    options?: { recursive?: boolean; overwrite?: boolean }
  ): Promise<TransferHandle>;
  download(
    hostId: string,
    remotePath: string,
    localPath: string,
    options?: { recursive?: boolean; overwrite?: boolean }
  ): Promise<TransferHandle>;
}

export interface ServerApi {
  listAll(): Promise<HostConfigSafe[]>;
  get(hostId: string): Promise<HostConfigSafe | null>;
  add(host: Omit<_HostConfig, 'id'> & { password?: string; private_key?: string }): Promise<_HostConfig>;
  update(
    hostId: string,
    patch: Partial<Omit<_HostConfig, 'id'>> & { password?: string; private_key?: string }
  ): Promise<_HostConfig>;
  remove(hostId: string): Promise<void>;
  testConnection(hostId: string): Promise<ConnectResult>;
  getConnectionState(hostId: string): Promise<ConnectionState>;
  listCategories(): Promise<CategoryConfig[]>;
  addCategory(name: string, order?: number): Promise<CategoryConfig>;
  updateCategory(categoryId: string, patch: Partial<CategoryConfig>): Promise<CategoryConfig>;
  removeCategory(categoryId: string): Promise<void>;
  connect(hostId: string): Promise<void>;
  disconnect(hostId: string): Promise<void>;
  cancelReconnect(hostId: string): void;
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
  headers?: Record<string, string>;
  body?: string | Uint8Array | FormData;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HttpResponse<T = unknown> {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: T;
  ok: boolean;
}

export interface HttpApi {
  request<T = unknown>(url: string, options?: HttpRequestOptions): Promise<HttpResponse<T>>;
  get<T = unknown>(url: string, headers?: Record<string, string>): Promise<HttpResponse<T>>;
  post<T = unknown>(
    url: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>>;
  put<T = unknown>(
    url: string,
    body?: unknown,
    headers?: Record<string, string>
  ): Promise<HttpResponse<T>>;
  delete<T = unknown>(url: string, headers?: Record<string, string>): Promise<HttpResponse<T>>;
}

export interface ThemePalette {
  [key: string]: string;
}

export interface ThemeInfo {
  id: string;
  name: string;
  type: 'light' | 'dark';
  palette: ThemePalette;
}

export interface ThemeApi {
  getCurrent(): Promise<ThemeInfo>;
  listAll(): Promise<ThemeInfo[]>;
  get(themeId: string): Promise<ThemeInfo | null>;
  apply(themeId: string): Promise<void>;
}

export const RD_TUNNELS_SCHEMA_URL = 'https://rd.dev/schemas/rd-tunnels-v1.json';
export interface RdTunnelsFile {
  $schema: typeof RD_TUNNELS_SCHEMA_URL;
  specVersion: '1.0';
  exportTime: number;
  exportedBy: string;
  rules: TunnelRule[];
}
export type TunnelConflictStrategy = 'skip' | 'overwrite' | 'rename';
export interface TunnelImportResult {
  imported: number;
  skipped: number;
  overwritten: number;
  renamed: number;
  rules: TunnelRule[];
}

export interface TunnelApi {
  listRules(hostId?: string): Promise<TunnelRule[]>;
  getRule(tunnelId: string): Promise<TunnelRule | null>;
  addRule(rule: Omit<TunnelRule, 'id' | 'createdAt'>): Promise<TunnelRule>;
  updateRule(tunnelId: string, patch: Partial<Omit<TunnelRule, 'id' | 'hostId' | 'createdAt'>>): Promise<TunnelRule>;
  removeRule(tunnelId: string): Promise<void>;
  start(tunnelId: string): Promise<TunnelStatus>;
  stop(tunnelId: string): Promise<void>;
  getStatus(tunnelId: string): Promise<TunnelStatus | null>;
  listStatuses(hostId?: string): Promise<TunnelStatus[]>;
  exportRules(): Promise<RdTunnelsFile>;
  importRules(file: RdTunnelsFile, onConflict?: TunnelConflictStrategy): Promise<TunnelImportResult>;
}

export interface RDContext {
  readonly pluginId: string;
  readonly manifest: PluginManifest;
  readonly ui: UiApi;
  readonly storage: StorageApi;
  readonly ssh: SshApi;
  readonly sftp: SftpApi;
  readonly server: ServerApi;
  readonly http: HttpApi;
  readonly tunnel: TunnelApi;
  readonly theme: ThemeApi;
  readonly log: {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
  };
}

export abstract class BasePlugin {
  public manifest!: PluginManifest;

  abstract init(ctx: RDContext, bus: EventBus): Promise<void>;
  abstract enable(): Promise<void>;
  abstract disable(): Promise<void>;
  abstract uninstall(): Promise<void>;
  abstract onConfigChange(newConfig: Record<string, unknown>): Promise<void>;
}

export type PluginClass = new () => BasePlugin;
