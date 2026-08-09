import { create } from 'zustand';
import { useEffect } from 'react';
import { CheckCircle2, Info, AlertTriangle, XCircle, X } from 'lucide-react';
import type { ToastItem, ToastKind } from '../types';
import '../styles/finder.css';

interface ToastState {
  toasts: ToastItem[];
  push: (kind: ToastKind, message: string, durationMs?: number) => void;
  dismiss: (id: number) => void;
}

let _id = 0;

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (kind, message, durationMs = 3000) => {
    const id = ++_id;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    if (durationMs > 0) {
      window.setTimeout(() => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      }, durationMs);
    }
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

const ICONS: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    return () => {
      // 组件卸载时无需清理外部副作用，setTimeout 自行过期
    };
  }, []);

  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            <Icon size={16} className="toast-icon" />
            <span className="toast-message">{t.message}</span>
            <button
              className="toast-close"
              onClick={() => dismiss(t.id)}
              aria-label="关闭"
              type="button"
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
