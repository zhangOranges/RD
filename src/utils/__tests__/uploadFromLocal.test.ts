import { describe, test, expect } from 'vitest';
import { joinRemotePath } from '../path';

describe('joinRemotePath', () => {
  const cases: { base: string; rel: string; expected: string; label: string }[] = [
    { base: '', rel: 'foo', expected: '/foo', label: 'empty_base_simple' },
    { base: '', rel: '/foo', expected: '/foo', label: 'empty_base_rel_leading_slash' },
    { base: '', rel: '', expected: '/', label: 'empty_base_empty_rel' },
    { base: '/home/user', rel: 'file.txt', expected: '/home/user/file.txt', label: 'base_no_slash' },
    { base: '/home/user/', rel: 'file.txt', expected: '/home/user/file.txt', label: 'base_with_slash' },
    { base: '/home/user', rel: '/file.txt', expected: '/home/user/file.txt', label: 'rel_leading_slash_stripped' },
    { base: '/home/user/', rel: '/file.txt', expected: '/home/user/file.txt', label: 'both_slash_stripped' },
    { base: '/root', rel: 'a/b/c', expected: '/root/a/b/c', label: 'nested_rel' },
    { base: '/root/', rel: '/a/b/c', expected: '/root/a/b/c', label: 'nested_rel_leading_slash' },
    { base: '/', rel: 'x', expected: '/x', label: 'root_base_single_char' },
    { base: '/a', rel: 'b', expected: '/a/b', label: 'short_paths' },
  ];

  for (const { base, rel, expected, label } of cases) {
    test(label, () => {
      expect(joinRemotePath(base, rel)).toBe(expected);
    });
  }
});
