/**
 * 纯字符串转义工具：零依赖（不引入 store / React / CSS），可被 Node + 浏览器双向使用。
 * 被 pluginBridge.ts 调用、也在 __tests__/pluginBridge.test.ts 单独测试。
 */

/** HTML 属性值转义（双引号内容），仅处理最低必要字符避免 XSS / 解析断裂 */
export function escapeAttr(s: string): string {
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
export function escapeCssValue(s: string): string {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\A ')
    .replace(/\r/g, '\\D ')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/;/g, '\\;')
    .replace(/}/g, '\\}');
}
