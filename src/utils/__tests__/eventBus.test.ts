/**
 * EventBus 测试验证（纯 TS，npx tsx 运行或 tsc + node）
 * 验证 TR-2.1.1 / TR-2.1.2 / TR-2.1.3
 */
import { kernelEventBus } from '../eventBus';
import type { ReconnectMeta, ConnectResult } from '../../types/plugin';

// —— TR-2.1.1: reconnect 事件流顺序 ——
function testReconnectFlow(): boolean {
  const owner = {};
  const sequence: string[] = [];

  kernelEventBus.on('connection:reconnecting', () => sequence.push('reconnecting'), owner);
  kernelEventBus.on('connection:reconnect-attempt', () => sequence.push('attempt'), owner);
  kernelEventBus.on('connection:reconnect-success', () => sequence.push('success'), owner);
  kernelEventBus.on('connection:reconnect-aborted', () => sequence.push('aborted'), owner);

  const meta: ReconnectMeta = { attempt: 1, nextDelayMs: 2000, nextAt: Date.now() + 2000 };
  kernelEventBus.emit('connection:reconnecting', 'host-1', meta);
  kernelEventBus.emit('connection:reconnect-attempt', 'host-1', 1, 2000);
  kernelEventBus.emit('connection:reconnect-success', 'host-1', {} as ConnectResult);
  kernelEventBus.emit('connection:reconnect-aborted', 'host-1', 'timeout');

  const expected = ['reconnecting', 'attempt', 'success', 'aborted'];
  const ok = JSON.stringify(sequence) === JSON.stringify(expected);
  console.assert(ok, `TR-2.1.1 FAILED: expected ${JSON.stringify(expected)}, got ${JSON.stringify(sequence)}`);

  kernelEventBus.offAll(owner);
  return ok;
}

// —— TR-2.1.2: offAll 后所有监听器不再触发 ——
function testOffAll(): boolean {
  const owner = {};
  let callCount = 0;

  kernelEventBus.on('connection:close', () => callCount++, owner);
  kernelEventBus.on('connection:success', () => callCount++, owner);
  kernelEventBus.on('terminal:new-tab', () => callCount++, owner);

  kernelEventBus.offAll(owner);

  kernelEventBus.emit('connection:close', 'host-1', 'user');
  kernelEventBus.emit('connection:success', 'host-1', {} as ConnectResult);
  kernelEventBus.emit('terminal:new-tab', 'term-1');

  const ok = callCount === 0;
  console.assert(ok, `TR-2.1.2 FAILED: expected 0 calls, got ${callCount}`);
  return ok;
}

// —— TR-2.1.3: 插件 A/B 隔离 ——
function testPluginIsolation(): boolean {
  const ownerA = {};
  const ownerB = {};
  let aCount = 0;
  let bCount = 0;

  // 插件 A 订阅 connection:close
  kernelEventBus.on('connection:close', () => aCount++, ownerA);
  // 插件 B 订阅 connection:success（不同事件）
  kernelEventBus.on('connection:success', () => bCount++, ownerB);

  // 内核 emit connection:close → 只有 A 收到
  kernelEventBus.emit('connection:close', 'host-1', 'user');
  // 内核 emit connection:success → 只有 B 收到
  kernelEventBus.emit('connection:success', 'host-1', {} as ConnectResult);

  const ok = aCount === 1 && bCount === 1;
  console.assert(ok, `TR-2.1.3 FAILED: expected A=1 B=1, got A=${aCount} B=${bCount}`);

  kernelEventBus.offAll(ownerA);
  kernelEventBus.offAll(ownerB);
  return ok;
}

// 运行
const results = [testReconnectFlow(), testOffAll(), testPluginIsolation()];
const allPass = results.every((r) => r);
console.log(`\nEventBus Tests: ${results.filter((r) => r).length}/${results.length} passed`);
if (!allPass) {
  throw new Error('EventBus tests failed');
}
