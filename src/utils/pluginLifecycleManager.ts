/**
 * 插件生命周期调度器（单例）。
 * 维护 Map<pluginId, { root, handleRef }>，动态挂载隐藏的 PluginSandbox 到 <body id="__rd_plugin_sandboxes__">。
 *
 * 核心 API：
 *  - setDesiredPlugins(plugins: Array<{id, manifest, indexHtmlUrl?: string}>)
 *      把启用/禁用状态与内部 Map 对齐：新增插件 → mount → callInit → callEnable；
 *      消失的插件 → callDisable → destroy → unmount。
 *  - getState(): Map 快照（调试用）
 */
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PluginSandbox,
  type PluginSandboxHandle,
} from '../components/plugin/PluginSandbox';
import type { PluginManifest, RDContext } from '../types/plugin';
import { SDK_API_VERSION, createRDContext } from './pluginSdk';
import { kernelEventBus } from './eventBus';
import { usePluginUiStore } from '../store/pluginUiStore';
import { getCurrentThemeInfo, useThemeStore } from '../store/themeStore';

function syncThemeToIframeViaMsg(iframeEl: HTMLIFrameElement | null | undefined): void {
  if (!iframeEl?.contentWindow) return;
  const info = getCurrentThemeInfo();
  iframeEl.contentWindow.postMessage(
    { __rd_plugin: true, type: 'theme-sync', palette: info.palette, themeId: info.id },
    '*'
  );
}

interface Mounted {
  root: Root;
  container: HTMLDivElement;
  handle: PluginSandboxHandle | null;
  manifest: PluginManifest;
  enabled: boolean;
  /** 该插件在 kernelEventBus 上的 owner，用于 offAll 批量清理监听器 */
  owner: object;
}

const SANDBOX_CONTAINER_ID = '__rd_plugin_sandboxes__';

function ensureRootContainer(): HTMLDivElement {
  let el = document.getElementById(SANDBOX_CONTAINER_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = SANDBOX_CONTAINER_ID;
    el.style.display = 'none';
    document.body.appendChild(el);
  }
  return el;
}

class PluginLifecycleManager {
  private readonly mounted = new Map<string, Mounted>();

  /**
   * 对齐启用集。Phase 1 不抛异常，所有错误打 console.warn。
   * @param desired 要启用的插件集合（{id, manifest}）
   */
  async setDesiredPlugins(
    desired: Array<{ id: string; manifest: PluginManifest; indexHtmlUrl?: string }>,
  ): Promise<void> {
    const desiredMap = new Map(desired.map((d) => [d.id, d]));
    const toRemove: string[] = [];
    for (const id of this.mounted.keys()) {
      if (!desiredMap.has(id)) toRemove.push(id);
    }
    for (const id of toRemove) {
      await this._disableAndDestroy(id);
    }
    for (const [id, info] of desiredMap.entries()) {
      await this._ensureMountedAndEnabled(id, info.manifest, info.indexHtmlUrl);
    }
  }

  private async _ensureMountedAndEnabled(
    id: string,
    manifest: PluginManifest,
    customSrc?: string,
  ): Promise<void> {
    const demoSrc =
      'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        `<html><body><script>
          window.addEventListener('message', (ev) => {
            const d = ev.data;
            if (!d || !d.__rd_plugin) return;
            if (d.type === 'theme-sync') {
              if (d.palette && typeof d.palette === 'object') {
                for (const [k, v] of Object.entries(d.palette)) {
                  document.documentElement.style.setProperty(k, String(v));
                }
              }
              if (d.themeId) document.documentElement.setAttribute('data-theme', String(d.themeId));
              return;
            }
            if (d.type === 'watchdog-ping') {
              window.parent.postMessage({ __rd_plugin: true, type: 'watchdog-pong', ts: d.ts }, '*');
              return;
            }
            if (d.type === 'lifecycle:destroy') {
              return;
            }
            if (d.type === 'lifecycle') {
              const port = ev.ports && ev.ports[0];
              if (port) port.postMessage({ ok: true, lifecycle: d.name });
            }
          });
          window.parent.postMessage({ __rd_plugin_ready: true, id: ${JSON.stringify(id)} }, '*');
        <\/script></body></html>`,
      );
    const src = customSrc?.trim() ? customSrc.trim() : demoSrc;

    if (!this.mounted.has(id)) {
      const rootContainer = ensureRootContainer();
      const container = document.createElement('div');
      rootContainer.appendChild(container);
      const root = createRoot(container);
      const handleRef: { current: PluginSandboxHandle | null } = { current: null };
      root.render(
        createElement(PluginSandbox, {
          pluginId: id,
          manifest,
          src,
          ref: (h: PluginSandboxHandle | null) => {
            handleRef.current = h;
          },
          onReady: () => {},
        }),
      );
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      const owner: object = {};
      this.mounted.set(id, {
        root,
        container,
        handle: handleRef.current,
        manifest,
        enabled: false,
        owner,
      });
    }

    const mounted = this.mounted.get(id)!;
    mounted.manifest = manifest;

    const ctx: Partial<RDContext> = createRDContext({
      pluginId: id,
      manifest,
      sdkVersion: SDK_API_VERSION,
    });

    try {
      if (!mounted.enabled) {
        await mounted.handle?.callInit(ctx);
        syncThemeToIframeViaMsg(mounted.container.querySelector('iframe') as HTMLIFrameElement);
        await mounted.handle?.callEnable();
        mounted.enabled = true;
      }
    } catch (e) {
      console.warn(`[PluginLifecycleManager] init/enable 失败 ${id}:`, e);
    }
  }

  reSyncAllTheme(): void {
    for (const m of this.mounted.values()) {
      const iframe = m.container.querySelector('iframe') as HTMLIFrameElement | null;
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage(
          { __rd_plugin: true, type: 'theme-sync', palette: getCurrentThemeInfo().palette, themeId: useThemeStore.getState().theme },
          '*'
        );
      }
    }
  }

  private async _disableAndDestroy(id: string): Promise<void> {
    const m = this.mounted.get(id);
    if (!m) return;
    try {
      if (m.enabled) await m.handle?.callDisable();
      await m.handle?.callUninstall();
    } catch (e) {
      console.warn(`[PluginLifecycleManager] disable/uninstall 异常 ${id}:`, e);
    } finally {
      // 清理该插件在 kernelEventBus 上的所有事件监听器（在 destroy 之前）
      try {
        kernelEventBus.offAll(m.owner);
      } catch {}
      // 清理该插件注册的所有 UI 资源（Toolbar 按钮等）
      try {
        usePluginUiStore.getState().removeAllForPlugin(id);
      } catch {}
      try {
        m.handle?.destroy();
      } catch {}
      try {
        m.root.unmount();
      } catch {}
      if (m.container.parentNode) m.container.parentNode.removeChild(m.container);
      this.mounted.delete(id);
    }
  }

  getMountedIds(): string[] {
    return Array.from(this.mounted.keys());
  }

  /**
   * 销毁指定插件实例（不重新加载）。
   * 用于热重载流程中先销毁旧实例。
   */
  async destroyPlugin(id: string): Promise<void> {
    await this._disableAndDestroy(id);
  }
}

export const pluginLifecycleManager = new PluginLifecycleManager();

if (typeof window !== 'undefined') {
  let lastTheme: string = useThemeStore.getState().theme;
  useThemeStore.subscribe((state) => {
    if (state.theme !== lastTheme) {
      lastTheme = state.theme;
      pluginLifecycleManager.reSyncAllTheme();
    }
  });
}
