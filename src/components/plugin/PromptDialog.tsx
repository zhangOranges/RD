import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: string;
  message: string;
  defaultValue?: string;
  onConfirm: (value: string) => void;
  onCancel: () => void;
}

/**
 * 插件 prompt 对话框。
 * 复用 finder.css 中已有的 .dialog-overlay / .dialog / .form-input / .btn 样式。
 * 通过 createPortal 渲染到 document.body；Enter 提交、Escape 取消。
 */
export function PromptDialog({ title, message, defaultValue = '', onConfirm, onCancel }: Props) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm(value);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel, value]);

  return createPortal(
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog dialog-prompt" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-header">
          <h2 className="dialog-title">{title}</h2>
        </div>
        <div className="dialog-body">
          <p>{message}</p>
          <input
            ref={inputRef}
            type="text"
            className="form-input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <div className="dialog-footer">
          <div className="dialog-footer-center">
            <button type="button" className="btn btn-secondary" onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => onConfirm(value)}
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
