import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { X, Check, Palette, Sliders, DownloadCloud, RefreshCw, Gauge, Plus, Trash2, FolderOpen, Eraser, Bug, Keyboard, RotateCcw } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
import { useToastStore } from './Toast';
import { useThemeStore, THEME_OPTIONS } from '../store/themeStore';
import { useShortcutStore, SHORTCUTS, eventToShortcut } from '../store/shortcutStore';
import { useTerminalStore } from '../store/terminalStore';
import { useVirtualizer } from '@tanstack/react-virtual';
import { logInfo, logWarn } from '../utils/log';
import {
  useAppUpdater,
  getMirrorOptions,
  getUpdateMirror,
  setUpdateMirror,
  addCustomMirror,
  removeCustomMirror,
  probeMirrorLatency,
  type UpdateMirror,
  type MirrorDelayResult,
  type MirrorOption,
} from '../hooks/useAppUpdater';

type SettingsTab = 'general' | 'theme' | 'update' | 'shortcuts' | 'debug';

interface TabItem {
  id: SettingsTab;
  label: string;
  icon: typeof Palette;
}

const TABS: TabItem[] = [
  { id: 'general', label: '通用', icon: Sliders },
  { id: 'theme', label: '主题', icon: Palette },
  { id: 'update', label: '更新', icon: DownloadCloud },
  { id: 'shortcuts', label: '快捷键', icon: Keyboard },
  { id: 'debug', label: '调试', icon: Bug },
];

/**
 * 设置弹窗（Finder 风格模态）。
 *
 * 左侧分类菜单 + 右侧内容切换布局。
 * 当前包含：
 * - 通用：目录记忆全局开关（remember_dir_global）
 * - 主题：多主题选择
 * - 更新：下载源 / 镜像选择
 *
 * 弹窗可见性由 uiStore.settingsVisible 控制；
 * 通过 Ctrl+,（Windows）/ Cmd+,（macOS）快捷键打开（监听在 App.tsx）。
 */

/** 终端外观设置分组（字体 / 字号 / 行高 / 字间距） */
/** 字体列表项高度（与 CSS 中 .terminal-font-item 的 padding + line-height 对应） */
const FONT_ITEM_HEIGHT = 28;

function TerminalSettingsGroup() {
  const settings = useTerminalStore((s) => s.settings);
  const setSettings = useTerminalStore((s) => s.setSettings);
  const pushToast = useToastStore.getState().push;

  // 系统字体列表
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [fontsLoaded, setFontsLoaded] = useState(false);
  const [fontSearch, setFontSearch] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showCustomInput, setShowCustomInput] = useState(false);
  const [hoverFont, setHoverFont] = useState<string | null>(null);
  const [keyboardIndex, setKeyboardIndex] = useState<number>(-1);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 获取系统字体
  useEffect(() => {
    let cancelled = false;
    async function loadFonts() {
      try {
        const fonts = await invoke<string[]>('get_system_fonts');
        if (!cancelled) {
          setSystemFonts(fonts);
          setFontsLoaded(true);
          logInfo(`[terminal-settings] 获取系统字体: ${fonts.length} 个`);
        }
      } catch (e) {
        if (!cancelled) {
          logWarn(`[terminal-settings] 获取系统字体失败: ${e}`);
          setFontsLoaded(true);
        }
      }
    }
    loadFonts();
    return () => {
      cancelled = true;
    };
  }, []);

  // 点击外部关闭下拉
  useEffect(() => {
    if (!dropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
        setShowCustomInput(false);
        setHoverFont(null);
        setKeyboardIndex(-1);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [dropdownOpen]);

  // 当前字体（fontFamily fallback 链中的第一个名字）
  const primaryFont = settings.fontFamily.split(',')[0]?.replace(/^"|"$/g, '').trim() ?? '';

  // 从 fontFamily fallback 链中找到系统已安装的第一个字体名
  // 如果 primaryFont 不在系统列表中，会按链依次查找
  const currentFont = useMemo(() => {
    if (!fontsLoaded || systemFonts.length === 0) return primaryFont;
    const fontsLower = new Set(systemFonts.map((f) => f.toLowerCase()));
    const candidates = settings.fontFamily
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, '').trim())
      .filter(Boolean);
    for (const name of candidates) {
      if (fontsLower.has(name.toLowerCase())) return name;
    }
    return primaryFont;
  }, [primaryFont, fontsLoaded, systemFonts, settings.fontFamily]);

  // 预览字体：hover 时临时使用 hover 字体，否则用当前设置
  const previewFontFamily = hoverFont
    ? `"${hoverFont}", Menlo, Monaco, Consolas, "Courier New", monospace`
    : settings.fontFamily;

  // 过滤后的字体列表
  const filteredFonts = useMemo(
    () =>
      fontSearch
        ? systemFonts.filter((f) => f.toLowerCase().includes(fontSearch.toLowerCase()))
        : systemFonts,
    [systemFonts, fontSearch],
  );

  // 虚拟滚动
  const virtualizer = useVirtualizer({
    count: filteredFonts.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => FONT_ITEM_HEIGHT,
    overscan: 8,
  });

  // 展开下拉时自动定位到当前字体
  useEffect(() => {
    if (!dropdownOpen || !fontsLoaded) return;
    const idx = filteredFonts.findIndex(
      (f) => f.toLowerCase() === currentFont.toLowerCase(),
    );
    if (idx >= 0) {
      setKeyboardIndex(idx);
      requestAnimationFrame(() => virtualizer.scrollToIndex(idx, { align: 'center' }));
    } else {
      setKeyboardIndex(0);
    }
  }, [dropdownOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // 搜索变化时重置键盘索引
  useEffect(() => {
    if (dropdownOpen) setKeyboardIndex(filteredFonts.length > 0 ? 0 : -1);
  }, [fontSearch]); // eslint-disable-line react-hooks/exhaustive-deps

  // 键盘导航
  const handleListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setKeyboardIndex((prev) => {
          const next = Math.min(prev + 1, filteredFonts.length - 1);
          virtualizer.scrollToIndex(next, { align: 'auto' });
          setHoverFont(filteredFonts[next] ?? null);
          return next;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setKeyboardIndex((prev) => {
          const next = Math.max(prev - 1, 0);
          virtualizer.scrollToIndex(next, { align: 'auto' });
          setHoverFont(filteredFonts[next] ?? null);
          return next;
        });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (keyboardIndex >= 0 && keyboardIndex < filteredFonts.length) {
          applySystemFont(filteredFonts[keyboardIndex]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setDropdownOpen(false);
        setHoverFont(null);
        setKeyboardIndex(-1);
      }
    },
    [filteredFonts, keyboardIndex, virtualizer],
  );

  // 选择系统字体
  function applySystemFont(fontName: string) {
    const name = fontName.trim();
    const quoted = /[\s"'"]/.test(name) ? `"${name}"` : name;
    setSettings({
      fontFamily: `${quoted}, Menlo, Monaco, Consolas, "Courier New", monospace`,
    });
    setHoverFont(null);
    setKeyboardIndex(-1);
    setDropdownOpen(false);
    setShowCustomInput(false);
    setFontSearch('');
  }

  // 应用自定义字体名
  function applyCustomFont() {
    if (!fontSearch.trim()) {
      pushToast('error', '字体名不能为空');
      return;
    }
    const name = fontSearch.trim();
    const quoted = /[\s"'"]/.test(name) ? `"${name}"` : name;
    setSettings({
      fontFamily: `${quoted}, Menlo, Monaco, Consolas, "Courier New", monospace`,
    });
    setShowCustomInput(false);
    setFontSearch('');
  }

  return (
    <>
      <div className="settings-section-divider">
        <span>终端外观</span>
      </div>

      {/* 字体预览区：放在字体选择上方，方便对比 */}
      <div className="settings-row">
        <div className="settings-row-main">
          <div className="settings-row-label">字体预览</div>
          <div className="settings-row-desc">
            预览当前字体的显示效果
          </div>
        </div>
        <div className="terminal-font-preview" style={{ fontFamily: previewFontFamily }}>
          <div className="preview-line">
            ABCDEFGHIJKLMNOPQRSTUVWXYZ
          </div>
          <div className="preview-line">
            abcdefghijklmnopqrstuvwxyz
          </div>
          <div className="preview-line">
            0123456789
          </div>
          <div className="preview-line">
            !@#$%^&*()-_=+[]{}|;:'",&lt;&gt;./?`~
          </div>

        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-main">
          <div className="settings-row-label">字体</div>
          <div className="settings-row-desc">选择系统中已安装的字体。</div>
        </div>
        <div className="terminal-font-group" ref={dropdownRef}>
          {/* 收起状态：显示当前字体，点击展开 */}
          <button
            type="button"
            className="form-input form-input-compact terminal-font-trigger"
            onClick={() => setDropdownOpen(!dropdownOpen)}
          >
            <span className="terminal-font-trigger-name">{currentFont || '点击选择字体'}</span>
            <span className={`terminal-font-trigger-arrow ${dropdownOpen ? 'open' : ''}`}>▾</span>
          </button>

          {/* 展开状态：搜索 + 虚拟滚动列表 */}
          {dropdownOpen && (
            <div className="terminal-font-dropdown" onKeyDown={handleListKeyDown}>
              {!showCustomInput ? (
                <>
                  <input
                    type="text"
                    className="form-input form-input-compact terminal-font-search"
                    placeholder="搜索字体... (↑↓ 选择, Enter 确认)"
                    value={fontSearch}
                    onChange={(e) => setFontSearch(e.target.value)}
                    autoFocus
                  />
                  {!fontsLoaded ? (
                    <div className="terminal-font-loading">加载系统字体中...</div>
                  ) : filteredFonts.length === 0 ? (
                    <div className="terminal-font-empty">
                      {fontSearch ? '未找到匹配的字体' : '系统中未检测到字体'}
                      <button
                        className="terminal-font-custom-btn"
                        onClick={() => setShowCustomInput(true)}
                      >
                        手动输入
                      </button>
                    </div>
                  ) : (
                    <div className="terminal-font-list" ref={listRef}>
                      <div
                        style={{
                          height: virtualizer.getTotalSize(),
                          width: '100%',
                          position: 'relative',
                        }}
                      >
                        {virtualizer.getVirtualItems().map((vItem) => {
                          const fontName = filteredFonts[vItem.index];
                          const isActive =
                            fontName.toLowerCase() === currentFont.toLowerCase();
                          const isKbd = vItem.index === keyboardIndex;
                          return (
                            <button
                              key={fontName}
                              className={`terminal-font-item ${isActive ? 'active' : ''} ${isKbd ? 'keyboard-active' : ''}`}
                              style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: `${vItem.size}px`,
                                transform: `translateY(${vItem.start}px)`,
                              }}
                              onMouseEnter={() => {
                                setHoverFont(fontName);
                                setKeyboardIndex(vItem.index);
                              }}
                              onMouseLeave={() => setHoverFont(null)}
                              onClick={() => applySystemFont(fontName)}
                            >
                              <span
                                className="terminal-font-item-name"
                                style={{ fontFamily: `"${fontName}", monospace` }}
                              >
                                {fontName}
                              </span>
                              {isActive && <Check size={12} className="terminal-font-item-check" />}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  <div className="terminal-font-footer">
                    <button
                      className="terminal-font-custom-btn"
                      onClick={() => setShowCustomInput(true)}
                    >
                      手动输入字体名...
                    </button>
                  </div>
                </>
              ) : (
                <div className="terminal-custom-font-row">
                  <input
                    type="text"
                    className="form-input form-input-compact terminal-custom-font-input"
                    placeholder="输入字体名"
                    value={fontSearch}
                    onChange={(e) => setFontSearch(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') applyCustomFont();
                      if (e.key === 'Escape') setShowCustomInput(false);
                    }}
                    autoFocus
                  />
                  <div className="terminal-custom-font-buttons">
                    <button
                      type="button"
                      className="btn btn-accent btn-compact"
                      onClick={applyCustomFont}
                    >
                      应用
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-compact"
                      onClick={() => setShowCustomInput(false)}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-main">
          <div className="settings-row-label">字号</div>
          <div className="settings-row-desc">终端文字大小，单位 px。</div>
        </div>
        <div className="settings-number-control">
          <input
            type="number"
            className="form-input form-input-compact settings-number-input"
            min={8}
            max={32}
            step={1}
            value={settings.fontSize}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v)) return;
              setSettings({ fontSize: Math.max(8, Math.min(32, v)) });
            }}
          />
          <span className="settings-number-suffix">px</span>
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => setSettings({ fontSize: 14 })}
          >
            重置
          </button>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-main">
          <div className="settings-row-label">行高</div>
          <div className="settings-row-desc">每行之间的垂直间距倍数，影响整体可读性。</div>
        </div>
        <div className="settings-number-control">
          <input
            type="number"
            className="form-input form-input-compact settings-number-input"
            min={1}
            max={2}
            step={0.05}
            value={settings.lineHeight}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v)) return;
              setSettings({ lineHeight: Math.max(1, Math.min(2, v)) });
            }}
          />
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => setSettings({ lineHeight: 1.2 })}
          >
            重置
          </button>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-main">
          <div className="settings-row-label">字间距</div>
          <div className="settings-row-desc">字符之间的水平间距，单位 px。</div>
        </div>
        <div className="settings-number-control">
          <input
            type="number"
            className="form-input form-input-compact settings-number-input"
            min={0}
            max={3}
            step={0.1}
            value={settings.letterSpacing}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (!Number.isFinite(v)) return;
              setSettings({ letterSpacing: Math.max(0, Math.min(3, v)) });
            }}
          />
          <span className="settings-number-suffix">px</span>
          <button
            type="button"
            className="btn btn-ghost btn-compact"
            onClick={() => setSettings({ letterSpacing: 0.3 })}
          >
            重置
          </button>
        </div>
      </div>

      <div className="settings-row settings-row-no-bottom">
        <div className="settings-row-main">
          <div className="settings-row-label">全部重置</div>
          <div className="settings-row-desc">将终端外观恢复为默认值。</div>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-compact"
          onClick={() => {
            setSettings({
              fontFamily: '"JetBrainsMono Nerd Font", "JetBrains Mono", Menlo, Monaco, Consolas, "Courier New", monospace',
              fontSize: 14,
              lineHeight: 1.2,
              letterSpacing: 0.3,
            });
            setFontSearch('');
            setShowCustomInput(false);
            pushToast('success', '终端外观已重置为默认值');
          }}
        >
          <RotateCcw size={13} />
          <span>重置终端</span>
        </button>
      </div>
    </>
  );
}

export function SettingsDialog() {
  const settingsVisible = useUIStore((s) => s.settingsVisible);
  const setSettingsVisible = useUIStore((s) => s.setSettingsVisible);
  const pushToast = useToastStore((s) => s.push);
  const theme = useThemeStore((s) => s.theme);
  const setTheme = useThemeStore((s) => s.setTheme);
  const updater = useAppUpdater();

  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [rememberDirGlobal, setRememberDirGlobal] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [updateMirror, setUpdateMirrorState] = useState<UpdateMirror>('github');
  const [mirrorOptions, setMirrorOptions] = useState<MirrorOption[]>([]);
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [delays, setDelays] = useState<MirrorDelayResult>({});
  const [probing, setProbing] = useState(false);
  const [debugLogging, setDebugLogging] = useState(false);

  // 快捷键设置
  const shortcutMap = useShortcutStore((s) => s.map);
  const setShortcut = useShortcutStore((s) => s.setShortcut);
  const resetShortcut = useShortcutStore((s) => s.resetShortcut);
  const resetAllShortcuts = useShortcutStore((s) => s.resetAll);
  /** 正在录制的快捷键 id；null 表示未在录制 */
  const [recordingId, setRecordingId] = useState<string | null>(null);

  // 录制快捷键：监听按键，按下有效组合键即写入并结束录制
  useEffect(() => {
    if (!recordingId) return;
    const id = recordingId;
    function onKey(e: KeyboardEvent) {
      // Esc 取消录制，不写入
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setRecordingId(null);
        return;
      }
      // 忽略纯修饰键按下（等用户按下主键）
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      const value = eventToShortcut(e);
      // 至少要有一个主键
      if (!value || value.endsWith('+')) return;
      setShortcut(id, value);
      setRecordingId(null);
    }
    // 捕获阶段优先拦截，避免被其他监听器处理
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [recordingId, setShortcut]);

  // 弹窗打开时加载设置
  useEffect(() => {
    if (!settingsVisible) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const val = await invoke<string>('get_setting', { key: 'remember_dir_global' });
        if (cancelled) return;
        // "true"/"false" 字符串 → boolean；非 "false" 视为 true
        setRememberDirGlobal(val !== 'false');
        // 加载已保存的更新源（localStorage）
        setUpdateMirrorState(getUpdateMirror());
        // 加载镜像选项列表（内置 + 自定义）
        setMirrorOptions(getMirrorOptions());
        // 加载调试日志开关
        const debugVal = await invoke<boolean>('get_debug_logging');
        if (cancelled) return;
        setDebugLogging(debugVal);
      } catch (err) {
        if (!cancelled) {
          pushToast('error', `读取设置失败：${formatErr(err)}`);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [settingsVisible, pushToast]);

  // 检查更新产生的延迟结果同步到本地
  useEffect(() => {
    if (updater.mirrorDelays && Object.keys(updater.mirrorDelays).length > 0) {
      setDelays(updater.mirrorDelays);
    }
  }, [updater.mirrorDelays]);

  // Escape 关闭
  useEffect(() => {
    if (!settingsVisible) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSettingsVisible(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [settingsVisible, setSettingsVisible]);

  if (!settingsVisible) return null;

  async function handleToggleRememberDir(checked: boolean) {
    setRememberDirGlobal(checked);
    setSaving(true);
    try {
      await invoke('set_setting', {
        key: 'remember_dir_global',
        value: checked ? 'true' : 'false',
      });
      pushToast('success', checked ? '已开启目录记忆' : '已关闭目录记忆');
    } catch (err) {
      // 写入失败：回滚 UI 状态
      setRememberDirGlobal(!checked);
      pushToast('error', `保存设置失败：${formatErr(err)}`);
    } finally {
      setSaving(false);
    }
  }

  function handleClose() {
    setSettingsVisible(false);
  }

  async function handleToggleDebugLog(checked: boolean) {
    setDebugLogging(checked);
    setSaving(true);
    try {
      await invoke('set_debug_logging', { enabled: checked });
    } catch (err) {
      setDebugLogging(!checked);
      pushToast('error', `保存设置失败：${formatErr(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleProbeLatency() {
    if (probing) return;
    setProbing(true);
    try {
      const result = await probeMirrorLatency();
      setDelays(result);
      const reachable = Object.values(result).filter(
        (v): v is number => typeof v === 'number' && Number.isFinite(v),
      );
      if (reachable.length === 0) {
        pushToast('error', '所有镜像均无法连通，请检查网络后重试', 4000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushToast('error', `延迟检测失败：${msg}`, 5000);
    } finally {
      setProbing(false);
    }
  }

  /** 延迟标签：与 UpdateDialog 保持一致的分级逻辑 */
  function delayLabelFor(delay: number | null | undefined, probing: boolean): { label: string; cls: string } {
    if (probing) return { label: '检测中…', cls: 'mirror-delay mirror-delay-bad' };
    if (delay === undefined || delay === null) return { label: '不可达', cls: 'mirror-delay mirror-delay-bad' };
    if (delay < 300) return { label: `${delay} ms`, cls: 'mirror-delay mirror-delay-good' };
    if (delay < 1000) return { label: `${delay} ms`, cls: 'mirror-delay mirror-delay-ok' };
    return { label: `${(delay / 1000).toFixed(1)} s`, cls: 'mirror-delay mirror-delay-bad' };
  }

  function handleAddCustomMirror() {
    const url = customUrlInput.trim();
    if (!url) {
      pushToast('error', '请输入镜像地址', 2500);
      return;
    }
    const ok = addCustomMirror(url);
    if (!ok) {
      pushToast('error', '该镜像已存在', 2500);
      return;
    }
    setMirrorOptions(getMirrorOptions());
    setCustomUrlInput('');
    pushToast('success', '已添加自定义镜像源', 2500);
  }

  function handleRemoveCustomMirror(url: string) {
    const ok = removeCustomMirror(url);
    if (!ok) {
      pushToast('error', '删除失败', 2500);
      return;
    }
    // 如果删除的是当前选中的源，回退到 github
    if (updateMirror === url) {
      setUpdateMirrorState('github');
    }
    setMirrorOptions(getMirrorOptions());
    // 清除该源的延迟记录
    setDelays((prev) => {
      const next = { ...prev };
      delete next[url];
      return next;
    });
    pushToast('success', '已删除自定义镜像源', 2500);
  }

  return createPortal(
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
      onClick={handleClose}
    >
      <div className="dialog dialog-settings" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 id="settings-dialog-title" className="dialog-title">
            设置
          </h2>
          <button
            type="button"
            className="dialog-close"
            aria-label="关闭"
            onClick={handleClose}
          >
            <X size={16} />
          </button>
        </div>

        <div className="settings-layout">
          {/* 左侧分类菜单 */}
          <nav className="settings-sidebar">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={`settings-nav-item ${active ? 'is-active' : ''}`}
                  onClick={() => setActiveTab(tab.id)}
                  aria-pressed={active}
                >
                  <Icon size={15} className="settings-nav-icon" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>

          {/* 右侧内容区 */}
          <div className="settings-content">
            {/* 通用 */}
            {activeTab === 'general' && (
              <div className="settings-pane">
                <div className="settings-pane-title">通用设置</div>

                <div className="settings-row">
                  <div className="settings-row-main">
                    <div className="settings-row-label">目录记忆（全局默认）</div>
                    <div className="settings-row-desc">
                      关闭后，新建主机的目录记忆默认关闭。已有主机的目录记忆由各自配置决定。
                    </div>
                  </div>
                  <label className="form-switch">
                    <input
                      type="checkbox"
                      checked={rememberDirGlobal}
                      onChange={(e) => void handleToggleRememberDir(e.target.checked)}
                      disabled={loading || saving}
                    />
                    <span className="form-switch-track" aria-hidden="true" />
                    <span className="form-switch-label">
                      {loading ? '加载中…' : saving ? '保存中…' : rememberDirGlobal ? '开启' : '关闭'}
                    </span>
                  </label>
                </div>

                {/* 终端外观设置 */}
                <TerminalSettingsGroup />
              </div>
            )}

            {/* 主题 */}
            {activeTab === 'theme' && (
              <div className="settings-pane">
                <div className="settings-pane-title">主题外观</div>
                <div className="settings-pane-desc">
                  选择应用的配色风格，切换后即时生效。
                </div>
                <div className="settings-theme-grid">
                  {THEME_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      className={`theme-card ${theme === opt.id ? 'is-selected' : ''}`}
                      onClick={() => {
                        setTheme(opt.id);
                        pushToast('success', `已切换主题：${opt.name}`);
                      }}
                      aria-pressed={theme === opt.id}
                    >
                      <span className="theme-card-swatch" style={{ background: opt.swatch }} />
                      <span className="theme-card-name">{opt.name}</span>
                      <span className="theme-card-desc">{opt.desc}</span>
                      {theme === opt.id && <Check size={14} className="theme-card-check" />}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* 更新 */}
            {activeTab === 'update' && (
              <div className="settings-pane">
                <div className="settings-pane-header">
                  <div className="settings-pane-title-wrap">
                    <div className="settings-pane-title">更新下载源</div>
                    <div className="settings-update-mirror-desc">
                      检查更新和下载安装包时使用的下载源。国内网络建议选择镜像以加速下载。
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact settings-probe-btn"
                    onClick={() => void handleProbeLatency()}
                    disabled={probing}
                  >
                    {probing ? (
                      <RefreshCw size={13} className="is-spin" />
                    ) : (
                      <Gauge size={13} />
                    )}
                    <span>{probing ? '检测中…' : '检测延迟'}</span>
                  </button>
                </div>

                <div className="settings-mirror-grid">
                  {mirrorOptions.map((opt) => {
                    const selected = updateMirror === opt.id;
                    const delay = delays[opt.id];
                    const { label: delayLabel, cls: delayClass } = delayLabelFor(delay, probing);
                    return (
                      <div
                        key={opt.id}
                        className={`mirror-card ${selected ? 'is-selected' : ''} ${!opt.builtin ? 'is-custom' : ''}`}
                        onClick={() => {
                          setUpdateMirrorState(opt.id as UpdateMirror);
                          setUpdateMirror(opt.id as UpdateMirror);
                        }}
                        style={{ cursor: 'pointer' }}
                      >
                        <div className="mirror-card-info">
                          <div className="mirror-card-header">
                            <span className="mirror-card-name">{opt.name}</span>
                            <div className="mirror-card-right">
                              <span className={delayClass}>{delayLabel}</span>
                              {selected && <Check size={14} className="mirror-card-check" />}
                            </div>
                          </div>
                          <div className="mirror-card-desc">{opt.desc}</div>
                        </div>
                        {!opt.builtin && (
                          <button
                            type="button"
                            className="mirror-card-delete"
                            title="删除此自定义镜像源"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveCustomMirror(opt.id);
                            }}
                          >
                            <Trash2 size={12} />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* 添加自定义镜像源 */}
                <div className="settings-add-mirror">
                  <div className="settings-add-mirror-label">添加自定义镜像源</div>
                  <div className="settings-add-mirror-row">
                    <input
                      type="text"
                      className="form-input settings-add-mirror-input"
                      placeholder="https://v4.gh-proxy.org"
                      value={customUrlInput}
                      onChange={(e) => setCustomUrlInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddCustomMirror();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost btn-compact"
                      onClick={handleAddCustomMirror}
                    >
                      <Plus size={13} />
                      <span>添加</span>
                    </button>
                  </div>
                  <div className="settings-add-mirror-hint">
                    输入镜像站点地址（如 https://v4.gh-proxy.org），会作为 GitHub URL 的前缀拼接。
                  </div>
                </div>
              </div>
            )}

            {/* 快捷键 */}
            {activeTab === 'shortcuts' && (
              <div className="settings-pane">
                <div className="settings-pane-header">
                  <div className="settings-pane-title-wrap">
                    <div className="settings-pane-title">快捷键</div>
                    <div className="settings-update-mirror-desc">
                      点击右侧按钮录制新的快捷键组合。Esc 取消录制。
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost btn-compact"
                    onClick={() => {
                      resetAllShortcuts();
                      pushToast('success', '已重置所有快捷键');
                    }}
                  >
                    <RotateCcw size={13} />
                    <span>重置全部</span>
                  </button>
                </div>

                <div className="settings-shortcut-list">
                  {SHORTCUTS.map((sc) => {
                    const current = shortcutMap[sc.id] ?? sc.defaultValue;
                    const isDefault = current === sc.defaultValue;
                    const isRecording = recordingId === sc.id;
                    return (
                      <div key={sc.id} className="settings-shortcut-row">
                        <div className="settings-shortcut-info">
                          <div className="settings-shortcut-label">{sc.label}</div>
                          <div className="settings-shortcut-desc">{sc.desc}</div>
                        </div>
                        <div className="settings-shortcut-actions">
                          <button
                            type="button"
                            className={`shortcut-badge ${isRecording ? 'is-recording' : ''} ${!isDefault ? 'is-custom' : ''}`}
                            onClick={() => setRecordingId(isRecording ? null : sc.id)}
                          >
                            {isRecording ? '按下快捷键…' : current}
                          </button>
                          {!isDefault && (
                            <button
                              type="button"
                              className="shortcut-reset-btn"
                              title="重置为默认"
                              onClick={() => resetShortcut(sc.id)}
                            >
                              <RotateCcw size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 调试 */}
            {activeTab === 'debug' && (
              <div className="settings-pane">
                <div className="settings-pane-title">调试日志</div>

                <div className="settings-row">
                  <div className="settings-row-main">
                    <div className="settings-row-label">详细日志</div>
                    <div className="settings-row-desc">
                      开启后记录所有级别的日志（含 Info），用于排查问题。关闭后仅记录警告和错误。
                    </div>
                  </div>
                  <label className="form-switch">
                    <input
                      type="checkbox"
                      checked={debugLogging}
                      onChange={(e) => void handleToggleDebugLog(e.target.checked)}
                      disabled={loading || saving}
                    />
                    <span className="form-switch-track" aria-hidden="true" />
                    <span className="form-switch-label">
                      {loading ? '加载中…' : saving ? '保存中…' : debugLogging ? '开启' : '关闭'}
                    </span>
                  </label>
                </div>

                <div className="settings-update-log-section">
                  <div className="settings-pane-row">
                    <div>
                      <div className="settings-pane-title">日志文件</div>
                      <div className="settings-update-mirror-desc">
                        点击按钮在文件管理器中打开日志文件所在目录，或清空已有日志内容。
                      </div>
                    </div>
                    <div className="settings-log-actions">
                      <button
                        type="button"
                        className="btn btn-ghost btn-compact"
                        onClick={() => {
                          invoke('open_update_log_folder').catch((err) => {
                            pushToast('error', `打开日志文件夹失败：${formatErr(err)}`);
                          });
                        }}
                      >
                        <FolderOpen size={13} />
                        <span>打开日志文件夹</span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-compact"
                        onClick={async () => {
                          try {
                            await invoke('clear_update_log');
                            pushToast('success', '日志已清空');
                          } catch (err) {
                            pushToast('error', `清空日志失败：${formatErr(err)}`);
                          }
                        }}
                      >
                        <Eraser size={13} />
                        <span>清空日志</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="dialog-footer">
          <button type="button" className="btn btn-primary" onClick={handleClose}>
            关闭
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function formatErr(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
