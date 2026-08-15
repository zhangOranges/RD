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

function runTests(): boolean {
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
  let ok = true;
  for (const [host, exp] of cases) {
    const actual = isPrivateHost(host);
    if (actual !== exp) {
      console.error(`FAIL: host=${host} expected=${exp} actual=${actual}`);
      ok = false;
    }
  }
  console.log(`HttpPrivate Tests: ${cases.filter(([h, e]) => isPrivateHost(h) === e).length}/${cases.length} passed`);
  return ok;
}

if (!runTests()) throw new Error('HttpPrivate tests failed');
