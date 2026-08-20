/** 远程 POSIX 路径拼接（只负责拼 "当前目录 / 相对路径"，简单处理） */
export function joinRemotePath(base: string, rel: string): string {
  if (!base) return `/${rel.replace(/^\//, '')}`;
  const b = base.endsWith('/') ? base : `${base}/`;
  return b + rel.replace(/^\//, '');
}
