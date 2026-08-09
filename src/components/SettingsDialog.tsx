import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import { useUIStore } from '../store/uiStore';
import { useToastStore } from './Toast';

/**
 * 设置弹窗（Finder 风格模态）。
 *
 * 当前包含：
 * - 通用设置：目录记忆全局开关（remember_dir_global）
 *   读取 get_setting('remember_dir_global')，默认 "true"。
 *   修改时调用 set_setting('remember_dir_global', value) 即时生效。
 *
 * 弹窗可见性由 uiStore.settingsVisible 控制；
 * 通过 Ctrl+,（Windows）/ Cmd+,（macOS）快捷键打开（监听在 App.tsx）。
 */
export function SettingsDialog() {
  const settingsVisible = useUIStore((s) => s.settingsVisible);
  const setSettingsVisible = useUIStore((s) => s.setSettingsVisible);
  const pushToast = useToastStore((s) => s.push);

  const [rememberDirGlobal, setRememberDirGlobal] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

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

        <div className="dialog-body">
          <div className="settings-section-title">通用</div>

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
