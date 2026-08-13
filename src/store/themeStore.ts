import { create } from 'zustand';
import {
  type PresetThemeId,
  type CustomTheme,
  type ThemePalette,
  PRESET_PALETTES,
  PALETTE_GROUPS,
  isCustomThemeId,
  resolveCustomPalette,
  paletteToCssText,
  generateCustomThemeId,
} from '../theme/palette';
import { useToastStore } from '../components/Toast';

/**
 * 主题系统 Store
 *
 * 支持两种主题：
 * 1. 预设主题（tech-dark / dark / light / eye-care-green / system）
 *    —— 写在 finder.css 的 :root[data-theme] 块中，切换 data-theme 即可生效
 * 2. 自定义主题（id 形如 'custom-xxx'）
 *    —— 继承某个预设主题，覆盖部分字段；运行时用 adoptedStyleSheets 注入 CSS 变量
 *
 * 注入优先级（高 → 低）：
 *   自定义主题注入（adoptedStyleSheets）> 预设主题 CSS（:root[data-theme]）> :root 默认值
 */

/* ---------- 类型 ---------- */

/** 预设主题 ID（含 system） */
export type PresetThemeIdWithSystem = PresetThemeId | 'system';

/** 任意主题 ID：预设、system、或自定义（custom-xxx） */
export type ThemeId = PresetThemeIdWithSystem | string;

export interface ThemeOption {
  id: ThemeId;
  name: string;
  desc: string;
  /** 用于预览色块的代表色 */
  swatch: string;
  /** 是否为自定义主题 */
  custom?: boolean;
}

/* ---------- 预设主题选项 ---------- */

const PRESET_OPTIONS: ThemeOption[] = [
  { id: 'tech-dark', name: '黑夜科技', desc: '青蓝荧光 + 紫色辅助 + 深近黑底（推荐）', swatch: '#00D4FF' },
  { id: 'dark', name: '标准暗色', desc: 'macOS 暗色模式风格', swatch: '#0A84FF' },
  { id: 'eye-care-green', name: '护眼绿', desc: '经典绿豆沙底色，缓解长时间阅读疲劳', swatch: '#2E8B57' },
  { id: 'light', name: '浅色', desc: 'macOS Sonoma 浅色风格', swatch: '#5AC8FA' },
  { id: 'system', name: '跟随系统', desc: '根据系统偏好自动切换浅色/暗色', swatch: '#8E8E93' },
];

/* ---------- 常量 ---------- */

const STORAGE_KEY = 'app_theme';
const CUSTOM_THEMES_KEY = 'app_custom_themes';
const DEFAULT_THEME: ThemeId = 'tech-dark';

/* ---------- 自定义主题持久化 ---------- */

function loadCustomThemes(): CustomTheme[] {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveCustomThemes(themes: CustomTheme[]): boolean {
  try {
    const serialized = JSON.stringify(themes);
    // 预检：localStorage 通常限 5MB，接近时提前拒绝
    if (serialized.length > 4_500_000) {
      useToastStore.getState().push('error', '背景图过大，保存失败。请使用更小的图片。');
      return false;
    }
    localStorage.setItem(CUSTOM_THEMES_KEY, serialized);
    return true;
  } catch (e) {
    // QuotaExceededError 等：提示用户而非静默吞错
    useToastStore.getState().push('error', '主题保存失败（存储空间不足），背景图可能过大。');
    return false;
  }
}

/* ---------- 主题应用：data-theme + CSS 变量注入 ---------- */

/** 当前注入的 adoptedStyleSheet 引用（自定义主题用），切换/移除时清理 */
let injectedSheet: CSSStyleSheet | null = null;

/**
 * 解析主题为实际生效的 data-theme 值。
 * - 预设主题：返回自身（system 解析为 light/dark）
 * - 自定义主题：返回其 extends 基础预设
 */
function resolveDataTheme(theme: ThemeId, customThemes: CustomTheme[]): PresetThemeId {
  if (isCustomThemeId(theme)) {
    const ct = customThemes.find((t) => t.id === theme);
    return ct?.extends ?? 'tech-dark';
  }
  if (theme === 'system') {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return 'dark';
  }
  return theme as PresetThemeId;
}

/**
 * 注入自定义主题的 CSS 变量到 :root（通过 adoptedStyleSheets，优先级高于预设 CSS）。
 * 切换到预设主题时调用 clearInjectedTheme() 清理。
 *
 * 背景图特殊处理（经验 1284067 + 495218）：
 *   bgImage（base64 DataURL）可能高达数 MB，放入 CSSStyleSheet.replaceSync() 会
 *   因 CSS 文本过大而静默失败或极慢。因此 bgImage 不走 adoptedStyleSheets，
 *   改为直接在 documentElement 上设置内联 style.setProperty('--bg-image', url(...))。
 *   其余颜色变量（含玻璃化 alpha 相乘后的值）仍走 CSSStyleSheet 注入。
 */
function injectCustomTheme(theme: CustomTheme) {
  if (typeof document === 'undefined') return;
  // 先清理上一次注入
  clearInjectedTheme();
  const palette = resolveCustomPalette(theme);

  // ---- 背景图：直接在 html 元素上设置内联 background-image，不走 CSS 变量 ----
  //     原因：CSS 变量 var(--bg-image) 在 ::before 中可能因层叠优先级或空值解析问题失效。
  //     直接设 html.style.backgroundImage 更可靠，html::after 遮罩层叠在其上即可。
  if (palette.bgImage) {
    const dataUrl = palette.bgImage.replace(/"/g, '\\"');
    const htmlEl = document.documentElement;
    htmlEl.style.backgroundImage = `url("${dataUrl}")`;
    htmlEl.style.backgroundSize = 'cover';
    // 背景图位置：用户可通过主题编辑器拖拽设定（百分比），默认 50%/50% = center
    const posX = palette.bgPositionX || '50';
    const posY = palette.bgPositionY || '50';
    htmlEl.style.backgroundPosition = `${posX}% ${posY}%`;
    htmlEl.style.backgroundRepeat = 'no-repeat';
    htmlEl.style.backgroundAttachment = 'fixed';
    htmlEl.setAttribute('data-bg-image', '1');
  } else {
    const htmlEl = document.documentElement;
    htmlEl.style.backgroundImage = '';
    htmlEl.style.backgroundSize = '';
    htmlEl.style.backgroundPosition = '';
    htmlEl.style.backgroundRepeat = '';
    htmlEl.style.backgroundAttachment = '';
    htmlEl.removeAttribute('data-bg-image');
  }

  // ---- 其余 CSS 变量：通过 adoptedStyleSheets 注入（不含 bgImage，避免 CSS 文本过大） ----
  const { bgImage: _omit, ...paletteWithoutImage } = palette;
  const cssText = paletteToCssText(paletteWithoutImage, !!palette.bgImage);
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    injectedSheet = sheet;
  } catch {
    // CSSStyleSheet 不可用时降级：用 <style> 标签
    const style = document.getElementById('__custom_theme_style__');
    if (style) style.remove();
    const el = document.createElement('style');
    el.id = '__custom_theme_style__';
    el.textContent = cssText;
    document.head.appendChild(el);
    injectedSheet = null;
  }
}

/** 清理自定义主题注入的 CSS 变量 */
function clearInjectedTheme() {
  if (typeof document === 'undefined') return;
  if (injectedSheet) {
    try {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== injectedSheet);
    } catch {
      /* ignore */
    }
    injectedSheet = null;
  }
  const style = document.getElementById('__custom_theme_style__');
  if (style) style.remove();
  // 清理背景图内联样式 + data-bg-image 标记
  const htmlEl = document.documentElement;
  htmlEl.style.backgroundImage = '';
  htmlEl.style.backgroundSize = '';
  htmlEl.style.backgroundPosition = '';
  htmlEl.style.backgroundRepeat = '';
  htmlEl.style.backgroundAttachment = '';
  htmlEl.removeAttribute('data-bg-image');
}

/** 应用主题：写 data-theme + 按需注入/清理自定义 CSS 变量 */
function applyTheme(theme: ThemeId, customThemes: CustomTheme[]) {
  if (typeof document === 'undefined') return;
  const dataTheme = resolveDataTheme(theme, customThemes);
  document.documentElement.setAttribute('data-theme', dataTheme);

  if (isCustomThemeId(theme)) {
    const ct = customThemes.find((t) => t.id === theme);
    if (ct) {
      injectCustomTheme(ct);
    }
  } else {
    clearInjectedTheme();
  }
}

/* ---------- 初始化 ---------- */

function initTheme(): { theme: ThemeId; customThemes: CustomTheme[] } {
  if (typeof window === 'undefined') return { theme: DEFAULT_THEME, customThemes: [] };
  const customThemes = loadCustomThemes();
  let saved: ThemeId = DEFAULT_THEME;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      // 接受预设 ID、system、或已存在的自定义 ID
      if (raw === 'system' || isCustomThemeId(raw) || PRESET_PALETTES[raw as PresetThemeId]) {
        saved = raw;
      }
    }
  } catch {
    /* ignore */
  }
  applyTheme(saved, customThemes);
  return { theme: saved, customThemes };
}

const initial = initTheme();

/* ---------- Store ---------- */

interface ThemeState {
  /** 当前激活的主题 ID（预设 / system / 自定义） */
  theme: ThemeId;
  /** 自定义主题列表 */
  customThemes: CustomTheme[];

  /** 切换主题（预设或自定义）并持久化 */
  setTheme: (t: ThemeId) => void;

  /** 新建自定义主题（基于某预设），返回新主题 ID */
  createCustomTheme: (name: string, extends_: PresetThemeId, overrides?: Partial<ThemePalette>) => string;

  /** 更新自定义主题的覆盖字段 */
  updateCustomTheme: (id: string, overrides: Partial<ThemePalette>, name?: string) => void;

  /** 删除自定义主题；若正在使用则回退到其基础预设 */
  deleteCustomTheme: (id: string) => void;

  /** 获取自定义主题的解析后完整 palette（用于编辑器回显） */
  getResolvedPalette: (id: string) => ThemePalette | null;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: initial.theme,
  customThemes: initial.customThemes,

  setTheme: (t) => {
    const { customThemes } = get();
    applyTheme(t, customThemes);
    try {
      localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* ignore */
    }
    set({ theme: t });
  },

  createCustomTheme: (name, extends_, overrides) => {
    const id = generateCustomThemeId();
    const now = Date.now();
    const ct: CustomTheme = {
      id,
      name: name || '自定义主题',
      desc: `基于${PRESET_OPTIONS.find((o) => o.id === extends_)?.name ?? extends_}`,
      extends: extends_,
      overrides: overrides ?? {},
      createdAt: now,
      updatedAt: now,
    };
    const next = [...get().customThemes, ct];
    saveCustomThemes(next);
    set({ customThemes: next });
    return id;
  },

  updateCustomTheme: (id, overrides, name) => {
    const next = get().customThemes.map((t) => {
      if (t.id !== id) return t;
      return {
        ...t,
        overrides: { ...t.overrides, ...overrides },
        name: name ?? t.name,
        updatedAt: Date.now(),
      };
    });
    // 持久化失败时不更新内存 state，避免"会话内看似生效但重启丢失"
    if (!saveCustomThemes(next)) return;
    set({ customThemes: next });
    // 若当前正在使用该主题，重新注入以即时生效
    if (get().theme === id) {
      const ct = next.find((t) => t.id === id);
      if (ct) injectCustomTheme(ct);
    }
  },

  deleteCustomTheme: (id) => {
    const target = get().customThemes.find((t) => t.id === id);
    const next = get().customThemes.filter((t) => t.id !== id);
    saveCustomThemes(next);
    set({ customThemes: next });
    // 若正在使用被删除的主题，回退到其基础预设
    if (get().theme === id && target) {
      get().setTheme(target.extends);
    }
  },

  getResolvedPalette: (id) => {
    const ct = get().customThemes.find((t) => t.id === id);
    if (!ct) return null;
    return resolveCustomPalette(ct);
  },
}));

/* ---------- 派生：完整的主题选项列表（预设 + 自定义） ---------- */

/** 获取所有可选主题（预设 + 自定义），供设置面板渲染 */
export function useThemeOptions(): ThemeOption[] {
  const customThemes = useThemeStore((s) => s.customThemes);
  const customOpts: ThemeOption[] = customThemes.map((t) => ({
    id: t.id,
    name: t.name,
    desc: t.desc,
    swatch: resolveCustomPalette(t).accent,
    custom: true,
  }));
  return [...PRESET_OPTIONS, ...customOpts];
}

/* ---------- 跟随系统监听 ---------- */

if (typeof window !== 'undefined' && window.matchMedia) {
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if (useThemeStore.getState().theme === 'system') {
      applyTheme('system', useThemeStore.getState().customThemes);
    }
  };
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', onChange);
  } else if (typeof (mql as MediaQueryList).addListener === 'function') {
    (mql as MediaQueryList).addListener(onChange);
  }
}

export { PRESET_OPTIONS, PALETTE_GROUPS };
