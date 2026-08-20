/**
 * 上传路径拼接函数测试（纯 TS，npx tsx 运行）
 * 验证 joinRemotePath 在各种边界条件下的正确性
 */
import { joinRemotePath } from '../path';

function testJoinRemotePath(): boolean {
  const cases: { base: string; rel: string; expected: string; label: string }[] = [
    // 空 base：结果必须以 / 开头
    { base: '', rel: 'foo', expected: '/foo', label: 'empty_base_simple' },
    { base: '', rel: '/foo', expected: '/foo', label: 'empty_base_rel_leading_slash' },
    { base: '', rel: '', expected: '/', label: 'empty_base_empty_rel' },

    // base 无尾斜杠：自动补 /
    { base: '/home/user', rel: 'file.txt', expected: '/home/user/file.txt', label: 'base_no_slash' },

    // base 有尾斜杠：不重复
    { base: '/home/user/', rel: 'file.txt', expected: '/home/user/file.txt', label: 'base_with_slash' },

    // rel 带前导斜杠：必须被去掉，不能出现 //
    { base: '/home/user', rel: '/file.txt', expected: '/home/user/file.txt', label: 'rel_leading_slash_stripped' },
    { base: '/home/user/', rel: '/file.txt', expected: '/home/user/file.txt', label: 'both_slash_stripped' },

    // 多层嵌套路径
    { base: '/root', rel: 'a/b/c', expected: '/root/a/b/c', label: 'nested_rel' },
    { base: '/root/', rel: '/a/b/c', expected: '/root/a/b/c', label: 'nested_rel_leading_slash' },

    // 单字符边界
    { base: '/', rel: 'x', expected: '/x', label: 'root_base_single_char' },
    { base: '/a', rel: 'b', expected: '/a/b', label: 'short_paths' },
  ];

  let ok = true;
  for (const { base, rel, expected, label } of cases) {
    const actual = joinRemotePath(base, rel);
    if (actual !== expected) {
      console.error(`FAIL [${label}]: joinRemotePath("${base}", "${rel}") = "${actual}", expected "${expected}"`);
      ok = false;
    }
  }
  const passed = cases.filter(({ base, rel, expected }) => joinRemotePath(base, rel) === expected).length;
  console.log(`JoinRemotePath Tests: ${passed}/${cases.length} passed`);
  return ok;
}

const results = [testJoinRemotePath()];
const allPass = results.every((r) => r);
console.log(`\nUploadFromLocal Tests: ${results.filter((r) => r).length}/${results.length} passed`);
if (!allPass) {
  throw new Error('UploadFromLocal tests failed');
}
