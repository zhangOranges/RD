/**
 * ThemePalette —— 主题调色板数据模型
 *
 * 把一套主题的所有 CSS 变量用结构化数据描述，使主题可被读取、编辑、
 * 导入导出与继承。预设主题的值与 finder.css 中的 :root[data-theme] 块保持一致。
 *
 * 分层注入优先级（高 → 低）：
 *   1. 自定义主题运行时注入（adoptedStyleSheets，:root 高优先级）
 *   2. 预设主题 CSS 文件（:root[data-theme="..."]）
 *   3. :root 默认值
 */

/* ============================================================
 * 一、Meta 元信息
 * ============================================================ */

/** 预设主题 ID（写在 CSS 文件里，不可删除） */
export type PresetThemeId = 'light' | 'dark' | 'tech-dark' | 'eye-care-green';

/** 自定义主题 ID 前缀，运行时生成的自定义主题使用此前缀以区分预设 */
export const CUSTOM_THEME_PREFIX = 'custom-';

/** 判断一个主题 ID 是否为自定义主题 */
export const isCustomThemeId = (id: string): boolean => id.startsWith(CUSTOM_THEME_PREFIX);

/* ============================================================
 * 二、ThemePalette 完整字段定义
 * ============================================================ */

/**
 * 一套主题的完整调色板。字段名与 finder.css 的 CSS 变量一一对应
 * （CSS 变量名 = `--` + camelCase → kebab-case）。
 *
 * 设计原则：所有字段均为可选，自定义主题可只覆盖差异部分，
 * 其余从 extends 指定的基础主题继承。
 */
export interface ThemePalette {
  /* ---------- 背景 ---------- */
  bgApp: string;              // 应用最底层
  bgSidebar: string;          // 侧边栏（半透明玻璃）
  bgSidebarSolid: string;     // 侧边栏不透明兜底
  bgContent: string;          // 内容区
  bgToolbar: string;          // 工具栏（毛玻璃）
  bgToolbarSolid: string;     // 工具栏不透明兜底
  bgStatusbar: string;        // 状态栏
  bgInput: string;            // 输入框
  bgTerminal: string;         // 终端容器背景

  /* ---------- 分割线 / 边框 ---------- */
  divider: string;
  dividerSoft: string;
  dividerStrong: string;
  borderGlow: string;

  /* ---------- 文字层次 ---------- */
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textQuaternary: string;
  textOnAccent: string;       // 强调色背景上的文字

  /* ---------- 强调色 ---------- */
  accent: string;             // 主强调色
  accent2: string;            // 辅助强调色 2
  accent3: string;            // 辅助强调色 3
  accentSoft: string;         // 主强调色半透明
  accentSoft2: string;        // 辅助强调色半透明

  /* ---------- 悬停 / 按压 ---------- */
  hover: string;
  hoverStrong: string;

  /* ---------- 连接状态色 ---------- */
  stateDisconnected: string;
  stateConnecting: string;
  stateConnected: string;

  /* ---------- 语义色 ---------- */
  danger: string;
  warning: string;
  success: string;
  info: string;

  /* ---------- 自定义背景图（可选，空字符串表示无） ----------
   * bgImage: DataURL (base64) 格式图片，存储在 localStorage，避免路径失效
   * bgOverlayAlpha: 0–1，背景图遮罩层透明度（越大越看不清图，面板越不透明更清晰）
   * bgGlassAlpha: 0–1，面板（bg-content/bg-sidebar/...）半透明程度（越大面板越不透明，越小越玻璃透出底图）
   */
  bgImage: string;
  bgOverlayAlpha: string;      // '0.85' -> 85% 遮罩
  bgGlassAlpha: string;        // '0.92' -> 面板 92% 不透明

  /* ---------- 圆角体系 ---------- */
  radiusXs: string;
  radiusControl: string;
  radiusLarge: string;
  radiusDialog: string;
  radiusXl: string;

  /* ---------- 阴影体系 ---------- */
  shadowDialog: string;
  shadowToast: string;
  shadowMenu: string;
  shadowGlow: string;
  shadowGlowStrong: string;

  /* ---------- 选中渐变 ---------- */
  selectedGradient: string;
  selectedGradientSoft: string;

  /* ---------- 终端：标题栏 / 标签 / 按钮 ---------- */
  termBg: string;
  termFg: string;
  termAccent: string;
  termAccentSoft: string;
  termAccentGlow: string;
  termAccent2: string;
  termStateOk: string;
  termStateOkSoft: string;

  termTitlebarBgA: string;
  termTitlebarBgB: string;
  termTitlebarBorder: string;
  termTitlebarText: string;
  termTitlebarTextDim: string;

  termTabInactive: string;
  termTabHoverBg: string;
  termTabHoverText: string;
  termTabActiveBg: string;
  termTabActiveText: string;
  termTabActiveBorder: string;
  termTabActiveInsert: string;

  termBtn: string;
  termBtnHoverBg: string;
  termBtnHoverText: string;
  termBtnHoverBorder: string;
  termBtnDisabled: string;

  termScrollbar: string;
  termScrollbarHover: string;
  termScrollbarGlow: string;

  /* ---------- 终端：xterm ANSI 16 色 + 光标 / 选区 ---------- */
  xtermBg: string;
  xtermFg: string;
  xtermCursor: string;
  xtermCursorAccent: string;
  xtermSelection: string;
  xtermBlack: string;
  xtermRed: string;
  xtermGreen: string;
  xtermYellow: string;
  xtermBlue: string;
  xtermMagenta: string;
  xtermCyan: string;
  xtermWhite: string;
  xtermBrightBlack: string;
  xtermBrightRed: string;
  xtermBrightGreen: string;
  xtermBrightYellow: string;
  xtermBrightBlue: string;
  xtermBrightMagenta: string;
  xtermBrightCyan: string;
  xtermBrightWhite: string;
}

/* ============================================================
 * 三、自定义主题（带元信息 + 继承）
 * ============================================================ */

/**
 * 自定义主题：在某个预设主题基础上覆盖部分字段。
 * - extends: 继承的预设主题 ID，运行时合并
 * - overrides: 仅包含被修改的字段（Partial）
 */
export interface CustomTheme {
  id: string;                 // 形如 'custom-1700000000000'
  name: string;
  desc: string;
  extends: PresetThemeId;     // 继承自哪个预设
  overrides: Partial<ThemePalette>;
  createdAt: number;
  updatedAt: number;
}

/* ============================================================
 * 四、字段元信息（供编辑器渲染分组、标签、说明）
 * ============================================================ */

export interface PaletteFieldMeta {
  key: keyof ThemePalette;
  label: string;
  desc?: string;
}

export interface PaletteGroupMeta {
  id: string;
  title: string;
  desc?: string;
  /** 该组是否默认折叠（高级组默认折叠） */
  advanced?: boolean;
  fields: PaletteFieldMeta[];
}

/**
 * 字段分组定义。编辑器按此分组渲染颜色拾取器。
 * 核心组默认展开，高级组（终端细节、阴影）默认折叠。
 */
export const PALETTE_GROUPS: PaletteGroupMeta[] = [
  {
    id: 'background-image',
    title: '背景图片',
    desc: '自定义背景图 + 玻璃拟态，图片会透出在面板下方',
    fields: [
      { key: 'bgImage', label: '背景图片', desc: '上传一张图片作为应用背景（DataURL 存储）' },
      { key: 'bgOverlayAlpha', label: '遮罩透明度', desc: '值越大，背景图越不明显；越接近于原图越清晰需减小' },
      { key: 'bgGlassAlpha', label: '面板透明度', desc: '值越大面板越不清晰、底图越明显；越大面板文字越清楚' },
    ],
  },
  {
    id: 'background',
    title: '背景颜色',
    desc: '应用各层级的背景色，决定整体明暗基调',
    fields: [
      { key: 'bgApp', label: '应用底层', desc: '桌面级最底层背景' },
      { key: 'bgSidebar', label: '侧边栏', desc: '半透明玻璃效果' },
      { key: 'bgContent', label: '内容区', desc: '文件列表等主内容' },
      { key: 'bgToolbar', label: '工具栏', desc: '顶部毛玻璃' },
      { key: 'bgStatusbar', label: '状态栏' },
      { key: 'bgInput', label: '输入框' },
      { key: 'bgTerminal', label: '终端容器' },
    ],
  },
  {
    id: 'text',
    title: '文字',
    desc: '四级文字层次，从主到次',
    fields: [
      { key: 'textPrimary', label: '主文字' },
      { key: 'textSecondary', label: '次要文字' },
      { key: 'textTertiary', label: '三级文字' },
      { key: 'textQuaternary', label: '四级文字' },
      { key: 'textOnAccent', label: '强调色上文字', desc: '按钮等强调色背景上的文字' },
    ],
  },
  {
    id: 'accent',
    title: '强调色',
    desc: '主色与辅助色，决定主题性格',
    fields: [
      { key: 'accent', label: '主强调色', desc: '按钮、选中、链接' },
      { key: 'accent2', label: '辅助色 2' },
      { key: 'accent3', label: '辅助色 3' },
    ],
  },
  {
    id: 'semantic',
    title: '状态 / 语义色',
    fields: [
      { key: 'stateConnected', label: '已连接' },
      { key: 'stateConnecting', label: '连接中' },
      { key: 'stateDisconnected', label: '已断开' },
      { key: 'danger', label: '危险' },
      { key: 'warning', label: '警告' },
      { key: 'success', label: '成功' },
    ],
  },
  {
    id: 'xterm',
    title: '终端 ANSI 16 色',
    desc: '终端中命令输出的标准 16 色，影响 ls / git 等命令着色',
    fields: [
      { key: 'xtermBg', label: '终端背景' },
      { key: 'xtermFg', label: '终端前景' },
      { key: 'xtermCursor', label: '光标' },
      { key: 'xtermSelection', label: '选区' },
      { key: 'xtermBlack', label: 'Black' },
      { key: 'xtermRed', label: 'Red' },
      { key: 'xtermGreen', label: 'Green' },
      { key: 'xtermYellow', label: 'Yellow' },
      { key: 'xtermBlue', label: 'Blue' },
      { key: 'xtermMagenta', label: 'Magenta' },
      { key: 'xtermCyan', label: 'Cyan' },
      { key: 'xtermWhite', label: 'White' },
      { key: 'xtermBrightBlack', label: 'Bright Black' },
      { key: 'xtermBrightRed', label: 'Bright Red' },
      { key: 'xtermBrightGreen', label: 'Bright Green' },
      { key: 'xtermBrightYellow', label: 'Bright Yellow' },
      { key: 'xtermBrightBlue', label: 'Bright Blue' },
      { key: 'xtermBrightMagenta', label: 'Bright Magenta' },
      { key: 'xtermBrightCyan', label: 'Bright Cyan' },
      { key: 'xtermBrightWhite', label: 'Bright White' },
    ],
  },
  {
    id: 'terminal-ui',
    title: '终端 UI 细节',
    desc: '标签栏、按钮、滚动条等终端外壳样式（高级）',
    advanced: true,
    fields: [
      { key: 'termTitlebarBgA', label: '标题栏背景 A' },
      { key: 'termTitlebarBgB', label: '标题栏背景 B' },
      { key: 'termTitlebarBorder', label: '标题栏边框' },
      { key: 'termTitlebarText', label: '标题栏文字' },
      { key: 'termTabActiveBg', label: '激活标签背景' },
      { key: 'termTabActiveText', label: '激活标签文字' },
      { key: 'termTabActiveBorder', label: '激活标签边框' },
      { key: 'termBtnHoverBg', label: '按钮悬停背景' },
      { key: 'termBtnHoverText', label: '按钮悬停文字' },
      { key: 'termScrollbar', label: '滚动条' },
      { key: 'termScrollbarHover', label: '滚动条悬停' },
    ],
  },
  {
    id: 'divider',
    title: '分割线 / 边框',
    advanced: true,
    fields: [
      { key: 'divider', label: '分割线' },
      { key: 'dividerSoft', label: '弱分割线' },
      { key: 'dividerStrong', label: '强分割线' },
      { key: 'borderGlow', label: '发光边框' },
    ],
  },
  {
    id: 'shadow',
    title: '阴影 / 渐变',
    advanced: true,
    fields: [
      { key: 'shadowDialog', label: '弹窗阴影' },
      { key: 'shadowToast', label: 'Toast 阴影' },
      { key: 'shadowMenu', label: '菜单阴影' },
      { key: 'shadowGlow', label: '发光阴影' },
      { key: 'shadowGlowStrong', label: '强发光阴影' },
      { key: 'selectedGradient', label: '选中渐变' },
      { key: 'selectedGradientSoft', label: '弱选中渐变' },
    ],
  },
  {
    id: 'radius',
    title: '圆角',
    advanced: true,
    fields: [
      { key: 'radiusXs', label: '极小圆角' },
      { key: 'radiusControl', label: '控件圆角' },
      { key: 'radiusLarge', label: '大圆角' },
      { key: 'radiusDialog', label: '弹窗圆角' },
      { key: 'radiusXl', label: '超大圆角' },
    ],
  },
];

/* ============================================================
 * 五、预设主题 Palette 数据（与 finder.css 一致，用于继承）
 * ============================================================ */

const PRESET_TECH_DARK: ThemePalette = {
  bgApp: '#050810', bgSidebar: 'rgba(10, 14, 24, 0.82)', bgSidebarSolid: '#0a0e18',
  bgContent: '#0d111c', bgToolbar: 'rgba(14, 20, 34, 0.78)', bgToolbarSolid: '#0e1422',
  bgStatusbar: 'rgba(8, 12, 22, 0.86)', bgInput: '#131a2a', bgTerminal: '#0a0e1a',
  divider: 'rgba(120, 180, 255, 0.10)', dividerSoft: 'rgba(120, 180, 255, 0.05)',
  dividerStrong: 'rgba(120, 180, 255, 0.18)', borderGlow: 'rgba(0, 212, 255, 0.55)',
  textPrimary: '#e6f1ff', textSecondary: '#8aa3c4', textTertiary: '#5a7396',
  textQuaternary: '#3d566f', textOnAccent: '#050810',
  accent: '#00D4FF', accent2: '#4DE5FF', accent3: '#A855F7',
  accentSoft: 'rgba(0, 212, 255, 0.18)', accentSoft2: 'rgba(168, 85, 247, 0.16)',
  hover: 'rgba(0, 212, 255, 0.06)', hoverStrong: 'rgba(0, 212, 255, 0.12)',
  stateDisconnected: '#3d566f', stateConnecting: '#FFB020', stateConnected: '#00E5A0',
  danger: '#FF453A', warning: '#FFB020', success: '#00E5A0', info: '#00D4FF',
  bgImage: '', bgOverlayAlpha: '0.85', bgGlassAlpha: '1.0',
  radiusXs: '4px', radiusControl: '7px', radiusLarge: '10px', radiusDialog: '14px', radiusXl: '20px',
  shadowDialog: '0 24px 72px rgba(0, 0, 0, 0.7), 0 6px 18px rgba(0, 0, 0, 0.5)',
  shadowToast: '0 8px 28px rgba(0, 0, 0, 0.6), 0 2px 6px rgba(0, 0, 0, 0.4)',
  shadowMenu: '0 8px 28px rgba(0, 0, 0, 0.65), 0 2px 6px rgba(0, 0, 0, 0.4)',
  shadowGlow: '0 0 0 3px rgba(0, 212, 255, 0.32)',
  shadowGlowStrong: '0 0 0 4px rgba(0, 212, 255, 0.45), 0 0 32px rgba(0, 212, 255, 0.32)',
  selectedGradient: 'linear-gradient(135deg, #00D4FF 0%, #A855F7 100%)',
  selectedGradientSoft: 'linear-gradient(135deg, rgba(0,212,255,0.30) 0%, rgba(168,85,247,0.20) 100%)',
  termBg: '#0a0e1a', termFg: '#a9b1d6', termAccent: '#00D4FF',
  termAccentSoft: 'rgba(0, 212, 255, 0.14)', termAccentGlow: 'rgba(0, 212, 255, 0.35)',
  termAccent2: '#A855F7', termStateOk: '#00E5A0', termStateOkSoft: 'rgba(0, 229, 160, 0.14)',
  termTitlebarBgA: 'rgba(14, 20, 38, 0.94)', termTitlebarBgB: 'rgba(10, 14, 26, 0.94)',
  termTitlebarBorder: 'rgba(122, 162, 247, 0.18)', termTitlebarText: '#c0caf5', termTitlebarTextDim: '#565f89',
  termTabInactive: '#565f89', termTabHoverBg: 'rgba(122, 162, 247, 0.08)', termTabHoverText: '#a9b1d6',
  termTabActiveBg: 'rgba(122, 162, 247, 0.14)', termTabActiveText: '#c0caf5',
  termTabActiveBorder: 'rgba(122, 162, 247, 0.28)', termTabActiveInsert: 'rgba(122, 162, 247, 0.4)',
  termBtn: '#565f89', termBtnHoverBg: 'rgba(122, 162, 247, 0.12)', termBtnHoverText: '#7aa2f7',
  termBtnHoverBorder: 'rgba(122, 162, 247, 0.25)', termBtnDisabled: '#3b3f54',
  termScrollbar: 'rgba(122, 162, 247, 0.22)', termScrollbarHover: 'rgba(122, 162, 247, 0.38)', termScrollbarGlow: 'rgba(122, 162, 247, 0.3)',
  xtermBg: '#0a0e1a', xtermFg: '#a9b1d6', xtermCursor: '#c0caf5', xtermCursorAccent: '#0a0e1a',
  xtermSelection: 'rgba(122, 162, 247, 0.3)',
  xtermBlack: '#32344a', xtermRed: '#f7768e', xtermGreen: '#9ece6a', xtermYellow: '#e0af68',
  xtermBlue: '#7aa2f7', xtermMagenta: '#bb9af7', xtermCyan: '#7dcfff', xtermWhite: '#c0caf5',
  xtermBrightBlack: '#565f89', xtermBrightRed: '#f7768e', xtermBrightGreen: '#9ece6a', xtermBrightYellow: '#e0af68',
  xtermBrightBlue: '#7aa2f7', xtermBrightMagenta: '#bb9af7', xtermBrightCyan: '#7dcfff', xtermBrightWhite: '#acb0d0',
};

const PRESET_DARK: ThemePalette = {
  ...PRESET_TECH_DARK,
  bgApp: '#000000', bgSidebar: 'rgba(30, 30, 32, 0.8)', bgSidebarSolid: '#1e1e20',
  bgContent: '#1e1e20', bgToolbar: 'rgba(38, 38, 42, 0.72)', bgToolbarSolid: '#26262a',
  bgStatusbar: 'rgba(28, 28, 30, 0.82)', bgInput: '#2c2c2e', bgTerminal: '#1a1b26',
  divider: 'rgba(255, 255, 255, 0.10)', dividerSoft: 'rgba(255, 255, 255, 0.05)',
  dividerStrong: 'rgba(255, 255, 255, 0.15)', borderGlow: 'rgba(10, 132, 255, 0.45)',
  textPrimary: '#f5f5f7', textSecondary: '#a1a1a6', textTertiary: '#6e6e73',
  textQuaternary: '#48484a', textOnAccent: '#ffffff',
  accent: '#0A84FF', accent2: '#64D2FF', accent3: '#5E5CE6',
  accentSoft: 'rgba(10, 132, 255, 0.22)', accentSoft2: 'rgba(100, 210, 255, 0.18)',
  hover: 'rgba(255, 255, 255, 0.06)', hoverStrong: 'rgba(255, 255, 255, 0.10)',
  stateDisconnected: '#48484a', stateConnecting: '#FF9F0A', stateConnected: '#30D158',
  danger: '#FF3B30', warning: '#FF9F0A', success: '#30D158', info: '#0A84FF',
  shadowDialog: '0 24px 72px rgba(0, 0, 0, 0.6), 0 6px 18px rgba(0, 0, 0, 0.4)',
  shadowToast: '0 8px 28px rgba(0, 0, 0, 0.5), 0 2px 6px rgba(0, 0, 0, 0.3)',
  shadowMenu: '0 8px 28px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.3)',
  shadowGlow: '0 0 0 3px rgba(10, 132, 255, 0.28)',
  shadowGlowStrong: '0 0 0 4px rgba(10, 132, 255, 0.4), 0 0 28px rgba(10, 132, 255, 0.28)',
  selectedGradient: 'linear-gradient(135deg, #0A84FF 0%, #64D2FF 100%)',
  selectedGradientSoft: 'linear-gradient(135deg, rgba(10,132,255,0.28) 0%, rgba(100,210,255,0.18) 100%)',
  termBg: '#1e1e20', termFg: '#e6e6e6',
  xtermBg: '#1e1e20', xtermFg: '#abb2bf', xtermCursor: '#528bff', xtermCursorAccent: '#1e1e20',
  xtermSelection: 'rgba(82, 139, 255, 0.25)',
  xtermBlack: '#2c323c', xtermRed: '#e06c75', xtermGreen: '#98c379', xtermYellow: '#e5c07b',
  xtermBlue: '#61afef', xtermMagenta: '#c678dd', xtermCyan: '#56b6c2', xtermWhite: '#abb2bf',
  xtermBrightBlack: '#5c6370', xtermBrightRed: '#e06c75', xtermBrightGreen: '#98c379', xtermBrightYellow: '#e5c07b',
  xtermBrightBlue: '#61afef', xtermBrightMagenta: '#c678dd', xtermBrightCyan: '#56b6c2', xtermBrightWhite: '#e5e9f0',
};

const PRESET_LIGHT: ThemePalette = {
  ...PRESET_DARK,
  bgApp: '#f5f5f7', bgSidebar: 'rgba(246, 246, 248, 0.85)', bgSidebarSolid: '#f6f6f8',
  bgContent: '#ffffff', bgToolbar: 'rgba(250, 250, 252, 0.72)', bgToolbarSolid: '#fafafc',
  bgStatusbar: 'rgba(241, 241, 243, 0.82)', bgInput: '#ffffff', bgTerminal: '#ffffff',
  divider: 'rgba(0, 0, 0, 0.08)', dividerSoft: 'rgba(0, 0, 0, 0.045)',
  dividerStrong: 'rgba(0, 0, 0, 0.12)', borderGlow: 'rgba(10, 132, 255, 0.35)',
  textPrimary: '#1d1d1f', textSecondary: '#6e6e73', textTertiary: '#98989d',
  textQuaternary: '#bcbcc1', textOnAccent: '#ffffff',
  accent: '#0A84FF', accent2: '#5AC8FA', accent3: '#5856D6',
  accentSoft: 'rgba(10, 132, 255, 0.12)', accentSoft2: 'rgba(90, 200, 250, 0.15)',
  hover: 'rgba(0, 0, 0, 0.04)', hoverStrong: 'rgba(0, 0, 0, 0.07)',
  stateDisconnected: '#c7c7cc', stateConnecting: '#FF9F0A', stateConnected: '#30D158',
  danger: '#FF3B30', warning: '#FF9F0A', success: '#30D158', info: '#0A84FF',
  shadowDialog: '0 24px 72px rgba(0, 0, 0, 0.22), 0 6px 18px rgba(0, 0, 0, 0.10)',
  shadowToast: '0 8px 28px rgba(0, 0, 0, 0.14), 0 2px 6px rgba(0, 0, 0, 0.08)',
  shadowMenu: '0 8px 28px rgba(0, 0, 0, 0.15), 0 2px 6px rgba(0, 0, 0, 0.08)',
  shadowGlow: '0 0 0 3px rgba(10, 132, 255, 0.18)',
  shadowGlowStrong: '0 0 0 4px rgba(10, 132, 255, 0.28), 0 0 24px rgba(10, 132, 255, 0.18)',
  selectedGradient: 'linear-gradient(135deg, #0A84FF 0%, #5AC8FA 100%)',
  selectedGradientSoft: 'linear-gradient(135deg, rgba(10,132,255,0.14) 0%, rgba(90,200,250,0.10) 100%)',
  /* 终端窗口框架（浅色 macOS 风格） */
  termBg: '#ffffff', termFg: '#3c3c3c',
  termTitlebarBgA: 'rgba(246, 246, 248, 0.92)', termTitlebarBgB: 'rgba(238, 238, 242, 0.92)',
  termTitlebarBorder: 'rgba(0, 0, 0, 0.10)', termTitlebarText: '#3c3c3c', termTitlebarTextDim: '#8e8e93',
  termTabInactive: '#8e8e93', termTabHoverBg: 'rgba(10, 132, 255, 0.06)', termTabHoverText: '#3c3c3c',
  termTabActiveBg: 'rgba(10, 132, 255, 0.10)', termTabActiveText: '#1d1d1f',
  termTabActiveBorder: 'rgba(10, 132, 255, 0.22)', termTabActiveInsert: 'rgba(10, 132, 255, 0.45)',
  termBtn: '#8e8e93', termBtnHoverBg: 'rgba(10, 132, 255, 0.08)', termBtnHoverText: '#0A84FF',
  termBtnHoverBorder: 'rgba(10, 132, 255, 0.22)', termBtnDisabled: '#c7c7cc',
  termScrollbar: 'rgba(0, 0, 0, 0.18)', termScrollbarHover: 'rgba(0, 0, 0, 0.32)', termScrollbarGlow: 'rgba(10, 132, 255, 0.10)',
  /* xterm 配色（Solarized Light 变种，与 finder.css :root 一致） */
  xtermBg: '#ffffff', xtermFg: '#586e75', xtermCursor: '#0A84FF', xtermCursorAccent: '#ffffff',
  xtermSelection: 'rgba(10, 132, 255, 0.22)',
  xtermBlack: '#073642', xtermRed: '#dc322f', xtermGreen: '#859900', xtermYellow: '#b58900',
  xtermBlue: '#268bd2', xtermMagenta: '#d33682', xtermCyan: '#2aa198', xtermWhite: '#eee8d5',
  xtermBrightBlack: '#002b36', xtermBrightRed: '#cb4b16', xtermBrightGreen: '#586e75',
  xtermBrightYellow: '#657b83', xtermBrightBlue: '#839496', xtermBrightMagenta: '#6c71c4',
  xtermBrightCyan: '#93a1a1', xtermBrightWhite: '#fdf6e3',
};

const PRESET_EYE_CARE_GREEN: ThemePalette = {
  ...PRESET_LIGHT,
  bgApp: '#C7EDCC', bgSidebar: 'rgba(214, 238, 219, 0.88)', bgSidebarSolid: '#D6EEDB',
  bgContent: '#EAF5EC', bgToolbar: 'rgba(230, 245, 233, 0.82)', bgToolbarSolid: '#E6F5E9',
  bgStatusbar: 'rgba(208, 236, 215, 0.88)', bgInput: '#F2F8F3', bgTerminal: '#BFE3C6',
  textPrimary: '#2C4A35', textSecondary: '#5A7363', textTertiary: '#7A9686',
  textQuaternary: '#9AB5A6', textOnAccent: '#ffffff',
  accent: '#2E8B57', accent2: '#3CB371', accent3: '#8B6C8C',
  accentSoft: 'rgba(46, 139, 87, 0.15)', accentSoft2: 'rgba(139, 108, 140, 0.14)',
  hover: 'rgba(46, 139, 87, 0.06)', hoverStrong: 'rgba(46, 139, 87, 0.10)',
  stateDisconnected: '#9AB5A6', stateConnecting: '#9A8B3D', stateConnected: '#2E8B57',
  danger: '#B2543C', warning: '#9A8B3D', success: '#2E8B57', info: '#4682B4',
  xtermBg: '#B0D7B7', xtermFg: '#2C4A35', xtermCursor: '#2E8B57', xtermCursorAccent: '#B0D7B7',
  xtermSelection: 'rgba(46, 139, 87, 0.22)',
  xtermBlack: '#375A42', xtermRed: '#B2543C', xtermGreen: '#2E8B57', xtermYellow: '#9A8B3D',
  xtermBlue: '#4682B4', xtermMagenta: '#8B6C8C', xtermCyan: '#3D8B8A', xtermWhite: '#6E8E78',
  xtermBrightBlack: '#51705C', xtermBrightRed: '#CC6A51', xtermBrightGreen: '#3CB371', xtermBrightYellow: '#B8A346',
  xtermBrightBlue: '#5A9AD0', xtermBrightMagenta: '#A482A7', xtermBrightCyan: '#55A7A6', xtermBrightWhite: '#4A6B57',
};

/** 预设主题的完整 Palette 数据，供自定义主题继承合并 */
export const PRESET_PALETTES: Record<PresetThemeId, ThemePalette> = {
  'tech-dark': PRESET_TECH_DARK,
  dark: PRESET_DARK,
  light: PRESET_LIGHT,
  'eye-care-green': PRESET_EYE_CARE_GREEN,
};

/* ============================================================
 * 六、转换 / 合并工具函数
 * ============================================================ */

/** ThemePalette 字段名 → CSS 变量名（camelCase → kebab-case） */
const PALETTE_KEY_TO_CSS: Record<keyof ThemePalette, string> = {
  bgApp: '--bg-app', bgSidebar: '--bg-sidebar', bgSidebarSolid: '--bg-sidebar-solid',
  bgContent: '--bg-content', bgToolbar: '--bg-toolbar', bgToolbarSolid: '--bg-toolbar-solid',
  bgStatusbar: '--bg-statusbar', bgInput: '--bg-input', bgTerminal: '--bg-terminal',
  divider: '--divider', dividerSoft: '--divider-soft', dividerStrong: '--divider-strong', borderGlow: '--border-glow',
  textPrimary: '--text-primary', textSecondary: '--text-secondary', textTertiary: '--text-tertiary',
  textQuaternary: '--text-quaternary', textOnAccent: '--text-on-accent',
  accent: '--accent', accent2: '--accent-2', accent3: '--accent-3', accentSoft: '--accent-soft', accentSoft2: '--accent-soft-2',
  hover: '--hover', hoverStrong: '--hover-strong',
  stateDisconnected: '--state-disconnected', stateConnecting: '--state-connecting', stateConnected: '--state-connected',
  danger: '--danger', warning: '--warning', success: '--success', info: '--info',
  bgImage: '--bg-image', bgOverlayAlpha: '--bg-overlay-alpha', bgGlassAlpha: '--bg-glass-alpha',
  radiusXs: '--radius-xs', radiusControl: '--radius-control', radiusLarge: '--radius-large',
  radiusDialog: '--radius-dialog', radiusXl: '--radius-xl',
  shadowDialog: '--shadow-dialog', shadowToast: '--shadow-toast', shadowMenu: '--shadow-menu',
  shadowGlow: '--shadow-glow', shadowGlowStrong: '--shadow-glow-strong',
  selectedGradient: '--selected-gradient', selectedGradientSoft: '--selected-gradient-soft',
  termBg: '--term-bg', termFg: '--term-fg', termAccent: '--term-accent', termAccentSoft: '--term-accent-soft',
  termAccentGlow: '--term-accent-glow', termAccent2: '--term-accent-2', termStateOk: '--term-state-ok', termStateOkSoft: '--term-state-ok-soft',
  termTitlebarBgA: '--term-titlebar-bg-a', termTitlebarBgB: '--term-titlebar-bg-b', termTitlebarBorder: '--term-titlebar-border',
  termTitlebarText: '--term-titlebar-text', termTitlebarTextDim: '--term-titlebar-text-dim',
  termTabInactive: '--term-tab-inactive', termTabHoverBg: '--term-tab-hover-bg', termTabHoverText: '--term-tab-hover-text',
  termTabActiveBg: '--term-tab-active-bg', termTabActiveText: '--term-tab-active-text',
  termTabActiveBorder: '--term-tab-active-border', termTabActiveInsert: '--term-tab-active-insert',
  termBtn: '--term-btn', termBtnHoverBg: '--term-btn-hover-bg', termBtnHoverText: '--term-btn-hover-text',
  termBtnHoverBorder: '--term-btn-hover-border', termBtnDisabled: '--term-btn-disabled',
  termScrollbar: '--term-scrollbar', termScrollbarHover: '--term-scrollbar-hover', termScrollbarGlow: '--term-scrollbar-glow',
  xtermBg: '--term-xterm-bg', xtermFg: '--term-xterm-fg', xtermCursor: '--term-xterm-cursor',
  xtermCursorAccent: '--term-xterm-cursor-accent', xtermSelection: '--term-xterm-selection',
  xtermBlack: '--term-xterm-black', xtermRed: '--term-xterm-red', xtermGreen: '--term-xterm-green', xtermYellow: '--term-xterm-yellow',
  xtermBlue: '--term-xterm-blue', xtermMagenta: '--term-xterm-magenta', xtermCyan: '--term-xterm-cyan', xtermWhite: '--term-xterm-white',
  xtermBrightBlack: '--term-xterm-bright-black', xtermBrightRed: '--term-xterm-bright-red',
  xtermBrightGreen: '--term-xterm-bright-green', xtermBrightYellow: '--term-xterm-bright-yellow',
  xtermBrightBlue: '--term-xterm-bright-blue', xtermBrightMagenta: '--term-xterm-bright-magenta',
  xtermBrightCyan: '--term-xterm-bright-cyan', xtermBrightWhite: '--term-xterm-bright-white',
};

/**
 * 合并：基础预设 palette + 自定义覆盖 → 完整 palette。
 * 自定义主题通过 extends 继承预设，overrides 覆盖差异字段。
 */
export function resolveCustomPalette(theme: CustomTheme): ThemePalette {
  const base = PRESET_PALETTES[theme.extends] ?? PRESET_PALETTES['tech-dark'];
  return { ...base, ...theme.overrides };
}

/** 生成一个新的自定义主题 ID */
export function generateCustomThemeId(): string {
  return `${CUSTOM_THEME_PREFIX}${Date.now()}`;
}

/**
 * 将 File 对象读取为 DataURL（Base64）字符串，用于存入 localStorage/ThemePalette。
 * 经验 495218：链路全程 DataURL，避免 raw base64 和 data:image/...;base64, 前缀脱节。
 */
export function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

/**
 * 压缩图片：缩放到 maxSize 以内，转为 JPEG DataURL。
 * 避免大图 base64 超出 localStorage 5MB 限额导致重启丢失。
 */
export function compressImage(dataUrl: string, maxSize = 1920, quality = 0.82): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxSize || height > maxSize) {
        const ratio = Math.min(maxSize / width, maxSize / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(dataUrl); return; }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl); // 压缩失败回退原图
    img.src = dataUrl;
  });
}

/** 需要乘 glassAlpha 的"背景类"字段：按钮/弹框/面板的底色都会变半透明，透出底图 */
const GLASSIFIED_KEYS: readonly (keyof ThemePalette)[] = [
  'bgApp',
  'bgSidebar', 'bgSidebarSolid',
  'bgContent',
  'bgToolbar', 'bgToolbarSolid',
  'bgStatusbar',
  'bgInput',
  'bgTerminal',
  'termBg',
  'termTitlebarBgA', 'termTitlebarBgB',
  'xtermBg',
];

/**
 * 把任意 CSS 颜色（#hex / #rrggbbaa / rgb() / rgba()）的 alpha 通道乘以 factor。
 * 解析失败或不支持的格式（color-mix、hsl 等）则原样返回，避免破坏效果。
 */
function multiplyAlpha(color: string, factor: number): string {
  if (factor >= 0.999 || !color) return color;
  const f = Math.max(0, Math.min(1, factor));

  // #RGB / #RGBA / #RRGGBB / #RRGGBBAA
  const hexMatch = color.match(/^#([0-9a-fA-F]{3,8})$/);
  if (hexMatch) {
    let hex = hexMatch[1];
    let r: number, g: number, b: number, a: number;
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
      a = 255;
    } else if (hex.length === 4) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
      a = parseInt(hex[3] + hex[3], 16);
    } else if (hex.length === 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
      a = 255;
    } else if (hex.length === 8) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
      a = parseInt(hex.slice(6, 8), 16);
    } else {
      return color;
    }
    const newA = Math.round(a * f);
    return `rgba(${r}, ${g}, ${b}, ${(newA / 255).toFixed(4).replace(/\.?0+$/, '')})`;
  }

  // rgb(r,g,b) / rgba(r,g,b,a) —— 同时兼容带空格/百分比
  const rgbMatch = color.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*([\d.]+))?\s*\)$/i,
  );
  if (rgbMatch) {
    const r = parseInt(rgbMatch[1], 10);
    const g = parseInt(rgbMatch[2], 10);
    const b = parseInt(rgbMatch[3], 10);
    const a = rgbMatch[4] != null ? parseFloat(rgbMatch[4]) : 1;
    const newA = Math.max(0, Math.min(1, a * f));
    return `rgba(${r}, ${g}, ${b}, ${newA.toFixed(4).replace(/\.?0+$/, '')})`;
  }

  return color;
}

/**
 * 把 palette 写成 CSS 变量样式文本。
 *
 * 背景图 + 玻璃化特殊逻辑：
 *   - bgImage 非空时：--bg-image 包一层 url("...")，供 html::before 的 background-image: var(--bg-image) 使用。
 *   - bgImage 非空 且 0 < bgGlassAlpha < 1 时：把 GLASSIFIED_KEYS 中列出的各"背景色"乘上 alpha 系数，
 *     所有使用这些变量的按钮/弹框/面板会自动透出底图，呈现玻璃拟态。
 *
 *   注意：调用方可能已将 bgImage 从 palette 中移除（改为内联 style 设置），
 *   此时通过 hasBgImage 参数显式传入"是否有背景图"以保持玻璃化判断正确。
 */
export function paletteToCssText(palette: Partial<ThemePalette>, hasBgImageFlag?: boolean): string {
  const lines: string[] = [];
  const hasBgImage = hasBgImageFlag ?? !!palette.bgImage;
  let glassFactor = 1;
  if (hasBgImage && palette.bgGlassAlpha != null) {
    const v = parseFloat(String(palette.bgGlassAlpha));
    if (!Number.isNaN(v)) glassFactor = v;
  }
  const doGlass = hasBgImage && glassFactor < 0.999;

  (Object.keys(palette) as (keyof ThemePalette)[]).forEach((key) => {
    const cssVar = PALETTE_KEY_TO_CSS[key];
    const value = palette[key];
    if (!cssVar || value == null) return;

    if (key === 'bgImage') {
      const v = String(value).trim();
      // --bg-image: 需要为 url("...") 格式；空串不写入（html[data-bg-image] 会隐藏背景层）
      if (v) lines.push(`  ${cssVar}: url("${v.replace(/"/g, '\\"')}");`);
      return;
    }
    if (key === 'bgGlassAlpha' || key === 'bgOverlayAlpha') {
      // 原样写（CSS 层读取这些数字做 color-mix / overlay 合成用）
      lines.push(`  ${cssVar}: ${value};`);
      return;
    }
    if (doGlass && GLASSIFIED_KEYS.includes(key)) {
      lines.push(`  ${cssVar}: ${multiplyAlpha(String(value), glassFactor)};`);
      return;
    }
    lines.push(`  ${cssVar}: ${value};`);
  });

  /* 用 :root[data-theme] 而非 :root，使 specificity (0,2,0) 与
   * finder.css 中预设主题 :root[data-theme="xxx"] 的 (0,2,0) 持平，
   * 再借助 adoptedStyleSheets 在级联中更靠后 → 注入值胜出，
   * 玻璃化 alpha 才能真正覆盖预设的实心背景色。 */
  return `:root[data-theme] {\n${lines.join('\n')}\n}`;
}
