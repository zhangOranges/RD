import { TerminalSquare, FileText, Upload, RefreshCw, Lock, Search } from 'lucide-react';
import { useHostStore } from '../store/hostStore';
import { useUIStore } from '../store/uiStore';
import { useFileStore } from '../store/fileStore';
import { useToastStore } from './Toast';

/**
 * 右侧面板 - 快捷操作区
 * 2×3 网格按钮，未连接主机时全部禁用。
 */
export function QuickActions() {
  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const toggleTerminal = useUIStore((s) => s.toggleTerminal);
  const toast = useToastStore((s) => s.push);

  const connState = selectedHostId ? connectionStates[selectedHostId] : undefined;
  const isConnected = connState === 'connected';

  const actions: {
    icon: typeof TerminalSquare;
    label: string;
    onClick: () => void;
  }[] = [
    {
      icon: TerminalSquare,
      label: '打开终端',
      onClick: () => {
        if (selectedHostId) toggleTerminal(selectedHostId);
      },
    },
    {
      icon: FileText,
      label: '新建文本',
      onClick: () => toast('info', '请远程文件栏空白处右键新建'),
    },
    {
      icon: Upload,
      label: '上传文件',
      onClick: () => toast('info', '请拖拽本地文件到远程栏'),
    },
    {
      icon: RefreshCw,
      label: '同步目录',
      onClick: () => {
        if (selectedHostId) void useFileStore.getState().refresh(selectedHostId);
      },
    },
    {
      icon: Lock,
      label: '权限设置',
      onClick: () => toast('info', '功能开发中'),
    },
    {
      icon: Search,
      label: '查找文件',
      onClick: () => toast('info', '功能开发中'),
    },
  ];

  return (
    <section className="rp-section">
      <div className="rp-section-title">快捷操作</div>
      <div className="rp-quick-grid">
        {actions.map(({ icon: Icon, label, onClick }) => (
          <button
            key={label}
            type="button"
            className="rp-quick-btn"
            disabled={!isConnected}
            onClick={onClick}
            title={label}
          >
            <Icon size={16} />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
