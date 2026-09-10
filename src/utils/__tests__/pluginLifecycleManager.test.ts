import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock 依赖
vi.mock('react', () => ({ createElement: vi.fn() }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: vi.fn(), unmount: vi.fn() }) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./pluginBridge', () => ({ buildPluginIframeSrc: (html: string) => html }));
vi.mock('./eventBus', () => ({ kernelEventBus: { offAll: vi.fn() } }));
vi.mock('./pluginSdk', () => ({
  SDK_API_VERSION: 'v1',
  createRDContext: () => ({}),
}));
vi.mock('../../store/pluginUiStore', () => ({
  usePluginUiStore: { getState: () => ({ removeAllForPlugin: vi.fn(), closePluginView: vi.fn() }) },
}));
vi.mock('../../store/themeStore', () => ({
  useThemeStore: { getState: () => ({}), subscribe: () => () => {} },
  getCurrentThemeInfo: () => ({ id: 'dark', type: 'dark', palette: {} }),
}));
vi.mock('../log', () => ({ logInfo: vi.fn(), logWarn: vi.fn() }));

// Mock PluginSandbox —— 不实际渲染，只提供 ref 回调
vi.mock('../../components/plugin/PluginSandbox', () => ({
  PluginSandbox: () => null,
}));

import { pluginLifecycleManager } from '../pluginLifecycleManager';
import type { PluginManifest } from '../../types/plugin';

const manifest: PluginManifest = {
  id: 'test-plugin',
  name: 'Test Plugin',
  version: '1.0.0',
  apiVersion: 'v1',
  author: 'test',
  description: 'test plugin',
  category: 'utility',
  entry: 'index.js',
  indexHtml: 'index.html',
  permissions: [],
  minRdVersion: '0.1.0',
  hotReload: false,
};

// 构造一个 mock 的 Mounted 条目，直接注入到 manager 的私有 mounted Map 中
function injectMountedPlugin(
  manager: typeof pluginLifecycleManager,
  id: string,
  enabled: boolean,
  handle: { callDisable: ReturnType<typeof vi.fn>; callUninstall: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> },
) {
  const mounted = (manager as unknown as { mounted: Map<string, unknown> }).mounted;
  mounted.set(id, {
    root: { unmount: vi.fn() },
    container: { querySelector: () => null } as unknown as HTMLDivElement,
    windowEl: { classList: { toggle: vi.fn(), remove: vi.fn() }, parentNode: null, querySelector: () => null } as unknown as HTMLDivElement,
    handleRef: { current: handle },
    manifest,
    enabled,
    owner: {},
  });
}

describe('pluginLifecycleManager — 高危漏洞 #5: 禁用时错误调用 callUninstall', () => {
  beforeEach(() => {
    // 清空 mounted Map
    const manager = pluginLifecycleManager as unknown as { mounted: Map<string, unknown> };
    manager.mounted.clear();
    vi.clearAllMocks();
  });

  test('销毁已启用插件时只调用 callDisable，不调用 callUninstall（修复 #5）', async () => {
    const handle = {
      callDisable: vi.fn().mockResolvedValue(undefined),
      callUninstall: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };

    injectMountedPlugin(pluginLifecycleManager, 'test-plugin', true, handle);

    // destroyPlugin 内部调用 _disableAndDestroy（仅 disable，不 uninstall）
    await pluginLifecycleManager.destroyPlugin('test-plugin');

    // callDisable 应该被调用（禁用操作）
    expect(handle.callDisable).toHaveBeenCalledTimes(1);
    // 修复后：callUninstall 不再在禁用/销毁时被调用
    expect(handle.callUninstall).not.toHaveBeenCalled();
  });

  test('销毁未启用插件时 callDisable 和 callUninstall 均不调用（修复 #5）', async () => {
    const handle = {
      callDisable: vi.fn().mockResolvedValue(undefined),
      callUninstall: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };

    // enabled = false
    injectMountedPlugin(pluginLifecycleManager, 'test-plugin', false, handle);

    await pluginLifecycleManager.destroyPlugin('test-plugin');

    expect(handle.callDisable).not.toHaveBeenCalled();
    expect(handle.callUninstall).not.toHaveBeenCalled();
  });

  test('真正卸载时调用 callDisable + callUninstall', async () => {
    const handle = {
      callDisable: vi.fn().mockResolvedValue(undefined),
      callUninstall: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };

    injectMountedPlugin(pluginLifecycleManager, 'test-plugin', true, handle);

    await pluginLifecycleManager.uninstallPlugin('test-plugin');

    expect(handle.callDisable).toHaveBeenCalledTimes(1);
    expect(handle.callUninstall).toHaveBeenCalledTimes(1);
  });

  test('销毁后插件从 mounted Map 中移除', async () => {
    const handle = {
      callDisable: vi.fn().mockResolvedValue(undefined),
      callUninstall: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn(),
    };

    injectMountedPlugin(pluginLifecycleManager, 'test-plugin', true, handle);
    expect(pluginLifecycleManager.getMountedIds()).toContain('test-plugin');

    await pluginLifecycleManager.destroyPlugin('test-plugin');

    expect(pluginLifecycleManager.getMountedIds()).not.toContain('test-plugin');
  });
});
