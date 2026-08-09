import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Save, Eye, Pencil } from 'lucide-react';
import { useFileStore } from '../store/fileStore';
import { useToastStore } from './Toast';

export interface TextEditorProps {
  hostId: string;
  // 要打开的文件的绝对路径
  filePath: string;
  // 文件名（仅展示）
  fileName: string;
  // true = 只读"查看"模式，可切到编辑
  viewOnly?: boolean;
  onClose: () => void;
}

export function TextEditorDialog({
  hostId,
  filePath,
  fileName,
  viewOnly = false,
  onClose,
}: TextEditorProps) {
  const readFileText = useFileStore((s) => s.readFileText);
  const writeFileText = useFileStore((s) => s.writeFileText);
  const refresh = useFileStore((s) => s.refresh);
  const pushToast = useToastStore((s) => s.push);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [content, setContent] = useState('');
  const [original, setOriginal] = useState('');
  const [editable, setEditable] = useState(!viewOnly);
  const [err, setErr] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    readFileText(hostId, filePath)
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setOriginal(text);
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(typeof e === 'string' ? e : e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hostId, filePath, readFileText]);

  const dirty = content !== original;

  function handleSwitchToEdit() {
    setEditable(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  async function handleSave() {
    if (!dirty) return;
    setSaving(true);
    try {
      await writeFileText(hostId, filePath, content);
      setOriginal(content);
      pushToast('success', '已保存文件');
      void refresh(hostId);
    } catch (e) {
      pushToast(
        'error',
        `保存失败：${typeof e === 'string' ? e : e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSaving(false);
    }
  }

  function handleClose() {
    if (dirty) {
      if (!window.confirm('文件已修改但未保存，确定关闭？')) return;
    }
    onClose();
  }

  // Ctrl+S / Cmd+S 保存 + Esc 关闭
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (editable) void handleSave();
      } else if (e.key === 'Escape') {
        handleClose();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, editable]);

  return createPortal(
    <div className="dialog-overlay" role="dialog" aria-modal="true" aria-label="文件编辑器">
      <div className="dialog text-editor-dialog">
        <div className="dialog-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--text-secondary)' }}>
              {editable ? <Pencil size={14} /> : <Eye size={14} />}
            </span>
            <h3 className="dialog-title">
              {editable ? '编辑' : '查看'}：{fileName}
            </h3>
            {dirty && (
              <span
                style={{
                  fontSize: 11,
                  padding: '1px 6px',
                  borderRadius: 8,
                  background: 'var(--accent-soft)',
                  color: 'var(--accent)',
                  fontWeight: 600,
                  marginLeft: 8,
                }}
              >
                未保存
              </span>
            )}
          </div>
          <button
            className="dialog-close"
            type="button"
            aria-label="关闭"
            onClick={handleClose}
          >
            <X size={14} />
          </button>
        </div>

        <div className="dialog-body dialog-body-compact text-editor-body">
          {loading ? (
            <div className="text-editor-empty">加载中…</div>
          ) : err ? (
            <div className="text-editor-empty text-editor-error">读取失败：{err}</div>
          ) : (
            <textarea
              ref={textareaRef}
              className="text-editor-textarea"
              value={content}
              onChange={(e) => editable && setContent(e.target.value)}
              readOnly={!editable}
              spellCheck={false}
              placeholder={editable ? '输入文件内容…' : '（文件为空）'}
            />
          )}
        </div>

        <div className="dialog-footer">
          <div style={{ flex: 1, display: 'flex', gap: 6 }}>
            {!editable && !loading && !err && (
              <button
                className="btn btn-secondary"
                type="button"
                onClick={handleSwitchToEdit}
              >
                <Pencil size={12} /> 切换到编辑
              </button>
            )}
          </div>
          <button className="btn btn-ghost" type="button" onClick={handleClose}>
            关闭
          </button>
          <button
            className="btn btn-primary"
            type="button"
            onClick={handleSave}
            disabled={!editable || saving || !dirty}
          >
            <Save size={12} /> {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
