/**
 * 前端统一日志工具：通过后端 `update_log` 命令写入 update.log 文件。
 *
 * 所有日志都带 `[FE]` 标签，与后端的 `[BE]` 标签区分。
 * level: 'info' | 'warn' | 'error'
 *   - info: 仅在开启"调试日志"开关时写入
 *   - warn / error: 始终写入
 *
 * 不使用 console，确保日志统一持久化到后端文件，便于离线排查。
 */
import { invoke } from '@tauri-apps/api/core';

export type LogLevel = 'info' | 'warn' | 'error';

/**
 * 写一条日志到后端 update.log。
 * 用 `void` 不 await，避免阻塞调用方流程；失败静默忽略（日志不应影响主逻辑）。
 */
export function log(level: LogLevel, msg: string): void {
  void invoke('update_log', { level, msg: `[FE] ${msg}` }).catch(() => {
    /* 忽略：日志写入失败不应影响主流程 */
  });
}

export const logInfo = (msg: string) => log('info', msg);
export const logWarn = (msg: string) => log('warn', msg);
export const logError = (msg: string) => log('error', msg);
