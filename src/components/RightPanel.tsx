import { ServerInfo } from './ServerInfo';
import { TransferQueue } from './TransferQueue';
import '../styles/rightpanel.css';

/**
 * 右侧功能面板容器：自上而下依次为
 * 服务器信息、传输队列两个区块。
 * 端口转发面板作为独立插件承载（插件自有 iframe UI），不在主程序中固化。
 */
export function RightPanel() {
  return (
    <div className="rightpanel">
      <ServerInfo />
      <TransferQueue />
    </div>
  );
}
