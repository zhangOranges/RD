import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { X, ChevronDown, ChevronRight, RotateCcw, Eye, Check, Upload, Trash2, Image as ImageIcon } from 'lucide-react';
import { useThemeStore, PRESET_OPTIONS } from '../store/themeStore';
import {
  type ThemePalette,
  type PresetThemeId,
  PALETTE_GROUPS,
  PRESET_PALETTES,
  resolveCustomPalette,
  fileToDataURL,
  compressImage,
} from '../theme/palette';
import { logInfo } from '../utils/log';

interface ThemeEditorProps {
  /** 要编辑的自定义主题 ID */
  themeId: string;
  onClose: () => void;
}

/**
 * 自定义主题编辑器。
 *
 * - 按 PALETTE_GROUPS 分组渲染颜色编辑器（拾取器 + hex/rgba 输入框）
 * - 高级组（终端 UI 细节 / 分割线 / 阴影 / 圆角）默认折叠
 * - 颜色改动即时调用 updateCustomTheme 注入，所见即所得
 * - 右侧实时预览面板：按钮 / 文字 / 终端样例，反映当前 palette
 * - 顶部：主题名称 + 基础主题 + "恢复该字段"逐项重置
 */
export function ThemeEditor({ themeId, onClose }: ThemeEditorProps) {
  const customThemes = useThemeStore((s) => s.customThemes);
  const updateCustomTheme = useThemeStore((s) => s.updateCustomTheme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const theme = useThemeStore((s) => s.theme);

  const ct = customThemes.find((t) => t.id === themeId);

  // 编辑中的完整 palette（base + overrides 合并结果），用于回显
  const [palette, setPalette] = useState<ThemePalette>(() =>
    ct ? resolveCustomPalette(ct) : PRESET_PALETTES['tech-dark']
  );
  // 主题名称
  const [name, setName] = useState(ct?.name ?? '自定义主题');
  // 折叠状态：高级组默认折叠
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    PALETTE_GROUPS.forEach((g) => {
      init[g.id] = !!g.advanced;
    });
    return init;
  });

  // 当切换编辑的主题时，重新加载 palette + 自动应用主题（确保编辑即时生效）
  useEffect(() => {
    if (ct) {
      setPalette(resolveCustomPalette(ct));
      setName(ct.name);
      // 自动应用当前编辑的主题，使所有修改即时注入 CSS 并预览
      if (theme !== themeId) {
        setTheme(themeId);
      }
    }
  }, [themeId]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 修改单个字段：更新本地 palette + 写入 store（即时注入）。
   * 只把被改的字段作为 override 存入，未改的保持继承。
   */
  const handleChange = useCallback(
    (key: keyof ThemePalette, value: string) => {
      setPalette((prev) => ({ ...prev, [key]: value }));
      if (ct) {
        updateCustomTheme(ct.id, { [key]: value } as Partial<ThemePalette>);
        // bgImage 值是 DataURL（可能数 MB），只记录长度避免日志爆炸
        const logVal = key === 'bgImage' ? `<DataURL ${Math.round(value.length / 1024)}KB>` : value;
        logInfo(`[theme-editor] 更新字段 ${String(key)} = ${logVal}`);
        // 背景图/遮罩/面板透明度变化时，通知终端重读 CSS 变量更新 xterm canvas 主题
        // （xterm canvas 不会自动响应 CSS 变量变化，必须主动调用 term.options.theme 刷新）
        if (key === 'bgImage' || key === 'bgGlassAlpha' || key === 'bgOverlayAlpha' || key === 'xtermBg') {
          window.dispatchEvent(new CustomEvent('terminal-theme-update'));
        }
      }
    },
    [ct, updateCustomTheme]
  );

  /** 恢复单个字段到基础预设值 */
  const handleResetField = useCallback(
    (key: keyof ThemePalette) => {
      if (!ct) return;
      const baseValue = PRESET_PALETTES[ct.extends][key];
      setPalette((prev) => ({ ...prev, [key]: baseValue }));
      // 显式设置回基础值（而非删除 override），因为 updateCustomTheme 内部用
      // { ...t.overrides, ...overrides } 合并，删除 key 不会覆盖旧值
      updateCustomTheme(ct.id, { [key]: baseValue } as Partial<ThemePalette>);
    },
    [ct, updateCustomTheme]
  );

  /** 保存主题名称 */
  const handleSaveName = useCallback(() => {
    if (ct) updateCustomTheme(ct.id, {}, name);
  }, [ct, name, updateCustomTheme]);

  /** 立即应用此主题（预览整体效果） */
  const handleApply = useCallback(() => {
    if (themeId) setTheme(themeId);
  }, [themeId, setTheme]);

  const isApplied = theme === themeId;

  // 预览面板用的内联样式（直接取 palette 值，确保与实际渲染一致）
  const previewStyle = useMemo(
    () => ({
      background: palette.bgContent,
      color: palette.textPrimary,
      borderColor: palette.divider,
    }),
    [palette]
  );

  if (!ct) {
    return (
      <div className="theme-editor">
        <div className="theme-editor-header">
          <span className="theme-editor-title">主题编辑器</span>
          <button className="theme-editor-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="theme-editor-empty">主题不存在或已被删除</div>
      </div>
    );
  }

  return (
    <div className="theme-editor">
      {/* ---------- 头部 ---------- */}
      <div className="theme-editor-header">
        <span className="theme-editor-title">主题编辑器</span>
        <div className="theme-editor-actions">
          <button
            className={`theme-editor-apply ${isApplied ? 'is-active' : ''}`}
            onClick={handleApply}
            disabled={isApplied}
            title={isApplied ? '当前已应用' : '应用此主题'}
          >
            {isApplied ? <Check size={13} /> : <Eye size={13} />}
            <span>{isApplied ? '已应用' : '应用'}</span>
          </button>
          <button className="theme-editor-close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="theme-editor-body">
        {/* ---------- 左侧：编辑区 ---------- */}
        <div className="theme-editor-edit">
          {/* 元信息 */}
          <div className="te-meta">
            <label className="te-meta-row">
              <span className="te-meta-label">名称</span>
              <input
                className="te-name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onBlur={handleSaveName}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                placeholder="自定义主题名称"
              />
            </label>
            <div className="te-meta-row">
              <span className="te-meta-label">基于</span>
              <span className="te-base-name">
                {PRESET_OPTIONS.find((o) => o.id === ct.extends)?.name ?? ct.extends}
              </span>
            </div>
          </div>

          {/* 分组颜色编辑器 */}
          <div className="te-groups">
            {PALETTE_GROUPS.map((group) => {
              const isCollapsed = collapsed[group.id];
              return (
                <div key={group.id} className="te-group">
                  <button
                    className="te-group-header"
                    onClick={() => setCollapsed((p) => ({ ...p, [group.id]: !p[group.id] }))}
                  >
                    {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    <span className="te-group-title">{group.title}</span>
                    {group.desc && <span className="te-group-desc">{group.desc}</span>}
                  </button>
                  {!isCollapsed && (
                    <div className="te-group-fields">
                      {group.id === 'background-image' ? (
                        <BackgroundImageFields
                          palette={palette}
                          basePresetId={ct.extends}
                          isOverriddenImage={!!ct.overrides.bgImage}
                          isOverriddenOverlay={!!ct.overrides.bgOverlayAlpha}
                          isOverriddenGlass={!!ct.overrides.bgGlassAlpha}
                          onChange={(k, v) => handleChange(k, v)}
                          onReset={handleResetField}
                        />
                      ) : (
                        group.fields.map((field) => (
                          <ColorField
                            key={field.key}
                            label={field.label}
                            desc={field.desc}
                            value={palette[field.key]}
                            isOverridden={!!ct.overrides[field.key]}
                            onChange={(v) => handleChange(field.key, v)}
                            onReset={() => handleResetField(field.key)}
                          />
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ---------- 右侧：实时预览 ---------- */}
        <div className="theme-editor-preview" style={previewStyle}>
          <div className="te-preview-title">实时预览</div>

          {/* UI 控件预览 */}
          <div className="te-preview-section">
            <div className="te-preview-label">界面元素</div>
            <div className="te-preview-ui" style={{ background: palette.bgApp }}>
              <div className="te-preview-window" style={{ background: palette.bgContent, borderColor: palette.divider }}>
                <div className="te-preview-toolbar" style={{ background: palette.bgToolbar, borderBottomColor: palette.divider }}>
                  <span style={{ color: palette.textSecondary }}>工具栏</span>
                  <span
                    className="te-preview-btn"
                    style={{ background: palette.accent, color: palette.textOnAccent }}
                  >
                    主按钮
                  </span>
                </div>
                <div className="te-preview-content">
                  <div className="te-preview-row" style={{ background: palette.hover }}>
                    <span style={{ color: palette.accent }}>●</span>
                    <span style={{ color: palette.textPrimary }}>文件夹</span>
                    <span style={{ color: palette.textTertiary }}>2026/01/01</span>
                  </div>
                  <div className="te-preview-row te-preview-selected" style={{ background: palette.accentSoft, color: palette.accent }}>
                    <span>●</span>
                    <span>选中项</span>
                    <span style={{ color: palette.accent2 }}>详情</span>
                  </div>
                  <div className="te-preview-row" style={{ color: palette.textSecondary }}>
                    <span>●</span>
                    <span>普通项</span>
                  </div>
                </div>
                <div className="te-preview-statusbar" style={{ background: palette.bgStatusbar, borderTopColor: palette.divider }}>
                  <span style={{ color: palette.stateConnected }}>● 已连接</span>
                  <span style={{ color: palette.textTertiary }}>CPU 12%</span>
                </div>
              </div>
            </div>
          </div>

          {/* 终端预览 */}
          <div className="te-preview-section">
            <div className="te-preview-label">终端</div>
            <div
              className="te-preview-terminal"
              style={{
                background: palette.xtermBg,
                color: palette.xtermFg,
                borderColor: palette.termTitlebarBorder,
              }}
            >
              <div className="te-preview-term-titlebar" style={{ background: palette.termTitlebarBgA, borderBottomColor: palette.termTitlebarBorder }}>
                <span style={{ color: palette.termTabActiveText }}>● 标签1</span>
                <span style={{ color: palette.termTabInactive }}>标签2</span>
              </div>
              <div className="te-preview-term-body">
                <div>
                  <span style={{ color: palette.xtermGreen }}>user@host</span>
                  <span style={{ color: palette.xtermFg }}>:</span>
                  <span style={{ color: palette.xtermBlue }}>~/project</span>
                  <span style={{ color: palette.xtermFg }}>$ </span>
                  <span style={{ color: palette.xtermYellow }}>ls -la</span>
                </div>
                <div>
                  <span style={{ color: palette.xtermCyan }}>drwxr-xr-x</span>{' '}
                  <span style={{ color: palette.xtermBlue }}>src</span>
                </div>
                <div>
                  <span style={{ color: palette.xtermRed }}>-rw-r--r--</span>{' '}
                  <span style={{ color: palette.xtermFg }}>README.md</span>
                </div>
                <div>
                  <span style={{ color: palette.xtermGreen }}>user@host</span>
                  <span style={{ color: palette.xtermFg }}>:</span>
                  <span style={{ color: palette.xtermBlue }}>~/project</span>
                  <span style={{ color: palette.xtermFg }}>$ </span>
                  <span style={{ color: palette.xtermCursor }}>▋</span>
                </div>
              </div>
            </div>
          </div>

          {/* ANSI 色板 */}
          <div className="te-preview-section">
            <div className="te-preview-label">ANSI 16 色</div>
            <div className="te-preview-ansi">
              {([
                ['xtermBlack', '黑'], ['xtermRed', '红'], ['xtermGreen', '绿'], ['xtermYellow', '黄'],
                ['xtermBlue', '蓝'], ['xtermMagenta', '品红'], ['xtermCyan', '青'], ['xtermWhite', '白'],
                ['xtermBrightBlack', '亮黑'], ['xtermBrightRed', '亮红'], ['xtermBrightGreen', '亮绿'], ['xtermBrightYellow', '亮黄'],
                ['xtermBrightBlue', '亮蓝'], ['xtermBrightMagenta', '亮品红'], ['xtermBrightCyan', '亮青'], ['xtermBrightWhite', '亮白'],
              ] as [keyof ThemePalette, string][]).map(([key, label]) => (
                <div key={key} className="te-ansi-item" title={label}>
                  <span className="te-ansi-swatch" style={{ background: palette[key] as string }} />
                  <span className="te-ansi-label" style={{ color: palette.textTertiary }}>{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
 * 子组件：单个颜色字段编辑器
 * ============================================================ */

interface ColorFieldProps {
  label: string;
  desc?: string;
  value: string;
  isOverridden: boolean; // 是否已被自定义覆盖（决定是否显示重置按钮）
  onChange: (v: string) => void;
  onReset: () => void;
}

function ColorField({ label, desc, value, isOverridden, onChange, onReset }: ColorFieldProps) {
  // 判断是否为纯 hex 颜色（input[type=color] 只支持 #rrggbb）
  const isHex = /^#[0-9a-fA-F]{6}$/.test(value);
  // 用于 color picker 的值（非 hex 时取一个近似值，picker 仅辅助）
  const pickerValue = isHex ? value : '#000000';

  return (
    <div className={`te-field ${isOverridden ? 'is-overridden' : ''}`}>
      <div className="te-field-main">
        <label className="te-field-label" title={desc}>
          {label}
          {isOverridden && <span className="te-field-dot" title="已自定义，点击右侧恢复" />}
        </label>
        <div className="te-field-inputs">
          <input
            type="color"
            className="te-color-picker"
            value={pickerValue}
            onChange={(e) => onChange(e.target.value)}
            disabled={!isHex}
            title={isHex ? '点击拾色' : '当前为 rgba 等格式，请直接输入'}
          />
          <input
            type="text"
            className="te-hex-input"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            spellCheck={false}
          />
          {isOverridden && (
            <button className="te-field-reset" onClick={onReset} title="恢复到基础主题值">
              <RotateCcw size={12} />
            </button>
          )}
        </div>
      </div>
      {desc && <div className="te-field-desc">{desc}</div>}
    </div>
  );
}

/* ==========================================================================
 * 背景图片字段组：图片上传 + 遮罩透明度滑块 + 面板透明度滑块
 * ========================================================================== */

interface BackgroundImageFieldsProps {
  palette: ThemePalette;
  /** 该自定义主题继承的预设 ID，用于按深浅给出合理的"首次联动默认值" */
  basePresetId: PresetThemeId;
  isOverriddenImage: boolean;
  isOverriddenOverlay: boolean;
  isOverriddenGlass: boolean;
  onChange: (key: keyof ThemePalette, value: string) => void;
  onReset: (key: keyof ThemePalette) => void;
}

/**
 * 根据预设主题判断深浅，返回"首次上传背景图"时的推荐遮罩/面板默认值。
 * 原预设默认 bgOverlayAlpha=0.85 + bgGlassAlpha=1.0 对"想看到底图"的诉求太保守，
 * 尤其 tech-dark/dark 两个深色主题 0.85 的纯黑遮罩会把暖色图完全盖没。
 * 这里根据主题亮度一次性把两个滑块调到"既能看见图，文字又不太糊"的档位：
 *   tech-dark（黑夜科技专属）：遮罩 0.38、面板 0.60
 *     —— bgApp=#050810 极深，遮罩层改为深暖灰 overlay + 极弱染色，0.38 足够保证对比又留暖色
 *   dark（标准暗）：遮罩 0.45、面板 0.68（常规深色档位）
 *   浅色（light/护眼绿）：遮罩 0.50、面板 0.72（浅色背景配合浅灰 overlay，整体更透）
 */
function recommendedBgDefaultsForPreset(preset: PresetThemeId): { overlay: string; glass: string } {
  switch (preset) {
    case 'tech-dark':
      return { overlay: '0.38', glass: '0.60' };
    case 'dark':
      return { overlay: '0.45', glass: '0.68' };
    case 'light':
    case 'eye-care-green':
    default:
      return { overlay: '0.50', glass: '0.72' };
  }
}

function BackgroundImageFields({
  palette,
  basePresetId,
  isOverriddenImage,
  isOverriddenOverlay,
  isOverriddenGlass,
  onChange,
  onReset,
}: BackgroundImageFieldsProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handlePickFile = () => fileInputRef.current?.click();

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    if (!f.type.startsWith('image/')) {
      logInfo(`[theme-editor] 非图片文件，跳过: ${f.type}`);
      return;
    }
    try {
      // 经验 495218：FileReader → DataURL 全链路 base64，展示时直接当 URL 用
      const rawDataUrl = await fileToDataURL(f);
      // 压缩图片：缩放到 1920px 以内 + JPEG 0.82，避免 base64 超出 localStorage 5MB 限额
      const dataUrl = await compressImage(rawDataUrl);
      onChange('bgImage', dataUrl);
      logInfo(`[theme-editor] 已设置背景图：原始 ${Math.round(rawDataUrl.length / 1024)}KB → 压缩后 ${Math.round(dataUrl.length / 1024)}KB`);

      // 首次配背景图时，按预设主题深浅给推荐的遮罩/面板联动默认值
      // （用户手动改过的字段不覆盖）
      const defaults = recommendedBgDefaultsForPreset(basePresetId);
      const currentGlass = parseFloat(palette.bgGlassAlpha ?? '1');
      if (!isNaN(currentGlass) && currentGlass >= 0.99 && !isOverriddenGlass) {
        onChange('bgGlassAlpha', defaults.glass);
        logInfo(`[theme-editor] 首次设置背景图，联动面板透明度 → ${defaults.glass}（基础主题 ${basePresetId}）`);
      }
      const currentOverlay = parseFloat(palette.bgOverlayAlpha ?? '1');
      if (!isNaN(currentOverlay) && currentOverlay >= 0.84 && !isOverriddenOverlay) {
        onChange('bgOverlayAlpha', defaults.overlay);
        logInfo(`[theme-editor] 首次设置背景图，联动遮罩透明度 → ${defaults.overlay}（基础主题 ${basePresetId}）`);
      }
    } catch (err) {
      logInfo(`[theme-editor] 读取图片失败：${String(err)}`);
    } finally {
      // 重置 input，让选择同一张文件也能再次触发 change
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleClearImage = () => onChange('bgImage', '');

  /** 拖拽预览图调整背景图位置 */
  const handlePreviewMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startPosX = parseFloat(palette.bgPositionX || '50');
    const startPosY = parseFloat(palette.bgPositionY || '50');

    const handleMove = (ev: MouseEvent) => {
      // 鼠标位移转换为百分比（预览框宽高比例换算）
      const dx = ((ev.clientX - startX) / rect.width) * 100;
      const dy = ((ev.clientY - startY) / rect.height) * 100;
      const newPosX = Math.max(0, Math.min(100, startPosX - dx));
      const newPosY = Math.max(0, Math.min(100, startPosY - dy));
      onChange('bgPositionX', String(Math.round(newPosX)));
      onChange('bgPositionY', String(Math.round(newPosY)));
    };
    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  };

  /** 重置背景图位置到居中 */
  const handleResetPosition = () => {
    onChange('bgPositionX', '50');
    onChange('bgPositionY', '50');
  };

  const overlayValue = parseFloat(palette.bgOverlayAlpha || '0.85');
  const glassValue = parseFloat(palette.bgGlassAlpha || '1.0');

  return (
    <div className="te-bg-image-group">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleFile}
      />

      {/* 背景图上传 + 拖拽定位预览 */}
      <div className={`te-field ${isOverriddenImage ? 'is-overridden' : ''}`}>
        <div className="te-field-label">
          <ImageIcon size={13} />
          <span>背景图片</span>
          {isOverriddenImage && (
            <button
              className="te-field-reset"
              onClick={() => onReset('bgImage')}
              title="恢复到基础主题值（清除背景图）"
              type="button"
            >
              <RotateCcw size={12} />
            </button>
          )}
        </div>
        <div className="te-field-main">
          <div className="te-bg-image-row">
            {palette.bgImage ? (
              <div
                className="te-bg-preview"
                title="拖拽以调整背景图显示位置"
                onMouseDown={handlePreviewMouseDown}
              >
                <div
                  className="te-bg-preview-img"
                  style={{
                    backgroundImage: `url("${palette.bgImage}")`,
                    backgroundPosition: `${palette.bgPositionX || '50'}% ${palette.bgPositionY || '50'}%`,
                  }}
                />
                <div className="te-bg-preview-hint">拖拽调整位置</div>
              </div>
            ) : (
              <div className="te-bg-image-empty">
                <ImageIcon size={18} />
                <span>未设置</span>
              </div>
            )}
            <div className="te-bg-image-actions">
              <button type="button" className="te-btn-primary" onClick={handlePickFile}>
                <Upload size={13} />
                <span>上传图片</span>
              </button>
              {palette.bgImage && (
                <>
                  <button
                    type="button"
                    className="te-btn-ghost"
                    onClick={handleResetPosition}
                    title="重置位置到居中"
                  >
                    <RotateCcw size={13} />
                    <span>重置位置</span>
                  </button>
                  <button
                    type="button"
                    className="te-btn-danger"
                    onClick={handleClearImage}
                    title="清除背景图"
                  >
                    <Trash2 size={13} />
                    <span>清除</span>
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
        <div className="te-field-desc">
          上传一张图片作为应用背景（会以内联 Base64 形式保存在配置中，单张建议 2MB 以内）。拖拽预览图可调整显示位置。
        </div>
      </div>

      {/* 遮罩透明度 */}
      <SliderField
        label="遮罩透明度"
        desc="值越大遮罩越不透明 → 背景图越不明显；减小可让原图更清晰。推荐 0.70 ~ 0.95。"
        min={0}
        max={1}
        step={0.05}
        value={isNaN(overlayValue) ? 0.85 : overlayValue}
        format={(v) => `${Math.round(v * 100)}%`}
        isOverridden={isOverriddenOverlay}
        onChange={(v) => onChange('bgOverlayAlpha', String(v))}
        onReset={() => onReset('bgOverlayAlpha')}
      />

      {/* 面板透明度（玻璃拟态强度） */}
      <SliderField
        label="面板透明度"
        desc="值越大面板越不透明、文字越清楚；减小会让侧边栏/按钮/弹框透出底图。推荐 0.6 ~ 0.9。"
        min={0.15}
        max={1}
        step={0.05}
        value={isNaN(glassValue) ? 1 : glassValue}
        format={(v) => `${Math.round(v * 100)}%`}
        isOverridden={isOverriddenGlass}
        onChange={(v) => onChange('bgGlassAlpha', String(v))}
        onReset={() => onReset('bgGlassAlpha')}
      />
    </div>
  );
}

interface SliderFieldProps {
  label: string;
  desc?: string;
  min: number;
  max: number;
  step: number;
  value: number;
  format?: (v: number) => string;
  isOverridden: boolean;
  onChange: (v: number) => void;
  onReset: () => void;
}

function SliderField({
  label,
  desc,
  min,
  max,
  step,
  value,
  format,
  isOverridden,
  onChange,
  onReset,
}: SliderFieldProps) {
  return (
    <div className={`te-field te-slider-field ${isOverridden ? 'is-overridden' : ''}`}>
      <div className="te-field-label">
        <span>{label}</span>
        {isOverridden && (
          <button className="te-field-reset" onClick={onReset} title="恢复到基础主题值" type="button">
            <RotateCcw size={12} />
          </button>
        )}
      </div>
      <div className="te-field-main">
        <div className="te-slider-row">
          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
            className="te-slider"
          />
          <span className="te-slider-value">{format ? format(value) : value.toFixed(2)}</span>
        </div>
      </div>
      {desc && <div className="te-field-desc">{desc}</div>}
    </div>
  );
}
