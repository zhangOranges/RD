import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
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
  FolderTree,
  Network,
  KeyRound,
  Puzzle,
  Search,
  AlertTriangle,
} from 'lucide-react';
import { useHostStore } from '../store/hostStore';
import { useUIStore, type ToolType } from '../store/uiStore';
import { matchShortcut } from '../store/shortcutStore';
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
  const cancelReconnect = useHostStore((s) => s.cancelReconnect);
  const removeHost = useHostStore((s) => s.removeHost);
  const saveCategory = useHostStore((s) => s.saveCategory);
  const deleteCategory = useHostStore((s) => s.deleteCategory);
  const toggleCategory = useHostStore((s) => s.toggleCategory);
  const pushToast = useToastStore((s) => s.push);

  // UI store：搜索框、工具菜单、打码模式
  const sidebarSearch = useUIStore((s) => s.sidebarSearch);
  const setSidebarSearch = useUIStore((s) => s.setSidebarSearch);
  const activeTool = useUIStore((s) => s.activeTool);
  const setActiveTool = useUIStore((s) => s.setActiveTool);
  const maskMode = useUIStore((s) => s.maskMode);

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

  // ========== 自定义确认 / 输入对话框（替代 window.confirm / window.prompt）==========
  // Tauri WebView 环境下原生 window.confirm / window.prompt 常被禁用不弹框，
  // 这里使用与其他对话框一致的 React Portal 自绘组件，样式上为紧凑 mini 版本。
  type MiniDialogKind = 'confirm' | 'prompt';
  interface MiniDialogState {
    kind: MiniDialogKind;
    title: string;
    message: string;
    // prompt 模式的默认值与 placeholder
    promptDefault?: string;
    promptPlaceholder?: string;
    okLabel?: string;
    cancelLabel?: string;
    danger?: boolean; // 危险操作（删除 / 断开）：OK 按钮红色
    onOk: (inputValue?: string) => void;
  }
  const [miniDialog, setMiniDialog] = useState<MiniDialogState | null>(null);
  const [miniPromptInput, setMiniPromptInput] = useState('');

  function closeMiniDialog() {
    setMiniDialog(null);
    setMiniPromptInput('');
  }

  function openConfirm(opts: {
    title?: string;
    message: string;
    okLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
    onOk: () => void;
  }) {
    setMiniDialog({
      kind: 'confirm',
      title: opts.title ?? '请确认',
      message: opts.message,
      okLabel: opts.okLabel,
      cancelLabel: opts.cancelLabel,
      danger: opts.danger,
      onOk: () => {
        opts.onOk();
        closeMiniDialog();
      },
    });
  }

  function openPrompt(opts: {
    title?: string;
    message: string;
    defaultValue?: string;
    placeholder?: string;
    okLabel?: string;
    cancelLabel?: string;
    onOk: (value: string) => void;
  }) {
    setMiniPromptInput(opts.defaultValue ?? '');
    setMiniDialog({
      kind: 'prompt',
      title: opts.title ?? '请输入',
      message: opts.message,
      promptDefault: opts.defaultValue,
      promptPlaceholder: opts.placeholder,
      okLabel: opts.okLabel,
      cancelLabel: opts.cancelLabel,
      onOk: (v) => {
        if (typeof v === 'string') opts.onOk(v);
        closeMiniDialog();
      },
    });
  }

  // ========== 搜索框 ==========
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // 聚焦搜索框快捷键（可在设置面板自定义）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (matchShortcut('focusSearch', e)) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ========== 工具菜单配置 ==========
  const tools: { id: ToolType; label: string; icon: typeof FolderTree }[] = [
    { id: 'sftp', label: 'SFTP', icon: FolderTree },
    { id: 'port-forward', label: '端口转发', icon: Network },
    { id: 'keys', label: '密钥管理', icon: KeyRound },
    { id: 'plugins', label: '插件中心', icon: Puzzle },
  ];

  // ========== 底部连接信息概览（已移至右上角 ServerInfo） ==========

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

  // 关闭右键菜单 & 边界检测
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

  // 菜单渲染后做边界检测，靠近视口右/下边缘时向上/左偏移，避免溢出导致离鼠标过远
  useEffect(() => {
    if (!ctxMenu || !ctxMenuRef.current) return;
    const el = ctxMenuRef.current;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let shiftX = 0;
    let shiftY = 0;
    if (rect.right > window.innerWidth - margin) {
      shiftX = rect.right - (window.innerWidth - margin);
    }
    if (rect.bottom > window.innerHeight - margin) {
      shiftY = rect.bottom - (window.innerHeight - margin);
    }
    if (shiftX !== 0 || shiftY !== 0) {
      el.style.left = `${ctxMenu.x - shiftX}px`;
      el.style.top = `${ctxMenu.y - shiftY}px`;
    }
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
    const connState = connectionStates[host.id];
    if (connState === 'connected' || connState === 'connecting') {
      openConfirm({
        title: '编辑前需断开连接',
        message: `主机「${host.name}」当前已连接，编辑前需要先断开连接。是否立即断开并继续编辑？`,
        okLabel: '断开并编辑',
        cancelLabel: '取消',
        danger: false,
        onOk: () => {
          void disconnectHost(host.id);
          setEditingHost(host);
          setDuplicatePreset(null);
          setDialogOpen(true);
          setMenuHostId(null);
          closeContextMenu();
        },
      });
      return;
    }
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

  function handleDelete(host: HostConfig) {
    setMenuHostId(null);
    openConfirm({
      title: '确认删除主机',
      message: `确认删除主机「${host.name}」？此操作不可撤销。`,
      okLabel: '确认删除',
      cancelLabel: '取消',
      danger: true,
      onOk: async () => {
        try {
          await removeHost(host.id);
          // 清理该主机的终端标签持久化数据
          useUIStore.getState().clearTerminalTabsForHost(host.id);
          pushToast('success', '已删除主机');
        } catch (err) {
          pushToast('error', `删除失败：${formatErr(err)}`);
        }
      },
    });
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

  function handleRenameCategory(cat: CategoryConfig) {
    openPrompt({
      title: '重命名分类',
      message: `为分类「${cat.name}」设置新名称`,
      defaultValue: cat.name,
      placeholder: '分类名称',
      okLabel: '保存',
      cancelLabel: '取消',
      onOk: async (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        try {
          await saveCategory({ ...cat, name: trimmed });
        } catch (err) {
          pushToast('error', `重命名失败：${formatErr(err)}`);
        }
      },
    });
  }

  function handleDeleteCategory(cat: CategoryConfig) {
    if (cat.id === 'default') {
      pushToast('error', '默认分类不可删除');
      return;
    }
    const count = hosts.filter((h) => h.category_id === cat.id).length;
    const msg = count > 0
      ? `分类「${cat.name}」下还有 ${count} 个主机，删除后这些主机将移至「默认」分类。确定删除？`
      : `确定删除分类「${cat.name}」？`;
    openConfirm({
      title: '确认删除分类',
      message: msg,
      okLabel: '确认删除',
      cancelLabel: '取消',
      danger: true,
      onOk: async () => {
        try {
          await deleteCategory(cat.id);
          pushToast('success', '已删除分类');
        } catch (err) {
          pushToast('error', `删除失败：${formatErr(err)}`);
        }
      },
    });
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

  // 按分类分组的主机（按搜索关键词过滤）
  const grouped = useMemo(() => {
    const q = sidebarSearch.trim().toLowerCase();
    const filteredHosts = q
      ? hosts.filter(
          (h) =>
            h.name.toLowerCase().includes(q) ||
            h.host.toLowerCase().includes(q),
        )
      : hosts;

    const map = new Map<string, HostConfig[]>();
    for (const cat of categories) {
      map.set(cat.id, []);
    }
    for (const h of filteredHosts) {
      const cid = h.category_id || 'default';
      if (!map.has(cid)) map.set(cid, []);
      map.get(cid)!.push(h);
    }
    const sortedCats = [...categories].sort((a, b) => a.order - b.order);
    return sortedCats.map((cat) => ({
      category: cat,
      hosts: (map.get(cat.id) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [hosts, categories, sidebarSearch]);

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
        <span className="sidebar-title">连接管理</span>
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

      <div className="sidebar-search">
        <div className="sidebar-search-wrap">
          <Search size={12} className="sidebar-search-icon" />
          <input
            ref={searchInputRef}
            className="sidebar-search-input"
            type="text"
            placeholder="搜索主机或 IP (Ctrl+K)"
            value={sidebarSearch}
            onChange={(e) => setSidebarSearch(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onContextMenu={(e) => e.stopPropagation()}
          />
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
                                className={`host-addr ${maskMode ? 'mask-sensitive' : ''}`}
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

      {/* ========== 工具菜单 ========== */}
      <div className="sidebar-tools">
        {tools.map((t) => {
          const Icon = t.icon;
          const active = activeTool === t.id;
          return (
            <button
              key={t.id}
              type="button"
              className={`sidebar-tool-item ${active ? 'active' : ''}`}
              onClick={() => setActiveTool(t.id)}
            >
              <Icon size={14} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* ========== 统一右键菜单（通过 Portal 挂载到 body，避免 sidebar 的 backdrop-filter
           导致 position:fixed 失效及 overflow:hidden 裁剪） ========== */}
      {ctxMenu && createPortal(
        <div
          className="host-menu sidebar-context-menu"
          ref={ctxMenuRef}
          style={{
            position: 'fixed',
            top: ctxMenu.y,
            left: ctxMenu.x,
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
              {connectionStates[ctxHost.id] === 'reconnecting' ? (
                <button
                  className="host-menu-item"
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeContextMenu();
                    cancelReconnect(ctxHost.id);
                  }}
                >
                  <AlertTriangle size={11} /> 取消重连
                </button>
              ) : connectionStates[ctxHost.id] === 'connected' ||
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
        </div>,
        document.body,
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

      {/* 自定义 mini 确认 / 输入对话框（紧凑版）：替代 window.confirm / window.prompt */}
      {miniDialog &&
        createPortal(
          <div
            className="dialog-overlay sidebar-mini-overlay"
            role="dialog"
            aria-modal="true"
            onClick={() => closeMiniDialog()}
          >
            <div
              className="dialog dialog-mini"
              onClick={(e) => e.stopPropagation()}
              style={{ width: 420 }}
            >
              <div className="dialog-header">
                <div className="sidebar-mini-title-wrap">
                  {miniDialog.danger ? (
                    <AlertTriangle
                      size={16}
                      className="sidebar-mini-icon sidebar-mini-icon-danger"
                    />
                  ) : (
                    <AlertTriangle
                      size={16}
                      className="sidebar-mini-icon sidebar-mini-icon-info"
                    />
                  )}
                  <h3 className="dialog-title">{miniDialog.title}</h3>
                </div>
              </div>
              <div className="dialog-body sidebar-mini-body">
                <p className="sidebar-mini-message">{miniDialog.message}</p>
                {miniDialog.kind === 'prompt' && (
                  <input
                    type="text"
                    className="sidebar-mini-input"
                    autoFocus
                    value={miniPromptInput}
                    placeholder={miniDialog.promptPlaceholder}
                    onChange={(e) => setMiniPromptInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        miniDialog.onOk(miniPromptInput);
                      }
                    }}
                  />
                )}
              </div>
              <div className="dialog-footer sidebar-mini-footer">
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => closeMiniDialog()}
                >
                  {miniDialog.cancelLabel ?? '取消'}
                </button>
                <button
                  type="button"
                  className={`btn ${miniDialog.danger ? 'btn-danger' : 'btn-primary'}`}
                  onClick={() => {
                    if (miniDialog.kind === 'prompt') {
                      miniDialog.onOk(miniPromptInput);
                    } else {
                      miniDialog.onOk();
                    }
                  }}
                >
                  {miniDialog.okLabel ?? '确定'}
                </button>
              </div>
            </div>
          </div>,
          document.body,
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
