import { useEffect } from 'react';
import { usePluginUiStore } from '../../store/pluginUiStore';
import { pluginLifecycleManager } from '../../utils/pluginLifecycleManager';

/**
 * 插件视图宿主：全屏模态显示当前激活插件的 index.html 界面。
 * - 插件窗口（标题栏 + iframe）由 pluginLifecycleManager 常驻创建（不移动 iframe，
 *   避免重载导致插件状态丢失），本组件仅渲染点击可关闭的半透明遮罩。
 * - 激活状态来自 pluginUiStore.activePluginView（由插件 SDK ui.openPluginView 设置）。
 */
export function PluginViewHost() {
  const activeId = usePluginUiStore((s) => s.activePluginView);
  const closePluginView = usePluginUiStore((s) => s.closePluginView);

  useEffect(() => {
    if (activeId) {
      pluginLifecycleManager.openView(activeId);
    } else {
      pluginLifecycleManager.closeView();
    }
  }, [activeId]);

  if (!activeId) return null;
  return <div className="rd-view-mask" onClick={closePluginView} />;
}
