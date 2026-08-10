import { useState, useEffect, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { X, PlugZap, Loader2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useHostStore } from '../store/hostStore';
import { useToastStore } from './Toast';
import type {
  HostConfig,
  HostFormValues,
  AuthType,
  CredentialType,
  CategoryConfig,
} from '../types';

interface HostDialogProps {
  host: HostConfig | null;
  categories: CategoryConfig[];
  // 新增主机时预设的分类
  presetCategoryId?: string;
  // 新增主机时直接预设表单（复制主机场景），优先级高于 presetCategoryId
  initialValues?: HostFormValues;
  onClose: () => void;
}

const DEFAULT_PORT = 22;

function genId(): string {
  // 简单生成一个客户端临时 ID，最终保存以 Rust 端分配/接受为准。
  // 这里采用 crypto.randomUUID（Tauri WebView 支持），否则降级时间戳。
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `h_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function emptyForm(): HostFormValues {
  return {
    name: '',
    host: '',
    port: DEFAULT_PORT,
    username: '',
    auth_type: 'password',
    password: '',
    private_key: '',
    remember_dir: true,
    remark: '',
    category_id: 'default',
  };
}

function fromHost(host: HostConfig): HostFormValues {
  return {
    name: host.name,
    host: host.host,
    port: host.port,
    username: host.username,
    auth_type: host.auth_type,
    password: '',
    private_key: '',
    remember_dir: host.remember_dir,
    remark: host.remark ?? '',
    category_id: host.category_id || 'default',
  };
}

export function HostDialog({ host, categories, presetCategoryId = 'default', initialValues, onClose }: HostDialogProps) {
  const isEdit = !!host;
  const addHost = useHostStore((s) => s.addHost);
  const updateHost = useHostStore((s) => s.updateHost);
  const pushToast = useToastStore((s) => s.push);

  const [form, setForm] = useState<HostFormValues>(() => {
    if (host) return fromHost(host);
    if (initialValues) return initialValues;
    return { ...emptyForm(), category_id: presetCategoryId };
  });
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function update<K extends keyof HostFormValues>(key: K, value: HostFormValues[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function validate(): string | null {
    if (!form.name.trim()) return '请填写名称';
    if (!form.host.trim()) return '请填写主机地址';
    if (!form.port || form.port < 1 || form.port > 65535) return '端口范围 1-65535';
    if (!form.username.trim()) return '请填写用户名';
    if (!isEdit) {
      if (form.auth_type === 'password' && !form.password) return '请填写密码';
      if (form.auth_type === 'key' && !form.private_key.trim()) return '请粘贴私钥内容';
    }
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const err = validate();
    if (err) {
      pushToast('warning', err);
      return;
    }
    setSaving(true);

    const config: HostConfig = {
      id: host?.id ?? genId(),
      name: form.name.trim(),
      host: form.host.trim(),
      port: Number(form.port),
      username: form.username.trim(),
      auth_type: form.auth_type,
      remember_dir: form.remember_dir,
      remark: form.remark.trim(),
      category_id: form.category_id || 'default',
    };

    // 仅当用户填写了凭据时才一并保存（编辑模式下留空表示不修改）
    const credType: CredentialType = form.auth_type === 'password' ? 'password' : 'private_key';
    const credValue =
      form.auth_type === 'password' ? form.password : form.private_key;
    const credential =
      credValue && credValue.trim().length > 0
        ? { type: credType, value: credValue }
        : undefined;

    try {
      if (isEdit) {
        await updateHost(config, credential);
        pushToast('success', '已保存主机');
      } else {
        await addHost(config, credential);
        pushToast('success', '已新增主机');
      }
      onClose();
    } catch (err) {
      pushToast('error', `保存失败：${formatErr(err)}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if (!form.host.trim() || !form.username.trim()) {
      pushToast('warning', '请先填写主机地址和用户名');
      return;
    }
    // 编辑模式下凭据可能留空（表示不修改），此时尝试用已保存的凭据测试
    let password: string | null = form.password || null;
    let privateKey: string | null = form.private_key || null;
    if (isEdit && !password && !privateKey) {
      try {
        if (form.auth_type === 'password') {
          password = await invoke<string | null>('get_credential', {
            hostId: host!.id,
            credType: 'password',
          });
        } else {
          privateKey = await invoke<string | null>('get_credential', {
            hostId: host!.id,
            credType: 'private_key',
          });
        }
      } catch {
        // ignore
      }
      if (!password && !privateKey) {
        pushToast('warning', '请填写密码或私钥后再测试');
        return;
      }
    } else if (!isEdit) {
      if (form.auth_type === 'password' && !password) {
        pushToast('warning', '请填写密码后再测试');
        return;
      }
      if (form.auth_type === 'key' && !privateKey?.trim()) {
        pushToast('warning', '请粘贴私钥后再测试');
        return;
      }
    }

    setTesting(true);
    const t0 = performance.now();
    try {
      await invoke<{ home_dir: string; fingerprint: string }>('test_connection', {
        params: {
          host_id: host?.id ?? 'test',
          host: form.host.trim(),
          port: Number(form.port),
          username: form.username.trim(),
          auth_type: form.auth_type,
          password,
          private_key: privateKey,
        },
      });
      const latency = Math.round(performance.now() - t0);
      pushToast('success', `连接成功，延迟 ${latency}ms`);
    } catch (err) {
      pushToast('error', `连接失败：${formatErr(err)}`);
    } finally {
      setTesting(false);
    }
  }

  return createPortal(
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="host-dialog-title"
      onClick={onClose}
    >
      <div
        className="dialog"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 id="host-dialog-title" className="dialog-title">
            {isEdit ? '编辑主机' : '新增主机'}
          </h2>
          <button
            type="button"
            className="dialog-close"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        <form className="dialog-body" onSubmit={handleSubmit}>
          <div className="form-row">
            <label className="form-label" htmlFor="f-name">
              名称 <span className="required">*</span>
            </label>
            <input
              id="f-name"
              className="form-input"
              type="text"
              value={form.name}
              onChange={(e) => update('name', e.target.value)}
              placeholder="例如：生产服务器"
              autoFocus
            />
          </div>

          <div className="form-row form-row-2">
            <div className="form-cell">
              <label className="form-label" htmlFor="f-host">
                主机地址 <span className="required">*</span>
              </label>
              <input
                id="f-host"
                className="form-input"
                type="text"
                value={form.host}
                onChange={(e) => update('host', e.target.value)}
                placeholder="IP 或域名"
              />
            </div>
            <div className="form-cell form-cell-port">
              <label className="form-label" htmlFor="f-port">
                端口
              </label>
              <input
                id="f-port"
                className="form-input"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => update('port', Number(e.target.value) || 0)}
              />
            </div>
          </div>

          <div className="form-row">
            <label className="form-label" htmlFor="f-username">
              用户名 <span className="required">*</span>
            </label>
            <input
              id="f-username"
              className="form-input"
              type="text"
              value={form.username}
              onChange={(e) => update('username', e.target.value)}
              placeholder="root / ubuntu 等"
            />
          </div>

          <div className="form-row">
            <label className="form-label" htmlFor="f-category">
              分类
            </label>
            <select
              id="f-category"
              className="form-input"
              value={form.category_id}
              onChange={(e) => update('category_id', e.target.value)}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="form-row">
            <label className="form-label">认证方式</label>
            <div className="form-radio-group">
              <label className="form-radio">
                <input
                  type="radio"
                  name="auth_type"
                  value="password"
                  checked={form.auth_type === 'password'}
                  onChange={() => update('auth_type', 'password' as AuthType)}
                />
                <span>密码</span>
              </label>
              <label className="form-radio">
                <input
                  type="radio"
                  name="auth_type"
                  value="key"
                  checked={form.auth_type === 'key'}
                  onChange={() => update('auth_type', 'key' as AuthType)}
                />
                <span>私钥</span>
              </label>
            </div>
          </div>

          {form.auth_type === 'password' ? (
            <div className="form-row">
              <label className="form-label" htmlFor="f-password">
                密码
                {isEdit && <span className="form-hint">（留空表示不修改）</span>}
              </label>
              <input
                id="f-password"
                className="form-input"
                type="password"
                value={form.password}
                onChange={(e) => update('password', e.target.value)}
                placeholder={isEdit ? '留空不修改' : '请输入密码'}
                autoComplete="new-password"
              />
            </div>
          ) : (
            <div className="form-row">
              <label className="form-label" htmlFor="f-key">
                私钥内容
                {isEdit && <span className="form-hint">（留空表示不修改）</span>}
              </label>
              <textarea
                id="f-key"
                className="form-textarea"
                rows={6}
                value={form.private_key}
                onChange={(e) => update('private_key', e.target.value)}
                placeholder={`-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----`}
                spellCheck={false}
              />
            </div>
          )}

          <div className="form-row form-row-inline">
            <label className="form-switch">
              <input
                type="checkbox"
                checked={form.remember_dir}
                onChange={(e) => update('remember_dir', e.target.checked)}
              />
              <span className="form-switch-track" aria-hidden="true" />
              <span className="form-switch-label">目录记忆</span>
            </label>
          </div>

          <div className="form-row">
            <label className="form-label" htmlFor="f-remark">
              备注
            </label>
            <input
              id="f-remark"
              className="form-input"
              type="text"
              value={form.remark}
              onChange={(e) => update('remark', e.target.value)}
              placeholder="可选"
            />
          </div>

          <div className="dialog-footer">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleTestConnection}
              disabled={testing || saving}
              title="测试是否能连接到该主机"
            >
              {testing ? <Loader2 size={14} className="is-spin" /> : <PlugZap size={14} />}
              {testing ? '测试中…' : '测试连接'}
            </button>
            <div className="dialog-footer-right">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving || testing}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </div>
        </form>
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
