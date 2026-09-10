import { useState, useEffect, useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { usePluginStore, type PluginInfo } from '../../store/pluginStore';
import { useToastStore } from '../Toast';
import { PluginConfigForm } from './PluginConfigForm';
import { Settings, Shield, Trash2, Package } from 'lucide-react';

const HIGH_RISK: string[] = ['ssh.run', 'server.write', 'sftp.operate', 'tunnel.manage'];
const MEDIUM_RISK: string[] = [
  'network.http',
  'file.local.write',
  'server.manage',
  'updater.manage',
];

function riskColor(perm: string): string {
  if (HIGH_RISK.includes(perm)) return '#ef4444';
  if (MEDIUM_RISK.includes(perm)) return '#f59e0b';
  return '#22c55e';
}

/** 权限 ID → i18n key（与 permissions.rs 对齐） */
const PERM_DESC_KEY: Record<string, string> = {
  'network.http': 'plugin.permissionDescNetworkHttp',
  'storage.read': 'plugin.permissionDescStorageRead',
  'storage.write': 'plugin.permissionDescStorageWrite',
  'file.local.read': 'plugin.permissionDescFileLocalRead',
  'file.local.write': 'plugin.permissionDescFileLocalWrite',
  'server.read': 'plugin.permissionDescServerRead',
  'server.write': 'plugin.permissionDescServerWrite',
  'server.manage': 'plugin.permissionDescServerManage',
  'ssh.run': 'plugin.permissionDescSshRun',
  'sftp.operate': 'plugin.permissionDescSftpOperate',
  'ui.notification': 'plugin.permissionDescUiNotification',
  'ui.dialog': 'plugin.permissionDescUiDialog',
  'ui.inject-menu': 'plugin.permissionDescUiInjectMenu',
  'theme.read': 'plugin.permissionDescThemeRead',
  'tunnel.manage': 'plugin.permissionDescTunnelManage',
  'log.read': 'plugin.permissionDescLogRead',
  'updater.manage': 'plugin.permissionDescUpdaterManage',
};

export function PluginDetail() {
  const { t } = useTranslation();
  const plugins = usePluginStore((s) => s.plugins);
  const togglePlugin = usePluginStore((s) => s.togglePlugin);
  const uninstallComplete = usePluginStore((s) => s.uninstallComplete);
  const setGranted = usePluginStore((s) => s.setGranted);
  const getConfig = usePluginStore((s) => s.getConfig);
  const setConfig = usePluginStore((s) => s.setConfig);
  const loadPlugins = usePluginStore((s) => s.loadPlugins);
  const installFromFile = usePluginStore((s) => s.installFromFile);
  const pushToast = useToastStore.getState().push;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [config, setConfigState] = useState<Record<string, unknown>>({});
  const [showConfig, setShowConfig] = useState(false);

  const selected = selectedId ? (plugins.find((p) => p.id === selectedId) ?? null) : null;

  useEffect(() => {
    if (selected) {
      void getConfig(selected.id).then(setConfigState);
    }
  }, [selected, getConfig]);

  const handleTogglePerm = useCallback(
    async (plugin: PluginInfo, perm: string, granted: boolean) => {
      const current = [...plugin.grantedPermissions];
      if (granted) {
        if (!current.includes(perm)) current.push(perm);
      } else {
        const idx = current.indexOf(perm);
        if (idx >= 0) current.splice(idx, 1);
      }
      try {
        await setGranted(plugin.id, current);
        await loadPlugins();
        pushToast('success', granted ? t('plugin.permGranted', { perm }) : t('plugin.permRevoked', { perm }));
      } catch (e) {
        pushToast('error', `${t('common.failed')}：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    [setGranted, loadPlugins, pushToast],
  );

  const handleInstallFromFile = useCallback(async () => {
    try {
      const selected = await open({
        filters: [{ name: 'RD Plugin', extensions: ['rdplugin', 'zip'] }],
        multiple: false,
      });
      if (!selected || Array.isArray(selected)) return;
      const zipPath = selected;
      const info = await installFromFile(zipPath);
      if (info) {
        pushToast('success', t('plugin.installSuccessWithName', { name: info.name }));
      }
    } catch (e) {
      pushToast('error', `${t('plugin.installFailed')}：${e instanceof Error ? e.message : String(e)}`);
    }
  }, [installFromFile, pushToast]);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        if (file.name.endsWith('.rdplugin') || file.name.endsWith('.zip')) {
          const path = (file as unknown as { path?: string }).path;
          if (!path) continue;
          try {
            const info = await installFromFile(path);
            if (info) {
              pushToast('success', t('plugin.installSuccessWithName', { name: info.name }));
            }
          } catch (err) {
            pushToast(
              'error',
              `${t('plugin.dragInstallFailed')}：${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    },
    [installFromFile, pushToast],
  );

  if (plugins.length === 0) {
    return (
      <div onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
        <div className="settings-row" style={{ marginBottom: 16 }}>
          <div className="settings-row-main">
            <div className="settings-row-label">{t('plugin.installFromZip')}</div>
            <div className="settings-row-desc">
              {t('plugin.installHint')}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void handleInstallFromFile()}
          >
            <Package size={12} style={{ marginRight: 4 }} />
            {t('plugin.selectFileToInstall')}
          </button>
        </div>
        <div
          style={{
            padding: 32,
            textAlign: 'center',
            color: 'var(--color-text-muted)',
            fontSize: 13,
          }}
        >
          {t('plugin.noPlugins')}
        </div>
      </div>
    );
  }

  return (
    <div onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
      <div className="settings-row" style={{ marginBottom: 16 }}>
        <div className="settings-row-main">
          <div className="settings-row-label">{t('plugin.installFromZip')}</div>
          <div className="settings-row-desc">
            {t('plugin.installHint')}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void handleInstallFromFile()}
        >
          <Package size={12} style={{ marginRight: 4 }} />
          {t('plugin.selectFileToInstall')}
        </button>
      </div>
      <div style={{ display: 'flex', gap: 12, minHeight: 400 }}>
      {/* 左侧列表 */}
      <div style={{ width: 280, flexShrink: 0, overflowY: 'auto' }}>
        {plugins.map((plugin) => (
          <div
            key={plugin.id}
            onClick={() => {
              setSelectedId(plugin.id);
              setShowConfig(false);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '8px 10px',
              borderRadius: 8,
              cursor: 'pointer',
              background:
                selectedId === plugin.id ? 'var(--color-bg-secondary)' : 'transparent',
            }}
          >
            {/* 图标 */}
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                flexShrink: 0,
                background: 'var(--color-bg-secondary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
              }}
            >
              {plugin.name.charAt(0).toUpperCase()}
            </div>
            {/* 信息 */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 500,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {plugin.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                v{plugin.version} · {plugin.category}
              </div>
            </div>
            {/* 启用开关 + 卸载 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <label
                className="form-switch"
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  type="checkbox"
                  checked={plugin.enabled}
                  onChange={(e) => void togglePlugin(plugin.id, e.target.checked)}
                />
                <span className="form-switch-track" aria-hidden="true" />
              </label>
              <button
                type="button"
                className="btn"
                onClick={(e) => {
                  e.stopPropagation();
                  void uninstallComplete(plugin.id);
                }}
                title={t('plugin.uninstall')}
                style={{
                  padding: '2px 6px',
                  fontSize: 12,
                  color: 'var(--color-danger, #ef4444)',
                  background: 'transparent',
                  border: '1px solid var(--color-border, rgba(127,127,127,0.18))',
                  cursor: 'pointer',
                  borderRadius: 4,
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 右侧详情 */}
      {selected && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 4px' }}>
          {/* 头部 */}
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <div
              style={{
                width: 48,
                height: 48,
                borderRadius: 12,
                flexShrink: 0,
                background: 'var(--color-bg-secondary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 20,
                fontWeight: 600,
                color: 'var(--color-text-secondary)',
              }}
            >
              {selected.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{selected.name}</div>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                v{selected.version}
              </div>
            </div>
            <div style={{ flex: 1 }} />
            {/* 操作按钮 */}
            {selected.manifest.configSchema && (
              <button
                type="button"
                className={`btn ${showConfig ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setShowConfig(!showConfig)}
                style={{ fontSize: 12, padding: '4px 10px' }}
              >
                <Settings size={12} style={{ marginRight: 4 }} />
                {t('plugin.config')}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void uninstallComplete(selected.id)}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                color: 'var(--color-danger, #ef4444)',
              }}
            >
              <Trash2 size={12} style={{ marginRight: 4 }} />
              {t('plugin.uninstall')}
            </button>
          </div>

          {/* 元信息 */}
          <div
            style={{
              fontSize: 12,
              color: 'var(--color-text-muted)',
              marginBottom: 16,
              lineHeight: 1.7,
            }}
          >
            <div>{t('plugin.author')}：{selected.author || t('common.unknown')}</div>
            <div>{t('plugin.category')}：{selected.category}</div>
            <div>{t('plugin.apiVersion')}：{selected.apiVersion}</div>
            {selected.loadError && (
              <div style={{ color: 'var(--color-danger, #ef4444)' }}>
                {t('plugin.loadError')}：{selected.loadError}
              </div>
            )}
          </div>

          {/* 配置卡 */}
          {showConfig && selected.manifest.configSchema && (
            <div style={{ marginBottom: 16 }}>
              <PluginConfigForm
                manifest={selected.manifest}
                initialConfig={config}
                onSave={async (newConfig) => {
                  await setConfig(selected.id, newConfig);
                  setConfigState(newConfig);
                  pushToast('success', t('plugin.configSaved'));
                }}
              />
            </div>
          )}

          {/* 权限卡 */}
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Shield size={14} />
            {t('plugin.permissions')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {selected.grantedPermissions.length === 0 && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-muted)',
                  padding: '8px 0',
                }}
              >
                {t('plugin.noGrantedPermissions')}
              </div>
            )}
            {selected.grantedPermissions.map((perm) => (
              <div
                key={perm}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 10px',
                  borderRadius: 6,
                  background: 'var(--color-bg-secondary)',
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: riskColor(perm),
                    flexShrink: 0,
                  }}
                />
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{perm}</span>
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--color-text-muted)',
                      marginLeft: 8,
                    }}
                  >
                    {t(HIGH_RISK.includes(perm) ? 'plugin.riskHigh' : MEDIUM_RISK.includes(perm) ? 'plugin.riskMedium' : 'plugin.riskLow')} · {t(PERM_DESC_KEY[perm] ?? '') || perm}
                  </span>
                </div>
                <label className="form-switch" style={{ flexShrink: 0 }}>
                  <input
                    type="checkbox"
                    checked={true}
                    onChange={(e) => void handleTogglePerm(selected, perm, e.target.checked)}
                  />
                  <span className="form-switch-track" aria-hidden="true" />
                </label>
              </div>
            ))}
          </div>

          {/* 未授予的权限（manifest 声明但未授予） */}
          {selected.manifest.permissions.filter(
            (p) => !selected.grantedPermissions.includes(p),
          ).length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-muted)',
                  marginBottom: 4,
                }}
              >
                {t('plugin.notGrantedPermissions')}
              </div>
              {selected.manifest.permissions
                .filter((p) => !selected.grantedPermissions.includes(p))
                .map((perm) => (
                  <div
                    key={perm}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      borderRadius: 6,
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: riskColor(perm),
                        flexShrink: 0,
                        opacity: 0.4,
                      }}
                    />
                    <span style={{ fontSize: 13, opacity: 0.6 }}>{perm}</span>
                    <span
                      style={{
                        fontSize: 11,
                        color: 'var(--color-text-muted)',
                        marginLeft: 8,
                        opacity: 0.6,
                      }}
                    >
                      {t(PERM_DESC_KEY[perm] ?? '') || perm}
                    </span>
                    <div style={{ flex: 1 }} />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void handleTogglePerm(selected, perm, true)}
                      style={{ fontSize: 11, padding: '2px 8px' }}
                    >
                      {t('plugin.grant')}
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
