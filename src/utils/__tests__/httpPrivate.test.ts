import { describe, test, expect } from 'vitest';
import { isPrivateHost } from '../httpPrivate';

describe('isPrivateHost', () => {
  const cases: [string, boolean][] = [
    ['github.com', false],
    ['192.168.1.1', true],
    ['10.0.0.1', true],
    ['172.16.0.1', true],
    ['127.0.0.1', true],
    ['localhost', true],
    ['::1', true],
    ['8.8.8.8', false],
    ['169.254.169.254', false],
  ];

  for (const [host, expected] of cases) {
    test(`${host} → ${expected}`, () => {
      expect(isPrivateHost(host)).toBe(expected);
    });
  }
});
