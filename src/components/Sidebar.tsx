import { useState, useRef, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Plus,
  Pencil,
  Trash2,
  MoreHorizontal,
  Server,
  ChevronRight,
  ChevronDown,
  FolderOpen,
  Folder,
  Tag,
  Power,
  PowerOff,
  Copy,
} from 'lucide-react';
import { useHostStore } from '../store/hostStore';
import { useToastStore } from './Toast';
import { HostDialog } from './HostDialog';
import type { HostConfig, CategoryConfig, HostFormValues } from '../types';

type ContextMenuKind = 'blank' | 'category' | 'host';

interface ContextMenuState {
  kind: ContextMenuKind;
  x: number;
  y: number;
  categoryId?: string;
  hostId?: string;
}

export function Sidebar() {
  const hosts = useHostStore((s) => s.hosts);
  const categories = useHostStore((s) => s.categories);
  const expandedCategories = useHostStore((s) => s.expandedCategories);
  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const selectHost = useHostStore((s) => s.selectHost);
  const connectHost = useHostStore((s) => s.connectHost);
  const disconnectHost = useHostStore((s) => s.disconnectHost);
  const removeHost = useHostStore((s) => s.removeHost);
  const saveCategory = useHostStore((s) => s.saveCategory);
  const deleteCategory = useHostStore((s) => s.deleteCategory);
  const toggleCategory = useHostStore((s) => s.toggleCategory);
  const pushToast = useToastStore((s) => s.push);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<HostConfig | null>(null);
  // HostDialog 新增主机时预设的 category_id
  const [hostPresetCategoryId, setHostPresetCategoryId] = useState<string>('default');
  // 复制主机模式下的预设表单值（name 留空，其他来自原主机 + 读回的凭据）
  const [duplicatePreset, setDuplicatePreset] = useState<HostFormValues | null>(null);

  // ========== 小按钮弹出的面板菜单（非右键） ==========
  const [menuHostId, setMenuHostId] = useState<string | null>(null);
  const [menuCategoryId, setMenuCategoryId] = useState<string | null>(null);
  const panelMenuRef = useRef<HTMLDivElement | null>(null);

  // ========== 右键菜单 ==========
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);

  const [newCategoryOpen, setNewCategoryOpen] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState('');

  // 关闭面板菜单（小按钮触发的）
  useEffect(() => {
    if (!menuHostId && !menuCategoryId) return;
    function onDocClick(e: MouseEvent) {
      if (panelMenuRef.current && !panelMenuRef.current.contains(e.target as Node)) {
        setMenuHostId(null);
        setMenuCategoryId(null);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [menuHostId, menuCategoryId]);

  // 关闭右键菜单
  useEffect(() => {
    if (!ctxMenu) return;
    function onDocClick(e: MouseEvent) {
      // 点击右键菜单内部节点不关闭
      if (ctxMenuRef.current && ctxMenuRef.current.contains(e.target as Node)) return;
      setCtxMenu(null);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setCtxMenu(null);
    }
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [ctxMenu]);

  function closeContextMenu() {
    setCtxMenu(null);
  }

  function handleHostClick(host: HostConfig) {
    const state = connectionStates[host.id];
    if (state === 'connected') {
      selectHost(host.id);
    } else if (state === 'connecting') {
      selectHost(host.id);
    } else {
      void connectHost(host.id);
    }
  }

  function handleAdd(presetCategoryId: string = 'default') {
    setHostPresetCategoryId(presetCategoryId);
    setEditingHost(null);
    setDuplicatePreset(null);
    setDialogOpen(true);
  }

  function handleEdit(host: HostConfig) {
    setEditingHost(host);
    setDuplicatePreset(null);
    setDialogOpen(true);
    setMenuHostId(null);
  }

  async function handleDuplicate(host: HostConfig) {
    closeContextMenu();
    let password = '';
    let privateKey = '';
    try {
      if (host.auth_type === 'password') {
        password =
          (await invoke<string | null>('get_credential', {
            hostId: host.id,
            credType: 'password',
          })) ?? '';
      } else {
        privateKey =
          (await invoke<string | null>('get_credential', {
            hostId: host.id,
            credType: 'private_key',
          })) ?? '';
      }
    } catch (err) {
      pushToast('warning', `未能读取原主机凭据，请手动填写：${formatErr(err)}`);
    }
    const preset: HostFormValues = {
      name: '', // 名字必须由用户自己填写
      host: host.host,
      port: host.port,
      username: host.username,
      auth_type: host.auth_type,
      password,
      private_key: privateKey,
      remember_dir: host.remember_dir,
      remark: host.remark ?? '',
      category_id: host.category_id || 'default',
    };
    setEditingHost(null);
    setDuplicatePreset(preset);
    setDialogOpen(true);
  }

  async function handleDelete(host: HostConfig) {
    setMenuHostId(null);
    const ok = window.confirm(`确认删除主机「${host.name}」？此操作不可撤销。`);
    if (!ok) return;
    try {
      await removeHost(host.id);
      pushToast('success', '已删除主机');
    } catch (err) {
      pushToast('error', `删除失败：${formatErr(err)}`);
    }
  }

  async function handleToggleConnect(host: HostConfig) {
    const state = connectionStates[host.id];
    if (state === 'connected' || state === 'connecting') {
      await disconnectHost(host.id);
    } else {
      await connectHost(host.id);
    }
  }

  async function handleAddCategory() {
    const name = newCategoryName.trim();
    if (!name) {
      setNewCategoryOpen(false);
      setNewCategoryName('');
      return;
    }
    const id = `cat_${Date.now()}`;
    const maxOrder = categories.reduce((m, c) => Math.max(m, c.order), -1);
    await saveCategory({ id, name, order: maxOrder + 1 });
    setNewCategoryName('');
    setNewCategoryOpen(false);
    // 展开新分类
    toggleCategory(id);
  }

  async function handleRenameCategory(cat: CategoryConfig) {
    const name = window.prompt('重命名分类', cat.name);
    if (!name) return;
    await saveCategory({ ...cat, name: name.trim() });
  }

  async function handleDeleteCategory(cat: CategoryConfig) {
    if (cat.id === 'default') {
      pushToast('error', '默认分类不可删除');
      return;
    }
    const count = hosts.filter((h) => h.category_id === cat.id).length;
    const msg = count > 0
      ? `分类「${cat.name}」下还有 ${count} 个主机，删除后这些主机将移至「默认」分类。确定删除？`
      : `确定删除分类「${cat.name}」？`;
    if (!window.confirm(msg)) return;
    try {
      await deleteCategory(cat.id);
      pushToast('success', '已删除分类');
    } catch (err) {
      pushToast('error', `删除失败：${formatErr(err)}`);
    }
  }

  // ===== 右键菜单事件处理 =====
  function openBlankContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ kind: 'blank', x: e.clientX, y: e.clientY });
  }

  function openCategoryContextMenu(e: React.MouseEvent, category: CategoryConfig) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      kind: 'category',
      x: e.clientX,
      y: e.clientY,
      categoryId: category.id,
    });
  }

  function openHostContextMenu(e: React.MouseEvent, host: HostConfig) {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      kind: 'host',
      x: e.clientX,
      y: e.clientY,
      hostId: host.id,
    });
  }

  // 按分类分组的主机
  const grouped = useMemo(() => {
    const map = new Map<string, HostConfig[]>();
    for (const cat of categories) {
      map.set(cat.id, []);
    }
    for (const h of hosts) {
      const cid = h.category_id || 'default';
      if (!map.has(cid)) map.set(cid, []);
      map.get(cid)!.push(h);
    }
    const sortedCats = [...categories].sort((a, b) => a.order - b.order);
    return sortedCats.map((cat) => ({
      category: cat,
      hosts: (map.get(cat.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [hosts, categories]);

  const ctxCategory = ctxMenu?.categoryId
    ? categories.find((c) => c.id === ctxMenu.categoryId)
    : undefined;
  const ctxHost = ctxMenu?.hostId
    ? hosts.find((h) => h.id === ctxMenu.hostId)
    : undefined;

  return (
    <aside
      className="sidebar"
      aria-label="主机侧边栏"
      onContextMenu={(e) => {
        // 最外层兜底：任何没被子元素拦截的右键都当做空白区处理
        e.preventDefault();
        openBlankContextMenu(e);
      }}
    >
      <div className="sidebar-header">
        <span className="sidebar-title">主机</span>
        <div className="sidebar-header-actions">
          <button
            className="sidebar-add-btn"
            type="button"
            aria-label="新增分类"
            title="新增分类"
            onClick={() => {
              setNewCategoryOpen(true);
              setNewCategoryName('');
            }}
          >
            <Tag size={14} />
          </button>
          <button
            className="sidebar-add-btn"
            type="button"
            aria-label="新增主机"
            title="新增主机"
            onClick={() => handleAdd('default')}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div
        className="sidebar-list"
        onContextMenu={(e) => {
          // 空白区域右键（list 容器，非子元素）：显示空白菜单
          if (e.target === e.currentTarget) {
            e.preventDefault();
            e.stopPropagation();
            openBlankContextMenu(e);
          }
        }}
      >
        {hosts.length === 0 && categories.length <= 1 ? (
          <div
            className="sidebar-empty"
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openBlankContextMenu(e);
            }}
          >
            <Server size={28} className="sidebar-empty-icon" />
            <p>暂无主机，点击 + 添加</p>
          </div>
        ) : (
          grouped.map(({ category, hosts: catHosts }) => {
            const expanded = expandedCategories.has(category.id);
            return (
              <div key={category.id} className="sidebar-group">
                <div
                  className={`sidebar-group-header ${expanded ? 'is-expanded' : ''}`}
                  onClick={() => toggleCategory(category.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggleCategory(category.id);
                    }
                  }}
                  onContextMenu={(e) => openCategoryContextMenu(e, category)}
                >
                  <span className="sidebar-group-chevron">
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </span>
                  <span className="sidebar-group-icon">
                    {expanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                  </span>
                  <span className="sidebar-group-name">{category.name}</span>
                  <span className="sidebar-group-count">{catHosts.length}</span>
                  {category.id !== 'default' && (
                    <div
                      className="sidebar-group-actions"
                      ref={menuCategoryId === category.id ? panelMenuRef : null}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        className="host-action-btn"
                        type="button"
                        aria-label="分类操作"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMenuCategoryId((cur) => (cur === category.id ? null : category.id));
                        }}
                      >
                        <MoreHorizontal size={12} />
                      </button>
                      {menuCategoryId === category.id && (
                        <div className="host-menu" role="menu">
                          <button
                            className="host-menu-item"
                            type="button"
                            role="menuitem"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleRenameCategory(category);
                              setMenuCategoryId(null);
                            }}
                          >
                            <Pencil size={12} /> 重命名
                          </button>
                          <button
                            className="host-menu-item host-menu-danger"
                            type="button"
                            role="menuitem"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleDeleteCategory(category);
                              setMenuCategoryId(null);
                            }}
                          >
                            <Trash2 size={12} /> 删除
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
                {expanded && (
                  <div
                    className="sidebar-group-body"
                    onContextMenu={(e) => {
                      // 分类 body 的空白区域右键 → 当做在该分类下添加主机
                      if (e.target === e.currentTarget) {
                        e.preventDefault();
                        e.stopPropagation();
                        setCtxMenu({
                          kind: 'category',
                          x: e.clientX,
                          y: e.clientY,
                          categoryId: category.id,
                        });
                      }
                    }}
                  >
                    {catHosts.length === 0 ? (
                      <div
                        className="sidebar-group-empty"
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setCtxMenu({
                            kind: 'category',
                            x: e.clientX,
                            y: e.clientY,
                            categoryId: category.id,
                          });
                        }}
                      >
                        暂无主机
                      </div>
                    ) : (
                      catHosts.map((host) => {
                        const state = connectionStates[host.id] ?? 'disconnected';
                        const selected = host.id === selectedHostId;
                        return (
                          <div
                            key={host.id}
                            className={`host-item ${selected ? 'host-item-selected' : ''}`}
                            onClick={() => handleHostClick(host)}
                            role="button"
                            tabIndex={0}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault();
                                handleHostClick(host);
                              }
                            }}
                            onContextMenu={(e) => openHostContextMenu(e, host)}
                          >
                            <span
                              className={`host-state-dot host-state-${state}`}
                              aria-hidden="true"
                            />
                            <div className="host-info">
                              <div className="host-name" title={host.name}>
                                {host.name}
                              </div>
                              <div
                                className="host-addr"
                                title={`${host.host}:${host.port}`}
                              >
                                {host.host}:{host.port}
                              </div>
                            </div>
                            <div
                              className="host-actions"
                              ref={menuHostId === host.id ? panelMenuRef : null}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                className="host-action-btn"
                                type="button"
                                aria-label="更多操作"
                                title="更多操作"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setMenuHostId((cur) =>
                                    cur === host.id ? null : host.id,
                                  );
                                }}
                              >
                                <MoreHorizontal size={14} />
                              </button>
                              {menuHostId === host.id && (
                                <div className="host-menu" role="menu">
                                  <button
                                    className="host-menu-item"
                                    type="button"
                                    role="menuitem"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleToggleConnect(host);
                                    }}
                                  >
                                    {state === 'connected' || state === 'connecting'
                                      ? '断开连接'
                                      : '发起连接'}
                                  </button>
                                  <button
                                    className="host-menu-item"
                                    type="button"
                                    role="menuitem"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleEdit(host);
                                    }}
                                  >
                                    <Pencil size={12} /> 编辑
                                  </button>
                                  <button
                                    className="host-menu-item host-menu-danger"
                                    type="button"
                                    role="menuitem"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      void handleDelete(host);
                                    }}
                                  >
                                    <Trash2 size={12} /> 删除
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {newCategoryOpen && (
        <div
          className="sidebar-new-category"
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleAddCategory();
            else if (e.key === 'Escape') {
              setNewCategoryOpen(false);
              setNewCategoryName('');
            }
          }}
        >
          <input
            autoFocus
            className="sidebar-new-category-input"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            placeholder="分类名称"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            className="sidebar-new-category-btn"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void handleAddCategory();
            }}
          >
            确定
          </button>
          <button
            className="sidebar-new-category-btn sidebar-new-category-cancel"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setNewCategoryOpen(false);
              setNewCategoryName('');
            }}
          >
            取消
          </button>
        </div>
      )}

      {/* ========== 统一右键菜单 ========== */}
      {ctxMenu && (
        <div
          className="host-menu sidebar-context-menu"
          ref={ctxMenuRef}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            transform: `translate(${ctxMenu.x}px, ${ctxMenu.y}px)`,
          }}
          role="menu"
          onContextMenu={(e) => e.preventDefault()}
        >
          {ctxMenu.kind === 'blank' && (
            <>
              <button
                className="host-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  closeContextMenu();
                  handleAdd('default');
                }}
              >
                <Plus size={11} /> 新增主机
              </button>
              <button
                className="host-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  closeContextMenu();
                  setNewCategoryOpen(true);
                  setNewCategoryName('');
                }}
              >
                <Tag size={11} /> 新增分类
              </button>
            </>
          )}

          {ctxMenu.kind === 'category' && ctxCategory && (
            <>
              <button
                className="host-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  closeContextMenu();
                  handleAdd(ctxCategory.id);
                }}
              >
                <Plus size={11} /> 新增主机到此分类
              </button>
              <div className="host-menu-separator" />
              {ctxCategory.id !== 'default' && (
                <>
                  <button
                    className="host-menu-item"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeContextMenu();
                      void handleRenameCategory(ctxCategory);
                    }}
                  >
                    <Pencil size={11} /> 重命名分类
                  </button>
                  <button
                    className="host-menu-item host-menu-danger"
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeContextMenu();
                      void handleDeleteCategory(ctxCategory);
                    }}
                  >
                    <Trash2 size={11} /> 删除分类
                  </button>
                </>
              )}
              {ctxCategory.id === 'default' && (
                <button
                  className="host-menu-item host-menu-disabled"
                  type="button"
                  role="menuitem"
                  disabled
                >
                  （默认分类不可重命名或删除）
                </button>
              )}
            </>
          )}

          {ctxMenu.kind === 'host' && ctxHost && (
            <>
              {connectionStates[ctxHost.id] === 'connected' ||
              connectionStates[ctxHost.id] === 'connecting' ? (
                <button
                  className="host-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeContextMenu();
                    void handleToggleConnect(ctxHost);
                  }}
                >
                  <PowerOff size={11} /> 断开连接
                </button>
              ) : (
                <button
                  className="host-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeContextMenu();
                    void handleToggleConnect(ctxHost);
                  }}
                >
                  <Power size={11} /> 发起连接
                </button>
              )}
              <button
                className="host-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  closeContextMenu();
                  handleEdit(ctxHost);
                }}
              >
                <Pencil size={11} /> 编辑
              </button>
              <button
                className="host-menu-item"
                type="button"
                role="menuitem"
                onClick={() => {
                  closeContextMenu();
                  void handleDuplicate(ctxHost);
                }}
              >
                <Copy size={11} /> 复制主机
              </button>
              <button
                className="host-menu-item host-menu-danger"
                type="button"
                role="menuitem"
                onClick={() => {
                  closeContextMenu();
                  void handleDelete(ctxHost);
                }}
              >
                <Trash2 size={11} /> 删除
              </button>
            </>
          )}
        </div>
      )}

      {dialogOpen && (
        <HostDialog
          host={editingHost}
          categories={categories}
          presetCategoryId={editingHost ? editingHost.category_id : hostPresetCategoryId}
          initialValues={duplicatePreset ?? undefined}
          onClose={() => {
            setDialogOpen(false);
            setEditingHost(null);
            setHostPresetCategoryId('default');
            setDuplicatePreset(null);
          }}
        />
      )}
    </aside>
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
