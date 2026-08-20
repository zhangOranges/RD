import { formatFileSize } from '../format';

function testFormatFileSize(): boolean {
  const cases: { input: number; expected: string; label: string }[] = [
    // 字节
    { input: 0, expected: '0 B', label: 'zero' },
    { input: 512, expected: '512 B', label: 'less_than_1kb' },
    { input: 1023, expected: '1023 B', label: 'just_under_1kb' },
    // KB — 1 位小数
    { input: 1024, expected: '1.0 KB', label: 'exactly_1kb' },
    { input: 16560, expected: '16.2 KB', label: 'typical_kb' },
    { input: 10240, expected: '10.0 KB', label: 'exactly_10kb' },
    { input: 102400, expected: '100.0 KB', label: 'three_digit_kb' },
    // MB — 1 位小数
    { input: 1048576, expected: '1.0 MB', label: 'exactly_1mb' },
    { input: 5242880, expected: '5.0 MB', label: '5mb' },
    { input: 10485760, expected: '10.0 MB', label: '10mb' },
    // GB — 2 位小数
    { input: 1073741824, expected: '1.00 GB', label: 'exactly_1gb' },
    { input: 2147483648, expected: '2.00 GB', label: '2gb' },
    // TB — 2 位小数
    { input: 1099511627776, expected: '1.00 TB', label: 'exactly_1tb' },
    // 边界
    { input: -1, expected: '0 B', label: 'negative' },
    { input: NaN, expected: '0 B', label: 'nan' },
    { input: Infinity, expected: '0 B', label: 'infinity' },
  ];

  let ok = true;
  for (const { input, expected, label } of cases) {
    const actual = formatFileSize(input);
    if (actual !== expected) {
      console.error(`FAIL [${label}]: formatFileSize(${input}) = "${actual}", expected "${expected}"`);
      ok = false;
    }
  }
  const passed = cases.filter(({ input, expected }) => formatFileSize(input) === expected).length;
  console.log(`FormatFileSize Tests: ${passed}/${cases.length} passed`);
  return ok;
}

const results = [testFormatFileSize()];
const allPass = results.every((r) => r);
console.log(`\nFormat Tests: ${results.filter((r) => r).length}/${results.length} passed`);
if (!allPass) {
  throw new Error('Format tests failed');
}
