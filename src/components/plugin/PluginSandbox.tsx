import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import type { PluginManifest, RDContext, RdEventMap } from '../../types/plugin';
import { kernelEventBus } from '../../utils/eventBus';
import { usePluginStore } from '../../store/pluginStore';
import { usePluginUiStore } from '../../store/pluginUiStore';

type ForwarderFn = (...args: unknown[]) => void;

export interface PluginSandboxHandle {
  destroy: () => void;
  callInit: (ctx: Partial<RDContext>) => Promise<void>;
  callEnable: () => Promise<void>;
  callDisable: () => Promise<void>;
  callUninstall: () => Promise<void>;
  /** 获取该插件的 owner 对象（用于 kernelEventBus.offAll） */
  getOwner: () => object;
  /** 供内核直接转发事件给 iframe（不经过 kernelEventBus 订阅模式，用于广播场景） */
  forwardEvent: <K extends keyof RdEventMap>(event: K, args: RdEventMap[K]) => void;
}

interface Props {
  pluginId: string;
  manifest: PluginManifest;
  src: string;
  onReady?: () => void;
}

type LifecycleName = 'init' | 'enable' | 'disable' | 'uninstall';

export function buildDemoSrc(pluginId: string): string {
  return (
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
        window.parent.postMessage({ __rd_plugin_ready: true, id: ${JSON.stringify(pluginId)} }, '*');
      <\/script></body></html>`,
    )
  );
}

function sendLifecycle(
  target: Window,
  pluginId: string,
  manifest: PluginManifest,
  name: LifecycleName,
  ctx?: Partial<RDContext>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const ch = new MessageChannel();
    let settled = false;
    const payload: Record<string, unknown> = {
      __rd_plugin: true,
      type: 'lifecycle',
      name,
      pluginId,
      manifest,
    };
    if (ctx) {
      payload.ctx = ctx;
    }
    const transfer: Transferable[] = [ch.port2];
    ch.port1.onmessage = (ev: MessageEvent) => {
      if (settled) return;
      settled = true;
      ch.port1.close();
      const data = ev.data;
      if (data && typeof data === 'object' && typeof data.error === 'string') {
        // 错误回复：reject，但 Phase 1 调用方已包 try/catch
        Promise.reject(new Error(data.error)).catch(() => {});
        resolve();
      } else {
        resolve();
      }
    };
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        ch.port1.close();
      } catch {}
      resolve();
    }, 3000);
    try {
      target.postMessage(payload, '*', transfer);
    } catch (e) {
      window.clearTimeout(timer);
      if (settled) return;
      settled = true;
      console.warn('[PluginSandbox] postMessage 异常:', e);
      resolve();
    }
  });
}

export const PluginSandbox = forwardRef<PluginSandboxHandle, Props>(function PluginSandbox(
  { pluginId, manifest, src, onReady },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const loadedRef = useRef(false);
  /** 该插件专属 owner，用于在 kernelEventBus 上批量移除该插件所有监听器 */
  const ownerRef = useRef<object>({});
  /** key = `${event}:${listenerId}`，value = forwarder，用于精确 off */
  const forwardersRef = useRef<Map<string, ForwarderFn>>(new Map());
  /** watchdog 定时器（每 2s ping，5s 无 pong 则判定卡死） */
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 内存检测定时器（每 5s 检查 usedJSHeapSize） */
  const memoryCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 最近一次收到 pong 的时间戳 */
  const lastPongRef = useRef<number>(Date.now());

  useImperativeHandle(
    ref,
    () => ({
      destroy: () => {
        // 停止 watchdog 和内存检测
        if (watchdogRef.current) {
          clearInterval(watchdogRef.current);
          watchdogRef.current = null;
        }
        if (memoryCheckRef.current) {
          clearInterval(memoryCheckRef.current);
          memoryCheckRef.current = null;
        }
        // 通知 iframe 自行清理定时器/监听器
        try {
          iframeRef.current?.contentWindow?.postMessage(
            { __rd_plugin: true, type: 'lifecycle:destroy' },
            '*',
          );
        } catch {
          /* ignore */
        }
        // 清理该插件在 kernelEventBus 上的所有 forwarder
        kernelEventBus.offAll(ownerRef.current);
        forwardersRef.current.clear();
        if (iframeRef.current?.parentElement) iframeRef.current.remove();
        iframeRef.current = null;
        loadedRef.current = false;
      },
      getOwner: () => ownerRef.current,
      forwardEvent: (event, args) => {
        iframeRef.current?.contentWindow?.postMessage(
          { __rd_plugin: true, type: 'bus-event', event, args },
          '*',
        );
      },
      callInit: async (ctx) => {
        const win = iframeRef.current?.contentWindow;
        if (!win) return;
        await sendLifecycle(win, pluginId, manifest, 'init', ctx);
      },
      callEnable: async () => {
        const win = iframeRef.current?.contentWindow;
        if (!win) return;
        await sendLifecycle(win, pluginId, manifest, 'enable');
      },
      callDisable: async () => {
        const win = iframeRef.current?.contentWindow;
        if (!win) return;
        await sendLifecycle(win, pluginId, manifest, 'disable');
      },
      callUninstall: async () => {
        const win = iframeRef.current?.contentWindow;
        if (!win) return;
        await sendLifecycle(win, pluginId, manifest, 'uninstall');
      },
    }),
    [pluginId, manifest],
  );

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || typeof data !== 'object') return;
      // iframe ready 通知
      if (data.__rd_plugin_ready === true) {
        loadedRef.current = true;
        // 启动 watchdog（ping/pong 卡死检测）
        if (!watchdogRef.current) {
          lastPongRef.current = Date.now();
          watchdogRef.current = setInterval(() => {
            const iframe = iframeRef.current;
            if (!iframe?.contentWindow) return;
            // 发送 ping
            try {
              iframe.contentWindow.postMessage(
                { __rd_plugin: true, type: 'watchdog-ping', ts: Date.now() },
                '*',
              );
            } catch {
              /* ignore */
            }
            // 检查上次 pong 是否超过 5s
            if (Date.now() - lastPongRef.current > 5_000) {
              console.warn(
                `[PluginSandbox] 插件 ${pluginId} 疑似卡死（5s 无 pong），自动禁用`,
              );
              usePluginUiStore
                .getState()
                .addLog(pluginId, 'error', '插件疑似卡死，已自动停止');
              usePluginStore
                .getState()
                .togglePlugin(pluginId, false)
                .catch(() => {});
              // 停止 watchdog
              if (watchdogRef.current) {
                clearInterval(watchdogRef.current);
                watchdogRef.current = null;
              }
            }
          }, 2_000);
        }
        // 启动内存检测
        if (!memoryCheckRef.current) {
          memoryCheckRef.current = setInterval(() => {
            const perf = performance as Performance & {
              memory?: {
                usedJSHeapSize: number;
                totalJSHeapSize: number;
                jsHeapSizeLimit: number;
              };
            };
            if (!perf.memory) return; // 非 Chrome 环境降级
            const usedMB = perf.memory.usedJSHeapSize / 1024 / 1024;
            if (usedMB > 200) {
              console.warn(
                `[PluginSandbox] 插件 ${pluginId} 内存超限: ${usedMB.toFixed(1)}MB`,
              );
              usePluginUiStore
                .getState()
                .addLog(
                  pluginId,
                  'error',
                  `内存超限: ${usedMB.toFixed(1)}MB，已自动停止`,
                );
              usePluginStore
                .getState()
                .togglePlugin(pluginId, false)
                .catch(() => {});
              if (memoryCheckRef.current) {
                clearInterval(memoryCheckRef.current);
                memoryCheckRef.current = null;
              }
            }
          }, 5_000);
        }
        onReady?.();
        return;
      }
      // 仅处理插件协议消息，并校验来源是该插件 iframe
      if (data.__rd_plugin !== true) return;
      if (ev.source !== iframeRef.current?.contentWindow) return;

      // watchdog pong 响应
      if (data.type === 'watchdog-pong') {
        lastPongRef.current = Date.now();
        return;
      }

      if (data.type === 'bus-on') {
        const event = data.event as keyof RdEventMap;
        const listenerId = data.listenerId as number;
        const key = String(event) + ':' + String(listenerId);
        const forwarder: ForwarderFn = (...args: unknown[]) => {
          iframeRef.current?.contentWindow?.postMessage(
            { __rd_plugin: true, type: 'bus-event', event, args, listenerId },
            '*',
          );
        };
        kernelEventBus.on(event, forwarder as (...args: RdEventMap[keyof RdEventMap]) => void, ownerRef.current);
        forwardersRef.current.set(key, forwarder);
      } else if (data.type === 'bus-off') {
        const event = data.event as keyof RdEventMap;
        const listenerId = data.listenerId as number;
        const key = String(event) + ':' + String(listenerId);
        const forwarder = forwardersRef.current.get(key);
        if (forwarder) {
          kernelEventBus.off(event, forwarder as (...args: RdEventMap[keyof RdEventMap]) => void);
          forwardersRef.current.delete(key);
        }
      }
    };
    window.addEventListener('message', onMsg);
    return () => {
      window.removeEventListener('message', onMsg);
      if (watchdogRef.current) {
        clearInterval(watchdogRef.current);
        watchdogRef.current = null;
      }
      if (memoryCheckRef.current) {
        clearInterval(memoryCheckRef.current);
        memoryCheckRef.current = null;
      }
    };
  }, [onReady, pluginId]);

  return (
    <div style={{ display: 'none' }}>
      <iframe
        ref={iframeRef}
        title={`plugin-${pluginId}`}
        src={src}
        sandbox="allow-scripts allow-popups"
      />
    </div>
  );
});
