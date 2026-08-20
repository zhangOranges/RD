/**
 * 判断传输错误是否为取消操作导致的。
 * 用于 catch 块中区分"用户主动取消"和"真实错误"。
 *
 * 后端返回 "canceled"，前端取消流程 throw Error('__canceled__')，
 * 两者都包含 "canceled" 子串。
 */
export function isCancelError(err: unknown): boolean {
  return String(err).includes('canceled');
}
