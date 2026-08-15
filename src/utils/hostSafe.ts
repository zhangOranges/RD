import type { HostConfig } from '../types';
import type { HostConfigSafe } from '../types/plugin';

export function sanitizeHostConfig(
  raw: HostConfig & { password?: unknown; private_key?: unknown },
): HostConfigSafe {
  const safe: HostConfigSafe = {
    id: raw.id,
    name: raw.name,
    host: raw.host,
    port: raw.port,
    username: raw.username,
    auth_type: raw.auth_type,
    remember_dir: raw.remember_dir,
    remark: raw.remark,
    category_id: raw.category_id,
    path_cache_id: raw.path_cache_id,
    has_password: raw.auth_type === 'password',
    has_private_key: raw.auth_type === 'key',
  };
  const roundtrip = JSON.parse(JSON.stringify(safe)) as Record<string, unknown>;
  if ('password' in roundtrip || 'private_key' in roundtrip) {
    delete roundtrip.password;
    delete roundtrip.private_key;
    console.error('[sanitizeHostConfig] SECURITY ALERT: 凭据字段意外出现在序列化结果中，已强制删除');
  }
  return safe;
}

export function sanitizeHostConfigs(
  list: (HostConfig & { password?: unknown })[],
): HostConfigSafe[] {
  return list.map(sanitizeHostConfig);
}
