import { useEffect } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 插件 confirm 对话框。
 * 复用 finder.css 中已有的 .dialog-overlay / .dialog / .btn 样式。
 * 通过 createPortal 渲染到 document.body，避免被父容器的层级/overflow 影响。
 */
export function ConfirmDialog({ title, message, onConfirm, onCancel }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);

  return createPortal(
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog dialog-confirm" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{title}</h2>
        </div>
        <div className="dialog-body">
          <p>{message}</p>
        </div>
        <div className="dialog-footer">
          <div className="dialog-footer-center">
            <button type="button" className="btn btn-secondary" onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={onConfirm}
              autoFocus
            >
              确认
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
