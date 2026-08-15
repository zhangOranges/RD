import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import type { PluginManifest, PluginPermission } from '../../types/plugin';

interface Props {
  manifest: PluginManifest;
  onConfirm: (grantedPermissions: PluginPermission[]) => void;
  onCancel: () => void;
}

// 权限风险等级映射（与 Rust 端对齐）
const HIGH_RISK: PluginPermission[] = ['ssh.run', 'server.write', 'sftp.operate', 'tunnel.manage'];
const MEDIUM_RISK: PluginPermission[] = [
  'network.http',
  'file.local.write',
  'server.manage',
  'updater.manage',
];

function riskLevel(perm: PluginPermission): 'high' | 'medium' | 'low' {
  if (HIGH_RISK.includes(perm)) return 'high';
  if (MEDIUM_RISK.includes(perm)) return 'medium';
  return 'low';
}

const RISK_COLORS: Record<'high' | 'medium' | 'low', string> = {
  high: 'var(--color-danger, #ef4444)',
  medium: 'var(--color-warning, #f59e0b)',
  low: 'var(--color-success, #22c55e)',
};

const RISK_LABELS: Record<'high' | 'medium' | 'low', string> = {
  high: '高危',
  medium: '中风险',
  low: '低风险',
};

// 高危权限后果说明
const HIGH_RISK_CONSEQUENCES: Record<string, string> = {
  'ssh.run': '插件可在远程服务器上执行任意命令，包括读取/修改/删除文件、安装软件、创建后门等。',
  'server.write':
    '插件可修改你的主机配置，包括更改密码/密钥/端口，可能导致你无法连接或被中间人攻击。',
  'sftp.operate': '插件可上传/下载/删除远程文件，可能覆盖关键系统文件或窃取敏感数据。',
  'tunnel.manage':
    '插件可创建端口转发规则，可能将内网服务暴露到公网或在服务器上开放端口。',
};

const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  'network.http': '发起 HTTP/HTTPS 网络请求',
  'storage.read': '读取插件持久化存储',
  'storage.write': '写入插件持久化存储',
  'file.local.read': '读取本地文件',
  'file.local.write': '写入本地文件',
  'server.read': '读取主机配置和连接状态',
  'server.write': '修改主机配置（增删改）',
  'server.manage': '管理主机分类和全局开关',
  'ssh.run': '在远程主机上执行 SSH 命令',
  'sftp.operate': '操作远程文件（上传/下载/删除/重命名）',
  'ui.notification': '显示通知提示',
  'ui.dialog': '弹出确认/输入对话框',
  'ui.inject-menu': '注入工具栏/侧边栏菜单项',
  'theme.read': '读取当前主题信息',
  'tunnel.manage': '管理端口转发规则（含远程转发）',
  'log.read': '读取内核日志',
  'updater.manage': '管理应用更新',
};

export function PluginInstallDialog({ manifest, onConfirm, onCancel }: Props) {
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const handleConfirm = useCallback(() => {
    onConfirm(manifest.permissions);
  }, [manifest.permissions, onConfirm]);

  const hasHighRisk = manifest.permissions.some((p) => HIGH_RISK.includes(p));

  return createPortal(
    <div className="dialog-overlay" onClick={onCancel} role="dialog" aria-modal="true">
      <div
        className="dialog dialog-plugin-install"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560 }}
      >
        {/* 头部 */}
        <div className="dialog-header">
          <h2 className="dialog-title">安装插件确认</h2>
        </div>

        <div className="dialog-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          {/* 插件信息 */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                background: 'var(--color-bg-secondary, rgba(0,0,0,0.04))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 20,
                fontWeight: 600,
                color: 'var(--color-text-secondary, #6e6e73)',
              }}
            >
              {manifest.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{manifest.name}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted, #98989d)' }}>
                v{manifest.version} · {manifest.author}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-muted, #98989d)',
                  marginTop: 2,
                }}
              >
                {manifest.description}
              </div>
            </div>
          </div>

          {/* 风险提示条 */}
          {hasHighRisk && (
            <div
              style={{
                background: 'var(--color-danger-soft, rgba(239,68,68,0.1))',
                border: '1px solid var(--color-danger, #ef4444)',
                borderRadius: 8,
                padding: '10px 12px',
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--color-danger, #ef4444)',
                }}
              >
                ⚠ 该插件请求高危权限
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-secondary, #6e6e73)',
                  marginTop: 4,
                }}
              >
                授予高危权限意味着插件可以在远程服务器上执行任意操作，请确认你信任该插件的来源。
              </div>
            </div>
          )}

          {/* 权限清单 */}
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>请求的权限</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {manifest.permissions.map((perm) => {
              const risk = riskLevel(perm);
              const color = RISK_COLORS[risk];
              const label = RISK_LABELS[risk];
              const desc = PERMISSION_DESCRIPTIONS[perm] ?? perm;
              const consequence = HIGH_RISK_CONSEQUENCES[perm];
              return (
                <div
                  key={perm}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    padding: '8px 10px',
                    borderRadius: 6,
                    background:
                      risk === 'high'
                        ? 'var(--color-danger-soft, rgba(239,68,68,0.05))'
                        : 'var(--color-bg-secondary, rgba(0,0,0,0.04))',
                    border:
                      risk === 'high'
                        ? '1px solid var(--color-danger, #ef4444)'
                        : '1px solid transparent',
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: color,
                      marginTop: 4,
                      flexShrink: 0,
                    }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>
                      {perm}
                      <span style={{ marginLeft: 8, fontSize: 11, color, fontWeight: 600 }}>
                        {label}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 12,
                        color: 'var(--color-text-muted, #98989d)',
                      }}
                    >
                      {desc}
                    </div>
                    {consequence && (
                      <div
                        style={{
                          fontSize: 12,
                          color: 'var(--color-danger, #ef4444)',
                          marginTop: 4,
                        }}
                      >
                        {consequence}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 复选框 */}
          {hasHighRisk && (
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 16,
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>我已阅读并理解以上风险</span>
            </label>
          )}
        </div>

        {/* 底部按钮 */}
        <div
          className="dialog-footer-right"
          style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}
        >
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={hasHighRisk && !acknowledged}
          >
            确认授予权限并安装
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
