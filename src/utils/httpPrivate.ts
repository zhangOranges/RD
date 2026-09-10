/**
 * 判断主机是否为私有/内网地址。
 * 用于插件 HTTP 请求的内网访问限制。
 */
export function isPrivateHost(host: string): boolean {
  if (host.toLowerCase() === 'localhost') return true;
  const cleaned = host.replace(/^\[/, '').replace(/\]$/, '');
  const v4Match = cleaned.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4Match) {
    const o = v4Match.slice(1, 5).map(Number);
    if (o.some(n => n < 0 || n > 255)) return false;
    const [a, b] = o;
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0 && o[1] === 0 && o[2] === 0 && o[3] === 0) return true;
    return false;
  }
  if (cleaned === '::1' || cleaned.toLowerCase().startsWith('fe80') ||
      cleaned.toLowerCase().startsWith('fc') || cleaned.toLowerCase().startsWith('fd') ||
      cleaned.toLowerCase().startsWith('::')) return true;
  return false;
}
