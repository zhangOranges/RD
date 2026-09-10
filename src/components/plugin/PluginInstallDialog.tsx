import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
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

const RISK_LABEL_KEYS: Record<'high' | 'medium' | 'low', string> = {
  high: 'riskHigh',
  medium: 'riskMedium',
  low: 'riskLow',
};

// 高危权限后果说明（i18n key）
const HIGH_RISK_CONSEQUENCE_KEYS: Record<string, string> = {
  'ssh.run': 'highRiskSshRun',
  'server.write': 'highRiskServerWrite',
  'sftp.operate': 'highRiskSftpOperate',
  'tunnel.manage': 'highRiskTunnelManage',
};

// 权限描述 i18n key 映射
const PERMISSION_DESC_KEYS: Record<string, string> = {
  'network.http': 'permissionDescNetworkHttp',
  'storage.read': 'permissionDescStorageRead',
  'storage.write': 'permissionDescStorageWrite',
  'file.local.read': 'permissionDescFileLocalRead',
  'file.local.write': 'permissionDescFileLocalWrite',
  'server.read': 'permissionDescServerRead',
  'server.write': 'permissionDescServerWrite',
  'server.manage': 'permissionDescServerManage',
  'ssh.run': 'permissionDescSshRun',
  'sftp.operate': 'permissionDescSftpOperate',
  'ui.notification': 'permissionDescUiNotification',
  'ui.dialog': 'permissionDescUiDialog',
  'ui.inject-menu': 'permissionDescUiInjectMenu',
  'theme.read': 'permissionDescThemeRead',
  'tunnel.manage': 'permissionDescTunnelManage',
  'log.read': 'permissionDescLogRead',
  'updater.manage': 'permissionDescUpdaterManage',
};

export function PluginInstallDialog({ manifest, onConfirm, onCancel }: Props) {
  const { t } = useTranslation();
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
          <h2 className="dialog-title">{t('plugin.installConfirm')}</h2>
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
                ⚠ {t('plugin.highRiskWarning')}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-secondary, #6e6e73)',
                  marginTop: 4,
                }}
              >
                {t('plugin.highRiskWarningDesc')}
              </div>
            </div>
          )}

          {/* 权限清单 */}
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t('plugin.requestedPermissions')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {manifest.permissions.map((perm) => {
              const risk = riskLevel(perm);
              const color = RISK_COLORS[risk];
              const label = t(`plugin.${RISK_LABEL_KEYS[risk]}`);
              const descKey = PERMISSION_DESC_KEYS[perm];
              const desc = descKey ? t(`plugin.${descKey}`) : perm;
              const consequenceKey = HIGH_RISK_CONSEQUENCE_KEYS[perm];
              const consequence = consequenceKey ? t(`plugin.${consequenceKey}`) : undefined;
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
              <span>{t('plugin.acknowledgeRisk')}</span>
            </label>
          )}
        </div>

        {/* 底部按钮 */}
        <div
          className="dialog-footer-right"
          style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}
        >
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleConfirm}
            disabled={hasHighRisk && !acknowledged}
          >
            {t('plugin.confirmInstall')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
