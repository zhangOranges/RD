import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { usePluginStore, type PluginInfo } from '../../store/pluginStore';
import type { PluginPermission } from '../../types/plugin';
import { Shield, Check, Lock, Globe, Database, FileText, Server, Terminal, FolderOpen, Bell, MessageSquare, Palette, ArrowLeftRight, FileSearch, RefreshCw } from 'lucide-react';

/** 权限元信息：分类、描述、图标 */
interface PermissionMeta {
  category: string;
  label: string;
  description: string;
  icon: typeof Shield;
}

const PERMISSION_META: Record<PluginPermission, PermissionMeta> = {
  'network.http': {
    category: 'network',
    label: 'permLabelNetworkHttp',
    description: 'permissionDescNetworkHttp',
    icon: Globe,
  },
  'storage.read': {
    category: 'storage',
    label: 'permLabelStorageRead',
    description: 'permissionDescStorageRead',
    icon: Database,
  },
  'storage.write': {
    category: 'storage',
    label: 'permLabelStorageWrite',
    description: 'permissionDescStorageWrite',
    icon: Database,
  },
  'file.local.read': {
    category: 'localFile',
    label: 'permLabelFileLocalRead',
    description: 'permissionDescFileLocalRead',
    icon: FileText,
  },
  'file.local.write': {
    category: 'localFile',
    label: 'permLabelFileLocalWrite',
    description: 'permissionDescFileLocalWrite',
    icon: FileText,
  },
  'server.read': {
    category: 'server',
    label: 'permLabelServerRead',
    description: 'permissionDescServerRead',
    icon: Server,
  },
  'server.write': {
    category: 'server',
    label: 'permLabelServerWrite',
    description: 'permissionDescServerWrite',
    icon: Server,
  },
  'server.manage': {
    category: 'server',
    label: 'permLabelServerManage',
    description: 'permissionDescServerManage',
    icon: Server,
  },
  'ssh.run': {
    category: 'ssh',
    label: 'permLabelSshRun',
    description: 'permissionDescSshRun',
    icon: Terminal,
  },
  'sftp.operate': {
    category: 'sftp',
    label: 'permLabelSftpOperate',
    description: 'permissionDescSftpOperate',
    icon: FolderOpen,
  },
  'ui.notification': {
    category: 'ui',
    label: 'permLabelUiNotification',
    description: 'permissionDescUiNotification',
    icon: Bell,
  },
  'ui.dialog': {
    category: 'ui',
    label: 'permLabelUiDialog',
    description: 'permissionDescUiDialog',
    icon: MessageSquare,
  },
  'ui.inject-menu': {
    category: 'ui',
    label: 'permLabelUiInjectMenu',
    description: 'permissionDescUiInjectMenu',
    icon: Lock,
  },
  'theme.read': {
    category: 'theme',
    label: 'permLabelThemeRead',
    description: 'permissionDescThemeRead',
    icon: Palette,
  },
  'tunnel.manage': {
    category: 'tunnel',
    label: 'permLabelTunnelManage',
    description: 'permissionDescTunnelManage',
    icon: ArrowLeftRight,
  },
  'log.read': {
    category: 'log',
    label: 'permLabelLogRead',
    description: 'permissionDescLogRead',
    icon: FileSearch,
  },
  'updater.manage': {
    category: 'updater',
    label: 'permLabelUpdaterManage',
    description: 'permissionDescUpdaterManage',
    icon: RefreshCw,
  },
};

const ALL_CATEGORIES = [
  'network',
  'storage',
  'localFile',
  'server',
  'ssh',
  'sftp',
  'ui',
  'theme',
  'tunnel',
  'log',
  'updater',
] as const;

const CATEGORY_COLORS: Record<string, string> = {
  network: '#3b82f6',
  storage: '#8b5cf6',
  localFile: '#06b6d4',
  server: '#f59e0b',
  ssh: '#22c55e',
  sftp: '#14b8a6',
  ui: '#ec4899',
  theme: '#a855f7',
  tunnel: '#ef4444',
  log: '#6b7280',
  updater: '#10b981',
};

export function PluginDevConsole() {
  const { t } = useTranslation();
  const plugins = usePluginStore((s) => s.plugins);
  const [selectedPluginId, setSelectedPluginId] = useState<string | null>(
    plugins[0]?.id ?? null,
  );

  // 当插件列表变化且当前选择无效时，自动选第一个
  const selectedPlugin: PluginInfo | null = useMemo(() => {
    if (selectedPluginId == null) return plugins[0] ?? null;
    return plugins.find((p) => p.id === selectedPluginId) ?? plugins[0] ?? null;
  }, [selectedPluginId, plugins]);

  // 按分类聚合权限
  const groupedPermissions = useMemo(() => {
    if (!selectedPlugin) return [] as { category: string; items: { perm: PluginPermission; granted: boolean }[] }[];
    const perms = selectedPlugin.manifest.permissions ?? [];
    const granted = new Set(selectedPlugin.grantedPermissions ?? []);
    const groups = new Map<string, { perm: PluginPermission; granted: boolean }[]>();
    for (const perm of perms) {
      const meta = PERMISSION_META[perm];
      const category = meta?.category ?? 'other';
      if (!groups.has(category)) groups.set(category, []);
      groups.get(category)!.push({ perm, granted: granted.has(perm) });
    }
    // 按 ALL_CATEGORIES 顺序排序
    return ALL_CATEGORIES.filter((c) => groups.has(c)).map((c) => ({
      category: c,
      items: groups.get(c)!,
    }));
  }, [selectedPlugin]);

  if (plugins.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '64px 16px',
          color: 'var(--color-text-muted)',
          fontSize: 13,
          textAlign: 'center',
          lineHeight: 1.7,
        }}
      >
        <div>
            <Shield size={40} style={{ margin: '0 auto 16px', opacity: 0.4 }} />
            <div>{t('plugin.noPlugins')}</div>
            <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
              {t('plugin.noPluginsDesc')}
            </div>
          </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        gap: 16,
        minHeight: 380,
        minWidth: 0,
      }}
    >
      {/* 左侧：插件列表 */}
      <div
        style={{
          width: 200,
          flexShrink: 0,
          borderRight: '1px solid var(--color-border)',
          paddingRight: 8,
          overflowY: 'auto',
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--color-text-muted)',
            padding: '4px 8px 8px',
            letterSpacing: 0.3,
          }}
        >
          {t('plugin.pluginList')}
        </div>
        {plugins.map((p) => {
          const isActive = selectedPlugin?.id === p.id;
          const permCount = p.manifest.permissions?.length ?? 0;
          return (
            <div
              key={p.id}
              onClick={() => setSelectedPluginId(p.id)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                padding: '10px 12px',
                borderRadius: 8,
                cursor: 'pointer',
                marginBottom: 4,
                background: isActive ? 'var(--color-bg-secondary)' : 'transparent',
                border: isActive
                  ? '1px solid var(--color-primary-soft, rgba(59,130,246,0.25))'
                  : '1px solid transparent',
                transition: 'all 0.15s ease',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  fontWeight: 500,
                  color: 'var(--text-primary)',
                }}
              >
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: p.enabled
                      ? 'var(--color-success, #22c55e)'
                      : 'var(--color-text-muted)',
                    flexShrink: 0,
                  }}
                />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {p.name}
                </span>
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--color-text-muted)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  paddingLeft: 16,
                }}
              >
                <span>v{p.version}</span>
                <span style={{ opacity: 0.5 }}>·</span>
                <span>{t('plugin.permissionCount', { count: permCount })}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 右侧：权限详情 */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {selectedPlugin && (
          <>
            {/* 插件头部 */}
            <div
              style={{
                padding: '4px 4px 16px',
                borderBottom: '1px solid var(--color-border)',
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginBottom: 6,
                }}
              >
                <h3
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    margin: 0,
                    color: 'var(--text-primary)',
                  }}
                >
                  {selectedPlugin.name}
                </h3>
                <span
                  style={{
                    fontSize: 11,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: 'var(--color-bg-secondary)',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  v{selectedPlugin.version}
                </span>
                {selectedPlugin.enabled ? (
                  <span
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: 'rgba(34,197,94,0.12)',
                      color: 'var(--color-success, #22c55e)',
                    }}
                  >
                    {t('plugin.enabled')}
                  </span>
                ) : (
                  <span
                    style={{
                      fontSize: 11,
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: 'rgba(107,114,128,0.12)',
                      color: 'var(--color-text-muted)',
                    }}
                  >
                    {t('plugin.disabled')}
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--color-text-muted)',
                  lineHeight: 1.6,
                }}
              >
                {selectedPlugin.manifest.description ?? t('plugin.noDescription')}
              </div>
              <div
                style={{
                  marginTop: 10,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  fontSize: 12,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    color: 'var(--color-text-muted)',
                  }}
                >
                  <Shield size={14} />
                  <span>
                    {t('plugin.requestedPermissions')}
                    <strong style={{ color: 'var(--text-primary)' }}>
                      {(selectedPlugin.manifest.permissions ?? []).length}
                    </strong>{' '}
                    {t('plugin.items')}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    color: 'var(--color-text-muted)',
                  }}
                >
                  <Check size={14} style={{ color: 'var(--color-success, #22c55e)' }} />
                  <span>
                    {t('plugin.granted')}
                    <strong style={{ color: 'var(--color-success, #22c55e)' }}>
                      {(selectedPlugin.grantedPermissions ?? []).length}
                    </strong>{' '}
                    {t('plugin.items')}
                  </span>
                </div>
              </div>
            </div>

            {/* 权限分组 */}
            {groupedPermissions.length === 0 ? (
              <div
                style={{
                  padding: '48px 16px',
                  textAlign: 'center',
                  color: 'var(--color-text-muted)',
                  fontSize: 13,
                }}
              >
                {t('plugin.noPermissionsRequested')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
                {groupedPermissions.map((group) => (
                  <div key={group.category}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        marginBottom: 10,
                      }}
                    >
                      <div
                        style={{
                          width: 3,
                          height: 14,
                          borderRadius: 2,
                          background:
                            CATEGORY_COLORS[group.category] ?? 'var(--color-primary)',
                        }}
                      />
                      <span
                        style={{
                          fontSize: 12,
                          fontWeight: 600,
                          color: 'var(--text-primary)',
                        }}
                      >
                        {t(`plugin.permCategory.${group.category}`)}
                      </span>
                      <span
                        style={{
                          fontSize: 11,
                          color: 'var(--color-text-muted)',
                        }}
                      >
                        ({group.items.length})
                      </span>
                    </div>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
                        gap: 8,
                        paddingLeft: 11,
                      }}
                    >
                      {group.items.map(({ perm, granted }) => {
                        const meta = PERMISSION_META[perm];
                        const IconCmp = meta?.icon ?? Shield;
                        return (
                          <div
                            key={perm}
                            style={{
                              padding: '12px 14px',
                              borderRadius: 10,
                              border: `1px solid ${granted
                                ? 'var(--color-border, #2a2d34)'
                                : 'rgba(239,68,68,0.25)'}`,
                              background: granted
                                ? 'var(--color-bg-secondary, #1a1c22)'
                                : 'rgba(239,68,68,0.04)',
                              position: 'relative',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: 10,
                              }}
                            >
                              <div
                                style={{
                                  width: 28,
                                  height: 28,
                                  borderRadius: 8,
                                  background: `${CATEGORY_COLORS[group.category] ?? 'var(--color-primary)'}20`,
                                  color: CATEGORY_COLORS[group.category] ?? 'var(--color-primary)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  flexShrink: 0,
                                  marginTop: 1,
                                }}
                              >
                                <IconCmp size={14} />
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: 8,
                                    marginBottom: 4,
                                  }}
                                >
                                  <span
                                    style={{
                                      fontSize: 13,
                                      fontWeight: 500,
                                      color: 'var(--text-primary)',
                                    }}
                                  >
                                    {meta ? t(`plugin.${meta.label}`) : perm}
                                  </span>
                                  {granted ? (
                                    <span
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 3,
                                        fontSize: 11,
                                        padding: '2px 6px',
                                        borderRadius: 999,
                                        background: 'rgba(34,197,94,0.12)',
                                        color: 'var(--color-success, #22c55e)',
                                        flexShrink: 0,
                                      }}
                                    >
                                      <Check size={10} />
                                      {t('plugin.granted')}
                                    </span>
                                  ) : (
                                    <span
                                      style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 3,
                                        fontSize: 11,
                                        padding: '2px 6px',
                                        borderRadius: 999,
                                        background: 'rgba(239,68,68,0.1)',
                                        color: 'var(--color-danger, #ef4444)',
                                        flexShrink: 0,
                                      }}
                                    >
                                      <Lock size={10} />
                                      {t('plugin.notGranted')}
                                    </span>
                                  )}
                                </div>
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: 'var(--color-text-muted)',
                                    lineHeight: 1.5,
                                  }}
                                >
                                  {meta ? t(`plugin.${meta.description}`) : perm}
                                </div>
                                <div
                                  style={{
                                    marginTop: 6,
                                    fontSize: 10,
                                    fontFamily: 'monospace',
                                    color: 'var(--color-text-muted)',
                                    opacity: 0.6,
                                  }}
                                >
                                  {perm}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
