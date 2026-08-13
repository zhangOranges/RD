import { useEffect } from 'react';
import { create } from 'zustand';
import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useToastStore } from '../components/Toast';
import { logInfo, logWarn, logError } from '../utils/log';
import type { ToastKind } from '../types';

/** 写入更新日志（fire-and-forget，不等待不抛错） */
function logUpdate(level: 'info' | 'warn' | 'error', msg: string): void {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  if (level === 'error') logError(msg);
  else if (level === 'warn') logWarn(msg);
  else logInfo(msg);
}

function showToast(opts: {
  type: ToastKind;
  message: string;
  duration?: number;
}) {
  const { push } = useToastStore.getState();
  push(opts.type, opts.message, opts.duration);
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded' // 下载完成，等待用户确认安装
  | 'installing'
  | 'done'
  | 'up-to-date' // 已是最新版本
  | 'error';

/** 更新源镜像：'github' 为内置官方源，其他字符串为自定义镜像 URL 前缀（如 'https://gh-proxy.com'） */
export type UpdateMirror = string;

export interface MirrorOption {
  id: UpdateMirror;
  name: string;
  desc: string;
  /** 是否内置（不可删除） */
  builtin: boolean;
}

const BUILTIN_MIRRORS: MirrorOption[] = [
  { id: 'github', name: 'GitHub 官方', desc: '直连，海外访问速度优先', builtin: true },
  { id: 'https://cdn.gh-proxy.org', name: 'cdn.gh-proxy 镜像', desc: '国内加速：cdn.gh-proxy.org', builtin: true },
  { id: 'https://axisnow.gh-proxy.org', name: 'axisnow 镜像', desc: '国内加速：axisnow.gh-proxy.org', builtin: true },
];

const CUSTOM_MIRRORS_KEY = 'app_updater_custom_mirrors';
const UPDATE_MIRROR_KEY = 'app_updater_mirror';
const UPDATE_PENDING_KEY = 'app_updater_pending';

/** 读取用户自定义镜像列表 */
function getCustomMirrors(): string[] {
  try {
    const raw = localStorage.getItem(CUSTOM_MIRRORS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((v) => typeof v === 'string' && v.trim().length > 0);
  } catch {
    return [];
  }
}

/** 保存用户自定义镜像列表 */
function setCustomMirrors(list: string[]) {
  try {
    localStorage.setItem(CUSTOM_MIRRORS_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

/** 添加自定义镜像，返回是否添加成功（重复返回 false） */
export function addCustomMirror(url: string): boolean {
  const normalized = normalizeMirrorUrl(url);
  if (!normalized) return false;
  const list = getCustomMirrors();
  if (list.includes(normalized) || BUILTIN_MIRRORS.some((m) => m.id === normalized)) return false;
  list.push(normalized);
  setCustomMirrors(list);
  return true;
}

/** 删除自定义镜像 */
export function removeCustomMirror(url: string): boolean {
  const normalized = normalizeMirrorUrl(url);
  if (!normalized) return false;
  const list = getCustomMirrors();
  const idx = list.indexOf(normalized);
  if (idx === -1) return false;
  list.splice(idx, 1);
  setCustomMirrors(list);
  // 如果删除的是当前选中的源，回退到 github
  if (getUpdateMirror() === normalized) {
    setUpdateMirror('github');
  }
  return true;
}

/** 规范化镜像 URL：去尾部斜杠，补 https:// */
function normalizeMirrorUrl(url: string): string {
  let v = url.trim();
  if (!v) return '';
  // 补协议
  if (!v.startsWith('http://') && !v.startsWith('https://')) {
    v = 'https://' + v;
  }
  // 去尾部斜杠
  v = v.replace(/\/+$/, '');
  return v;
}

/** 获取所有镜像选项（内置 + 自定义） */
export function getMirrorOptions(): MirrorOption[] {
  const customs = getCustomMirrors();
  const customOpts: MirrorOption[] = customs.map((url) => {
    let name: string;
    try {
      name = new URL(url).hostname;
    } catch {
      name = url;
    }
    return { id: url, name: `${name} 镜像`, desc: url, builtin: false };
  });
  return [...BUILTIN_MIRRORS, ...customOpts];
}

/** 兼容旧代码的静态导出（动态读取一次） */
export const UPDATE_MIRROR_OPTIONS = BUILTIN_MIRRORS;

interface PendingUpdate {
  version: string;
  filename: string;
  path: string;
  downloadedAt: number;
}

export function getUpdateMirror(): UpdateMirror {
  try {
    const raw = localStorage.getItem(UPDATE_MIRROR_KEY);
    if (!raw) return 'github';
    return raw;
  } catch {
    return 'github';
  }
}

export function setUpdateMirror(mirror: UpdateMirror) {
  try {
    localStorage.setItem(UPDATE_MIRROR_KEY, mirror);
  } catch {
    /* ignore */
  }
}

function getPendingUpdate(): PendingUpdate | null {
  try {
    const raw = localStorage.getItem(UPDATE_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingUpdate;
    if (!parsed || typeof parsed.version !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function setPendingUpdate(p: PendingUpdate | null) {
  try {
    if (p) localStorage.setItem(UPDATE_PENDING_KEY, JSON.stringify(p));
    else localStorage.removeItem(UPDATE_PENDING_KEY);
  } catch {
    /* ignore */
  }
}

export type MirrorDelayResult = Record<string, number | null>;

/** 默认的 latest.json endpoint（与 check() 内保持一致，模块外调用时可直接用） */
const DEFAULT_LATEST_ENDPOINT =
  'https://github.com/zhangOranges/RD/releases/latest/download/latest.json';

/**
 * 并行测试所有镜像源对 latest.json 的访问延迟，返回每个源的耗时（毫秒）或 null（失败/超时）。
 * 通过 Rust 后端 invoke('probe_url') 发 HTTP HEAD 请求，完全绕过浏览器 CORS 限制。
 * 超 6 秒返回 -1（失败）。
 *
 * 注意：endpoint 必须是纯 github.com 域名的 URL，否则镜像测速无法正确区分各源。
 * 如果传入了非 github.com 的 endpoint，会自动回退到 DEFAULT_LATEST_ENDPOINT。
 */
export async function probeMirrorLatency(
  endpoint: string = DEFAULT_LATEST_ENDPOINT,
): Promise<MirrorDelayResult> {
  // 确保 endpoint 是纯 github URL
  const isGithubDomain = /^https?:\/\/([^/]*\.)?github\.com\//i.test(endpoint);
  const safeEndpoint = isGithubDomain ? endpoint : DEFAULT_LATEST_ENDPOINT;
  if (!isGithubDomain) {
    logUpdate(
      'warn',
      `[probeMirrorLatency] endpoint=${endpoint} 非 github.com 域名，已回退到 DEFAULT_LATEST_ENDPOINT`,
    );
  }

  const options = getMirrorOptions();
  const results = await Promise.all(
    options.map(async (opt) => {
      const url = opt.id === 'github' ? safeEndpoint : applyMirror(safeEndpoint, opt.id);
      logUpdate('info', `[probeMirrorLatency] 测速 mirror=${opt.id}: ${url}`);
      try {
        const ms = await invoke<number>('probe_url', { url });
        logUpdate(
          'info',
          `[probeMirrorLatency] mirror=${opt.id}: ${ms >= 0 ? ms + 'ms' : '失败(超时/错误)'}`,
        );
        return { mirror: opt.id, ms };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logUpdate('warn', `[probeMirrorLatency] mirror=${opt.id} 调用 probe_url 异常: ${msg}`);
        return { mirror: opt.id, ms: -1 };
      }
    }),
  );

  const out: MirrorDelayResult = {};
  for (const r of results) {
    out[r.mirror] = typeof r.ms === 'number' && r.ms >= 0 ? r.ms : null;
  }
  return out;
}

/**
 * 并行测试所有镜像源对 latest.json 的访问延迟，返回延迟最低的镜像。
 * 所有镜像都失败时回退到用户当前设定的源。
 */
async function pickFastestMirror(
  endpoints: readonly string[],
  userMirror: UpdateMirror,
): Promise<UpdateMirror> {
  const all = await probeMirrorLatency(endpoints[0]);
  const options = getMirrorOptions();
  const reachable = options
    .map((o) => ({ mirror: o.id, elapsed: all[o.id] ?? Infinity }))
    .filter((r) => typeof r.elapsed === 'number' && Number.isFinite(r.elapsed)) as Array<{
    mirror: UpdateMirror;
    elapsed: number;
  }>;
  if (reachable.length === 0) return userMirror;
  reachable.sort((a, b) => a.elapsed - b.elapsed);
  return reachable[0].mirror;
}

/**
 * 将 GitHub 下载 URL 根据选择的镜像源进行转换。
 * mirror 为 'github' 时原样返回；
 * 否则仅对 github.com / *.github.com 域名的 URL 进行前缀拼接（已是镜像 URL 的原样返回）。
 */
function applyMirror(url: string, mirror: UpdateMirror): string {
  if (mirror === 'github') return url;
  // 仅对 github.com 域名的 URL 拼接镜像前缀，避免对已是镜像 URL 的 endpoint 重复拼接
  if (/^https?:\/\/([^/]*\.)?github\.com\//i.test(url)) {
    return `${mirror}/${url}`;
  }
  return url;
}

export interface AppUpdaterState {
  status: UpdateStatus;
  availableVersion: string | null;
  currentVersion: string | null;
  downloadedMB: number;
  /** 文件总大小 MB（来自 latest.json 或下载响应） */
  totalMB: number | null;
  progressPct: number;
  errorMsg: string | null;
  /** 更新说明（release notes / changelog） */
  releaseNotes: string | null;
  /** 是否显示更新对话框 */
  dialogVisible: boolean;
  mirror: UpdateMirror;
  /** 各镜像源访问延迟（毫秒），null 表示不可达 */
  mirrorDelays: MirrorDelayResult;
  /** 是否检测到本地有待安装的已下载包（跨 session 恢复） */
  pendingFromLocal: boolean;
  /** 已下载的安装包本地路径 */
  downloadedFilePath: string | null;
  /** 已下载的安装包文件名 */
  downloadedFilename: string | null;
}

const DEFAULT_STATE: AppUpdaterState = {
  status: 'idle',
  availableVersion: null,
  currentVersion: null,
  downloadedMB: 0,
  totalMB: null,
  progressPct: 0,
  errorMsg: null,
  releaseNotes: null,
  dialogVisible: false,
  mirror: 'github',
  mirrorDelays: {},
  pendingFromLocal: false,
  downloadedFilePath: null,
  downloadedFilename: null,
};

function isDevProfile(): boolean {
  // ⚠️ 临时调试：强制返回 false，使本地开发环境也能触发检查更新 & 安装流程
  // 正常情况下应使用下方注释的 Vite DEV 判断：
  // if (typeof window === 'undefined') return false;
  // return !!(import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV;
  return false;
}

/** latest.json 中单个平台条目 */
interface PlatformEntry {
  signature?: string;
  url: string;
  format?: string;
  size?: number;
}

/** 从 latest.json URL 手动拉取，提取完整 platforms 数据、notes 和 version。
 * 通过 Rust 后端 fetch_url_text 发起请求，绕过浏览器 CORS 限制。
 *
 * 注意：传入的 endpoints 必须是「纯 GitHub URL」（github.com 域名），不能是已经转换过的镜像 URL。
 * 这样 applyMirror 才能对所有镜像源一致地进行前缀拼接，避免重复拼接或错误 URL。
 *
 * @param requirePlatforms 是否必须拿到 platforms 字段才认为成功（下载场景需要 true，检查更新可以 false）
 */
async function fetchLatestMeta(
  endpoints: readonly string[],
  mirror: UpdateMirror,
  requirePlatforms: boolean = false,
): Promise<{
  notes: string | null;
  version: string | null;
  platforms: Record<string, PlatformEntry> | null;
}> {
  let notes: string | null = null;
  let version: string | null = null;
  let platforms: Record<string, PlatformEntry> | null = null;

  const tryFetch = async (url: string, label: string): Promise<boolean> => {
    try {
      logUpdate('info', `[fetchLatestMeta] 尝试 (${label}, requirePlatforms=${requirePlatforms}): ${url}`);
      const text = await invoke<string>('fetch_url_text', { url });
      const data = JSON.parse(text) as {
        version?: string;
        notes?: string;
        platforms?: Record<string, PlatformEntry>;
      };
      const gotVersion = !!data.version;
      const gotPlatforms = !!data.platforms;
      logUpdate(
        'info',
        `[fetchLatestMeta] 成功 (${label}): version=${data.version ?? 'null'}, platforms=${gotPlatforms}, notes=${!!data.notes}`,
      );
      if (!version) version = data.version ?? null;
      if (!notes) notes = data.notes ?? null;
      if (!platforms && data.platforms) platforms = data.platforms;
      // 成功判定：
      // - requirePlatforms=true（下载场景）：必须同时有 version 和 platforms
      // - requirePlatforms=false（检查更新场景）：只要有 version 就成功
      if (requirePlatforms) return gotVersion && gotPlatforms;
      return gotVersion;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logUpdate('warn', `[fetchLatestMeta] 失败 (${label}): ${msg}`);
      return false;
    }
  };

  // 确保 endpoints 只使用 github.com 域名的 URL，避免非 github 的镜像前缀 URL 干扰转换
  const pureGithubEndpoints = endpoints.filter(
    (ep) => /^https?:\/\/([^/]*\.)?github\.com\//i.test(ep),
  );
  const safeEndpoints =
    pureGithubEndpoints.length > 0
      ? pureGithubEndpoints
      : ['https://github.com/zhangOranges/RD/releases/latest/download/latest.json'];
  if (pureGithubEndpoints.length !== endpoints.length) {
    logUpdate(
      'warn',
      `[fetchLatestMeta] 检测到 endpoints 中含非 github.com URL，已过滤（避免镜像前缀重复拼接）。原始=${JSON.stringify(endpoints)}，使用=${JSON.stringify(safeEndpoints)}`,
    );
  }

  // 1) 首选：用户设定的源（或测速最优源）
  for (const ep of safeEndpoints) {
    const url = applyMirror(ep, mirror);
    const label = `首选 mirror=${mirror}`;
    if (await tryFetch(url, label)) {
      return { notes, version, platforms };
    }
  }

  // 2) fallback 其他镜像（依次尝试）
  const allOpts = getMirrorOptions();
  const fallbacks = allOpts.map((o) => o.id).filter((m) => m !== mirror);
  logUpdate(
    'info',
    `[fetchLatestMeta] 首选失败，开始 fallback 镜像顺序: ${JSON.stringify(fallbacks)}`,
  );
  for (const fb of fallbacks) {
    for (const ep of safeEndpoints) {
      const url = applyMirror(ep, fb);
      const label = `fallback mirror=${fb}`;
      if (await tryFetch(url, label)) {
        return { notes, version, platforms };
      }
    }
  }

  logUpdate('error', `[fetchLatestMeta] 所有镜像源均拉取失败。尝试镜像数=${1 + fallbacks.length}`);
  return { notes, version, platforms };
}

/** 比较语义化版本号：a < b 返回 -1，相等返回 0，a > b 返回 1 */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

function detectPlatformKey(): string | null {
  if (typeof navigator === 'undefined') return null;
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows-x86_64';
  if (ua.includes('mac')) return 'darwin-aarch64';
  if (ua.includes('linux')) return 'linux-x86_64';
  return null;
}

// ---- 模块级变量（不触发 re-render，全组件共享）----
let downloadingRef = false;
let installingRef = false;
let progressUnlistenRef: UnlistenFn | null = null;
let autoCheckDone = false;
let startupCheckDone = false;

// ---- Zustand store ----
interface AppUpdaterStore extends AppUpdaterState {
  changeMirror: (m: UpdateMirror) => void;
  hideDialog: () => void;
  showDialog: () => void;
  check: () => void;
  /** 仅开始后台下载（Rust download_installer），下载中用户可关闭对话框 */
  download: () => void;
  /** 立即执行安装（Rust run_installer），并退出当前程序 */
  install: () => void;
  /** 稍后安装（关闭对话框，下次启动时再次检查本地待安装包） */
  installLater: () => void;
  /** 在文件管理器中打开已下载的安装包所在目录 */
  openFolder: () => void;
  /** 重新下载（下载失败后重试） */
  dismissError: () => void;
  isDev: boolean;
}

const useUpdaterStore = create<AppUpdaterStore>((set, get) => ({
  ...DEFAULT_STATE,
  mirror: getUpdateMirror(),
  isDev: isDevProfile(),

  changeMirror: (m: UpdateMirror) => {
    setUpdateMirror(m);
    set({ mirror: m });
  },

  hideDialog: () => set({ dialogVisible: false }),

  showDialog: () => {
    const s = get().status;
    if (s === 'available' || s === 'downloaded' || s === 'downloading' || s === 'error') {
      set({ dialogVisible: true });
    }
  },

  dismissError: () =>
    set((s) => ({
      status: s.status === 'error' ? 'idle' : s.status,
      errorMsg: null,
    })),

  check: async () => {
    if (downloadingRef || installingRef) return;

    let cur = get().currentVersion;
    if (!cur && typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
      try {
        cur = await getVersion();
      } catch {
        cur = null;
      }
    }

    logUpdate('info', `========== 开始检查更新 (当前版本: ${cur ?? 'unknown'}) ==========`);

    set((s) => {
      if (s.status === 'checking' || s.status === 'downloading' || s.status === 'installing')
        return s;
      return {
        ...DEFAULT_STATE,
        mirror: s.mirror,
        status: 'checking',
        currentVersion: s.currentVersion || cur || null,
      };
    });

    try {
      // latest.json 的 GitHub 原始 URL（镜像转换的基准地址）
      const endpoints: readonly string[] = [DEFAULT_LATEST_ENDPOINT];
      logUpdate('info', `使用 endpoints: ${JSON.stringify(endpoints)}`);

      // 自动检查更新时测速选最优镜像（手动点击检查也走此逻辑）
      const userMirror = getUpdateMirror();
      logUpdate('info', `用户设定镜像源: ${userMirror}，开始测速...`);
      // 并行测速获取所有镜像的延迟结果，保存到 state 供对话框显示
      const delayResults = await probeMirrorLatency(endpoints[0]);
      const fastestMirror = (() => {
        const options = getMirrorOptions();
        const reachable = options
          .map((o) => ({ mirror: o.id, elapsed: delayResults[o.id] ?? Infinity }))
          .filter((r) => typeof r.elapsed === 'number' && Number.isFinite(r.elapsed)) as Array<{
          mirror: UpdateMirror;
          elapsed: number;
        }>;
        if (reachable.length === 0) return userMirror;
        reachable.sort((a, b) => a.elapsed - b.elapsed);
        return reachable[0].mirror;
      })();
      logUpdate('info', `测速完成，最快镜像: ${fastestMirror}，延迟详情: ${JSON.stringify(delayResults)}`);
      set({ mirror: fastestMirror, mirrorDelays: delayResults });

      logUpdate('info', `开始拉取 latest.json (镜像: ${fastestMirror})...`);
      const { notes, version: metaVersion, platforms } = await fetchLatestMeta(
        endpoints,
        fastestMirror,
      );
      logUpdate('info', `latest.json 解析结果: version=${metaVersion ?? 'null'}, hasPlatforms=${!!platforms}, hasNotes=${!!notes}`);

      const latestV = metaVersion;
      if (!latestV) {
        throw new Error(
          `无法获取最新版本号（所有镜像源均拉取 latest.json 失败）。请检查网络连接，或在设置 → 更新中检测各镜像源延迟。`,
        );
      }

      // 手动版本对比
      const currentV = cur ?? '0.0.0';
      const hasUpdate = compareVersions(latestV, currentV) > 0;
      logUpdate('info', `版本对比: 当前=${currentV}, 最新=${latestV}, 有更新=${hasUpdate}`);

      if (!hasUpdate) {
        // 没有可用更新 → 清除本地 pending 记录（旧版遗留的）
        setPendingUpdate(null);
        set((s) => ({
          ...DEFAULT_STATE,
          mirror: s.mirror,
          status: 'up-to-date',
          currentVersion: s.currentVersion || cur || null,
        }));
        logUpdate('info', '已经是最新版本，检查更新结束');
        return;
      }

      // 有可用更新 → 检查本地是否有已下载待安装的同版本包
      const pending = getPendingUpdate();
      const pendingMatches = pending && pending.version === latestV;
      logUpdate('info', `本地 pending: ${pending ? JSON.stringify({ version: pending.version, filename: pending.filename }) : 'null'}, 匹配最新版本: ${pendingMatches}`);

      if (pendingMatches && pending) {
        // 验证本地文件是否仍存在
        try {
          const localInfo = await invoke<{ path: string; size: number } | null>(
            'check_local_installer',
            { filename: pending.filename },
          );
          if (localInfo) {
            logUpdate('info', `本地待安装包存在: ${localInfo.path} (${localInfo.size} 字节)`);
            set((s) => ({
              ...s,
              status: 'downloaded',
              currentVersion: s.currentVersion || cur || currentV,
              availableVersion: latestV,
              releaseNotes: notes,
              dialogVisible: true,
              errorMsg: null,
              downloadedMB: Math.round((localInfo.size / 1024 / 1024) * 10) / 10,
              totalMB: Math.round((localInfo.size / 1024 / 1024) * 10) / 10,
              progressPct: 100,
              pendingFromLocal: true,
              downloadedFilePath: localInfo.path,
              downloadedFilename: pending.filename,
            }));
            return;
          } else {
            logUpdate('warn', `本地 pending 记录存在但文件不存在: ${pending.filename}`);
          }
        } catch (e) {
          logUpdate('warn', `检查本地安装包失败: ${e instanceof Error ? e.message : String(e)}`);
          // 文件检查失败，继续走正常更新流程
        }
        // 文件不存在了，清理 pending
        setPendingUpdate(null);
      }

      // 版本变化了，清理旧 pending
      if (pending && pending.version !== latestV) {
        logUpdate('info', `版本变化，清理旧 pending (旧: ${pending.version}, 新: ${latestV})`);
        try {
          await invoke('delete_local_installer', { filename: pending.filename });
        } catch {
          /* ignore */
        }
        setPendingUpdate(null);
      }

      // 检查当前平台是否有可用安装包
      const platformKey = detectPlatformKey();
      if (!platformKey || !platforms || !platforms[platformKey]) {
        const msg = `当前平台无可用更新包 (platformKey=${platformKey}, 可用平台=${platforms ? Object.keys(platforms).join(',') : 'null'})`;
        logUpdate('error', msg);
        throw new Error(msg);
      }

      const platformEntry = platforms[platformKey];
      const sizeMB = typeof platformEntry.size === 'number' && platformEntry.size > 0
        ? Math.round((platformEntry.size / 1024 / 1024) * 10) / 10
        : null;
      logUpdate('info', `发现新版本 ${latestV}: platformKey=${platformKey}, url=${platformEntry.url}, size=${sizeMB ?? 'unknown'}MB`);

      set((s) => ({
        ...s,
        status: 'available',
        currentVersion: s.currentVersion || cur || currentV,
        availableVersion: latestV,
        releaseNotes: notes,
        dialogVisible: true,
        errorMsg: null,
        downloadedMB: 0,
        totalMB: sizeMB,
        progressPct: 0,
        pendingFromLocal: false,
        downloadedFilePath: null,
        downloadedFilename: null,
      }));
      logUpdate('info', '检查更新完成，等待用户下载');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logUpdate('error', `检查更新失败: ${msg}`);
      set({
        status: 'error',
        errorMsg: msg,
        downloadedMB: 0,
        progressPct: 0,
      });
      showToast({ type: 'error', message: `检查更新失败：${msg}`, duration: 5000 });
    }
  },

  download: async () => {
    if (downloadingRef || installingRef) return;
    const state = get();
    if (state.status !== 'available' && state.status !== 'error') return;

    logUpdate('info', `========== 开始下载更新 (版本: ${state.availableVersion ?? 'unknown'}) ==========`);

    const mirror = state.mirror;
    // 立即切换到 downloading 状态，让 UI 马上给出反馈（避免拉取 latest.json 期间无响应）
    downloadingRef = true;
    set({
      status: 'downloading',
      errorMsg: null,
      downloadedMB: 0,
      progressPct: 0,
      downloadedFilePath: null,
      downloadedFilename: null,
    });

    // 重新获取 latest.json 中的平台 URL
    const endpoints: readonly string[] = [DEFAULT_LATEST_ENDPOINT];
    logUpdate('info', `下载使用镜像: ${mirror}`);
    let platforms: Record<string, PlatformEntry> | null = null;
    try {
      const meta = await fetchLatestMeta(endpoints, mirror, true);
      platforms = meta.platforms;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logUpdate('error', `下载前拉取 latest.json 失败: ${msg}`);
      downloadingRef = false;
      set({ status: 'error', errorMsg: `获取下载地址失败：${msg}` });
      showToast({ type: 'error', message: `获取下载地址失败：${msg}`, duration: 5000 });
      return;
    }

    const platformKey = detectPlatformKey();
    if (!platformKey || !platforms || !platforms[platformKey]) {
      const msg = `当前平台无可用更新包 (platformKey=${platformKey}, 可用平台=${platforms ? Object.keys(platforms).join(',') : 'null'})`;
      logUpdate('error', `下载失败: ${msg}`);
      downloadingRef = false;
      set({ status: 'error', errorMsg: msg });
      showToast({ type: 'error', message: '当前平台无可用更新包', duration: 5000 });
      return;
    }

    const platformEntry = platforms[platformKey];
    const rawUrl = platformEntry.url;
    const downloadUrl = applyMirror(rawUrl, mirror);
    // 从 URL 中提取文件名
    const filename = rawUrl.split('/').pop() || `RD_${state.availableVersion}_setup.exe`;
    logUpdate('info', `下载文件: filename=${filename}, rawUrl=${rawUrl}, downloadUrl=${downloadUrl}`);

    set({ downloadedFilename: filename });

    // 注册进度事件监听
    if (progressUnlistenRef) {
      progressUnlistenRef();
      progressUnlistenRef = null;
    }
    try {
      progressUnlistenRef = await listen<{ downloaded: number; total: number; pct: number }>(
        'update-download-progress',
        (event) => {
          const { downloaded, total, pct } = event.payload;
          const downloadedMB = Math.round((downloaded / 1024 / 1024) * 10) / 10;
          const totalMB = total > 0 ? Math.round((total / 1024 / 1024) * 10) / 10 : null;
          set((s) => ({
            downloadedMB,
            totalMB: totalMB ?? s.totalMB,
            progressPct: Math.max(s.progressPct, pct),
          }));
        },
      );
    } catch {
      logUpdate('warn', '注册下载进度事件监听失败（不影响下载）');
      // 监听失败不致命，下载仍可继续
    }

    try {
      logUpdate('info', `调用 download_installer...`);
      const savedPath = await invoke<string>('download_installer', {
        url: downloadUrl,
        filename,
      });
      logUpdate('info', `下载完成，保存路径: ${savedPath}`);

      // 下载完成 → 保存 pending 记录
      const version = get().availableVersion;
      if (version) {
        setPendingUpdate({
          version,
          filename,
          path: savedPath,
          downloadedAt: Date.now(),
        });
        logUpdate('info', `已保存 pending 记录: version=${version}, filename=${filename}`);
      }

      downloadingRef = false;
      if (progressUnlistenRef) {
        progressUnlistenRef();
        progressUnlistenRef = null;
      }

      set({
        status: 'downloaded',
        pendingFromLocal: false,
        dialogVisible: true,
        progressPct: 100,
        downloadedFilePath: savedPath,
        downloadedFilename: filename,
      });
      showToast({
        type: 'success',
        message: '更新包已下载完成，可在下次启动时安装',
        duration: 3000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logUpdate('error', `下载失败: ${msg} (url=${downloadUrl})`);
      downloadingRef = false;
      if (progressUnlistenRef) {
        progressUnlistenRef();
        progressUnlistenRef = null;
      }
      set({ status: 'error', errorMsg: msg });
      showToast({ type: 'error', message: `下载更新失败：${msg}`, duration: 5000 });
    }
  },

  install: async () => {
    if (installingRef) return;
    const state = get();
    const filePath = state.downloadedFilePath;
    const filename = state.downloadedFilename;

    logUpdate('info', `========== 开始安装更新 (版本: ${state.availableVersion ?? 'unknown'}, 文件: ${filename ?? 'null'}) ==========`);

    if (!filePath || !filename) {
      // 如果有 pending 记录但路径丢失，尝试从本地恢复
      logUpdate('warn', '内存中无文件路径，尝试从 pending 记录恢复');
      const pending = getPendingUpdate();
      if (pending) {
        try {
          const localInfo = await invoke<{ path: string; size: number } | null>(
            'check_local_installer',
            { filename: pending.filename },
          );
          if (localInfo) {
            logUpdate('info', `从 pending 恢复成功: ${localInfo.path}`);
            installingRef = true;
            set({ status: 'installing' });
            await invoke('run_installer', { path: localInfo.path });
            setPendingUpdate(null);
            logUpdate('info', '安装程序已启动，1 秒后退出');
            // 给安装程序一点时间启动，然后退出
            setTimeout(() => {
              void invoke('exit_app');
            }, 1000);
            return;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logUpdate('error', `从 pending 恢复安装失败: ${msg}`);
          installingRef = false;
          set({ status: 'error', errorMsg: `安装失败：${msg}` });
          showToast({ type: 'error', message: `安装更新失败：${msg}`, duration: 5000 });
          return;
        }
      }
      logUpdate('error', '未找到安装包文件，无 pending 记录可恢复');
      showToast({ type: 'error', message: '未找到安装包文件', duration: 3000 });
      return;
    }

    installingRef = true;
    set({ status: 'installing' });
    try {
      logUpdate('info', `调用 run_installer: ${filePath}`);
      await invoke('run_installer', { path: filePath });
      // 安装程序已启动 → 清理 pending 记录
      setPendingUpdate(null);
      set({ status: 'done', progressPct: 100 });
      logUpdate('info', '安装程序已启动，1 秒后退出');
      showToast({
        type: 'success',
        message: '安装程序已启动，程序即将退出',
        duration: 3000,
      });
      // 给安装程序一点时间启动，然后退出当前程序
      setTimeout(() => {
        void invoke('exit_app');
      }, 1000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logUpdate('error', `安装失败: ${msg} (path=${filePath})`);
      installingRef = false;
      set({ status: 'error', errorMsg: msg });
      showToast({ type: 'error', message: `安装更新失败：${msg}`, duration: 5000 });
    }
  },

  installLater: () => {
    set({ dialogVisible: false });
    showToast({
      type: 'info',
      message: '已保留更新包，下次启动时将再次提示安装',
      duration: 3000,
    });
  },

  openFolder: async () => {
    const path = get().downloadedFilePath;
    if (!path) {
      showToast({ type: 'warning', message: '未找到下载文件路径', duration: 3000 });
      return;
    }
    try {
      await invoke('open_folder', { path });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`打开文件夹失败: ${msg} (path=${path})`);
      showToast({ type: 'error', message: `打开文件夹失败：${msg}`, duration: 3000 });
    }
  },
}));

/** 启动时检查本地是否有待安装的更新包（跨 session 恢复） */
async function checkPendingInstallerOnStartup(): Promise<void> {
  const pending = getPendingUpdate();
  if (!pending) return;

  logUpdate('info', `========== 启动检查本地待安装包 ==========`);

  // 获取当前版本
  let cur: string | null = null;
  try {
    cur = await getVersion();
  } catch {
    cur = null;
  }
  logUpdate('info', `pending: version=${pending.version}, filename=${pending.filename}, 当前版本=${cur ?? 'unknown'}`);

  // 如果待安装版本 <= 当前版本，说明已经更新过了，清理本地包
  if (cur && compareVersions(pending.version, cur) <= 0) {
    logUpdate('info', `待安装版本 ${pending.version} <= 当前版本 ${cur}，已更新过，清理本地包`);
    try {
      await invoke('delete_local_installer', { filename: pending.filename });
    } catch {
      /* ignore */
    }
    setPendingUpdate(null);
    return;
  }

  // 验证本地文件是否仍存在
  let localInfo: { path: string; size: number } | null = null;
  try {
    localInfo = await invoke<{ path: string; size: number } | null>(
      'check_local_installer',
      { filename: pending.filename },
    );
  } catch {
    localInfo = null;
  }

  if (!localInfo) {
    logUpdate('warn', `本地安装包文件不存在: ${pending.filename}，清理 pending 记录`);
    // 文件不存在了，清理 pending
    setPendingUpdate(null);
    return;
  }
  logUpdate('info', `本地安装包存在: ${localInfo.path} (${localInfo.size} 字节)`);

  // 拉取 latest.json 检查待安装版本是否仍为最新
  const endpoints: readonly string[] = [DEFAULT_LATEST_ENDPOINT];

  const userMirror = getUpdateMirror();
  let fastestMirror = userMirror;
  try {
    fastestMirror = await pickFastestMirror(endpoints, userMirror);
  } catch {
    /* 测速失败用用户设定的源 */
  }
  logUpdate('info', `拉取 latest.json 验证版本 (镜像: ${fastestMirror})...`);

  const { notes, version: latestV } = await fetchLatestMeta(endpoints, fastestMirror);
  logUpdate('info', `latest.json 版本: ${latestV ?? 'null'}, pending 版本: ${pending.version}`);

  // 如果待安装版本与最新版本一致，提示安装
  if (latestV && pending.version === latestV) {
    const sizeMB = Math.round((localInfo.size / 1024 / 1024) * 10) / 10;
    logUpdate('info', `版本匹配，弹出安装确认对话框 (版本: ${pending.version}, 大小: ${sizeMB}MB)`);
    useUpdaterStore.setState({
      status: 'downloaded',
      currentVersion: cur,
      availableVersion: pending.version,
      releaseNotes: notes,
      dialogVisible: true,
      errorMsg: null,
      downloadedMB: sizeMB,
      totalMB: sizeMB,
      progressPct: 100,
      pendingFromLocal: true,
      downloadedFilePath: localInfo.path,
      downloadedFilename: pending.filename,
      mirror: fastestMirror,
    });
  } else {
    // 待安装版本与最新版本不一致（已有更新的版本），清理旧包
    logUpdate('info', `版本不匹配 (pending: ${pending.version}, latest: ${latestV ?? 'null'})，清理旧包`);
    try {
      await invoke('delete_local_installer', { filename: pending.filename });
    } catch {
      /* ignore */
    }
    setPendingUpdate(null);
  }
}

/** 兼容旧接口的 hook 包装 */
export function useAppUpdater() {
  const store = useUpdaterStore();

  // 启动时检查本地待安装包（跨 session 恢复）
  useEffect(() => {
    if (startupCheckDone) return;
    startupCheckDone = true;
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    if (isDevProfile()) return;
    void checkPendingInstallerOnStartup().catch(() => {
      /* 启动检查失败静默处理 */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 启动自动检查更新（仅 release 打包后环境，仅一次）
  useEffect(() => {
    if (autoCheckDone) return;
    autoCheckDone = true;
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    if (isDevProfile()) return;
    // 延迟 3 秒后检查更新，避免与启动 pending 检查冲突
    setTimeout(() => {
      void store.check();
    }, 3000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return store;
}
