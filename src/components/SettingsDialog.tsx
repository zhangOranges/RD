import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { X, Check, Palette, Sliders, DownloadCloud, RefreshCw, Gauge, Plus, Trash2, FolderOpen, Eraser, Bug } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
import { useToastStore } from './Toast';
import { useThemeStore, THEME_OPTIONS } from '../store/themeStore';
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

type SettingsTab = 'general' | 'theme' | 'update' | 'debug';

interface TabItem {
  id: SettingsTab;
  label: string;
  icon: typeof Palette;
}

const TABS: TabItem[] = [
  { id: 'general', label: '通用', icon: Sliders },
  { id: 'theme', label: '主题', icon: Palette },
  { id: 'update', label: '更新', icon: DownloadCloud },
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
