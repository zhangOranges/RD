import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePluginUiStore } from '../../store/pluginUiStore';
import { PortForwardManager } from './PortForwardManager';

export function PortForwardPluginBootstrap() {
  const [pfmOpen, setPfmOpen] = useState(false);

  useEffect(() => {
    usePluginUiStore.getState().registerToolbarButton(
      'rd-native:port-forward',
      {
        id: 'port-forward-open',
        label: '端口转发',
        icon: 'Network',
        tooltip: 'RD 官方端口转发管理器',
        onClick: () => setPfmOpen(true),
      },
      'center',
    );
    return () => {
      usePluginUiStore.getState().removeToolbarButton('port-forward-open');
    };
  }, []);

  if (!pfmOpen) return null;

  return createPortal(
    <PortForwardManager
      visible={pfmOpen}
      onClose={() => setPfmOpen(false)}
    />,
    document.body,
  );
}
