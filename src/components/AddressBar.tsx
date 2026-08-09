import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ChevronRight, Home, AlertCircle, Copy, Check } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useFileStore } from '../store/fileStore';
import { useUIStore } from '../store/uiStore';
import { useToastStore } from './Toast';

interface AddressBarProps {
  hostId: string;
  currentPath: string | null;
}

// 将命令字符串编码为 PTY 字节数组（仅前端编码；路径转义交给后端 pty_cd）。
function commandToBytes(command: string): number[] {
  return Array.from(new TextEncoder().encode(command + '\n'));
}

export function AddressBar({ hostId, currentPath }: AddressBarProps) {
  const navigate = useFileStore((s) => s.navigate);
  const resolvePath = useFileStore((s) => s.resolvePath);
  const setTerminalVisible = useUIStore((s) => s.setTerminalVisible);
  const pushToast = useToastStore((s) => s.push);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [hasError, setHasError] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const copyToastTimer = useRef<number | null>(null);

  // 进入编辑模式时聚焦并预填当前路径
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
      setDraft(currentPath ?? '/');
      setHasError(false);
    }
  }, [editing, currentPath]);

  // currentPath 变化时同步 draft（仅在非编辑态，避免覆盖用户输入）
  useEffect(() => {
    if (!editing) {
      setDraft(currentPath ?? '/');
      setHasError(false);
    }
  }, [currentPath, editing]);

  function startEditing() {
    if (!hostId) return;
    setEditing(true);
  }

  function commitEdit() {
    setEditing(false);
    setHasError(false);
  }

  function abortEdit() {
    setEditing(false);
    setHasError(false);
  }

  // 处理键盘：Enter 提交、Escape 取消
  async function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      abortEdit();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const raw = draft.trim();
    if (!raw) {
      abortEdit();
      return;
    }

    // 1) cmd / terminal → 唤起终端并 cd 到当前目录
    if (raw === 'cmd' || raw === 'terminal') {
      await openTerminalAndCd();
      commitEdit();
      return;
    }

    // 2) 路径判定：包含空格视为命令；否则按路径前缀判断
    //    - 以 / 开头 → 绝对路径
    //    - 以 ~ 或 . 开头 → 相对路径（需 resolvePath 补全）
    //    - 单段无空格无斜杠 → 视为命令（避免误把 ls/grep 当路径）
    const hasSpace = /\s/.test(raw);
    const looksLikePath =
      !hasSpace &&
      (raw.startsWith('/') || raw.startsWith('~') || raw.startsWith('.') || raw.includes('/'));

    if (looksLikePath) {
      let target = raw;
      // 相对路径用 sftp_resolve_path 解析为绝对路径
      if (!raw.startsWith('/')) {
        const resolved = await resolvePath(hostId, raw);
        if (!resolved) {
          setHasError(true);
          return;
        }
        target = resolved;
      }
      const ok = await navigate(hostId, target);
      if (ok) {
        commitEdit();
      } else {
        setHasError(true);
      }
      return;
    }

    // 3) 其它内容视为命令投递到终端
    await dispatchCommand(raw);
    commitEdit();
  }

  async function openTerminalAndCd() {
    try {
      setTerminalVisible(hostId, true);
      await invoke('pty_open', { hostId });
      if (currentPath) {
        await invoke('pty_cd', { hostId, path: currentPath });
      }
    } catch (err) {
      pushToast('error', `打开终端失败：${formatErr(err)}`);
    }
  }

  async function dispatchCommand(command: string) {
    try {
      setTerminalVisible(hostId, true);
      await invoke('pty_open', { hostId });
      const data = commandToBytes(command);
      await invoke('pty_write', { hostId, data });
    } catch (err) {
      pushToast('error', `命令投递失败：${formatErr(err)}`);
    }
  }

  // 面包屑跳转
  async function jumpTo(path: string) {
    if (!hostId) return;
    await navigate(hostId, path);
  }

  // 构造面包屑分段
  const crumbs = buildCrumbs(currentPath);
  const lastIndex = crumbs.length - 1;

  async function handleCopyPath(path: string, e: React.MouseEvent | React.KeyboardEvent) {
    e.stopPropagation();
    e.preventDefault();
    try {
      await writeText(path);
    } catch {
      try {
        await navigator.clipboard.writeText(path);
      } catch {
        pushToast('error', '复制失败');
        return;
      }
    }
    setCopied(true);
    pushToast('success', '路径已复制到剪贴板');
    if (copyToastTimer.current) window.clearTimeout(copyToastTimer.current);
    copyToastTimer.current = window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div
      className={`addressbar ${hasError ? 'addressbar-error' : ''}`}
      role="navigation"
      aria-label="当前路径"
      title={hasError ? '路径无效' : currentPath ?? ''}
      onDoubleClick={startEditing}
      onClick={(e) => {
        if (e.target === e.currentTarget) startEditing();
      }}
      onContextMenu={(e) => {
        // 右击地址栏空白或面包屑：提供复制当前完整路径
        if (!currentPath) return;
        e.preventDefault();
        void handleCopyPath(currentPath, e);
      }}
    >
      {editing ? (
        <input
          ref={inputRef}
          className="addressbar-input"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (hasError) setHasError(false);
          }}
          onKeyDown={handleKeyDown}
          onBlur={commitEdit}
          spellCheck={false}
          autoComplete="off"
          placeholder="输入绝对路径，或 cmd / terminal 唤起终端，或直接键入命令…"
        />
      ) : hasError ? (
        <>
          <AlertCircle size={14} style={{ color: 'var(--danger)', flex: '0 0 auto' }} />
          <span className="addressbar-input" style={{ color: 'var(--danger)' }}>
            {draft}
          </span>
        </>
      ) : (
        <>
          <div className="addressbar-crumbs">
            <button
              type="button"
              className="crumb crumb-root crumb-visited"
              title="跳转到根目录 / (右键复制)"
              onClick={(e) => {
                e.stopPropagation();
                void jumpTo('/');
              }}
              onContextMenu={(e) => void handleCopyPath('/', e)}
              aria-label="根目录"
            >
              <Home size={13} />
            </button>
            {crumbs.map((c, idx) => {
              const isLast = idx === lastIndex;
              return (
                <span key={c.path} className="crumb-sep-wrap">
                  <ChevronRight size={10} className="crumb-sep" />
                  <button
                    type="button"
                    className={`crumb ${isLast ? 'crumb-current' : 'crumb-visited'}`}
                    title={`${c.path} (右键复制)`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void jumpTo(c.path);
                    }}
                    onContextMenu={(e) => void handleCopyPath(c.path, e)}
                  >
                    {c.name}
                  </button>
                </span>
              );
            })}
          </div>
          {currentPath && (
            <button
              type="button"
              className={`addressbar-copy-btn ${copied ? 'addressbar-copy-ok' : ''}`}
              title="复制当前路径"
              aria-label="复制当前路径"
              onClick={(e) => void handleCopyPath(currentPath, e)}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          )}
        </>
      )}
    </div>
  );
}

interface Crumb {
  name: string;
  path: string;
}

function buildCrumbs(path: string | null): Crumb[] {
  if (!path) return [];
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed) return [];
  const parts = trimmed.split('/').filter(Boolean);
  const result: Crumb[] = [];
  let acc = '';
  for (const p of parts) {
    acc += '/' + p;
    result.push({ name: p, path: acc });
  }
  return result;
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
