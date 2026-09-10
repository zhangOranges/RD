import { describe, test, expect } from 'vitest';
import { formatFileSize } from '../format';

describe('formatFileSize', () => {
  const cases: { input: number; expected: string; label: string }[] = [
    { input: 0, expected: '0 B', label: 'zero' },
    { input: 512, expected: '512 B', label: 'less_than_1kb' },
    { input: 1023, expected: '1023 B', label: 'just_under_1kb' },
    { input: 1024, expected: '1.0 KB', label: 'exactly_1kb' },
    { input: 16560, expected: '16.2 KB', label: 'typical_kb' },
    { input: 10240, expected: '10.0 KB', label: 'exactly_10kb' },
    { input: 102400, expected: '100.0 KB', label: 'three_digit_kb' },
    { input: 1048576, expected: '1.0 MB', label: 'exactly_1mb' },
    { input: 5242880, expected: '5.0 MB', label: '5mb' },
    { input: 10485760, expected: '10.0 MB', label: '10mb' },
    { input: 1073741824, expected: '1.00 GB', label: 'exactly_1gb' },
    { input: 2147483648, expected: '2.00 GB', label: '2gb' },
    { input: 1099511627776, expected: '1.00 TB', label: 'exactly_1tb' },
    { input: -1, expected: '0 B', label: 'negative' },
    { input: NaN, expected: '0 B', label: 'nan' },
    { input: Infinity, expected: '0 B', label: 'infinity' },
  ];

  for (const { input, expected, label } of cases) {
    test(label, () => {
      expect(formatFileSize(input)).toBe(expected);
    });
  }
});
