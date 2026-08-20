/**
 * 取消错误判定测试（纯 TS，npx tsx 运行）
 * 验证 isCancelError 能正确区分"用户取消"和"真实错误"
 */
import { isCancelError } from '../cancel';

function testIsCancelError(): boolean {
  const cases: { input: unknown; expected: boolean; label: string }[] = [
    // 后端返回的取消错误
    { input: 'canceled', expected: true, label: 'backend_cancel' },
    // 前端取消流程 throw 的错误
    { input: '__canceled__', expected: true, label: 'frontend_cancel' },
    // 带后缀
    { input: 'canceled by user', expected: true, label: 'with_suffix' },
    // Error 对象
    { input: new Error('canceled'), expected: true, label: 'error_object' },
    { input: new Error('__canceled__'), expected: true, label: 'error_object_double' },
    // 真实错误 — 不应匹配
    { input: 'network error', expected: false, label: 'network_error' },
    { input: 'timeout', expected: false, label: 'timeout' },
    { input: 'permission denied', expected: false, label: 'permission_denied' },
    { input: 'size mismatch: expected 100 got 99', expected: false, label: 'size_mismatch' },
    { input: 'connection refused', expected: false, label: 'connection_refused' },
    // 边界
    { input: '', expected: false, label: 'empty_string' },
    { input: undefined, expected: false, label: 'undefined' },
    { input: null, expected: false, label: 'null' },
  ];

  let ok = true;
  for (const { input, expected, label } of cases) {
    const actual = isCancelError(input);
    if (actual !== expected) {
      console.error(`FAIL [${label}]: isCancelError(${JSON.stringify(input)}) = ${actual}, expected ${expected}`);
      ok = false;
    }
  }
  const passed = cases.filter(({ input, expected }) => isCancelError(input) === expected).length;
  console.log(`IsCancelError Tests: ${passed}/${cases.length} passed`);
  return ok;
}

const results = [testIsCancelError()];
const allPass = results.every((r) => r);
console.log(`\nCancel Tests: ${results.filter((r) => r).length}/${results.length} passed`);
if (!allPass) {
  throw new Error('Cancel tests failed');
}
