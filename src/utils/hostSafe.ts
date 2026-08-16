import type { HostConfig } from '../types';
import type { HostConfigSafe } from '../types/plugin';

/** HostConfigSafe 中允许暴露给插件的字段白名单（显式枚举 = 最安全的策略）。
 *  未来新增字段到 HostConfigSafe 时必须在这里更新，否则 sanitize 的断言会失败，
 *  这能避免开发者"忘记把敏感字段白名单化"就顺手塞进返回对象造成泄漏。
 *  ⚠️ 任何新增字段加入白名单前请做 SECURITY REVIEW：
 *  - 是否能反推出用户密码/私钥/口令/跳板机密码？→ 不能加
 *  - 是否能用于枚举内网主机/用户名（即便如此也必须是插件 server.read 权限场景）
 */
const HOST_SAFE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  'id',
  'name',
  'host',
  'port',
  'username',
  'auth_type',
  'remember_dir',
  'remark',
  'category_id',
  'path_cache_id',
  'has_password',
  'has_private_key',
]);

/** 黑名单字段：即使有人误把 raw 通过 spread 拷进 safe，这些字段也必须被立刻探测并告警。
 *  包含当前已知的敏感字段 + 常见的未来扩展命名（passphrase、密钥口令、跳板机密码等），
 *  列表不全没关系，"白名单" 已经是主防线；黑名单只在有人误用 spread 语法作为白名单兜底。
 */
const HOST_SAFE_BLOCKLIST_KEYS: ReadonlySet<string> = new Set([
  'password',
  'private_key',
  'passphrase',          // 私钥口令
  'key_passphrase',
  'proxy_password',      // 跳板机密码
  'proxy_private_key',   // 跳板机私钥
  'secret',
  'secret_key',
  'credential',          // 通用凭据对象
  'credential_value',
  'token',
  'access_token',
  'refresh_token',
  'bearer_token',
]);

/**
 * 把主程序内部使用的 HostConfig（可能含真实密码/私钥/其他凭据）
 * 脱敏成可提供给插件读取的 HostConfigSafe 版本。
 *
 * 安全策略：白名单为主 + 黑名单双保险。
 *  - 主：显式逐个赋值 12 个安全字段，其他 raw 的任何字段（包括未来新增的敏感字段）
 *    都不会进入返回值 → 即使 HostConfig 扩展了 passphrase/proxy_password，
 *    只要没加到白名单就默认安全。
 *  - 保险：
 *      ① 对最终 safe 对象做 Object.keys 校验，key 不能超白名单；
 *      ② 对 safe 所有 values 做 JSON.stringify 扫描，不得出现黑名单 key 名
 *         （防嵌套对象包含凭据的未来扩展）；
 *      ③ 直接探测 safe 上是否存在黑名单字段（哪怕是 undefined 也要强制删）。
 *  - 任何安全校验触发都会抛错到上层，让调用方（server.listAll 等）直接 500
 *    给插件，不泄漏任何数据。这比"打日志但仍然 return 数据"安全得多。
 */
export function sanitizeHostConfig<T extends HostConfig>(raw: T): HostConfigSafe {
  // ---- 白名单显式构造 ----
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

  // ---- 保险①：keys 不能超白名单（防止有人误改成 { ...raw, ...safe } spread 模式）----
  const keys = Object.keys(safe);
  for (const k of keys) {
    if (!HOST_SAFE_ALLOWED_KEYS.has(k)) {
      throw new Error(
        `HOST_SAFE_ASSURANCE_FAILURE: 字段「${k}」不在白名单，已拦截。` +
          `请把该字段加入 HOST_SAFE_ALLOWED_KEYS 前先做安全审查。`,
      );
    }
  }
  if (keys.length !== HOST_SAFE_ALLOWED_KEYS.size) {
    throw new Error(
      `HOST_SAFE_ASSURANCE_FAILURE: 白名单字段数量不匹配(${keys.length} != ${HOST_SAFE_ALLOWED_KEYS.size})。` +
        `说明 sanitize 的赋值列表与 ALLOWED_KEYS 未同步，请检查。`,
    );
  }

  // ---- 保险②：递归扫描 JSON 序列化结果，黑名单 key 不能出现在任何嵌套位置 ----
  //    （现在的 safe 都是顶层 primitive，未来若加嵌套对象（如 jump_host_info），
  //     这里也能拦截嵌套凭据。）
  const serialized = JSON.stringify(safe);
  for (const blocked of HOST_SAFE_BLOCKLIST_KEYS) {
    // 匹配 JSON 中的键：`"blockedKey":`  或者 `"blockedKey" :`
    const m = new RegExp(`"${blocked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*:`);
    if (m.test(serialized)) {
      console.error(
        `[sanitizeHostConfig] SECURITY FAIL: 序列化结果中检出黑名单字段「${blocked}」，拦截。`,
      );
      throw new Error(
        `HOST_SAFE_LEAK_DETECTED: 序列化结果包含敏感字段「${blocked}」，已拒绝返回。`,
      );
    }
  }

  // ---- 保险③：强制删除黑名单字段（即使白名单没加，有人用 Object.defineProperty 挂原型也得去掉）----
  for (const blocked of HOST_SAFE_BLOCKLIST_KEYS) {
    if (blocked in safe) {
      try { delete (safe as unknown as Record<string, unknown>)[blocked]; } catch { /* non-configurable: 抛错也不 return */ }
      console.error(
        `[sanitizeHostConfig] SECURITY ALERT: safe 对象上意外存在黑名单字段「${blocked}」，` +
          `已尝试删除；请立即排查 sanitize 赋值过程是否误用了 spread/Object.assign(raw, ...)。`,
      );
      throw new Error(
        `HOST_SAFE_LEAK_DETECTED: safe 对象存在黑名单字段「${blocked}」，已拦截。`,
      );
    }
  }

  return safe;
}

export function sanitizeHostConfigs<T extends HostConfig>(list: T[]): HostConfigSafe[] {
  // 注意：不能用 list.map(sanitizeHostConfig) 直接传，因为 map 会给回调传额外参数
  // (index, array)。sanitize 第二个参数不存在所以没问题，但未来加参数会炸。
  // 为了安全直接显式回调。
  return list.map((h) => sanitizeHostConfig(h));
}
