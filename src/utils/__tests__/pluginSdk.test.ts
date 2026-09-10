import { describe, test, expect, vi, beforeEach } from 'vitest';

// 所有被 vi.mock 工厂引用的变量必须放在 vi.hoisted 中
const { mockInvoke, storeState } = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  storeState: {
    cancelReconnect: vi.fn(),
    connectHost: vi.fn(),
    disconnectHost: vi.fn(),
    connectionStates: {} as Record<string, string>,
  },
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }));

vi.mock('../utils/log', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../store/hostStore', () => ({
  useHostStore: {
    getState: () => storeState,
  },
  classifyConnectFailure: (msg: string) => ({ headline: msg, suggestion: '检查网络连接' }),
}));

vi.mock('../../store/uiStore', () => ({
  useUIStore: {
    getState: () => ({
      pluginDisableAllServerWrite: false,
      pluginDisableAllSsh: false,
      pluginAllowInternalHttp: false,
    }),
  },
}));

vi.mock('../../store/pluginUiStore', () => ({
  usePluginUiStore: {
    getState: () => ({
      checkRateLimit: () => true,
      registerToolbarButton: vi.fn(),
      removeToolbarButton: vi.fn(),
    }),
  },
}));

vi.mock('../../components/Toast', () => ({
  useToastStore: { getState: () => ({ push: vi.fn() }) },
}));

vi.mock('../../store/themeStore', () => ({
  useThemeStore: { getState: () => ({}) },
  getCurrentThemeInfo: () => ({ id: 'dark', name: 'Dark' }),
  listAllThemeInfos: () => [{ id: 'dark', name: 'Dark' }],
  PRESET_OPTIONS: [],
}));

vi.mock('react', () => ({ createElement: vi.fn() }));
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: vi.fn(), unmount: vi.fn() }) }));

import { createRDContext } from '../pluginSdk';
import type { PluginManifest } from '../../types/plugin';

const manifest: PluginManifest = {
  id: 'test-plugin',
  name: 'Test Plugin',
  version: '1.0.0',
  apiVersion: 'v1',
  author: 'test',
  description: 'test plugin',
  category: 'utility',
  entry: 'index.js',
  indexHtml: 'index.html',
  permissions: [],
  minRdVersion: '0.1.0',
  hotReload: false,
};

function makeCtx() {
  return createRDContext({ pluginId: 'test-plugin', manifest, sdkVersion: 'v1' });
}

describe('pluginSdk — 高危漏洞 #3: assertPermission 错误处理', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('权限不足时抛出"权限不足"错误', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('PERMISSION_DENIED: ssh.run not granted'));
    const ctx = makeCtx();
    await expect(ctx.server?.connect?.('host-1')).rejects.toThrow('权限不足');
  });

  test('非权限错误原样抛出（修复 #3）', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('internal server error: store.json corrupted'));
    const ctx = makeCtx();
    try {
      await ctx.server?.connect?.('host-1');
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      // 修复后：非权限错误原样抛出，不再被误报为"权限不足"
      expect(msg).not.toContain('权限不足');
      expect(msg).toContain('store.json corrupted');
    }
  });
});

describe('pluginSdk — 高危漏洞 #1: cancelReconnect 权限绕过', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('无权限时 cancelReconnect 不被执行（修复 #1）', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('PERMISSION_DENIED'));
    const ctx = makeCtx();

    // 修复后：权限校验失败时抛出异常，cancelReconnect 不会被调用
    await expect(ctx.server?.cancelReconnect?.('host-1')).rejects.toThrow('权限不足');
    expect(storeState.cancelReconnect).not.toHaveBeenCalled();
  });

  test('有权限时 cancelReconnect 正常执行', async () => {
    mockInvoke.mockResolvedValueOnce(undefined);
    const ctx = makeCtx();

    await ctx.server?.cancelReconnect?.('host-1');
    expect(storeState.cancelReconnect).toHaveBeenCalledWith('host-1');
  });
});

describe('pluginSdk — 高危漏洞 #2: ssh.exec 超时不取消后端', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('超时时返回失败结果且已传递 timeoutMs 给后端（修复 #2）', async () => {
    vi.useFakeTimers();
    try {
      storeState.connectionStates['host-1'] = 'connected';
      // ssh_exec 永不 resolve
      let sshExecResolve!: (value: string) => void;
      const sshExecPromise = new Promise<string>((res) => { sshExecResolve = res; });
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'plugin_assert_perm') return Promise.resolve(undefined);
        if (cmd === 'ssh_exec') return sshExecPromise;
        return Promise.resolve(undefined);
      });

      const ctx = makeCtx();
      const execPromise = ctx.ssh?.exec?.('host-1', 'sleep 100', { timeoutMs: 1000 });

      // 推进定时器并刷新微任务
      await vi.advanceTimersByTimeAsync(1001);

      const result = await execPromise;
      expect(result?.success).toBe(false);
      expect(result?.exitCode).toBe(-1);

      // 修复后：timeoutMs 被传给后端，Rust 会在超时后取消底层 SSH channel
      expect(mockInvoke).toHaveBeenCalledWith(
        'ssh_exec',
        expect.objectContaining({ hostId: 'host-1', timeoutMs: 1000 }),
      );

      // 修复后：invokePromise 已挂载 catch，即使后端在超时后才返回/报错也不会产生未处理拒绝
      sshExecResolve('cleanup');
      await sshExecPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  test('正常执行成功时返回 stdout', async () => {
    storeState.connectionStates['host-2'] = 'connected';
    const calls: string[] = [];
    mockInvoke.mockImplementation((cmd: string) => {
      calls.push(cmd);
      if (cmd === 'plugin_assert_perm') return Promise.resolve(undefined);
      if (cmd === 'ssh_exec') return Promise.resolve('hello world');
      return Promise.resolve(undefined);
    });

    const ctx = makeCtx();
    const result = await ctx.ssh?.exec?.('host-2', 'echo hello');

    expect(calls).toContain('ssh_exec');
    expect(result?.success).toBe(true);
    expect(result?.output).toBe('hello world');
    expect(result?.exitCode).toBe(0);
  });
});
