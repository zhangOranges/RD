import { ServerInfo } from './ServerInfo';
import { QuickActions } from './QuickActions';
import { TransferQueue } from './TransferQueue';
import '../styles/rightpanel.css';

/**
 * 右侧功能面板容器：自上而下依次为
 * 服务器信息、快捷操作、传输队列三个区块。
 */
export function RightPanel() {
  return (
    <div className="rightpanel">
      <ServerInfo />
      <QuickActions />
      <TransferQueue />
    </div>
  );
}
