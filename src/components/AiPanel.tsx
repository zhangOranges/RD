import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  Send,
  X,
  Trash2,
  AlertCircle,
  MessageSquare,
  History,
  Plus,
  Square,
} from 'lucide-react';
import { useAiStore } from '../store/aiStore';
import { useHostStore } from '../store/hostStore';
import { AiMessageBubble } from './AiMessageBubble';
import '../styles/ai-panel.css';

export function AiPanel() {
  const { t } = useTranslation();
  const isPanelOpen = useAiStore((s) => s.isPanelOpen);
  const setPanelOpen = useAiStore((s) => s.setPanelOpen);
  const messages = useAiStore((s) => s.messages);
  const isLoading = useAiStore((s) => s.isLoading);
  const models = useAiStore((s) => s.models);
  const selectedModelId = useAiStore((s) => s.selectedModelId);
  const selectModel = useAiStore((s) => s.selectModel);
  const sendMessage = useAiStore((s) => s.sendMessage);
  const stopChat = useAiStore((s) => s.stopChat);
  const loadModels = useAiStore((s) => s.loadModels);
  const activeTab = useAiStore((s) => s.activeTab);
  const setActiveTab = useAiStore((s) => s.setActiveTab);
  const sessions = useAiStore((s) => s.sessions);
  const currentSessionId = useAiStore((s) => s.currentSessionId);
  const createSession = useAiStore((s) => s.createSession);
  const switchSession = useAiStore((s) => s.switchSession);
  const deleteSession = useAiStore((s) => s.deleteSession);

  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const selectedHostId = useHostStore((s) => s.selectedHostId);
  const connectionStates = useHostStore((s) => s.connectionStates);
  const connState = selectedHostId ? connectionStates[selectedHostId] : undefined;
  const isConnected = connState === 'connected';

  useEffect(() => {
    if (isPanelOpen && models.length === 0) {
      void loadModels();
    }
  }, [isPanelOpen, models.length, loadModels]);

  // 自动滚动到底部（messages 变化 或 面板打开时）
  useEffect(() => {
    if (!isPanelOpen || activeTab !== 'chat') return;
    requestAnimationFrame(() => {
      if (scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, [messages, isPanelOpen, activeTab]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    void sendMessage(text);
    setInput('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleNewSession = () => {
    createSession();
    setActiveTab('chat');
  };

  if (!isPanelOpen) return null;

  const hasModel = models.length > 0;
  const canSend = hasModel && isConnected && !isLoading;

  return (
    <div className="ai-panel-overlay" onClick={() => setPanelOpen(false)}>
      <div
        className={`ai-panel ${isPanelOpen ? 'ai-panel-open' : ''}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ai-panel-header">
          <div className="ai-panel-title">
            <Bot size={16} />
            <span>{t('ai.panelTitle')}</span>
          </div>
          <div className="ai-panel-actions">
            {hasModel && (
              <select
                className="ai-model-select"
                value={selectedModelId || ''}
                onChange={(e) => selectModel(e.target.value)}
                title={t('ai.selectModel')}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
            <button
              className="ai-icon-btn"
              type="button"
              onClick={() => setPanelOpen(false)}
              title={t('ai.close')}
            >
              <X size={15} />
            </button>
          </div>
        </div>

        {/* Tab 切换 */}
        <div className="ai-tabs">
          <button
            className={`ai-tab ${activeTab === 'chat' ? 'ai-tab-active' : ''}`}
            type="button"
            onClick={() => setActiveTab('chat')}
          >
            <MessageSquare size={13} />
            {t('ai.tabChat')}
          </button>
          <button
            className={`ai-tab ${activeTab === 'history' ? 'ai-tab-active' : ''}`}
            type="button"
            onClick={() => setActiveTab('history')}
          >
            <History size={13} />
            {t('ai.tabHistory')}
          </button>
          <button
            className="ai-tab ai-tab-new"
            type="button"
            onClick={handleNewSession}
            title={t('ai.newSession')}
          >
            <Plus size={14} />
          </button>
        </div>

        {/* 对话 Tab */}
        {activeTab === 'chat' && (
          <>
            <div className="ai-panel-messages" ref={scrollRef}>
              {messages.length === 0 && (
                <div className="ai-empty">
                  <Bot size={40} />
                  <p>{t('ai.emptyHint')}</p>
                  {!hasModel && (
                    <p className="ai-empty-sub">{t('ai.noModelHint')}</p>
                  )}
                  {hasModel && !isConnected && (
                    <p className="ai-empty-sub">{t('ai.notConnectedHint')}</p>
                  )}
                </div>
              )}
              {messages.map((m, i) => (
                <AiMessageBubble key={m.id} message={m} isLast={i === messages.length - 1} />
              ))}
            </div>

            <div className="ai-panel-input-area">
              {!isConnected && (
                <div className="ai-input-warning">
                  <AlertCircle size={13} />
                  {t('ai.notConnectedHint')}
                </div>
              )}
              <div className="ai-input-row">
                <textarea
                  className="ai-input"
                  placeholder={t('ai.placeholder')}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                  disabled={!canSend}
                />
                <button
                  className={`ai-send-btn ${isLoading ? 'ai-stop-btn' : ''}`}
                  type="button"
                  onClick={isLoading ? () => void stopChat() : handleSend}
                  disabled={!isLoading && (!canSend || !input.trim())}
                  title={isLoading ? t('ai.stop') : t('ai.send')}
                >
                  {isLoading ? <Square size={14} /> : <Send size={16} />}
                </button>
              </div>
            </div>
          </>
        )}

        {/* 历史会话 Tab */}
        {activeTab === 'history' && (
          <div className="ai-session-list">
            {sessions.length === 0 && (
              <div className="ai-empty">
                <History size={40} />
                <p>{t('ai.noSessions')}</p>
              </div>
            )}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`ai-session-item ${s.id === currentSessionId ? 'ai-session-active' : ''}`}
                onClick={() => switchSession(s.id)}
              >
                <div className="ai-session-info">
                  <div className="ai-session-title">
                    {s.title || t('ai.untitled')}
                  </div>
                  <div className="ai-session-meta">
                    {new Date(s.updatedAt).toLocaleString()}
                    <span className="ai-session-count">
                      {s.messages.length} {t('ai.messages')}
                    </span>
                  </div>
                </div>
                <button
                  className="ai-session-del"
                  type="button"
                  title={t('common.delete')}
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteSession(s.id);
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
