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
import { invoke } from '@tauri-apps/api/core';
import {
  PluginSandbox,
  type PluginSandboxHandle,
} from '../components/plugin/PluginSandbox';
import type { PluginManifest, RDContext } from '../types/plugin';
import { SDK_API_VERSION, createRDContext } from './pluginSdk';
import { buildPluginIframeSrc } from './pluginBridge';
import { kernelEventBus } from './eventBus';
import { usePluginUiStore } from '../store/pluginUiStore';
import { getCurrentThemeInfo, useThemeStore } from '../store/themeStore';
import { logInfo, logWarn } from './log';

function syncThemeToIframeViaMsg(iframeEl: HTMLIFrameElement | null | undefined): void {
  if (!iframeEl?.contentWindow) return;
  const info = getCurrentThemeInfo();
  iframeEl.contentWindow.postMessage(
    {
      __rd_plugin: true,
      type: 'theme-sync',
      palette: info.palette,
      themeId: info.id,
      themeType: info.type,
    },
    '*'
  );
}

interface Mounted {
  root: Root;
  container: HTMLDivElement;
  /** 插件视图窗口（标题栏 + 内容区），默认隐藏，openView 时显示 */
  windowEl: HTMLDivElement;
  /** 沙箱句柄（useImperativeHandle 的 ref，React 提交后才会赋值） */
  handleRef: { current: PluginSandboxHandle | null };
  manifest: PluginManifest;
  enabled: boolean;
  /** 该插件在 kernelEventBus 上的 owner，用于 offAll 批量清理监听器 */
  owner: object;
}

const VIEW_CONTAINER_ID = '__rd_plugin_views__';

/**
 * 常驻的插件视图根容器（非 React，由本管理器创建）：
 * - `position: fixed; inset: 0`，默认 `visibility: hidden; pointer-events: none`
 * - 打开插件视图时加 `has-open`，同时对应插件窗口加 `is-open`
 */
function ensureRootContainer(): HTMLDivElement {
  let el = document.getElementById(VIEW_CONTAINER_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = VIEW_CONTAINER_ID;
    el.className = 'rd-view-host';
    document.body.appendChild(el);
  }
  return el;
}

/** 构造插件的 iframe src：优先加载插件自己的 index.html（注入 SDK 桥），失败回退 demo。 */
async function resolveIframeSrc(pluginId: string, fallback: string): Promise<string> {
  try {
    const html = await invoke<string>('plugin_resolve_src', { pluginId });
    return buildPluginIframeSrc(html, pluginId);
  } catch (e) {
    console.warn(`[PluginLifecycleManager] 加载插件界面失败 ${pluginId}:`, e);
    return fallback;
  }
}

/** demo iframe 内容（插件 index.html 缺失/加载失败时的占位）。
 *  同时内联初始主题 CSS 变量 + data-theme / data-theme-type，
 *  与 buildPluginIframeSrc 的真实路径保持一致的首帧无闪屏行为。 */
function buildDemoSrc(pluginId: string): string {
  const info = typeof window !== 'undefined' ? getCurrentThemeInfo() : null;
  const themeAttrs = info
    ? `data-theme="${attr(info.id)}" data-theme-type="${attr(info.type)}"`
    : '';
  const vars: string[] = [];
  if (info?.palette && typeof info.palette === 'object') {
    for (const [k, v] of Object.entries(info.palette)) {
      if (!k.startsWith('--')) continue;
      vars.push(`${k}:${cssVal(String(v))};`);
    }
  }
  const styleTag = vars.length ? `<style>:root{${vars.join('')}}<\/style>` : '';
  return (
    'data:text/html;charset=utf-8,' +
    encodeURIComponent(
      `<html ${themeAttrs}><head>${styleTag}<\/head><body><script>
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
            if (d.themeType) document.documentElement.setAttribute('data-theme-type', String(d.themeType));
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
        window.parent.postMessage({ __rd_plugin_ready: true, id: ${JSON.stringify(pluginId)} }, '*');
      <\/script><div style="padding:24px;color:var(--text-secondary,#9a9aa2);font-family:system-ui">插件界面加载失败，请检查插件文件完整性。</div></body></html>`,
    )
  );
}
function attr(s: string) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function cssVal(s: string) {
  return String(s).replace(/\\/g, '\\\\').replace(/\n/g, '\\A ').replace(/\r/g, '\\D ')
    .replace(/"/g, '\\"').replace(/'/g, "\\'").replace(/;/g, '\\;').replace(/}/g, '\\}');
}

class PluginLifecycleManager {
  private readonly mounted = new Map<string, Mounted>();
  /** 进行中的挂载流程（pluginId -> Promise）。并发 setDesiredPlugins 时复用第一次的流程，
   *  避免同一插件被重复挂载（孤儿 iframe + 重复 init/enable + 重复注册工具栏按钮）。 */
  private readonly mounting = new Map<string, Promise<void>>();

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
    // 并行挂载所有启用插件，避免串行等待（一个插件慢会拖慢全部图标的出现）。
    // _ensureMountedAndEnabled 内部有 mounting 去重，重复调用安全。
    await Promise.all(
      Array.from(desiredMap.entries()).map(([id, info]) =>
        this._ensureMountedAndEnabled(id, info.manifest, info.indexHtmlUrl),
      ),
    );
  }

  private async _ensureMountedAndEnabled(
    id: string,
    manifest: PluginManifest,
    customSrc?: string,
  ): Promise<void> {
    // 同一插件的并发挂载：等待第一次完成即可（首次流程已负责 init/enable）
    const inFlight = this.mounting.get(id);
    if (inFlight) {
      await inFlight;
      return;
    }
    const p = this._mountAndEnableOnce(id, manifest, customSrc);
    this.mounting.set(id, p);
    try {
      await p;
    } finally {
      this.mounting.delete(id);
    }
  }

  private async _mountAndEnableOnce(
    id: string,
    manifest: PluginManifest,
    customSrc?: string,
  ): Promise<void> {
    // 优先加载插件自己的 index.html（注入 SDK 桥），失败回退 demo 占位
    const src =
      customSrc?.trim()
        ? customSrc.trim()
        : await resolveIframeSrc(id, buildDemoSrc(id));

    if (!this.mounted.has(id)) {
      const rootContainer = ensureRootContainer();

      // 插件视图窗口：标题栏（插件名 + 关闭按钮）+ 内容区
      const windowEl = document.createElement('div');
      windowEl.className = 'rd-view-window';
      windowEl.innerHTML = `
        <div class="rd-view-titlebar">
          <span class="rd-view-title"></span>
          <button class="rd-view-close" title="关闭">✕</button>
        </div>
        <div class="rd-view-body"></div>`;
      const closeBtn = windowEl.querySelector('.rd-view-close');
      closeBtn?.addEventListener('click', () => {
        usePluginUiStore.getState().closePluginView();
      });
      rootContainer.appendChild(windowEl);

      const body = windowEl.querySelector('.rd-view-body') as HTMLDivElement;
      const container = document.createElement('div');
      container.className = 'rd-plugin-sandbox-root';
      body.appendChild(container);

      const root = createRoot(container);
      const handleRef: { current: PluginSandboxHandle | null } = { current: null };
      root.render(
        createElement(PluginSandbox, {
          pluginId: id,
          manifest,
          src,
          ctx: this._ctxFor(id, manifest),
          ref: (h: PluginSandboxHandle | null) => {
            handleRef.current = h;
          },
          onReady: () => {},
        }),
      );
      // 等待 React 提交并挂上 ref 句柄。⚠️ 启动时主线程繁忙，React 初始渲染的
      // 提交可能晚于一帧：若句柄未就绪就继续，下面的 callInit 会被静默跳过，
      // 插件 init 永不执行 → 工具栏按钮/图标永远不出现。因此轮询等待（5s 上限）。
      const handleDeadline = Date.now() + 5_000;
      while (!handleRef.current && Date.now() < handleDeadline) {
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      if (!handleRef.current) {
        console.warn(`[PluginLifecycleManager] ${id} 沙箱句柄 5s 内未就绪，无法初始化插件`);
      }
      const owner: object = {};
      this.mounted.set(id, {
        root,
        container,
        windowEl,
        handleRef,
        manifest,
        enabled: false,
        owner,
      });
      logInfo(`[PluginLifecycleManager] 已挂载 ${id} 沙箱，等待 init/enable`);
    }

    const mounted = this.mounted.get(id)!;
    mounted.manifest = manifest;
    // 标题跟随 manifest 名称
    const title = mounted.windowEl.querySelector('.rd-view-title');
    if (title) title.textContent = manifest.name;

    const ctx: Partial<RDContext> = createRDContext({
      pluginId: id,
      manifest,
      sdkVersion: SDK_API_VERSION,
    });

    try {
      const handle = mounted.handleRef.current;
      if (!handle) {
        logWarn(`[PluginLifecycleManager] ${id} 沙箱句柄缺失，跳过 init/enable（插件按钮不会注册）`);
      } else if (!mounted.enabled) {
        logInfo(`[PluginLifecycleManager] ${id} 发送 init`);
        await handle.callInit(ctx);
        logInfo(`[PluginLifecycleManager] ${id} init 完成`);
        syncThemeToIframeViaMsg(mounted.container.querySelector('iframe') as HTMLIFrameElement);
        logInfo(`[PluginLifecycleManager] ${id} 发送 enable`);
        await handle.callEnable();
        logInfo(`[PluginLifecycleManager] ${id} enable 完成，插件已就绪`);
        mounted.enabled = true;
      }
    } catch (e) {
      logWarn(
        `[PluginLifecycleManager] init/enable 失败 ${id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  /** 为 PluginSandbox 构造一份 ctx（用于 iframe 的 sdk-invoke 消息处理） */
  private _ctxFor(id: string, manifest: PluginManifest): Partial<RDContext> {
    return createRDContext({
      pluginId: id,
      manifest,
      sdkVersion: SDK_API_VERSION,
    });
  }

  /**
   * 打开指定插件的视图（全屏模态显示其 index.html 界面）。
   * 同一时刻仅显示一个插件视图。
   */
  openView(pluginId: string): void {
    const root = document.getElementById(VIEW_CONTAINER_ID);
    for (const m of this.mounted.values()) {
      m.windowEl.classList.toggle('is-open', m.manifest.id === pluginId);
    }
    root?.classList.add('has-open');
  }

  /** 关闭当前插件视图。 */
  closeView(): void {
    document.getElementById(VIEW_CONTAINER_ID)?.classList.remove('has-open');
    for (const m of this.mounted.values()) {
      m.windowEl.classList.remove('is-open');
    }
  }

  reSyncAllTheme(): void {
    const info = getCurrentThemeInfo();
    for (const m of this.mounted.values()) {
      const iframe = m.container.querySelector('iframe') as HTMLIFrameElement | null;
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage(
          {
            __rd_plugin: true,
            type: 'theme-sync',
            palette: info.palette,
            themeId: useThemeStore.getState().theme,
            themeType: info.type,
          },
          '*'
        );
      }
    }
  }

  private async _disableAndDestroy(id: string): Promise<void> {
    const m = this.mounted.get(id);
    if (!m) return;
    const handle = m.handleRef.current;
    try {
      if (m.enabled) await handle?.callDisable();
      await handle?.callUninstall();
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
        handle?.destroy();
      } catch {}
      try {
        m.root.unmount();
      } catch {}
      if (m.windowEl.parentNode) m.windowEl.parentNode.removeChild(m.windowEl);
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
  // 主题同步给插件 iframe：主题 id 变化 OR 当前主题调色板变化（自定义主题编辑配色）
  // 都会触发重新推送（theme-sync）。仅比较 id 会漏掉"改配色不改 id"的场景。
  let lastThemeSig = '';
  const themeSig = (): string => {
    const info = getCurrentThemeInfo();
    return info.id + '|' + JSON.stringify(info.palette);
  };
  lastThemeSig = themeSig();
  useThemeStore.subscribe(() => {
    const sig = themeSig();
    if (sig !== lastThemeSig) {
      lastThemeSig = sig;
      pluginLifecycleManager.reSyncAllTheme();
    }
  });
}
