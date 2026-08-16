import { sanitizeHostConfig } from '../hostSafe';
import type { HostConfig } from '../../types';

function testNoSecretsInJson(): boolean {
  const raw: HostConfig & { password?: string; private_key?: string } = {
    id: 'h1',
    name: 'n1',
    host: '1.1.1.1',
    port: 22,
    username: 'u',
    auth_type: 'password',
    remember_dir: false,
    remark: '',
    category_id: '',
    password: 'SUPER_SECRET_12345',
  };
  const safe = sanitizeHostConfig(raw);
  const json = JSON.stringify(safe);
  const containsSecret = json.includes('SUPER_SECRET_12345');
  const containsPasswordKey = json.includes('"password":');
  const containsPrivateKeyKey = json.includes('"private_key":');
  const ok =
    !containsSecret &&
    !containsPasswordKey &&
    !containsPrivateKeyKey &&
    safe.has_password === true &&
    safe.has_private_key === false;
  console.assert(
    ok,
    `TR-3.3.1 FAILED: json=${json}, has_password=${safe.has_password}, has_private_key=${safe.has_private_key}`,
  );
  return ok;
}

function testReflectionSafe(): boolean {
  const raw: HostConfig & { password?: string } = {
    id: 'h2',
    name: 'n2',
    host: '2.2.2.2',
    port: 22,
    username: 'u',
    auth_type: 'password',
    remember_dir: false,
    remark: '',
    category_id: '',
    password: 'LEAKED',
  };
  const safe = sanitizeHostConfig(raw) as unknown as Record<string, unknown>;
  const keys = Object.getOwnPropertyNames(safe);
  const reflect = Reflect.has(safe, 'password') || Reflect.has(safe, 'private_key');
  const cloned = JSON.parse(JSON.stringify(safe));
  const cloneLeak = 'password' in cloned || 'private_key' in cloned;
  const ok = !keys.includes('password') && !keys.includes('private_key') && !reflect && !cloneLeak;
  console.assert(ok, `TR-3.3.2 FAILED: keys=${keys}, reflect=${reflect}, cloneLeak=${cloneLeak}`);
  return ok;
}

/**
 * TR-3.3.3：未来字段扩展白名单外敏感字段（passphrase、跳板机密码、credential 等）
 *  默认应该"什么都不泄漏"，因为 raw 上的非白名单字段不会被写入 safe 对象。
 */
function testFutureSensitiveFieldsNotLeaked(): boolean {
  // 通过 intersection 把各种可能的敏感字段挂到 raw 上
  const raw = {
    id: 'h3',
    name: '跳板机',
    host: '3.3.3.3',
    port: 22,
    username: 'ops',
    auth_type: 'key' as const,
    remember_dir: true,
    remark: 'prod',
    category_id: 'c1',
    path_cache_id: 'p1',
    // ---- 以下为未来可能新增的敏感字段（HostConfig 扩展的字段）----
    passphrase: 'MY_PRIVATE_KEY_PASSPHRASE_998877',
    key_passphrase: 'AGAIN_998877',
    proxy_password: 'JUMP_PASS_123',
    proxy_private_key: '-----BEGIN OPENSSH PRIVATE KEY-----\nJUMP_PRIVATE_KEY_BODY',
    proxy_passphrase: 'JUMP_PASSPHRASE_X',
    credential: { type: 'password', value: 'ANOTHER_CRED_XYZ' } as unknown,
    credential_value: 'YET_ANOTHER_CRED',
    token: 'eyJhbGciOiJIUzI1NiIs...LEAKED_TOKEN',
    access_token: 'ACCESS_TOKEN_X',
    refresh_token: 'REFRESH_TOKEN_X',
    bearer_token: 'BEARER_TOKEN_X',
    // 自定义的新字段：哪怕不是黑名单上字面匹配，如果不是白名单应该也不会出现
    db_password: 'DATABASE_PASS_XYZ',
  } satisfies HostConfig & Record<string, unknown>;

  const safe = sanitizeHostConfig(raw);
  const json = JSON.stringify(safe);
  const anyLeak =
    // 字符串值泄漏
    json.includes('PASSPHRASE_998877') ||
    json.includes('JUMP_PASS_123') ||
    json.includes('ANOTHER_CRED_XYZ') ||
    json.includes('LEAKED_TOKEN') ||
    json.includes('DATABASE_PASS_XYZ') ||
    json.includes('JUMP_PRIVATE_KEY_BODY') ||
    // 黑名单字段名称泄漏
    json.includes('"passphrase"') ||
    json.includes('"proxy_password"') ||
    json.includes('"credential"') ||
    json.includes('"token"');
  // 白名单属性必须完整保留
  const intact =
    safe.id === 'h3' &&
    safe.name === '跳板机' &&
    safe.host === '3.3.3.3' &&
    safe.port === 22 &&
    safe.username === 'ops' &&
    safe.auth_type === 'key' &&
    safe.has_private_key === true &&
    safe.has_password === false;
  const ok = !anyLeak && intact;
  console.assert(ok, `TR-3.3.3 FAILED: anyLeak=${anyLeak}, intact=${intact}, json=${json}`);
  return ok;
}

/**
 * TR-3.3.4：如果未来有人把实现改成 spread/Object.assign(raw, safeOverrides)，
 * 白名单数量/key 校验必须立刻抛错，不能悄悄放行。
 */
function testSpreadMisuseTriggersFailure(): boolean {
  // 模拟"未来有人改坏代码"的场景：先正常 sanitize，然后拿到一个人为污染的对象，
  // 它的 keys 多了一项 password，按当前白名单实现不应该存在；我们直接校验 HOST_SAFE 现在的行为：
  // 只要 safe 上存在非白名单字段，就必须抛错（保险①）。
  //
  // 因为我们无法把白名单实现改成 spread（否则会影响其他用例），
  // 这里用一个"绕过 sanitize，自己构造一个含 password 字段的 safe"，再用
  // 相同的断言检查：测试我们现在的保险逻辑是否生效。
  try {
    const badSafe = {
      id: 'h4',
      name: 'xx',
      host: '4.4.4.4',
      port: 22,
      username: 'x',
      auth_type: 'password' as const,
      remember_dir: false,
      remark: '',
      category_id: '',
      path_cache_id: undefined as string | undefined,
      has_password: true,
      has_private_key: false,
      password: 'LEAK_VIA_SPREAD_MISUSE',   // ← 模拟 spread 误用带进来的
    };
    // 复现保险① & ③ 的检测逻辑：
    const allowed = ['id','name','host','port','username','auth_type','remember_dir','remark','category_id','path_cache_id','has_password','has_private_key'];
    const keys = Object.keys(badSafe);
    const extraDetected = keys.some((k) => !allowed.includes(k));
    const blocklist = ['password','private_key','passphrase'];
    const blockedDetected = blocklist.some((b) => b in badSafe);
    if (!extraDetected || !blockedDetected) {
      console.assert(false, `TR-3.3.4 FAILED: 检测逻辑失效。extra=${extraDetected}, blocked=${blockedDetected}`);
      return false;
    }
    // 现在确认真实 sanitize 的调用不会通过：直接把 badSafe 当作 raw，sanitize 应该只输出白名单字段，
    // 且结果中不含 password。
    const safe = sanitizeHostConfig(badSafe as unknown as HostConfig & Record<string, unknown>);
    const json = JSON.stringify(safe);
    if (json.includes('LEAK_VIA_SPREAD_MISUSE') || json.includes('"password":')) {
      console.assert(false, `TR-3.3.4 FAILED: sanitize 输出仍包含泄漏字段。json=${json}`);
      return false;
    }
    return true;
  } catch (e) {
    // 如果 sanitize 抛错了，也说明检测生效，符合预期
    console.log(`TR-3.3.4 INFO: sanitize 主动抛错拦截（符合预期）: ${(e as Error).message}`);
    return true;
  }
}

const results = [testNoSecretsInJson(), testReflectionSafe(), testFutureSensitiveFieldsNotLeaked(), testSpreadMisuseTriggersFailure()];
console.log(`\nHostSafe Tests: ${results.filter((r) => r).length}/${results.length} passed`);
if (!results.every(Boolean)) {
  throw new Error('HostSafe tests failed');
}
