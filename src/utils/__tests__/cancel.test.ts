import { describe, test, expect } from 'vitest';
import { isCancelError } from '../cancel';

describe('isCancelError', () => {
  const cases: { input: unknown; expected: boolean; label: string }[] = [
    { input: 'canceled', expected: true, label: 'backend_cancel' },
    { input: '__canceled__', expected: true, label: 'frontend_cancel' },
    { input: 'canceled by user', expected: true, label: 'with_suffix' },
    { input: new Error('canceled'), expected: true, label: 'error_object' },
    { input: new Error('__canceled__'), expected: true, label: 'error_object_double' },
    { input: 'network error', expected: false, label: 'network_error' },
    { input: 'timeout', expected: false, label: 'timeout' },
    { input: 'permission denied', expected: false, label: 'permission_denied' },
    { input: 'size mismatch: expected 100 got 99', expected: false, label: 'size_mismatch' },
    { input: 'connection refused', expected: false, label: 'connection_refused' },
    { input: '', expected: false, label: 'empty_string' },
    { input: undefined, expected: false, label: 'undefined' },
    { input: null, expected: false, label: 'null' },
  ];

  for (const { input, expected, label } of cases) {
    test(label, () => {
      expect(isCancelError(input)).toBe(expected);
    });
  }
});
