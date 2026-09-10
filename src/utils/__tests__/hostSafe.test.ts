import { describe, test, expect } from 'vitest';
import { sanitizeHostConfig, sanitizeHostConfigs } from '../hostSafe';
import type { HostConfig } from '../../types';

describe('sanitizeHostConfig', () => {
  // TR-3.3.1: 密码不出现在 JSON 中
  test('密码不出现在 JSON 中', () => {
    const raw: HostConfig & { password?: string; private_key?: string } = {
      id: 'h1', name: 'n1', host: '1.1.1.1', port: 22, username: 'u',
      auth_type: 'password', remember_dir: false, remark: '', category_id: '',
      password: 'SUPER_SECRET_12345',
    };
    const safe = sanitizeHostConfig(raw);
    const json = JSON.stringify(safe);
    expect(json).not.toContain('SUPER_SECRET_12345');
    expect(json).not.toContain('"password":');
    expect(json).not.toContain('"private_key":');
    expect(safe.has_password).toBe(true);
    expect(safe.has_private_key).toBe(false);
  });

  // TR-3.3.2: 反射安全
  test('反射安全 — 无 password/private_key 属性', () => {
    const raw: HostConfig & { password?: string } = {
      id: 'h2', name: 'n2', host: '2.2.2.2', port: 22, username: 'u',
      auth_type: 'password', remember_dir: false, remark: '', category_id: '',
      password: 'LEAKED',
    };
    const safe = sanitizeHostConfig(raw) as unknown as Record<string, unknown>;
    const keys = Object.getOwnPropertyNames(safe);
    expect(keys).not.toContain('password');
    expect(keys).not.toContain('private_key');
    expect(Reflect.has(safe, 'password')).toBe(false);
    expect(Reflect.has(safe, 'private_key')).toBe(false);
    const cloned = JSON.parse(JSON.stringify(safe));
    expect('password' in cloned).toBe(false);
    expect('private_key' in cloned).toBe(false);
  });

  // TR-3.3.3: 未来敏感字段不泄漏
  test('未来敏感字段（passphrase/token 等）不泄漏', () => {
    const raw = {
      id: 'h3', name: '跳板机', host: '3.3.3.3', port: 22, username: 'ops',
      auth_type: 'key' as const, remember_dir: true, remark: 'prod', category_id: 'c1',
      path_cache_id: 'p1',
      passphrase: 'MY_PRIVATE_KEY_PASSPHRASE_998877',
      key_passphrase: 'AGAIN_998877',
      proxy_password: 'JUMP_PASS_123',
      proxy_private_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nJUMP_PRIVATE_KEY_BODY',
      proxy_passphrase: 'JUMP_PASSPHRASE_X',
      credential: { type: 'password', value: 'ANOTHER_CRED_XYZ' },
      credential_value: 'YET_ANOTHER_CRED',
      token: 'eyJhbGciOiJIUzI1NiIs...LEAKED_TOKEN',
      access_token: 'ACCESS_TOKEN_X',
      refresh_token: 'REFRESH_TOKEN_X',
      bearer_token: 'BEARER_TOKEN_X',
      db_password: 'DATABASE_PASS_XYZ',
    } satisfies HostConfig & Record<string, unknown>;

    const safe = sanitizeHostConfig(raw);
    const json = JSON.stringify(safe);
    expect(json).not.toContain('PASSPHRASE_998877');
    expect(json).not.toContain('JUMP_PASS_123');
    expect(json).not.toContain('ANOTHER_CRED_XYZ');
    expect(json).not.toContain('LEAKED_TOKEN');
    expect(json).not.toContain('DATABASE_PASS_XYZ');
    expect(json).not.toContain('JUMP_PRIVATE_KEY_BODY');
    expect(json).not.toContain('"passphrase"');
    expect(json).not.toContain('"proxy_password"');
    expect(json).not.toContain('"credential"');
    expect(json).not.toContain('"token"');
    // 白名单属性保留
    expect(safe.id).toBe('h3');
    expect(safe.has_private_key).toBe(true);
    expect(safe.has_password).toBe(false);
  });

  // TR-3.3.5: auth_type=key 时 has_private_key=true
  test('auth_type=key 时 has_private_key=true 且私钥不泄漏', () => {
    const raw: HostConfig & { private_key?: string } = {
      id: 'h5', name: 'key-auth-host', host: '5.5.5.5', port: 22, username: 'ops',
      auth_type: 'key', remember_dir: true, remark: 'with path cache', category_id: 'infra',
      path_cache_id: 'cache-001',
      private_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nPRIVATE_CONTENT\n-----END',
    };
    const safe = sanitizeHostConfig(raw);
    expect(JSON.stringify(safe)).not.toContain('PRIVATE_CONTENT');
    expect('private_key' in safe).toBe(false);
    expect(safe.has_private_key).toBe(true);
    expect(safe.has_password).toBe(false);
    expect(safe.path_cache_id).toBe('cache-001');
  });

  // TR-3.3.6: 返回对象恰好等于白名单字段集合
  test('返回对象字段数与白名单一致（12 个）', () => {
    const raw: HostConfig = {
      id: 'h6', name: 'minimal', host: '6.6.6.6', port: 22, username: 'u',
      auth_type: 'password', remember_dir: false, remark: '', category_id: '',
    };
    const safe = sanitizeHostConfig(raw) as unknown as Record<string, unknown>;
    const keys = Object.keys(safe).sort();
    const expected = [
      'auth_type', 'category_id', 'has_password', 'has_private_key', 'host', 'id',
      'name', 'path_cache_id', 'port', 'remember_dir', 'remark', 'username',
    ].sort();
    expect(keys).toEqual(expected);
  });

  // TR-3.3.8: 原型链注入黑名单字段必须被拦截
  test('原型链注入 password 时 sanitize 抛错', () => {
    const minimal: HostConfig = {
      id: 'p1', name: 'proto-test', host: '1.2.3.4', port: 22, username: 'u',
      auth_type: 'password', remember_dir: false, remark: '', category_id: '',
    };
    const proto = Object.prototype as unknown as Record<string, unknown>;
    const hadOwn = Object.prototype.hasOwnProperty.call(proto, 'password');
    const saved = (proto as { password?: unknown }).password;
    (proto as { password?: unknown }).password = 'POLLUTED_VIA_PROTOTYPE';
    try {
      expect(() => sanitizeHostConfig(minimal)).toThrow();
    } finally {
      if (hadOwn) {
        (proto as { password?: unknown }).password = saved;
      } else {
        delete (proto as { password?: unknown }).password;
      }
    }
  });
});

describe('sanitizeHostConfigs', () => {
  // TR-3.3.7: 批量脱敏
  test('批量脱敏结果数量正确且每项安全', () => {
    const list: HostConfig[] = [
      { id: 'b1', name: 'host1', host: '1.1.1.1', port: 22, username: 'u1',
        auth_type: 'password', remember_dir: false, remark: '', category_id: '' },
      { id: 'b2', name: 'host2', host: '2.2.2.2', port: 2222, username: 'u2',
        auth_type: 'key', remember_dir: true, remark: 'prod', category_id: 'infra',
        path_cache_id: 'pc-1' },
    ];
    const safeList = sanitizeHostConfigs(list);
    expect(safeList.length).toBe(2);
    expect(safeList[1].has_private_key).toBe(true);
    expect(safeList[1].path_cache_id).toBe('pc-1');
    const json = JSON.stringify(safeList);
    expect(json).not.toContain('"password":');
    expect(json).not.toContain('"private_key":');
  });
});
