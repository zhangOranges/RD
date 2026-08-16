import { useImperativeHandle, useLayoutEffect, useRef, useState, forwardRef } from 'react';
import type { PluginManifest, RDContext, RdEventMap } from '../../types/plugin';
import { kernelEventBus } from '../../utils/eventBus';
import { usePluginStore } from '../../store/pluginStore';
import { usePluginUiStore } from '../../store/pluginUiStore';
import { logInfo } from '../../utils/log';

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
  ctx?: Partial<RDContext>;
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
    // ⚠️ 不能把 ctx（含大量函数）放进 postMessage：结构化克隆会抛 DataCloneError，
    //    导致整个 lifecycle 消息发不出去。插件侧通过 window.__rdPlugin.ctx 访问 SDK。
    void ctx;
    const payload: Record<string, unknown> = {
      __rd_plugin: true,
      type: 'lifecycle',
      name,
      pluginId,
      manifest,
    };
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
  { pluginId, manifest, src, ctx, onReady },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const loadedRef = useRef(false);
  /** 该插件专属 owner，用于在 kernelEventBus 上批量移除该插件所有监听器 */
  const ownerRef = useRef<object>({});
  /** key = `${event}:${listenerId}`，value = forwarder，用于精确 off */
  const forwardersRef = useRef<Map<string, ForwarderFn>>(new Map());
  /** 主侧回调注册表：{ __rd_cb: id } 占位 → 可调用函数（发 sdk-callback 到 iframe） */
  const callbacksRef = useRef<Map<string, (...a: unknown[]) => Promise<unknown>>>(new Map());
  const cbSeqRef = useRef(0);
  /** 主侧发起的远程回调调用（callId -> {res,rej}） */
  const cbPendingRef = useRef<
    Map<string, { res: (v: unknown) => void; rej: (e: Error) => void }>
  >(new Map());
  /** watchdog 定时器（每 2s ping，5s 无 pong 则判定卡死） */
  const watchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 内存检测定时器（每 5s 检查 usedJSHeapSize） */
  const memoryCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /** 最近一次收到 pong 的时间戳 */
  const lastPongRef = useRef<number>(Date.now());
  /** 插件异常信息（JS 报错横幅）：null=无错误，string=最新一条（多行），可点击关闭 */
  const [pluginError, setPluginError] = useState<null | { kind: string; message: string; src: string; line: number; col: number; stack: string; ts: number }>(null);

  /**
   * 等待 iframe 加载并注册好生命周期处理器（上限 10s）。
   * 用"轮询 + ready-check 主动握手"而非一次性 ready Promise：iframe（data URL）加载
   * 可能早于监听器挂载，导致初始 __rd_plugin_ready 消息丢失。
   * 配合 useLayoutEffect 提前挂载 message 监听后，初始 ready 几乎总能被捕获，
   * 轮询仅作兜底（50ms 间隔，命中后立即返回）。
   */
  const waitForReady = async (): Promise<void> => {
    const deadline = Date.now() + 10_000;
    while (!loadedRef.current && Date.now() < deadline) {
      try {
        iframeRef.current?.contentWindow?.postMessage(
          { __rd_plugin: true, type: 'ready-check', ts: Date.now() },
          '*',
        );
      } catch {
        /* ignore */
      }
      await new Promise<void>((r) => setTimeout(r, 50));
    }
  };

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
        callbacksRef.current.clear();
        cbPendingRef.current.clear();
        if (iframeRef.current?.parentElement) iframeRef.current.remove();
        iframeRef.current = null;
        loadedRef.current = false;
        setPluginError(null);
      },
      getOwner: () => ownerRef.current,
      forwardEvent: (event, args) => {
        iframeRef.current?.contentWindow?.postMessage(
          { __rd_plugin: true, type: 'bus-event', event, args },
          '*',
        );
      },
      callInit: async (ctx) => {
        await waitForReady();
        const win = iframeRef.current?.contentWindow;
        if (!win) return;
        await sendLifecycle(win, pluginId, manifest, 'init', ctx);
      },
      callEnable: async () => {
        await waitForReady();
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

  // 用 useLayoutEffect（同步于 DOM 提交之后、浏览器开始解析 iframe 之前挂载监听），
  // 确保 iframe 内 SDK 桥的 __rd_plugin_ready 消息不会被主侧遗漏。
  useLayoutEffect(() => {
    /**
     * 主侧 pack：把函数替换为 `{ __rd_cb: id }` 占位（函数注册为本地回调，
     * 调用时发 sdk-callback 到 iframe）。与 pluginBridge 的 pack 语义一致。
     */
    // 主侧发起远程调用 → 进入 cbPendingRef 等待 callback-result；统一包装：
    //  - 60s 超时自动 reject（防止 iframe 崩溃后内存泄漏）
    //  - resolve/reject 后自动清理 Map
    const makePendingCall = (cid: string, send: () => void) => {
      return new Promise<unknown>((res, rej) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const done = (kind: 'res' | 'rej', value: unknown) => {
          if (settled) return;
          settled = true;
          if (timer) { clearTimeout(timer); timer = null; }
          cbPendingRef.current.delete(cid);
          if (kind === 'res') res(value); else rej(value as Error);
        };
        cbPendingRef.current.set(cid, {
          res: (v) => done('res', v),
          rej: (e) => done('rej', e),
        });
        timer = setTimeout(() => {
          done('rej', new Error('CALLBACK_PENDING_TIMEOUT: 插件响应超时（60s）'));
        }, 60_000);
        try { send(); } catch (e) {
          done('rej', e instanceof Error ? e : new Error(String(e)));
        }
      });
    };
    const packForFrame = (value: unknown): unknown => {
      if (typeof value === 'function') {
        const id = 'mc' + (++cbSeqRef.current);
        callbacksRef.current.set(id, (...a: unknown[]) => {
          const cid = 'mc' + (++cbSeqRef.current);
          return makePendingCall(cid, () => {
            iframeRef.current?.contentWindow?.postMessage(
              { __rd_plugin: true, type: 'sdk-callback', cbId: id, callId: cid, args: a.map(packForFrame) },
              '*',
            );
          });
        });
        return { __rd_cb: id };
      }
      if (Array.isArray(value)) {
        return value.map(packForFrame);
      }
      if (value && typeof value === 'object') {
        const o: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>)) {
          try {
            o[k] = packForFrame((value as Record<string, unknown>)[k]);
          } catch {
            /* ignore */
          }
        }
        return o;
      }
      return value;
    };

    /**
     * 主侧 unpack：把 `{ __rd_cb: id }` 还原为函数。本地（主侧）注册过的直接返回，
     * 否则构造"远程函数"（调用时发 sdk-callback 到 iframe）。
     */
    const unpackFromFrame = (value: unknown): unknown => {
      if (
        value &&
        typeof value === 'object' &&
        typeof (value as Record<string, unknown>).__rd_cb === 'string'
      ) {
        const id = String((value as Record<string, unknown>).__rd_cb);
        const local = callbacksRef.current.get(id);
        if (local) return local;
        const remote = (...a: unknown[]) => {
          const cid = 'mc' + (++cbSeqRef.current);
          return makePendingCall(cid, () => {
            iframeRef.current?.contentWindow?.postMessage(
              { __rd_plugin: true, type: 'sdk-callback', cbId: id, callId: cid, args: a.map(packForFrame) },
              '*',
            );
          });
        };
        callbacksRef.current.set(id, remote);
        return remote;
      }
      if (Array.isArray(value)) {
        return value.map(unpackFromFrame);
      }
      if (value && typeof value === 'object') {
        const o: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>)) {
          try {
            o[k] = unpackFromFrame((value as Record<string, unknown>)[k]);
          } catch {
            /* ignore */
          }
        }
        return o;
      }
      return value;
    };

    const onMsg = (ev: MessageEvent) => {
      const data = ev.data;
      if (!data || typeof data !== 'object') return;
      // iframe ready 通知
      if (data.__rd_plugin_ready === true) {
        loadedRef.current = true;
        logInfo(`[PluginSandbox] ${pluginId} iframe ready`);
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

      // 插件 JS 全局异常（window.onerror / unhandledrejection）：写入日志 + 展示横幅
      if (data.type === 'plugin-error') {
        const kind = String(data.kind || 'error');
        const message = String(data.message || '');
        const src = String(data.src || '');
        const line = Number(data.line || 0);
        const col = Number(data.col || 0);
        const stack = String(data.stack || '');
        const ts = Date.now();
        usePluginUiStore.getState().addLog(pluginId, 'error',
          `插件${kind === 'unhandledrejection' ? '未捕获 Promise' : ''}错误: ${message}` +
          (src ? ` （${src}:${line}:${col}）` : line ? ` （:${line}:${col}）` : '') +
          (stack ? '\n' + stack : ''));
        setPluginError({ kind, message, src, line, col, stack, ts });
        return;
      }

      // 插件 console.* 转发：写入日志面板（同时插件 iframe 自己的 devtools 仍可看到）
      if (data.type === 'plugin-console') {
        const levelRaw = String(data.level || 'info');
        const level: 'info' | 'warn' | 'error' =
          levelRaw === 'warn' ? 'warn' : levelRaw === 'error' ? 'error' : 'info';
        const rawLevel = String(data.rawLevel || level);
        const message = String(data.message ?? '');
        usePluginUiStore
          .getState()
          .addLog(
            pluginId,
            level,
            rawLevel !== level ? `[console.${rawLevel}] ${message}` : message,
          );
        return;
      }

      // 插件 performance.mark / performance.measure 转发：
      // 以 info 级别写入日志面板，方便排查「插件初始化慢在哪段」。
      if (data.type === 'plugin-performance') {
        const name = String(data.name || '');
        const entryType = String(data.entryType || 'perf');
        const startTime = Number(data.startTime ?? 0);
        const duration = Number(data.duration ?? 0);
        const msg =
          entryType === 'measure'
            ? `[perf:measure] ${name}: ${duration}ms （start +${startTime}ms）`
            : `[perf:mark] ${name} @ +${startTime}ms`;
        usePluginUiStore.getState().addLog(pluginId, 'info', msg);
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
      } else if (data.type === 'sdk-invoke') {
        // 插件 iframe 通过 SDK 桥调用内核 ctx 方法：
        // { type:'sdk-invoke', callId, path:['tunnel','listRules'], args:[...] }
        const callId = data.callId as string;
        const path = data.path as string[];
        logInfo(`[PluginSandbox] ${pluginId} sdk-invoke: ${path.join('.')}`);
        const reply = (ok: boolean, value?: unknown, error?: string) => {
          iframeRef.current?.contentWindow?.postMessage(
            { __rd_plugin: true, type: 'sdk-result', callId, ok, value: packForFrame(value), error },
            '*',
          );
        };
        let target: unknown = ctx;
        for (const seg of path) {
          if (target == null) break;
          target = (target as Record<string, unknown>)[seg];
        }
        if (typeof target !== 'function') {
          reply(false, undefined, `SDK_PATH_NOT_FUNCTION: ${path.join('.')}`);
          return;
        }
        let args: unknown[];
        try {
          args = unpackFromFrame((data.args ?? []) as unknown[]) as unknown[];
        } catch (e) {
          reply(false, undefined, `SDK_ARGS_UNPACK_FAILED: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        Promise.resolve()
          .then(() => (target as (...a: unknown[]) => unknown).apply(ctx, args))
          .then((v) => reply(true, v))
          .catch((e) =>
            reply(false, undefined, e instanceof Error ? e.message : String(e)),
          );
      } else if (data.type === 'sdk-callback') {
        // iframe 调用主侧注册的回调（如工具栏按钮的 onClick）
        const cbId = String(data.cbId ?? '');
        const callId = String(data.callId ?? '');
        const local = callbacksRef.current.get(cbId);
        const finish = (ok: boolean, value?: unknown, error?: string) => {
          iframeRef.current?.contentWindow?.postMessage(
            { __rd_plugin: true, type: 'callback-result', callId, ok, value: packForFrame(value), error },
            '*',
          );
        };
        if (typeof local !== 'function') {
          finish(false, undefined, 'CALLBACK_NOT_FOUND');
          return;
        }
        let cbArgs: unknown[];
        try {
          cbArgs = unpackFromFrame((data.args ?? []) as unknown[]) as unknown[];
        } catch (e) {
          finish(false, undefined, `CB_ARGS_UNPACK_FAILED: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        try {
          const r = local.apply(null, cbArgs);
          if (r && typeof (r as Promise<unknown>).then === 'function') {
            (r as Promise<unknown>).then(
              (v) => finish(true, v),
              (e) => finish(false, undefined, e instanceof Error ? e.message : String(e)),
            );
          } else {
            finish(true, r);
          }
        } catch (e) {
          finish(false, undefined, e instanceof Error ? e.message : String(e));
        }
      } else if (data.type === 'callback-result') {
        // iframe 对主侧远程回调调用的返回
        const callId = String(data.callId ?? '');
        const p = cbPendingRef.current.get(callId);
        if (p) {
          cbPendingRef.current.delete(callId);
          if (data.ok) {
            p.res(unpackFromFrame(data.value));
          } else {
            p.rej(new Error(String(data.error || 'CALLBACK_FAILED')));
          }
        }
      }
    };
    window.addEventListener('message', onMsg);
    return () => {
      window.removeEventListener('message', onMsg);
      // iframe 卸载：遍历 cbPendingRef 中还在等 reply 的 callId，全部 reject（防止 Promise hang）
      const pending = Array.from(cbPendingRef.current.entries());
      cbPendingRef.current.clear();
      for (const [, p] of pending) {
        try { p.rej(new Error('PLUGIN_UNLOADED: 插件已卸载或组件销毁')); } catch { /* promise 没 catch 时屏蔽 */ }
      }
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
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {pluginError && (
        <div
          role="alert"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            zIndex: 10,
            padding: '8px 14px',
            background: 'linear-gradient(180deg, #fef2f2, #fee2e2)',
            color: '#991b1b',
            borderBottom: '1px solid #fecaca',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            fontSize: 13,
            lineHeight: 1.5,
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
          }}
        >
          <span aria-hidden style={{ flexShrink: 0, marginTop: 1, fontSize: 16 }}>⚠️</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              插件运行时{pluginError.kind === 'unhandledrejection' ? '异步异常（未捕获 Promise）' : '错误'}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {pluginError.message}
              {pluginError.src
                ? `\n位置: ${pluginError.src}:${pluginError.line}:${pluginError.col}`
                : pluginError.line
                  ? `\n位置: :${pluginError.line}:${pluginError.col}`
                  : ''}
              {pluginError.stack ? `\n${pluginError.stack}` : ''}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'stretch' }}>
            <button
              type="button"
              onClick={() => setPluginError(null)}
              title="关闭错误提示"
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid #fecaca',
                background: '#fff',
                color: '#991b1b',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              关闭
            </button>
            <button
              type="button"
              onClick={() => {
                setPluginError(null);
                // 通过 reload iframe src 触发重挂载；
                // useLayoutEffect 的 cleanup(destroy + removeEventListener) + new src=相同 dataUrl 会触发浏览器重新 parse
                // 对 data URL，必须强制变更 src 才能保证重建；这里用替换 iframe 节点的方法
                const old = iframeRef.current;
                if (!old || !old.parentElement) return;
                const newIf = document.createElement('iframe');
                newIf.src = src;
                // 与 <iframe sandbox="..."> 属性保持一致：allow-same-origin 审计结论保持不启用
                // 见下方 sandbox 属性注释详情。
                newIf.sandbox.add('allow-scripts');
                newIf.sandbox.add('allow-popups');
                newIf.sandbox.add('allow-downloads');
                newIf.setAttribute('title', `plugin-${pluginId}`);
                newIf.style.width = '100%';
                newIf.style.height = '100%';
                newIf.style.border = '0';
                old.parentElement.insertBefore(newIf, old);
                old.parentElement.removeChild(old);
                (iframeRef as React.MutableRefObject<HTMLIFrameElement | null>).current = newIf;
                loadedRef.current = false;
              }}
              title="重新加载插件（尝试恢复）"
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                border: '1px solid #d1d5db',
                background: '#ffffff',
                color: '#111827',
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              重启插件
            </button>
          </div>
        </div>
      )}
      <iframe
        ref={iframeRef}
        title={`plugin-${pluginId}`}
        src={src}
        // [P0-1 allow-same-origin 审计结论：保持「不加 allow-same-origin」]
        //
        //  1) 当前 src 是 data:text/html;charset=utf-8,...（见 buildPluginIframeSrc），
        //     本身就是 opaque unique origin；即便设置 allow-same-origin，data URL
        //     在 HTML 规范里仍然是 opaque，加了也没有实际收益。
        //  2) 如果未来切到 file:/// 或 http(s)://<host>/ 方案作为插件加载源：
        //     - 不带 allow-same-origin → iframe 依然是 opaque origin，无法
        //       直接访问主程序同源的 localStorage / cookie / indexedDB，也
        //       无法发起带凭据的 fetch（主程序数据完全由 postMessage / SDK
        //       显式暴露，最小权限）；
        //     - 加上 allow-same-origin → file:// 场景下多插件 iframe 与主
        //       程序很可能被浏览器视为「同源」，任何插件被攻破即可直接读写
        //       主程序全部本地存储；http(s) 场景下同源策略大幅放宽。
        //  3) 综合风险面：保持 allow-same-origin 不启用，是目前最保守、安全
        //     的默认配置。如某一天确实需要它（例如共享 SharedWorker 或直读
        //     主程序 CSS 变量的样式计算），必须先做安全审查，并同步收紧
        //     SDK 暴露面 + 主程序 webPreferences 隔离策略。
        sandbox="allow-scripts allow-popups allow-downloads"
        style={{ width: '100%', height: '100%', border: 0, display: 'block' }}
      />
    </div>
  );
});
