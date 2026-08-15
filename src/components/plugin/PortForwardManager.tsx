import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import { X, Plus, ChevronDown, Play, Pause, Edit3, Trash2, Upload, Download, AlertTriangle } from 'lucide-react';
import { useHostStore } from '../../store/hostStore';
import { useUIStore } from '../../store/uiStore';
import { useToastStore } from '../Toast';
import { kernelEventBus } from '../../utils/eventBus';
import type { TunnelRule, TunnelStatus, TunnelMode, RdTunnelsFile, TunnelConflictStrategy } from '../../types/plugin';
import type { HostConfig } from '../../types';

const LISTEN_ADDR_PRESETS = ['127.0.0.1', '0.0.0.0', '::1', '::'];

function ModePill({ mode }: { mode: TunnelMode }) {
  const colors: Record<TunnelMode, string> = {
    local: '#3b82f6',
    remote: '#f59e0b',
    dynamic: '#8b5cf6',
  };
  const labels: Record<TunnelMode, string> = {
    local: 'local',
    remote: 'remote',
    dynamic: 'dynamic',
  };
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 10,
        fontSize: 11,
        fontWeight: 600,
        color: '#fff',
        background: colors[mode],
      }}
    >
      {labels[mode]}
    </span>
  );
}

function StatusDot({ status }: { status: TunnelStatus | null }) {
  if (!status) {
    return <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-text-muted)', opacity: 0.4, display: 'inline-block' }} />;
  }
  if (status.running) {
    return <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 0 2px rgba(34,197,94,0.15)', display: 'inline-block' }} />;
  }
  if (status.error) {
    return <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />;
  }
  return <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />;
}

interface NewRuleForm {
  hostId: string;
  mode: TunnelMode;
  localAddr: string;
  localAddrCustom: string;
  localPort: string;
  remoteAddr: string;
  remotePort: string;
  autoStart: boolean;
  tags: string;
  comment: string;
  riskConfirmed: boolean;
}

const emptyForm: NewRuleForm = {
  hostId: '',
  mode: 'local',
  localAddr: '127.0.0.1',
  localAddrCustom: '',
  localPort: '',
  remoteAddr: '',
  remotePort: '',
  autoStart: false,
  tags: '',
  comment: '',
  riskConfirmed: false,
};

function tunnelRuleFromDto(dto: Record<string, unknown>): TunnelRule {
  return {
    id: String(dto.id ?? dto.tunnel_id ?? ''),
    hostId: String(dto.host_id ?? dto.hostId ?? ''),
    mode: (dto.mode as TunnelMode) ?? 'local',
    localAddr: String(dto.local_addr ?? dto.localAddr ?? '127.0.0.1'),
    localPort: Number(dto.local_port ?? dto.localPort ?? 0),
    remoteAddr: dto.remote_addr ?? dto.remoteAddr ? String(dto.remote_addr ?? dto.remoteAddr) : undefined,
    remotePort: dto.remote_port ?? dto.remotePort ? Number(dto.remote_port ?? dto.remotePort) : undefined,
    autoStart: Boolean(dto.auto_start ?? dto.autoStart ?? false),
    tags: Array.isArray(dto.tags) ? (dto.tags as string[]) : undefined,
    comment: dto.comment ? String(dto.comment) : undefined,
    createdAt: Number(dto.created_at ?? dto.createdAt ?? Date.now()),
  };
}

function tunnelStatusFromDto(dto: Record<string, unknown>): TunnelStatus {
  return {
    tunnelId: String(dto.tunnel_id ?? dto.tunnelId ?? ''),
    running: Boolean(dto.running ?? false),
    pid: dto.pid != null ? Number(dto.pid) : undefined,
    error: dto.error ? String(dto.error) : undefined,
    boundHostId: dto.bound_host_id ?? dto.boundHostId ? String(dto.bound_host_id ?? dto.boundHostId) : undefined,
    acceptedConns: Number(dto.accepted_conns ?? dto.acceptedConns ?? 0),
    startTimeMs: dto.start_time_ms ?? dto.startTimeMs ? Number(dto.start_time_ms ?? dto.startTimeMs) : undefined,
  };
}

export function PortForwardManager({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const hosts = useHostStore((s) => s.hosts);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const tunnelAllowRemoteForwarding = useUIStore((s) => s.tunnelAllowRemoteForwarding);
  const setTunnelConfirmListenAllLast = useUIStore((s) => s.setTunnelConfirmListenAllLast);
  const pushToast = useToastStore.getState().push;

  const [rules, setRules] = useState<TunnelRule[]>([]);
  const [statuses, setStatuses] = useState<Record<string, TunnelStatus>>({});
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<NewRuleForm>(emptyForm);
  const [importMenuOpen, setImportMenuOpen] = useState(false);
  const importMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ownerRef = useRef<object>({});

  const connectedHosts = hosts.filter((h) => connectionStates[h.id] === 'connected');

  const loadRules = useCallback(async () => {
    try {
      const arr = await invoke<Record<string, unknown>[]>('tunnel_list_rules', { hostId: undefined });
      setRules(arr.map(tunnelRuleFromDto));
    } catch (e) {
      pushToast('error', `加载规则失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [pushToast]);

  const loadStatuses = useCallback(async () => {
    try {
      const arr = await invoke<Record<string, unknown>[]>('tunnel_list_statuses', { hostId: undefined });
      const map: Record<string, TunnelStatus> = {};
      for (const dto of arr) {
        const s = tunnelStatusFromDto(dto);
        map[s.tunnelId] = s;
      }
      setStatuses(map);
    } catch (e) {
      // silent
    }
  }, []);

  const refreshAll = useCallback(() => {
    void loadRules();
    void loadStatuses();
  }, [loadRules, loadStatuses]);

  useEffect(() => {
    if (!visible) return;
    refreshAll();

    const owner = ownerRef.current;
    const onStart = (tunnelId: string) => {
      void loadStatuses();
      void tunnelId;
    };
    const onStop = (tunnelId: string) => {
      void loadStatuses();
      void tunnelId;
    };
    const onError = (tunnelId: string) => {
      void loadStatuses();
      void tunnelId;
    };
    kernelEventBus.on('tunnel:start', onStart, owner);
    kernelEventBus.on('tunnel:stop', onStop, owner);
    kernelEventBus.on('tunnel:error', onError, owner);

    return () => {
      kernelEventBus.offAll(owner);
    };
  }, [visible, refreshAll, loadStatuses]);

  useEffect(() => {
    if (!importMenuOpen) return;
    function handleClick(e: MouseEvent) {
      if (importMenuRef.current && !importMenuRef.current.contains(e.target as Node)) {
        setImportMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [importMenuOpen]);

  useEffect(() => {
    if (!visible) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [visible, onClose]);

  const handleStart = async (id: string) => {
    try {
      setTunnelConfirmListenAllLast(true);
      await invoke('tunnel_start', {
        tunnelId: id,
        confirmListenAll: true,
        allowRemote: tunnelAllowRemoteForwarding,
      });
      pushToast('success', '隧道已启动');
      void loadStatuses();
    } catch (e) {
      pushToast('error', `启动失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleStop = async (id: string) => {
    try {
      await invoke('tunnel_stop', { tunnelId: id });
      pushToast('success', '隧道已停止');
      void loadStatuses();
    } catch (e) {
      pushToast('error', `停止失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleRemove = async (id: string) => {
    if (!window.confirm('确定删除此隧道？运行中的隧道会被先停止。')) return;
    try {
      await invoke('tunnel_remove_rule', { tunnelId: id });
      pushToast('success', '隧道已删除');
      refreshAll();
    } catch (e) {
      pushToast('error', `删除失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleEdit = (rule: TunnelRule) => {
    setEditingId(rule.id);
    setForm({
      hostId: rule.hostId,
      mode: rule.mode,
      localAddr: LISTEN_ADDR_PRESETS.includes(rule.localAddr) ? rule.localAddr : 'custom',
      localAddrCustom: LISTEN_ADDR_PRESETS.includes(rule.localAddr) ? '' : rule.localAddr,
      localPort: String(rule.localPort),
      remoteAddr: rule.remoteAddr ?? '',
      remotePort: rule.remotePort ? String(rule.remotePort) : '',
      autoStart: rule.autoStart,
      tags: rule.tags?.join(', ') ?? '',
      comment: rule.comment ?? '',
      riskConfirmed: false,
    });
    setShowForm(true);
  };

  const localPortNum = Number(form.localPort);
  const remotePortNum = Number(form.remotePort);
  const finalLocalAddr = form.localAddr === 'custom' ? form.localAddrCustom.trim() : form.localAddr;
  const isDangerousMode =
    form.mode === 'remote' || finalLocalAddr === '0.0.0.0' || finalLocalAddr === '::';
  const canSave =
    form.hostId &&
    localPortNum >= 1 &&
    localPortNum <= 65535 &&
    (form.mode === 'dynamic' || (remotePortNum >= 1 && remotePortNum <= 65535 && form.remoteAddr.trim() !== '')) &&
    (!isDangerousMode || form.riskConfirmed);

  const handleSave = async () => {
    if (!canSave) return;
    const patch = {
      hostId: form.hostId,
      mode: form.mode,
      localAddr: finalLocalAddr,
      localPort: localPortNum,
      remoteAddr: form.mode === 'dynamic' ? undefined : form.remoteAddr.trim(),
      remotePort: form.mode === 'dynamic' ? undefined : remotePortNum,
      autoStart: form.autoStart,
      tags: form.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      comment: form.comment.trim() || undefined,
    };
    try {
      if (editingId) {
        await invoke<Record<string, unknown>>('tunnel_update_rule', {
          tunnelId: editingId,
          patch,
        });
        pushToast('success', '规则已更新');
      } else {
        const saved = await invoke<Record<string, unknown>>('tunnel_add_rule', {
          rule: {
            ...patch,
            id: `tunnel_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
            createdAt: Date.now(),
          },
        });
        const savedId = String(saved.id ?? saved.tunnel_id ?? '');
        pushToast('success', '规则已创建');
        if (form.autoStart && savedId) {
          try {
            setTunnelConfirmListenAllLast(true);
            await invoke('tunnel_start', {
              tunnelId: savedId,
              confirmListenAll: true,
              allowRemote: tunnelAllowRemoteForwarding,
            });
          } catch {
            // ignore
          }
        }
      }
      setForm(emptyForm);
      setEditingId(null);
      setShowForm(false);
      refreshAll();
    } catch (e) {
      pushToast('error', `保存失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleExport = async () => {
    try {
      const json = await invoke<string>('tunnel_export_rules');
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `rd-tunnels-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      pushToast('success', '已导出规则');
    } catch (e) {
      pushToast('error', `导出失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const handleFileChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setImportMenuOpen(false);
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as RdTunnelsFile;
      const strategy =
        (window.prompt('冲突策略：skip / overwrite / rename', 'skip') as TunnelConflictStrategy | null) ?? 'skip';
      const validStrategy: TunnelConflictStrategy =
        strategy === 'overwrite' || strategy === 'rename' ? strategy : 'skip';
      const result = await invoke<Record<string, unknown>>('tunnel_import_rules', {
        file: parsed,
        conflictStrategy: validStrategy,
      });
      pushToast(
        'success',
        `导入完成：新增 ${result.imported}，跳过 ${result.skipped}，覆盖 ${result.overwritten}，重命名 ${result.renamed}`,
      );
      refreshAll();
    } catch (e) {
      pushToast('error', `导入失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (!visible) return null;

  return createPortal(
    <div
      className="dialog-overlay"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="dialog"
        style={{ width: 900, maxWidth: '92vw', maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">端口转发</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                setEditingId(null);
                setForm({ ...emptyForm, hostId: connectedHosts[0]?.id ?? '' });
                setShowForm(!showForm);
              }}
              style={{ fontSize: 12, padding: '4px 10px' }}
            >
              <Plus size={12} style={{ marginRight: 4 }} />
              新建
            </button>
            <div style={{ position: 'relative' }} ref={importMenuRef}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setImportMenuOpen(!importMenuOpen)}
                style={{ fontSize: 12, padding: '4px 10px' }}
              >
                <ChevronDown size={12} style={{ marginRight: 4 }} />
                导入 / 导出
              </button>
              {importMenuOpen && (
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 'calc(100% + 4px)',
                    minWidth: 160,
                    background: 'var(--color-bg-secondary)',
                    border: '1px solid var(--color-border-subtle, rgba(127,127,127,0.2))',
                    borderRadius: 8,
                    padding: 4,
                    zIndex: 10,
                    boxShadow: '0 4px 16px rgba(0,0,0,0.2)',
                  }}
                >
                  <button
                    type="button"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      width: '100%',
                      padding: '6px 10px',
                      fontSize: 12,
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      borderRadius: 6,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload size={12} />
                    从文件导入
                  </button>
                  <button
                    type="button"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      width: '100%',
                      padding: '6px 10px',
                      fontSize: 12,
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      borderRadius: 6,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                    onClick={() => {
                      setImportMenuOpen(false);
                      void handleExport();
                    }}
                  >
                    <Download size={12} />
                    导出所有规则
                  </button>
                </div>
              )}
            </div>
            <input
              type="file"
              accept=".json,.rd-tunnels.json"
              ref={fileInputRef}
              style={{ display: 'none' }}
              onChange={(e) => void handleFileChosen(e)}
            />
            <button
              type="button"
              className="dialog-close"
              aria-label="关闭"
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 20px' }}>
          {tunnelAllowRemoteForwarding && (
            <div
              style={{
                marginTop: 12,
                marginBottom: 12,
                padding: '8px 12px',
                borderRadius: 8,
                background: 'rgba(245,158,11,0.12)',
                border: '1px solid rgba(245,158,11,0.3)',
                color: '#f59e0b',
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <AlertTriangle size={14} />
              远程转发模式已开启，远端服务器将可回连本机端口
            </div>
          )}

          {showForm && form.mode === 'remote' && (
            <div
              style={{
                marginBottom: 12,
                padding: '8px 12px',
                borderRadius: 8,
                background: 'rgba(239,68,68,0.12)',
                border: '1px solid rgba(239,68,68,0.3)',
                color: 'var(--color-danger, #ef4444)',
                fontSize: 12,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <AlertTriangle size={14} />
              远程转发 (R 模式) 属于高危操作，请确认服务器权限安全
            </div>
          )}

          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 13,
            }}
          >
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border-subtle, rgba(127,127,127,0.2))' }}>
                {['状态', '模式', '绑定主机', '本地 → 远程', '自启', '操作'].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: 'left',
                      padding: '8px 10px',
                      fontSize: 12,
                      fontWeight: 500,
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    style={{
                      padding: 32,
                      textAlign: 'center',
                      color: 'var(--color-text-muted)',
                      fontSize: 13,
                    }}
                  >
                    暂无转发规则，点击右上角「新建」添加
                  </td>
                </tr>
              )}
              {rules.map((rule) => {
                const st = statuses[rule.id] ?? null;
                const host = hosts.find((h) => h.id === rule.hostId);
                const displayHost = host
                  ? `${host.name} (${host.host}:${host.port})`
                  : `host:${rule.hostId.slice(0, 8)}`;
                return (
                  <tr
                    key={rule.id}
                    style={{ borderBottom: '1px solid var(--color-border-subtle, rgba(127,127,127,0.08))' }}
                  >
                    <td style={{ padding: '8px 10px', whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <StatusDot status={st} />
                        <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                          {st?.running ? 'running' : st?.error ? 'error' : st ? 'starting' : 'stopped'}
                        </span>
                      </span>
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <ModePill mode={rule.mode} />
                    </td>
                    <td style={{ padding: '8px 10px', fontSize: 12 }}>{displayHost}</td>
                    <td style={{ padding: '8px 10px', fontSize: 12, fontFamily: 'monospace' }}>
                      {rule.mode === 'dynamic' ? (
                        <span>SOCKS5 {rule.localAddr}:{rule.localPort}</span>
                      ) : (
                        <span>
                          {rule.localAddr}:{rule.localPort} → {rule.remoteAddr}:{rule.remotePort}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <label className="form-switch" style={{ flexShrink: 0 }}>
                        <input
                          type="checkbox"
                          checked={rule.autoStart}
                          disabled
                        />
                        <span className="form-switch-track" aria-hidden="true" />
                      </label>
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        {st?.running ? (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => void handleStop(rule.id)}
                            style={{ fontSize: 11, padding: '2px 8px' }}
                            title="停止"
                          >
                            <Pause size={11} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() => void handleStart(rule.id)}
                            style={{ fontSize: 11, padding: '2px 8px' }}
                            title="启动"
                          >
                            <Play size={11} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => handleEdit(rule)}
                          style={{ fontSize: 11, padding: '2px 8px' }}
                          title="编辑"
                        >
                          <Edit3 size={11} />
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() => void handleRemove(rule.id)}
                          style={{
                            fontSize: 11,
                            padding: '2px 8px',
                            color: 'var(--color-danger, #ef4444)',
                          }}
                          title="删除"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {showForm && (
            <div
              style={{
                marginTop: 20,
                padding: 16,
                borderRadius: 10,
                background: 'var(--color-bg-secondary)',
                border: '1px solid var(--color-border-subtle, rgba(127,127,127,0.2))',
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>
                {editingId ? '编辑规则' : '新建规则'}
              </div>

              <div className="settings-row">
                <div className="settings-row-main">
                  <div className="settings-row-label">步骤一：绑定主机</div>
                  <div className="settings-row-desc">选择一条已连接的 SSH 主机</div>
                </div>
                <select
                  className="settings-select"
                  value={form.hostId}
                  onChange={(e) => setForm({ ...form, hostId: e.target.value })}
                  style={{ minWidth: 220 }}
                >
                  <option value="">请选择主机…</option>
                  {connectedHosts.map((h: HostConfig) => (
                    <option key={h.id} value={h.id}>
                      {h.name} ({h.host}:{h.port})
                    </option>
                  ))}
                  {connectedHosts.length === 0 && (
                    <option value="" disabled>
                      暂无已连接主机
                    </option>
                  )}
                </select>
              </div>

              <div className="settings-row">
                <div className="settings-row-main">
                  <div className="settings-row-label">步骤二：转发模式</div>
                  <div className="settings-row-desc">
                    local：本机监听 → 远程访问；remote：远程监听 → 回连本机；dynamic：SOCKS5 代理
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                  {(['local', 'remote', 'dynamic'] as TunnelMode[]).map((m) => (
                    <label
                      key={m}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 12,
                        cursor: 'pointer',
                        padding: '4px 10px',
                        borderRadius: 6,
                        background:
                          form.mode === m ? 'var(--color-bg-tertiary, rgba(127,127,127,0.15))' : 'transparent',
                        fontWeight: form.mode === m ? 600 : 400,
                      }}
                    >
                      <input
                        type="radio"
                        checked={form.mode === m}
                        onChange={() => setForm({ ...form, mode: m })}
                      />
                      <ModePill mode={m} />
                    </label>
                  ))}
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-main">
                  <div className="settings-row-label">步骤三：本地监听地址</div>
                  <div className="settings-row-desc">0.0.0.0 / :: 表示对外网卡开放（高危）</div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <select
                    className="settings-select"
                    value={form.localAddr}
                    onChange={(e) => setForm({ ...form, localAddr: e.target.value })}
                    style={{ minWidth: 140 }}
                  >
                    {LISTEN_ADDR_PRESETS.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                    <option value="custom">自定义…</option>
                  </select>
                  {form.localAddr === 'custom' && (
                    <input
                      type="text"
                      className="form-input form-input-compact"
                      placeholder="例如 192.168.1.10"
                      value={form.localAddrCustom}
                      onChange={(e) => setForm({ ...form, localAddrCustom: e.target.value })}
                      style={{ width: 180 }}
                    />
                  )}
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-main">
                  <div className="settings-row-label">步骤四：本地端口</div>
                  <div className="settings-row-desc">1 - 65535</div>
                </div>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  className="form-input form-input-compact"
                  style={{ width: 120 }}
                  value={form.localPort}
                  onChange={(e) => setForm({ ...form, localPort: e.target.value })}
                />
              </div>

              {form.mode !== 'dynamic' && (
                <>
                  <div className="settings-row">
                    <div className="settings-row-main">
                      <div className="settings-row-label">步骤五：远程地址</div>
                      <div className="settings-row-desc">目标主机/IP（local 模式下是对端可达地址，remote 模式下是本机可达地址）</div>
                    </div>
                    <input
                      type="text"
                      className="form-input form-input-compact"
                      placeholder="例如 10.0.0.1 或 127.0.0.1"
                      style={{ width: 200 }}
                      value={form.remoteAddr}
                      onChange={(e) => setForm({ ...form, remoteAddr: e.target.value })}
                    />
                  </div>
                  <div className="settings-row">
                    <div className="settings-row-main">
                      <div className="settings-row-label">远程端口</div>
                      <div className="settings-row-desc">1 - 65535</div>
                    </div>
                    <input
                      type="number"
                      min={1}
                      max={65535}
                      className="form-input form-input-compact"
                      style={{ width: 120 }}
                      value={form.remotePort}
                      onChange={(e) => setForm({ ...form, remotePort: e.target.value })}
                    />
                  </div>
                </>
              )}

              <div className="settings-row">
                <div className="settings-row-main">
                  <div className="settings-row-label">步骤六：标签与备注</div>
                  <div className="settings-row-desc">标签用逗号分隔；备注可选</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <input
                    type="text"
                    className="form-input form-input-compact"
                    placeholder="tags, comma separated"
                    value={form.tags}
                    onChange={(e) => setForm({ ...form, tags: e.target.value })}
                    style={{ width: 260 }}
                  />
                  <textarea
                    className="form-input form-input-compact"
                    placeholder="备注（可选）"
                    value={form.comment}
                    onChange={(e) => setForm({ ...form, comment: e.target.value })}
                    style={{ width: 260, minHeight: 56, resize: 'vertical' }}
                  />
                </div>
              </div>

              <div className="settings-row">
                <div className="settings-row-main">
                  <div className="settings-row-label">自启</div>
                  <div className="settings-row-desc">保存后或主机重连后自动启动此隧道</div>
                </div>
                <label className="form-switch">
                  <input
                    type="checkbox"
                    checked={form.autoStart}
                    onChange={(e) => setForm({ ...form, autoStart: e.target.checked })}
                  />
                  <span className="form-switch-track" aria-hidden="true" />
                </label>
              </div>

              {isDangerousMode && (
                <div
                  style={{
                    marginTop: 12,
                    padding: '10px 12px',
                    borderRadius: 8,
                    background: 'rgba(239,68,68,0.10)',
                    border: '1px solid rgba(239,68,68,0.25)',
                  }}
                >
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 12,
                      color: 'var(--color-danger, #ef4444)',
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={form.riskConfirmed}
                      onChange={(e) => setForm({ ...form, riskConfirmed: e.target.checked })}
                    />
                    我已了解风险并确认开启
                    {form.mode === 'remote' && '（远程转发模式）'}
                    {(finalLocalAddr === '0.0.0.0' || finalLocalAddr === '::') && '（监听所有网卡）'}
                  </label>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    setShowForm(false);
                    setEditingId(null);
                    setForm(emptyForm);
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleSave()}
                  disabled={!canSave}
                >
                  {editingId ? '保存修改' : '创建规则'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
