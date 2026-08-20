/**
 * 文件大小格式化：B / KB / MB / GB / TB。
 *
 * 规则：
 *   - < 1 KB: 整数 B
 *   - KB / MB: 1 位小数（如 16.2 KB）
 *   - GB: 2 位小数
 *   - TB: 2 位小数
 *
 * 与 LocalFilePane / FileBrowser / TransferQueue 三处原先的
 * 局部实现保持语义一致，避免同一文件在不同面板显示不同大小。
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 0 || !isFinite(bytes)) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024 * 1024 * 1024)).toFixed(2)} TB`;
}
