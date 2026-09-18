import { describe, test, expect, beforeEach, vi } from 'vitest';
import { useAiStore, extractCommands, isDangerousCommand } from '../aiStore';

// Mock Tauri invoke and event listen
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('mock-stream-id'),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock('../../utils/log', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}));

// Mock localStorage（node 环境下没有 window）
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, val: string) => {
      store[key] = val;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
  };
})();

// 注入到 global 作为 localStorage
(global as Record<string, unknown>).localStorage = localStorageMock;

// ============ extractCommands ============

describe('extractCommands', () => {
  test('提取单个 bash 代码块', () => {
    const content = '使用以下命令：\n```bash\nls -la\n```\n结束';
    const cmds = extractCommands(content);
    expect(cmds).toEqual(['ls -la']);
  });

  test('提取多个代码块', () => {
    const content =
      '步骤1：\n```bash\necho hello\n```\n步骤2：\n```bash\necho world\n```';
    const cmds = extractCommands(content);
    expect(cmds).toEqual(['echo hello', 'echo world']);
  });

  test('无代码块返回空数组', () => {
    expect(extractCommands('纯文本无命令')).toEqual([]);
  });

  test('提取 sh 和 shell 标签', () => {
    const content = '```sh\npwd\n```\n```shell\nwhoami\n```';
    expect(extractCommands(content)).toEqual(['pwd', 'whoami']);
  });

  test('无语言标签的代码块也能提取', () => {
    const content = '```\ndate\n```';
    expect(extractCommands(content)).toEqual(['date']);
  });

  test('空代码块被忽略', () => {
    const content = '```bash\n\n```';
    expect(extractCommands(content)).toEqual([]);
  });

  test('多行命令完整保留', () => {
    const content = '```bash\nfor i in 1 2 3; do\n  echo $i\ndone\n```';
    expect(extractCommands(content)).toEqual([
      'for i in 1 2 3; do\n  echo $i\ndone',
    ]);
  });
});

// ============ isDangerousCommand ============

describe('isDangerousCommand', () => {
  const dangerousCases = [
    'rm -rf /',
    'rm -rf / home',
    'mkfs.ext4 /dev/sda1',
    "dd if=/dev/zero of=/dev/sda",
    'shutdown -h now',
    'reboot',
    'halt',
    'chmod -R 777 /',
    'chown -R root:root /',
  ];

  test.each(dangerousCases)('检测危险命令: %s', (cmd) => {
    expect(isDangerousCommand(cmd)).toBe(true);
  });

  const safeCases = [
    'ls -la',
    'cat /etc/hosts',
    'grep "error" /var/log/syslog',
    'du -sh * | sort -rh | head -5',
    'echo hello',
    'ps aux',
    'df -h',
    'rm -rf /tmp/test',  // rm -rf 但不是根目录
  ];

  test.each(safeCases)('安全命令: %s', (cmd) => {
    expect(isDangerousCommand(cmd)).toBe(false);
  });
});

// ============ Store: 会话管理 ============

describe('AiStore 会话管理', () => {
  beforeEach(() => {
    localStorageMock.clear();
    useAiStore.setState({
      models: [],
      defaultModelId: null,
      selectedModelId: null,
      sessions: [],
      currentSessionId: null,
      messages: [],
      isLoading: false,
      isPanelOpen: false,
      activeTab: 'chat',
      _persistTimer: null,
      _tokenUnlisten: null,
      _doneUnlisten: null,
      _errorUnlisten: null,
      _pendingStreamId: null,
    });
  });

  test('createSession 创建新会话并切换', () => {
    const id = useAiStore.getState().createSession();
    expect(id).toBeTruthy();
    const state = useAiStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.currentSessionId).toBe(id);
    expect(state.messages).toEqual([]);
    expect(state.activeTab).toBe('chat');
  });

  test('createSession 新会话插入到列表头部', () => {
    const id1 = useAiStore.getState().createSession();
    const id2 = useAiStore.getState().createSession();
    const state = useAiStore.getState();
    expect(state.sessions[0].id).toBe(id2);
    expect(state.sessions[1].id).toBe(id1);
  });

  test('switchSession 加载历史消息', () => {
    const id = useAiStore.getState().createSession();
    // 手动注入消息到 session
    useAiStore.setState((s) => ({
      sessions: s.sessions.map((sv) =>
        sv.id === id
          ? {
              ...sv,
              title: 'test',
              messages: [
                { id: '1', role: 'user', content: 'hello' },
                { id: '2', role: 'assistant', content: 'hi' },
              ],
            }
          : sv,
      ),
    }));

    // 切换到另一个会话再切回来
    const id2 = useAiStore.getState().createSession();
    expect(useAiStore.getState().messages).toEqual([]);

    useAiStore.getState().switchSession(id);
    const state = useAiStore.getState();
    expect(state.currentSessionId).toBe(id);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].content).toBe('hello');
    expect(state.messages[1].content).toBe('hi');
    expect(state.activeTab).toBe('chat');
  });

  test('switchSession 清除 streaming 状态', () => {
    const id = useAiStore.getState().createSession();
    useAiStore.setState((s) => ({
      sessions: s.sessions.map((sv) =>
        sv.id === id
          ? {
              ...sv,
              messages: [
                { id: '1', role: 'user', content: 'test' },
                { id: '2', role: 'assistant', content: 'resp', streaming: true },
              ],
            }
          : sv,
      ),
    }));

    useAiStore.getState().switchSession(id);
    const msgs = useAiStore.getState().messages;
    expect(msgs[1].streaming).toBe(false);
  });

  test('deleteSession 删除当前会话后回退到第一个', () => {
    const id1 = useAiStore.getState().createSession();
    const id2 = useAiStore.getState().createSession();
    expect(useAiStore.getState().currentSessionId).toBe(id2);

    useAiStore.getState().deleteSession(id2);
    const state = useAiStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.currentSessionId).toBe(id1);
  });

  test('deleteSession 删除非当前会话不影响当前', () => {
    const id1 = useAiStore.getState().createSession();
    const id2 = useAiStore.getState().createSession();
    expect(useAiStore.getState().currentSessionId).toBe(id2);

    useAiStore.getState().deleteSession(id1);
    const state = useAiStore.getState();
    expect(state.sessions).toHaveLength(1);
    expect(state.currentSessionId).toBe(id2);
  });

  test('deleteSession 删除最后一个会话后状态为空', () => {
    const id = useAiStore.getState().createSession();
    useAiStore.getState().deleteSession(id);
    const state = useAiStore.getState();
    expect(state.sessions).toHaveLength(0);
    expect(state.currentSessionId).toBeNull();
    expect(state.messages).toEqual([]);
  });

  test('setActiveTab 切换 Tab', () => {
    useAiStore.getState().setActiveTab('history');
    expect(useAiStore.getState().activeTab).toBe('history');
    useAiStore.getState().setActiveTab('chat');
    expect(useAiStore.getState().activeTab).toBe('chat');
  });

  test('clearMessages 等同于创建新会话', () => {
    const id1 = useAiStore.getState().createSession();
    useAiStore.setState({ messages: [{ id: 'x', role: 'user', content: 'test' }] });

    useAiStore.getState().clearMessages();
    const state = useAiStore.getState();
    expect(state.messages).toEqual([]);
    expect(state.currentSessionId).not.toBe(id1);
    expect(state.sessions).toHaveLength(2);
  });
});

// ============ Store: 面板控制 ============

describe('AiStore 面板控制', () => {
  beforeEach(() => {
    useAiStore.setState({ isPanelOpen: false });
  });

  test('togglePanel 切换开关', () => {
    useAiStore.getState().togglePanel();
    expect(useAiStore.getState().isPanelOpen).toBe(true);
    useAiStore.getState().togglePanel();
    expect(useAiStore.getState().isPanelOpen).toBe(false);
  });

  test('setPanelOpen 直接设置', () => {
    useAiStore.getState().setPanelOpen(true);
    expect(useAiStore.getState().isPanelOpen).toBe(true);
    useAiStore.getState().setPanelOpen(false);
    expect(useAiStore.getState().isPanelOpen).toBe(false);
  });
});

// ============ Store: 防抖持久化 ============

describe('AiStore 防抖持久化', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.useFakeTimers();
    useAiStore.setState({
      sessions: [],
      currentSessionId: null,
      _persistTimer: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('500ms 内多次调用只写一次 localStorage', () => {
    useAiStore.getState().createSession();
    useAiStore.getState().createSession();
    useAiStore.getState().createSession();

    // 此时 localStorage 还没写入（防抖中）
    expect(localStorageMock.setItem).not.toHaveBeenCalled();

    // 快进 500ms
    vi.advanceTimersByTime(500);

    // 只写了一次
    expect(localStorageMock.setItem).toHaveBeenCalledTimes(1);
  });

  test('createSession 后 500ms 数据正确持久化', () => {
    const id = useAiStore.getState().createSession();
    vi.advanceTimersByTime(500);

    const raw = localStorageMock.getItem('rd_ai_sessions');
    expect(raw).not.toBeNull();
    const data = JSON.parse(raw!);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe(id);
  });
});
