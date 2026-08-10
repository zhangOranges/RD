import { create } from 'zustand';

/**
 * 主题类型：
 * - light：浅色（macOS Sonoma 风）
 * - dark：标准暗色
 * - tech-dark：黑夜科技（应用默认主题，青蓝荧光 + 紫色辅助 + 深近黑底）
 * - system：跟随系统 prefers-color-scheme
 */
export type ThemeId = 'light' | 'dark' | 'tech-dark' | 'system';

export interface ThemeOption {
  id: ThemeId;
  name: string;
  desc: string;
  /** 用于预览色块的代表色 */
  swatch: string;
}

export const THEME_OPTIONS: ThemeOption[] = [
  { id: 'tech-dark', name: '黑夜科技', desc: '青蓝荧光 + 紫色辅助 + 深近黑底（推荐）', swatch: '#00D4FF' },
  { id: 'dark', name: '标准暗色', desc: 'macOS 暗色模式风格', swatch: '#0A84FF' },
  { id: 'light', name: '浅色', desc: 'macOS Sonoma 浅色风格', swatch: '#5AC8FA' },
  { id: 'system', name: '跟随系统', desc: '根据系统偏好自动切换浅色/暗色', swatch: '#8E8E93' },
];

const STORAGE_KEY = 'app_theme';
const DEFAULT_THEME: ThemeId = 'tech-dark';

/** 实际生效的 data-theme 值：system 会被解析为 light/dark */
function resolveDataTheme(theme: ThemeId): 'light' | 'dark' | 'tech-dark' {
  if (theme === 'system') {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'dark';
  }
  return theme;
}

/** 把 data-theme 写到 <html> 上，让 CSS 变量立即生效 */
function applyTheme(theme: ThemeId) {
  if (typeof document === 'undefined') return;
  const dataTheme = resolveDataTheme(theme);
  document.documentElement.setAttribute('data-theme', dataTheme);
}

/** 启动时同步执行一次：从 localStorage 读取并应用主题，避免首屏闪烁 */
function initTheme(): ThemeId {
  if (typeof window === 'undefined') return DEFAULT_THEME;
  let saved: ThemeId = DEFAULT_THEME;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'tech-dark' || raw === 'system') {
      saved = raw;
    }
  } catch {
    // localStorage 不可用，使用默认
  }
  applyTheme(saved);
  return saved;
}

interface ThemeState {
  theme: ThemeId;
  /** 切换主题并持久化 */
  setTheme: (t: ThemeId) => void;
}

const initialTheme = initTheme();

export const useThemeStore = create<ThemeState>((set) => ({
  theme: initialTheme,
  setTheme: (t) => {
    applyTheme(t);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      // localStorage 不可用时静默忽略
    }
    set({ theme: t });
  },
}));

// 跟随系统：监听 prefers-color-scheme 变化，仅当当前主题为 system 时重新应用
if (typeof window !== 'undefined' && window.matchMedia) {
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (useThemeStore.getState().theme === 'system') {
      applyTheme('system');
    }
  };
  // addListener/addEventListener 兼容
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange);
  } else if (typeof (mql as MediaQueryList).addListener === 'function') {
    (mql as MediaQueryList).addListener(onChange);
  }
}
