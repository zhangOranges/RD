import { describe, test, expect } from 'vitest';
import { escapeAttr, escapeCssValue } from '../escape';

describe('escapeAttr', () => {
  // TR-B1.1: 安全值原样输出
  test('安全值不变', () => {
    const cases = [
      ['', ''],
      ['hello RD', 'hello RD'],
      ['#1a1b1f', '#1a1b1f'],
      ['Dark mode is on.', 'Dark mode is on.'],
    ];
    for (const [inp, exp] of cases) {
      expect(escapeAttr(inp)).toBe(exp);
    }
  });

  // TR-B1.2: 必须转义的字符 & " < >
  test('强制字符转义', () => {
    const cases: Array<[string, string]> = [
      ['&', '&amp;'],
      ['"', '&quot;'],
      ['<', '&lt;'],
      ['>', '&gt;'],
      ['"><script>alert(1)</script>', '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'],
      ['A & B < C > D "ok"', 'A &amp; B &lt; C &gt; D &quot;ok&quot;'],
      ['<<<<', '&lt;&lt;&lt;&lt;'],
      ['&&""', '&amp;&amp;&quot;&quot;'],
    ];
    for (const [inp, exp] of cases) {
      expect(escapeAttr(inp)).toBe(exp);
    }
  });

  // TR-B1.3: 非字符串输入安全转换
  test('输入类型 coercion', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'null'],
      [undefined, 'undefined'],
      [0, '0'],
      [1234, '1234'],
      [true, 'true'],
    ];
    for (const [inp, exp] of cases) {
      // @ts-expect-error 故意传入非 string
      expect(escapeAttr(inp)).toBe(exp);
    }
  });

  // TR-B1.4: 不变式 — 输出无原始 " < >
  test('不变式: 输出不含原始 "<>"', () => {
    const tricky = ['a"b<c>d&e', '"""<<<>>>(((', '&<">' + 'random stuff'];
    for (const s of tricky) {
      const out = escapeAttr(s);
      const cleaned = out.replace(/&quot;/g, '').replace(/&lt;/g, '').replace(/&gt;/g, '');
      expect(/["><]/.test(cleaned)).toBe(false);
    }
  });
});

describe('escapeCssValue', () => {
  // TR-B2.1: 合法 palette 值不变
  test('合法 palette 不变', () => {
    const safe = ['#0b1020', '#3b82f6', 'rgba(255,255,255,0.85)', '18px', '1.2s ease-in-out', 'pointer', ''];
    for (const s of safe) {
      expect(escapeCssValue(s)).toBe(s);
    }
  });

  // TR-B2.2: 阻止 ;} 闭合注入
  test('阻止 ;} 闭合注入', () => {
    const attack = '#000;} * { display: none !important; /*';
    const out = escapeCssValue(attack);
    let prev = '';
    for (let i = 0; i < out.length; i++) {
      const ch = out[i];
      if ((ch === ';' || ch === '}') && prev !== '\\') {
        throw new Error(`发现未转义的「${ch}」，可能被闭合注入。out=${JSON.stringify(out)}`);
      }
      prev = ch;
    }
    expect(out).toContain('\\;');
    expect(out).toContain('\\}');
  });

  // TR-B2.3: 换行/回车转义
  test('换行/回车转义', () => {
    const inp = 'first line\nsecond line\r\nfinal';
    const out = escapeCssValue(inp);
    expect(out).toContain('\\A ');
    expect(out).not.toContain('\n');
  });

  // TR-B2.4: 反斜杠/引号转义
  test('反斜杠/引号转义', () => {
    expect(escapeCssValue('a\\b')).toContain('\\\\');
    expect(escapeCssValue('"x"')).toContain('\\"');
    expect(escapeCssValue("'x'")).toContain("\\'");
    const mixOut = escapeCssValue('both\\":;}');
    expect(mixOut).toContain('\\\\');
    expect(mixOut).toContain('\\"');
    expect(mixOut).toContain('\\;');
    expect(mixOut).toContain('\\}');
  });

  // TR-B2.5: 非字符串输入安全转换
  test('输入类型 coercion', () => {
    const cases: Array<[unknown, string]> = [
      [null, 'null'],
      [undefined, 'undefined'],
      [42, '42'],
    ];
    for (const [inp, exp] of cases) {
      // @ts-expect-error 故意非 string
      expect(escapeCssValue(inp)).toBe(exp);
    }
  });
});
