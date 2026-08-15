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

const results = [testNoSecretsInJson(), testReflectionSafe()];
console.log(`\nHostSafe Tests: ${results.filter((r) => r).length}/${results.length} passed`);
if (!results.every(Boolean)) {
  throw new Error('HostSafe tests failed');
}
