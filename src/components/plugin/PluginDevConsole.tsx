import { useState, useMemo } from 'react';
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
    category: '网络',
    label: '发起 HTTP 请求',
    description: '允许插件通过 HTTP/HTTPS 协议访问外部网络资源',
    icon: Globe,
  },
  'storage.read': {
    category: '存储',
    label: '读取插件存储空间',
    description: '允许插件读取其独立沙箱内的持久化存储数据',
    icon: Database,
  },
  'storage.write': {
    category: '存储',
    label: '写入插件存储空间',
    description: '允许插件向其独立沙箱内写入持久化存储数据',
    icon: Database,
  },
  'file.local.read': {
    category: '本地文件',
    label: '读取本地文件',
    description: '允许插件读取用户本地文件系统中的文件内容',
    icon: FileText,
  },
  'file.local.write': {
    category: '本地文件',
    label: '写入本地文件',
    description: '允许插件向用户本地文件系统写入或修改文件',
    icon: FileText,
  },
  'server.read': {
    category: '主机管理',
    label: '读取主机配置',
    description: '允许插件获取已保存的 SSH 主机列表（脱敏后，不含密码/私钥）',
    icon: Server,
  },
  'server.write': {
    category: '主机管理',
    label: '新增/修改主机',
    description: '允许插件创建新的主机配置或修改现有主机信息',
    icon: Server,
  },
  'server.manage': {
    category: '主机管理',
    label: '管理主机连接',
    description: '允许插件主动连接、断开主机或测试主机连通性',
    icon: Server,
  },
  'ssh.run': {
    category: 'SSH',
    label: '执行 SSH 命令',
    description: '允许插件在已连接的 SSH 主机上执行 Shell 命令',
    icon: Terminal,
  },
  'sftp.operate': {
    category: 'SFTP',
    label: '操作远程文件',
    description: '允许插件通过 SFTP 浏览、上传、下载、重命名远程文件',
    icon: FolderOpen,
  },
  'ui.notification': {
    category: '界面',
    label: '发送系统通知',
    description: '允许插件向用户推送 Toast 通知消息',
    icon: Bell,
  },
  'ui.dialog': {
    category: '界面',
    label: '弹出对话框',
    description: '允许插件弹出确认框、输入框等模态对话框',
    icon: MessageSquare,
  },
  'ui.inject-menu': {
    category: '界面',
    label: '注入菜单项',
    description: '允许插件在侧边栏、右键菜单、工具栏等位置注入自定义按钮',
    icon: Lock,
  },
  'theme.read': {
    category: '主题',
    label: '读取主题信息',
    description: '允许插件获取当前应用主题色板与主题列表',
    icon: Palette,
  },
  'tunnel.manage': {
    category: '端口转发',
    label: '管理 SSH 隧道',
    description: '允许插件创建、启动、停止、删除 SSH 端口转发隧道',
    icon: ArrowLeftRight,
  },
  'log.read': {
    category: '日志',
    label: '读取应用日志',
    description: '允许插件读取应用日志流，便于监控和调试',
    icon: FileSearch,
  },
  'updater.manage': {
    category: '更新',
    label: '管理应用更新',
    description: '允许插件检查、下载、触发应用版本更新',
    icon: RefreshCw,
  },
};

const ALL_CATEGORIES = [
  '网络',
  '存储',
  '本地文件',
  '主机管理',
  'SSH',
  'SFTP',
  '界面',
  '主题',
  '端口转发',
  '日志',
  '更新',
] as const;

const CATEGORY_COLORS: Record<string, string> = {
  网络: '#3b82f6',
  存储: '#8b5cf6',
  本地文件: '#06b6d4',
  主机管理: '#f59e0b',
  SSH: '#22c55e',
  SFTP: '#14b8a6',
  界面: '#ec4899',
  主题: '#a855f7',
  端口转发: '#ef4444',
  日志: '#6b7280',
  更新: '#10b981',
};

export function PluginDevConsole() {
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
      const category = meta?.category ?? '其他';
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
          <div>暂无已安装的插件</div>
          <div style={{ marginTop: 4, fontSize: 12, opacity: 0.7 }}>
            安装插件后，可在此处查看各插件申请的权限详情
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
          插件列表
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
                <span>{permCount} 项权限</span>
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
                    已启用
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
                    已禁用
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
                {selectedPlugin.manifest.description ?? '暂无描述'}
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
                    申请权限：
                    <strong style={{ color: 'var(--text-primary)' }}>
                      {(selectedPlugin.manifest.permissions ?? []).length}
                    </strong>{' '}
                    项
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
                    已授予：
                    <strong style={{ color: 'var(--color-success, #22c55e)' }}>
                      {(selectedPlugin.grantedPermissions ?? []).length}
                    </strong>{' '}
                    项
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
                该插件未申请任何权限
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
                        {group.category}
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
                                    {meta?.label ?? perm}
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
                                      已授予
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
                                      未授予
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
                                  {meta?.description ?? perm}
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
