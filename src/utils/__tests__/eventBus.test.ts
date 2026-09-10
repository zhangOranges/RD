import { describe, test, expect, beforeEach } from 'vitest';
import { kernelEventBus } from '../eventBus';
import type { ConnectResult } from '../../types/plugin';

describe('EventBus', () => {
  const owner = {};

  beforeEach(() => {
    kernelEventBus.offAll(owner);
  });

  // TR-2.1.1: reconnect 事件流顺序
  test('reconnect 事件流顺序正确', () => {
    const sequence: string[] = [];
    kernelEventBus.on('connection:reconnecting', () => sequence.push('reconnecting'), owner);
    kernelEventBus.on('connection:reconnect-attempt', () => sequence.push('attempt'), owner);
    kernelEventBus.on('connection:reconnect-success', () => sequence.push('success'), owner);
    kernelEventBus.on('connection:reconnect-aborted', () => sequence.push('aborted'), owner);

    kernelEventBus.emit('connection:reconnecting', 'host-1', { attempt: 1, nextDelayMs: 2000, nextAt: Date.now() + 2000 });
    kernelEventBus.emit('connection:reconnect-attempt', 'host-1', 1, 2000);
    kernelEventBus.emit('connection:reconnect-success', 'host-1', {} as ConnectResult);
    kernelEventBus.emit('connection:reconnect-aborted', 'host-1', 'timeout');

    expect(sequence).toEqual(['reconnecting', 'attempt', 'success', 'aborted']);
  });

  // TR-2.1.2: offAll 后所有监听器不再触发
  test('offAll 后所有监听器不再触发', () => {
    let callCount = 0;
    kernelEventBus.on('connection:close', () => callCount++, owner);
    kernelEventBus.on('connection:success', () => callCount++, owner);
    kernelEventBus.on('terminal:new-tab', () => callCount++, owner);

    kernelEventBus.offAll(owner);

    kernelEventBus.emit('connection:close', 'host-1', 'user');
    kernelEventBus.emit('connection:success', 'host-1', {} as ConnectResult);
    kernelEventBus.emit('terminal:new-tab', 'term-1');

    expect(callCount).toBe(0);
  });

  // TR-2.1.3: 插件 A/B 隔离
  test('不同 owner 的监听器互相隔离', () => {
    const ownerA = {};
    const ownerB = {};
    let aCount = 0;
    let bCount = 0;

    kernelEventBus.on('connection:close', () => aCount++, ownerA);
    kernelEventBus.on('connection:success', () => bCount++, ownerB);

    kernelEventBus.emit('connection:close', 'host-1', 'user');
    kernelEventBus.emit('connection:success', 'host-1', {} as ConnectResult);

    expect(aCount).toBe(1);
    expect(bCount).toBe(1);

    kernelEventBus.offAll(ownerA);
    kernelEventBus.offAll(ownerB);
  });
});
