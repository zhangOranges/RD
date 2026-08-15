/**
 * 内核级事件总线（单例）。
 *
 * 与 pluginSdk.ts 中的 createEventBus() 区别：
 * - createEventBus() 是给插件 iframe 内部用的本地 bus（Phase 1 已实现）
 * - kernelEventBus 是内核主进程的事件总线，RD 核心代码 emit 事件，插件通过 PluginSandbox 桥接订阅
 *
 * owner 机制：
 * - 每个插件用一个唯一的 owner 对象（在 pluginLifecycleManager 中创建）注册监听器
 * - 插件 disable 时调用 offAll(owner) 批量移除该插件所有监听器
 * - 插件隔离：插件 A 只收到自己订阅的事件，不会收到插件 B 订阅但 A 没订阅的事件
 */
import type { EventBus, RdEventMap } from '../types/plugin';

type EventName = keyof RdEventMap;
type Listener = (...args: unknown[]) => void;

interface ListenerEntry {
  event: EventName;
  listener: Listener;
  owner: object;
  /** 内部生成的唯一 forwarder 引用，用于 off 精确匹配 */
  id: number;
}

let nextListenerId = 1;

class KernelEventBus implements EventBus {
  private listeners: ListenerEntry[] = [];

  on<K extends EventName>(
    event: K,
    listener: (...args: RdEventMap[K]) => void,
    owner?: object,
  ): void {
    this.listeners.push({
      event,
      listener: listener as Listener,
      owner: owner ?? this, // 无 owner 时用 bus 自身作为 owner
      id: nextListenerId++,
    });
  }

  off<K extends EventName>(
    event: K,
    listener: (...args: RdEventMap[K]) => void,
  ): void {
    const targetFn = listener as Listener;
    for (let i = this.listeners.length - 1; i >= 0; i--) {
      if (this.listeners[i].event === event && this.listeners[i].listener === targetFn) {
        this.listeners.splice(i, 1);
        break; // 只移除第一个匹配
      }
    }
  }

  offAll(owner: object): void {
    this.listeners = this.listeners.filter((l) => l.owner !== owner);
  }

  emit<K extends EventName>(event: K, ...args: RdEventMap[K]): void {
    // 复制一份，防止遍历中 splice
    const targets = this.listeners.filter((l) => l.event === event);
    for (const entry of targets) {
      try {
        entry.listener(...(args as unknown[]));
      } catch (e) {
        console.error(`[KernelEventBus] listener error for "${String(event)}":`, e);
      }
    }
  }

  /** 调试用：返回某事件当前订阅者数量 */
  subscriberCount(event: EventName): number {
    return this.listeners.filter((l) => l.event === event).length;
  }

  /** 调试用：返回某 owner 当前所有监听器数量 */
  ownerListenerCount(owner: object): number {
    return this.listeners.filter((l) => l.owner === owner).length;
  }
}

export const kernelEventBus = new KernelEventBus();
