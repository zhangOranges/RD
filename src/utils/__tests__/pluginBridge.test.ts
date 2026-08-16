/**
 * TR 系列：pluginBridge 关键纯函数单元测试
 * 运行方式：npx tsx src/utils/__tests__/pluginBridge.test.ts
 * 风格：与 hostSafe.test.ts 一致，console.assert 自执行。
 */
import { escapeAttr, escapeCssValue } from '../escape';

// =========================================================================
// TR-B1: escapeAttr —— 注入 HTML 属性时防断裂 / 防 XSS
// =========================================================================

function testEscapeAttrSafeValues(): boolean {
  // ① 安全值原样输出
  const cases = [
    ['', ''],
    ['hello RD', 'hello RD'],
    ['#1a1b1f', '#1a1b1f'],
    ['Dark mode is on.', 'Dark mode is on.'],
    // 已经转义过的实体：不会被双重 escape（escapeAttr 只看字面字符，智能判断不做）
    // → 这是预期的「纯字面量处理」，调用方只传原始字符串。
  ];
  for (const [inp, exp] of cases) {
    const got = escapeAttr(inp);
    if (got !== exp) {
      console.assert(false, `TR-B1.1 FAILED: inp=${JSON.stringify(inp)} exp=${JSON.stringify(exp)} got=${JSON.stringify(got)}`);
      return false;
    }
  }
  return true;
}

function testEscapeAttrEscapesMandatoryChars(): boolean {
  // ② 必须转义的 4 个字符：& " < >
  const cases: Array<[string, string]> = [
    // 单个
    ['&', '&amp;'],
    ['"', '&quot;'],
    ['<', '&lt;'],
    ['>', '&gt;'],
    // 组合：典型 XSS payload，放在属性双引号里必须被中性化
    ['"><script>alert(1)</script>', '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;'],
    // 与普通字符混合
    ['A & B < C > D "ok"', 'A &amp; B &lt; C &gt; D &quot;ok&quot;'],
    // 重复出现：全部替换
    ['<<<<', '&lt;&lt;&lt;&lt;'],
    ['&&""', '&amp;&amp;&quot;&quot;'],
  ];
  for (const [inp, exp] of cases) {
    const got = escapeAttr(inp);
    if (got !== exp) {
      console.assert(false, `TR-B1.2 FAILED: inp=${JSON.stringify(inp)} exp=${JSON.stringify(exp)} got=${JSON.stringify(got)}`);
      return false;
    }
  }
  return true;
}

function testEscapeAttrInputCoercion(): boolean {
  // ③ 非字符串输入（null / undefined / number）通过 String(s) 安全转换
  const cases: Array<[unknown, string]> = [
    [null, 'null'],
    [undefined, 'undefined'],
    [0, '0'],
    [1234, '1234'],
    [true, 'true'],
  ];
  for (const [inp, exp] of cases) {
    // @ts-expect-error — 故意传入非 string 验证 coercion 路径
    const got = escapeAttr(inp);
    if (got !== exp) {
      console.assert(false, `TR-B1.3 FAILED: inp=${String(inp)} exp=${exp} got=${got}`);
      return false;
    }
  }
  return true;
}

function testEscapeAttrOutputNeverContainsRawQuoteOrAngle(): boolean {
  // ④ 不变式：escapeAttr 输出中不应出现原始的 " < > （只有实体）
  const tricky = ['a"b<c>d&e', '"""<<<>>>(((', '&<">' + 'random stuff'];
  for (const s of tricky) {
    const out = escapeAttr(s);
    const bad = /["><]/.test(out.replace(/&quot;/g, '').replace(/&lt;/g, '').replace(/&gt;/g, ''));
    if (bad) {
      console.assert(false, `TR-B1.4 FAILED: 输出仍含未转义的危险字符 inp=${JSON.stringify(s)} out=${JSON.stringify(out)}`);
      return false;
    }
  }
  return true;
}

// =========================================================================
// TR-B2: escapeCssValue —— 注入 CSS 值时防止闭合注入 / 解析断裂
// =========================================================================

function testEscapeCssValueSafePaletteValuesUnchanged(): boolean {
  // ① 合法 palette（16 进制、RGB/A、数字、纯单词）经过 escape 应语义保持一致。
  //    （这些值不含转义目标字符，所以应 100% 字面相同。）
  const safe = [
    '#0b1020',
    '#3b82f6',
    'rgba(255,255,255,0.85)',
    '18px',
    '1.2s ease-in-out',
    'pointer',
    '',
  ];
  for (const s of safe) {
    const got = escapeCssValue(s);
    if (got !== s) {
      console.assert(false, `TR-B2.1 FAILED: 合法 palette 值不应被改变。inp=${JSON.stringify(s)} got=${JSON.stringify(got)}`);
      return false;
    }
  }
  return true;
}

function testEscapeCssValueBlocksCloseDeclaration(): boolean {
  // ② 核心注入拦截：恶意插件通过 theme 值中夹带 ;} 闭合 :root，追加任意后续 CSS。
  //    escapeCssValue 必须把 ; 和 } 转义成 CSS 字面实体（\; / \}）。
  const attack = '#000;} * { display: none !important; /*';
  const out = escapeCssValue(attack);
  // 断言：输出中不能有未转义的 ; 或 } ——即若出现，必须前面是 \
  // 简单验证：逐字符检查
  let prev = '';
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if ((ch === ';' || ch === '}') && prev !== '\\') {
      console.assert(false, `TR-B2.2 FAILED: 发现未转义的「${ch}」，可能被闭合注入。inp=${JSON.stringify(attack)} out=${JSON.stringify(out)}`);
      return false;
    }
    prev = ch;
  }
  // 显式存在 \; 和 \} 两个转义序列
  if (!out.includes('\\;') || !out.includes('\\}')) {
    console.assert(false, `TR-B2.2 FAILED: 缺少预期转义序列。out=${JSON.stringify(out)}`);
    return false;
  }
  return true;
}

function testEscapeCssValueNewlinesEscaped(): boolean {
  // ③ 换行/回车 → CSS 换行转义 \A / \D 后跟空格，保证不解析断行。
  const inp = 'first line\nsecond line\r\nfinal';
  const out = escapeCssValue(inp);
  const okLF = out.includes('\\A ') && !out.includes('\n');
  // CRLF 中的 CR 被转成 \D 
  const okCR = out.includes('\\D ') || !inp.includes('\r');
  if (!okLF || !okCR) {
    console.assert(false, `TR-B2.3 FAILED: 换行/回车未被正确转义。inp=${JSON.stringify(inp)} out=${JSON.stringify(out)}`);
    return false;
  }
  return true;
}

function testEscapeCssValueQuotesAndBackslash(): boolean {
  // ④ 反斜杠、单双引号必须转义（避免破坏 url("...")、破坏后续字符串等）
  //   a) 纯 `\` → 输出中应有 `\\` 序列
  const back = escapeCssValue('a\\b');
  if (!back.includes('\\\\')) {
    console.assert(false, `TR-B2.4a FAILED: 反斜杠未被转义。inp="a\\\\b" out=${JSON.stringify(back)}`);
    return false;
  }
  //   b) 双引号 `"` → `\"`
  const dq = escapeCssValue('"x"');
  if (!dq.includes('\\"')) {
    console.assert(false, `TR-B2.4b FAILED: 双引号未被转义。out=${JSON.stringify(dq)}`);
    return false;
  }
  //   c) 单引号 `'` → `\'`
  const sq = escapeCssValue("'x'");
  if (!sq.includes("\\'")) {
    console.assert(false, `TR-B2.4c FAILED: 单引号未被转义。out=${JSON.stringify(sq)}`);
    return false;
  }
  //   d) 组合：混合 \  "  ;  }  → 每一种都被转义
  const mix = 'both\\":;}';
  const mixOut = escapeCssValue(mix);
  const needs = ['\\\\', '\\"', '\\;', '\\}'];
  for (const seq of needs) {
    if (!mixOut.includes(seq)) {
      console.assert(false, `TR-B2.4d FAILED: 缺少转义序列 ${JSON.stringify(seq)}。inp=${JSON.stringify(mix)} out=${JSON.stringify(mixOut)}`);
      return false;
    }
  }
  return true;
}

function testEscapeCssValueCoercion(): boolean {
  // ⑤ 同 escapeAttr：非字符串安全通过 String() 转 string，不抛异常
  const cases: Array<[unknown, string]> = [
    [null, 'null'],
    [undefined, 'undefined'],
    [42, '42'],
  ];
  for (const [inp, exp] of cases) {
    // @ts-expect-error — 故意非 string
    const got = escapeCssValue(inp);
    if (got !== exp) {
      console.assert(false, `TR-B2.5 FAILED: coercion 路径失败。inp=${String(inp)} exp=${exp} got=${got}`);
      return false;
    }
  }
  return true;
}

// =========================================================================
// Runner
// =========================================================================
const tests: Array<[string, () => boolean]> = [
  ['TR-B1.1 escapeAttr 安全值不变', testEscapeAttrSafeValues],
  ['TR-B1.2 escapeAttr 强制字符转义', testEscapeAttrEscapesMandatoryChars],
  ['TR-B1.3 escapeAttr 输入类型 coercion', testEscapeAttrInputCoercion],
  ['TR-B1.4 escapeAttr 不变式: 无原始 "<>"', testEscapeAttrOutputNeverContainsRawQuoteOrAngle],
  ['TR-B2.1 escapeCssValue 合法 palette 不变', testEscapeCssValueSafePaletteValuesUnchanged],
  ['TR-B2.2 escapeCssValue 阻止 ;} 闭合注入', testEscapeCssValueBlocksCloseDeclaration],
  ['TR-B2.3 escapeCssValue 换行/回车转义', testEscapeCssValueNewlinesEscaped],
  ['TR-B2.4 escapeCssValue 反斜杠/引号转义', testEscapeCssValueQuotesAndBackslash],
  ['TR-B2.5 escapeCssValue 输入类型 coercion', testEscapeCssValueCoercion],
];

console.log('\n=== pluginBridge Unit Tests ===');
let passed = 0;
for (const [name, fn] of tests) {
  try {
    const ok = fn();
    if (ok) passed++;
    console.log(`  ${ok ? '✅' : '❌'} ${name}`);
  } catch (e) {
    console.log(`  ❌ ${name} —— thrown: ${(e as Error).message}`);
  }
}
console.log(`\nResult: ${passed}/${tests.length} passed`);
if (passed !== tests.length) {
  throw new Error('pluginBridge tests failed');
}
