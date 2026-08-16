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

/** 注入版 SDK 桥脚本（会被插到插件 index.html 的 </head> 前）。 */
export const PLUGIN_BRIDGE_SCRIPT = `(function(){
  var pending = {}, seq = 0;              // sdk-invoke 调用（callId -> {res,rej}）
  var cbPending = {};                     // 远程回调调用（callId -> {res,rej}）
  var callbacks = {}, cbSeq = 0;          // 本地回调（cbId -> fn）
  function post(msg){ window.parent.postMessage(Object.assign({__rd_plugin:true}, msg), '*'); }

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
  // 这样 CSS 变量先于 body 解析就位；桥脚本先于插件自己的 <script> 执行，
  // 确保 window.__rdPlugin 在插件代码读取前已存在。
  const tag = `${paletteStyle}<script>${bridge}<\/script>`;

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

/** HTML 属性值转义（双引号内容），仅处理最低必要字符避免 XSS / 解析断裂 */
function escapeAttr(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * CSS 属性值转义：在 `:root{--x:<value>}` 中注入时，防止
 *   - `;}` 闭合注入
 *   - 换行/回车导致 CSS 解析断开
 *   - 反斜杠破坏后续声明
 * 合法值本身（#rrggbb、rgba(...)、url("...") 等）经过此函数后保持语义不变，
 * 因为只对真正的 CSS 控制字符做转义。
 */
function escapeCssValue(s: string): string {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\A ')
    .replace(/\r/g, '\\D ')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/;/g, '\\;')
    .replace(/}/g, '\\}');
}
