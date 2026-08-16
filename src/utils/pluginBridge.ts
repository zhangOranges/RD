/**
 * 插件 SDK 桥（注入到插件 index.html 的 iframe 中）。
 *
 * 由于 postMessage 结构化克隆无法传输函数，主程序侧的 RDContext（含全部
 * SDK 能力）不能直接传给 iframe。本桥脚本在 iframe 内构造一个"调用代理"：
 * - `window.__rdPlugin.ctx.<group>.<method>(...)` → 通过 sdk-invoke 消息
 *   发往主程序，主程序用真实的 RDContext 执行后经 sdk-result 回传结果。
 * - `window.__rdPlugin.on(handlers)` 注册生命周期处理器（init/enable 等）。
 * - `window.__rdPlugin.onBus(event, fn)` 订阅内核事件总线（connection:success
 *   等），返回取消订阅函数。
 *
 * 【双向回调】UI 注册类 API（如 registerToolbarButton 的 onClick）需要把函数
 * 传进主程序，且主程序后续要能反向调用它。桥通过 pack/unpack 把函数序列化为
 * `{ __rd_cb: <id> }` 占位对象：
 * - 函数从 iframe → 主程序：pack 注册本地回调，主程序 unpack 得到"远程函数"
 *   （调用时发 sdk-callback 消息回 iframe）。
 * - 函数从主程序 → iframe：主程序 pack 注册自己的回调，iframe unpack 得到
 *   "远程函数"（调用时发 sdk-callback 消息回主程序）。
 * 两侧都处理 sdk-callback（查本地回调并执行）与 callback-result（解析远程调用）。
 *
 * 插件代码在 index.html 的 <script> 中直接使用 window.__rdPlugin 即可，
 * 无需关心桥接细节——这是给第三方插件开发者的标准接口。
 */

import { getCurrentThemeInfo } from '../store/themeStore';
import { escapeAttr, escapeCssValue } from './escape';
// 重新导出以便外部（以及测试前的临时调用方）继续从 pluginBridge 入口取用这两个函数
export { escapeAttr, escapeCssValue };

/**
 * 插件公共样式库（随桥脚本一起注入到每个插件 iframe 的 <head> 内）。
 *
 * 目标：
 *  - 给所有内置/第三方插件提供一套"和主程序视觉一致"的基础 CSS：reset、按钮、表单、switch、表格、菜单、
 *    tag / mono / 警示条等，避免每个插件都复制粘贴一遍 base 样式。
 *  - class 命名以 `.rd-` 前缀为主（如 `.rd-btn`、`.rd-form-input`），避免污染插件作者自己的私有样式；
 *    同时给早期通用名（`.btn` / `.form-input` 等）保留等价别名，兼容 rd-native-port-forward 这批
 *    已在内置插件目录里写好的 HTML（不用全量改 class 名，保持稳定）。
 *  - 颜色 / 尺寸 / 间距一律用主程序同步过来的 CSS 变量，找不到时 fallback 到主程序"默认深色主题"的同值，
 *    保证 iframe 没收到 theme-sync 前（首帧）也不会闪屏。
 */
export const PLUGIN_COMMON_CSS = `
/* ===== RD Plugin Common Styles (injected by bridge) ===== */
:root { color-scheme: dark; }
:root[data-theme-type="light"] { color-scheme: light; }

/* reset */
*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
    'Microsoft YaHei', sans-serif;
  font-size: 13px;
  color: var(--text-primary, #e4e4e7);
  background: var(--bg-content, #14161a);
  overflow: hidden;
  user-select: none;
}
input, select, textarea, button { font-family: inherit; }
a { color: inherit; }

/* layout helpers */
.rd-fill, #app { display: flex; flex-direction: column; height: 100%; width: 100%; }

/* ---- buttons ---- */
.rd-btn, .btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--divider, rgba(127,127,127,0.25));
  background: var(--bg-input, rgba(127,127,127,0.12));
  color: var(--text-primary, #e4e4e7);
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease, opacity 0.12s ease;
  white-space: nowrap;
}
.rd-btn:hover, .btn:hover { background: var(--hover, rgba(127,127,127,0.2)); }
.rd-btn:active, .btn:active { transform: translateY(1px); }
.rd-btn:disabled, .btn:disabled { opacity: 0.45; cursor: not-allowed; }

.rd-btn-primary, .btn-primary {
  background: var(--accent, #3b82f6);
  border-color: var(--accent, #3b82f6);
  color: var(--text-on-accent, #fff);
}
.rd-btn-primary:hover, .btn-primary:hover {
  filter: brightness(1.08);
  background: var(--accent, #3b82f6);
}
.rd-btn-danger, .btn-danger { color: var(--danger, #ef4444); }
.rd-btn-danger:hover, .btn-danger:hover {
  background: color-mix(in srgb, var(--danger, #ef4444) 12%, transparent);
}
.rd-btn-ghost, .btn-ghost { background: transparent; }

/* ---- form controls ---- */
.rd-form-input, .rd-form-select, .rd-form-textarea,
.form-input, .form-select, .form-textarea {
  background: var(--bg-input, rgba(127,127,127,0.12));
  border: 1px solid var(--divider, rgba(127,127,127,0.25));
  border-radius: 6px;
  color: var(--text-primary, #e4e4e7);
  font-size: 12.5px;
  padding: 5px 9px;
  outline: none;
}
.rd-form-input:focus, .rd-form-select:focus, .rd-form-textarea:focus,
.form-input:focus, .form-select:focus, .form-textarea:focus {
  border-color: var(--accent, #3b82f6);
}
.rd-form-textarea, .form-textarea { resize: vertical; min-height: 56px; line-height: 1.5; }

.rd-form-select, .form-select {
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  padding-right: 28px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path fill='none' stroke='%2394a3b8' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round' d='M3 4.5l3 3 3-3'/></svg>");
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 12px 12px;
  cursor: pointer;
  background-color: var(--bg-input, rgba(127,127,127,0.12));
}
.rd-form-select:hover, .form-select:hover {
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><path fill='none' stroke='%23cbd5e1' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round' d='M3 4.5l3 3 3-3'/></svg>");
}
.rd-form-select option, .form-select option {
  background: var(--bg-content, #1a1a1f);
  color: var(--text-primary, #e4e4e7);
}

/* ---- switch ---- */
.rd-switch-label, .pf-switch-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary, #b0b0b8);
  cursor: pointer;
  user-select: none;
}
.rd-switch, .pf-switch { position: relative; width: 30px; height: 16px; flex: 0 0 auto; }
.rd-switch input, .pf-switch input { opacity: 0; width: 0; height: 0; }
.rd-switch-track, .pf-switch-track {
  position: absolute; inset: 0;
  border-radius: 8px;
  background: var(--divider, rgba(127,127,127,0.3));
  transition: background 0.15s ease;
}
.rd-switch-track::after, .pf-switch-track::after {
  content: '';
  position: absolute; top: 2px; left: 2px;
  width: 12px; height: 12px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s ease;
}
.rd-switch.on .rd-switch-track, .rd-switch:has(input:checked) .rd-switch-track,
.rd-switch input:checked + .rd-switch-track,
.pf-switch.on .pf-switch-track, .pf-switch:has(input:checked) .pf-switch-track,
.pf-switch input:checked + .pf-switch-track { background: var(--accent, #3b82f6); }
.rd-switch.on .rd-switch-track::after, .rd-switch:has(input:checked) .rd-switch-track::after,
.rd-switch input:checked + .rd-switch-track::after,
.pf-switch.on .pf-switch-track::after, .pf-switch:has(input:checked) .pf-switch-track::after,
.pf-switch input:checked + .pf-switch-track::after { transform: translateX(14px); }
.rd-switch input:disabled + .rd-switch-track,
.pf-switch input:disabled + .pf-switch-track { opacity: 0.5; }

/* ---- dropdown menu ---- */
.rd-menu-wrap, .pf-menu-wrap { position: relative; }
.rd-menu, .pf-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  min-width: 168px;
  background: var(--bg-content, #14161a);
  border: 1px solid var(--divider, rgba(127,127,127,0.25));
  border-radius: 8px;
  padding: 4px;
  z-index: 20;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}
.rd-menu-item, .pf-menu-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  font-size: 12px;
  background: transparent;
  border: none;
  color: var(--text-primary, #e4e4e7);
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
}
.rd-menu-item:hover, .pf-menu-item:hover { background: var(--hover, rgba(127,127,127,0.2)); }

/* ---- warn / danger banner ---- */
.rd-banner-warn, .pf-warn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 8px;
  font-size: 12px;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.3);
  color: #f59e0b;
}
.rd-banner-danger, .pf-warn.danger {
  background: rgba(239, 68, 68, 0.12);
  border-color: rgba(239, 68, 68, 0.3);
  color: var(--danger, #ef4444);
}

/* ---- table ---- */
.rd-table, .pf-table { width: 100%; border-collapse: collapse; }
.rd-table th, .pf-table th {
  text-align: left;
  padding: 8px 10px;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-tertiary, #9a9aa2);
  border-bottom: 1px solid var(--divider, rgba(127,127,127,0.25));
  white-space: nowrap;
}
.rd-table td, .pf-table td {
  padding: 9px 10px;
  font-size: 12.5px;
  border-bottom: 1px solid var(--divider-soft, rgba(127,127,127,0.1));
  vertical-align: middle;
}
.rd-table tr:hover td, .pf-table tr:hover td { background: var(--hover, rgba(127,127,127,0.08)); }

/* ---- status pill / dot ---- */
.rd-pill, .pf-mode-pill {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
}
.rd-dot, .pf-dot { display: inline-flex; align-items: center; gap: 6px; }
.rd-dot i, .pf-dot i {
  width: 8px; height: 8px; border-radius: 50%; display: inline-block;
  background: var(--text-tertiary, #9a9aa2); opacity: 0.4;
}
.rd-dot i.running, .pf-dot i.running {
  background: #22c55e; opacity: 1; box-shadow: 0 0 0 2px rgba(34,197,94,0.15);
}
.rd-dot i.error, .pf-dot i.error { background: #ef4444; opacity: 1; }
.rd-dot i.starting, .pf-dot i.starting { background: #f59e0b; opacity: 1; }

/* ---- typography helpers ---- */
.rd-mono, .pf-mono {
  font-family: 'SF Mono', 'Consolas', 'Monaco', monospace;
  font-size: 12px;
}
.rd-muted { color: var(--text-tertiary, #9a9aa2); }
.rd-sub, .pf-sub { font-size: 11px; color: var(--text-tertiary, #9a9aa2); }
.rd-empty, .pf-empty {
  padding: 40px 0;
  text-align: center;
  color: var(--text-tertiary, #9a9aa2);
  font-size: 13px;
}

/* ---- card / panel ---- */
.rd-card, .pf-form {
  border-radius: 10px;
  background: var(--bg-input, rgba(127,127,127,0.06));
  border: 1px solid var(--divider, rgba(127,127,127,0.25));
  padding: 16px;
}
`;

/** 注入版 SDK 桥脚本（会被插到插件 index.html 的 </head> 前）。 */
export const PLUGIN_BRIDGE_SCRIPT = `(function(){
  var pending = {}, seq = 0;              // sdk-invoke 调用（callId -> {res,rej}）
  var cbPending = {};                     // 远程回调调用（callId -> {res,rej}）
  var callbacks = {}, cbSeq = 0;          // 本地回调（cbId -> fn）
  function post(msg){ window.parent.postMessage(Object.assign({__rd_plugin:true}, msg), '*'); }

  // ---- 捕获插件 JS 全局异常，转发给主程序展示错误横幅 ----
  // window.onerror：拦截同步错误（语法错、ReferenceError、插件未定义变量等）
  //   第 5 个参数 errObj 非标准但所有主流浏览器支持，优先取它的 stack
  window.onerror = function(msg, src, line, col, err){
    post({
      type: 'plugin-error',
      kind: 'error',
      message: String(msg),
      src: src || '',
      line: line || 0,
      col: col || 0,
      stack: (err && err.stack) ? String(err.stack) : ''
    });
  };
  // unhandledrejection：拦截 Promise 未捕获 reject（如 async 函数内部抛错没 await catch）
  window.addEventListener('unhandledrejection', function(ev){
    var reason = ev.reason;
    var msg, stack = '';
    if (reason instanceof Error) { msg = reason.message; stack = reason.stack || ''; }
    else if (reason && typeof reason === 'object' && typeof reason.message === 'string') { msg = reason.message; stack = reason.stack || ''; }
    else { try { msg = JSON.stringify(reason); } catch(_) { msg = String(reason); } }
    post({
      type: 'plugin-error',
      kind: 'unhandledrejection',
      message: msg,
      src: '',
      line: 0,
      col: 0,
      stack: typeof stack === 'string' ? stack : ''
    });
  });

  // ---- 转发 console.* 到主程序插件日志面板 ----
  //   - 原样保留 console 对开发者工具可见（通过 apply 调用原方法）；
  //   - 同时把参数格式化（截断长度）后 post 给主程序，主程序 addLog 展示。
  (function hookConsole(){
    var orig = {};
    var levels = ['log', 'info', 'debug', 'warn', 'error'];
    function mapLevel(l){ return (l === 'warn') ? 'warn' : (l === 'error' ? 'error' : 'info'); }
    function fmtArg(a){
      if (a === void 0) return 'undefined';
      if (a === null) return 'null';
      if (typeof a === 'string') { return a.length > 2000 ? a.slice(0,2000) + '...(+len=' + (a.length-2000) + ')' : a; }
      if (typeof a === 'number' || typeof a === 'boolean') { return String(a); }
      try {
        var s = JSON.stringify(a);
        if (s.length > 2000) return s.slice(0,2000) + '...(+len=' + (s.length-2000) + ')';
        return s;
      } catch(_) { return String(a); }
    }
    for (var i = 0; i < levels.length; i++) {
      (function(l){
        var fn = (typeof console !== 'undefined' && console[l]) || function(){};
        orig[l] = fn;
        console[l] = function(){
          var args = Array.prototype.slice.call(arguments);
          try { orig[l].apply(console, args); } catch(_) {}
          var text;
          try { text = args.map(fmtArg).join(' '); } catch(_) { text = '[console format error]'; }
          post({
            type: 'plugin-console',
            level: mapLevel(l),
            rawLevel: l,
            message: text,
            ts: Date.now()
          });
        };
      })(levels[i]);
    }
  })();

  // ---- 转发 performance.mark / performance.measure 到主程序插件日志面板 ----
  //   - 使用 PerformanceObserver 异步观察，不会阻塞插件业务代码；
  //   - 只带元信息（name / entryType / startTime / duration），不带任何用户 payload。
  (function hookPerf(){
    try {
      if (typeof PerformanceObserver !== 'function') return;
      var obs = new PerformanceObserver(function(list){
        var entries = list.getEntries ? list.getEntries() : [];
        for (var i = 0; i < entries.length; i++) {
          var e = entries[i];
          post({
            type: 'plugin-performance',
            name: String(e.name || ''),
            entryType: String(e.entryType || ''),
            startTime: typeof e.startTime === 'number' ? Math.round(e.startTime) : 0,
            duration: typeof e.duration === 'number' ? Math.round(e.duration) : 0,
            ts: Date.now()
          });
        }
      });
      obs.observe({ entryTypes: ['mark', 'measure'] });
    } catch(_) {
      // 非关键路径：失败静默即可（老 webview 不支持 PerformanceObserver）
    }
  })();

  // 把函数替换为 {__rd_cb: id} 占位，注册到本地 callbacks
  function pack(v){
    if (typeof v === 'function') {
      var id = 'cb' + (++cbSeq);
      callbacks[id] = v;
      return { __rd_cb: id };
    }
    if (Array.isArray(v)) {
      var arr = [];
      for (var i = 0; i < v.length; i++) { try { arr.push(pack(v[i])); } catch(e){} }
      return arr;
    }
    if (v && typeof v === 'object') {
      var o = {};
      for (var k in v) { try { o[k] = pack(v[k]); } catch(e){} }
      return o;
    }
    return v;
  }
  // 把 { __rd_cb: id } 还原为函数：本地已知 -> 原函数；未知 -> 远程函数
  function unpack(v){
    if (v && typeof v === 'object' && typeof v.__rd_cb === 'string') {
      var id = v.__rd_cb;
      if (callbacks[id]) return callbacks[id];
      return makeRemoteFn(id);
    }
    if (Array.isArray(v)) {
      var arr = [];
      for (var i = 0; i < v.length; i++) { try { arr.push(unpack(v[i])); } catch(e){} }
      return arr;
    }
    if (v && typeof v === 'object') {
      var o = {};
      for (var k in v) { try { o[k] = unpack(v[k]); } catch(e){} }
      return o;
    }
    return v;
  }
  // 远程函数：调用主程序侧注册的回调
  function makeRemoteFn(cbId){
    return function(){
      var args = Array.prototype.slice.call(arguments);
      var cid = 'rc' + (++seq);
      return new Promise(function(res, rej){
        cbPending[cid] = { res: res, rej: rej };
        post({ type: 'sdk-callback', cbId: cbId, callId: cid, args: args.map(pack) });
      });
    };
  }
  function makeProxy(path){
    function fn(){}
    return new Proxy(fn, {
      get: function(_, prop){ return makeProxy(path.concat([String(prop)])); },
      apply: function(_, _this, args){ return call(path, args); },
      set: function(){ return false; },
      construct: function(){ throw new Error('SDK: 不可构造'); }
    });
  }
  function call(path, args){
    return new Promise(function(res, rej){
      var id = 'c' + (++seq);
      pending[id] = {res: res, rej: rej};
      post({type: 'sdk-invoke', callId: id, path: path, args: (args || []).map(pack)});
    });
  }
  var lifecycleHandlers = {}, busEntries = {}, pendingLifecycle = [];
  function runLifecycle(d, port){
    var h = lifecycleHandlers[d.name];
    var finish = function(ok, err){ try { port.postMessage({ok: ok, error: err}); } catch(e){} };
    if (typeof h === 'function') {
      try {
        var r = h(d.ctx);
        if (r && typeof r.then === 'function') r.then(function(){ finish(true); }, function(e){ finish(false, String(e)); });
        else finish(true);
      } catch(e){ finish(false, String(e)); }
    } else { finish(true); }
  }
  window.addEventListener('message', function(ev){
    var d = ev.data;
    if (!d || !d.__rd_plugin) return;
    if (d.type === 'sdk-result') {
      var p = pending[d.callId];
      if (p) { delete pending[d.callId]; if (d.ok) p.res(unpack(d.value)); else p.rej(new Error(d.error || 'SDK_CALL_FAILED')); }
      return;
    }
    if (d.type === 'sdk-callback') {
      var f = callbacks[d.cbId];
      var finish = function(ok, value, error){
        try { post({ type: 'callback-result', callId: d.callId, ok: ok, value: pack(value), error: error }); } catch(e){}
      };
      if (typeof f !== 'function') { finish(false, undefined, 'CALLBACK_NOT_FOUND'); return; }
      var args;
      try { args = (d.args || []).map(unpack); } catch(e){ finish(false, undefined, String(e)); return; }
      try {
        var r = f.apply(null, args);
        if (r && typeof r.then === 'function') {
          r.then(function(v){ finish(true, v); }, function(e){ finish(false, undefined, (e && e.message) || String(e)); });
        } else { finish(true, r); }
      } catch(e){ finish(false, undefined, String(e)); }
      return;
    }
    if (d.type === 'callback-result') {
      var q = cbPending[d.callId];
      if (q) { delete cbPending[d.callId]; if (d.ok) q.res(unpack(d.value)); else q.rej(new Error(d.error || 'CALLBACK_FAILED')); }
      return;
    }
    if (d.type === 'theme-sync') {
      if (d.palette && typeof d.palette === 'object') { for (var k in d.palette) document.documentElement.style.setProperty(k, String(d.palette[k])); }
      if (d.themeId) document.documentElement.setAttribute('data-theme', String(d.themeId));
      if (d.themeType) document.documentElement.setAttribute('data-theme-type', String(d.themeType));
      return;
    }
    if (d.type === 'watchdog-ping') { post({type: 'watchdog-pong', ts: d.ts}); return; }
    if (d.type === 'ready-check') {
      // 主程序轮询确认桥已就绪：即使初始 __rd_plugin_ready 消息因监听器未挂载而丢失，
      // 也能通过本握手补回，避免插件初始化等待 10s 超时。
      post({__rd_plugin_ready: true, id: __RD_PLUGIN_ID__});
      return;
    }
    if (d.type === 'lifecycle') {
      var port = ev.ports && ev.ports[0];
      if (port) {
        // 处理器可能尚未注册（插件主脚本还在解析/执行）：缓冲到 R.on 注册后再补投，
        // 避免 init 早到被丢弃导致工具栏按钮永远不出现。
        if (typeof lifecycleHandlers[d.name] !== 'function') {
          pendingLifecycle.push({ d: d, port: port });
          return;
        }
        runLifecycle(d, port);
      }
      return;
    }
    if (d.type === 'bus-event') {
      var list = busEntries[d.event];
      if (list) { for (var i = 0; i < list.length; i++) { try { list[i].fn.apply(null, d.args); } catch(e){} } }
      return;
    }
  });
  window.__rdPlugin = {
    ctx: makeProxy([]),
    on: function(h){
      if (h && typeof h === 'object') {
        Object.assign(lifecycleHandlers, h);
        // 补投缓冲的 lifecycle 消息（按到达顺序执行）
        var pending = pendingLifecycle;
        pendingLifecycle = [];
        for (var i = 0; i < pending.length; i++) {
          var p = pending[i];
          runLifecycle(p.d, p.port);
        }
      }
    },
    onBus: function(event, fn){
      var id = 'b' + (++seq);
      (busEntries[event] = busEntries[event] || []).push({fn: fn, id: id});
      post({type: 'bus-on', event: event, listenerId: id});
      return function(){
        var arr = busEntries[event];
        if (arr) { for (var i = 0; i < arr.length; i++) { if (arr[i].id === id) { arr.splice(i, 1); break; } } }
        post({type: 'bus-off', event: event, listenerId: id});
      };
    },
    getPluginId: function(){ return __RD_PLUGIN_ID__; }
  };
  post({__rd_plugin_ready: true, id: __RD_PLUGIN_ID__});
})();`;

/**
 * 把 SDK 桥脚本注入到插件 index.html 中，并返回可用于 iframe src 的 data URL。
 * 为消除首帧闪屏，同时内联当前主题的 CSS 变量和 data-theme / data-theme-type 属性：
 *  - 在 <html> 上挂 data-theme / data-theme-type，使 :root[data-theme-type="light"]
 *    等 CSS 选择器在 HTML 解析到 body 前就生效；
 *  - 在 <head> 中注入 <style>:root{ --bg-content:xxx; ... }</style>，body 第一次
 *    绘制时就用当前主题色，而非 CSS fallback 硬编码色（之前用户看到的"过一会变蓝"
 *    就是因为 CSS var() 未定义时 fallback 为 accent #3b82f6 蓝色）。
 *
 * @param html 插件 index.html 原始内容（来自 Rust plugin_resolve_src）
 * @param pluginId 插件 id（注入到桥脚本，用于 ready 通知）
 */
export function buildPluginIframeSrc(html: string, pluginId: string): string {
  // ⚠️ 必须全局替换：桥脚本中 __RD_PLUGIN_ID__ 出现 3 处（ready-check 响应、
  // getPluginId、桥尾 ready 通知）。若只替换第一处，getPluginId 会引用未定义的
  // 变量抛 ReferenceError，导致插件主脚本崩溃、R.on 永不注册（生命周期消息被
  // 缓冲后永不补投，插件界面永远停留在"正在加载…"）。
  const bridge = PLUGIN_BRIDGE_SCRIPT.replace(
    /__RD_PLUGIN_ID__/g,
    JSON.stringify(pluginId),
  );

  // ---- 1. 构造初始主题样式 + 属性（消除首帧闪屏） ----
  const themeInfo =
    typeof window !== 'undefined'
      ? getCurrentThemeInfo()
      : null; // SSR / 测试环境降级为空（此时 iframe 也不会被展示）
  const themeAttrs: string[] = [];
  if (themeInfo) {
    themeAttrs.push(`data-theme="${escapeAttr(themeInfo.id)}"`);
    themeAttrs.push(`data-theme-type="${escapeAttr(themeInfo.type)}"`);
  }
  let paletteStyle = '';
  if (themeInfo && themeInfo.palette && typeof themeInfo.palette === 'object') {
    const vars: string[] = [];
    for (const [k, v] of Object.entries(themeInfo.palette)) {
      const key = String(k);
      // 仅注入合法的 CSS 变量名（以 -- 开头），避免把 palette 里混入的
      // 非 var 字段（如 id 字符串）写进样式导致 CSS 解析异常。
      if (!key.startsWith('--')) continue;
      vars.push(`${key}:${escapeCssValue(String(v))};`);
    }
    if (vars.length) {
      paletteStyle = `<style>:root{${vars.join('')}}<\/style>`;
    }
  }

  // ---- 2. 拼注入内容（顺序：<style> 先，<script> 桥后，都放 </head> 前）----
  // paletteStyle：当前主题的 CSS 变量，保证首帧颜色不闪
  // commonStyle：PLUGIN_COMMON_CSS 公共样式库（按钮/表单/switch/表格等），
  //   给所有插件一套和主程序视觉一致的 base class（含 .rd-* 前缀 + 旧别名）
  // <script> 桥：SDK 调用代理 + 异常/console 转发
  // 执行顺序保证：CSS 变量 → 公共样式 → 桥脚本 → 插件自己的 <style>/<script>
  const commonStyle = `<style>${PLUGIN_COMMON_CSS}<\/style>`;
  const tag = `${paletteStyle}${commonStyle}<script>${bridge}<\/script>`;

  // ---- 3. 给 <html> 根标签补 data-theme / data-theme-type 属性 ----
  // 匹配 <html（可能已有属性，如 <html lang="zh">），在末尾注入两个 data- 属性。
  let injected = html;
  if (themeAttrs.length) {
    const htmlTagRegex = /<html(\s[^>]*)?>/i;
    const htmlMatch = injected.match(htmlTagRegex);
    if (htmlMatch) {
      const existingAttrs = htmlMatch[1] ?? '';
      // 避免重复注入（如果插件本身已经写了 data-theme）——用我们的值覆盖，确保同步
      const cleaned = existingAttrs
        .replace(/\sdata-theme\s*=\s*"[^"]*"/gi, '')
        .replace(/\sdata-theme\s*=\s*'[^']*'/gi, '')
        .replace(/\sdata-theme-type\s*=\s*"[^"]*"/gi, '')
        .replace(/\sdata-theme-type\s*=\s*'[^']*'/gi, '');
      const replacement = `<html${cleaned} ${themeAttrs.join(' ')}>`;
      injected = injected.replace(htmlTagRegex, replacement);
    } else {
      // 插件没有 <html> 标签（极简 HTML）：在最前面包一层
      injected = `<html ${themeAttrs.join(' ')}>${injected}</html>`;
    }
  }

  injected = injected.includes('</head>')
    ? injected.replace('</head>', `${tag}</head>`)
    : `${tag}${injected}`;

  return 'data:text/html;charset=utf-8,' + encodeURIComponent(injected);
}
