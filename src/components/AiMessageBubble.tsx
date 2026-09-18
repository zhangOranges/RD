import { useState } from 'react';
import { Bot, User, Copy, Check, RotateCcw } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useTranslation } from 'react-i18next';
import type { AiConversationMessage } from '../types/ai';
import { extractCommands, useAiStore } from '../store/aiStore';
import { AiCommandBlock } from './AiCommandBlock';
import { useToastStore } from './Toast';

interface AiMessageBubbleProps {
  message: AiConversationMessage;
  isLast: boolean;
}

export function AiMessageBubble({ message, isLast }: AiMessageBubbleProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const retryLastMessage = useAiStore((s) => s.retryLastMessage);
  const isLoading = useAiStore((s) => s.isLoading);

  const isUser = message.role === 'user';

  const handleCopy = async () => {
    try {
      await writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      useToastStore.getState().push('error', t('ai.copyFailed'));
    }
  };

  // 仅当最后一条 assistant 消息内容为空（被停止/报错）且非加载中时可重试
  const canRetry = isLast && !isUser && !message.streaming && !isLoading && !message.content.trim();

  const handleRetry = () => {
    void retryLastMessage();
  };

  if (isUser) {
    return (
      <div className="ai-msg ai-msg-user">
        <div className="ai-msg-avatar">
          <User size={14} />
        </div>
        <div className="ai-msg-content">
          <div className="ai-msg-bubble ai-msg-bubble-user">
            {message.content}
          </div>
          <div className="ai-msg-actions">
            <button
              className="ai-msg-action-btn"
              type="button"
              onClick={handleCopy}
              title={t('ai.copy')}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // assistant：渲染文本 + 提取出的命令块
  const commands = message.commands && message.commands.length > 0
    ? message.commands
    : extractCommands(message.content);

  // 将文本按命令块拆分渲染（保留非命令文本）
  const parts = message.content.split(/```(?:bash|sh|shell)?\n?[\s\S]*?```/g);

  return (
    <div className="ai-msg ai-msg-assistant">
      <div className="ai-msg-avatar ai-msg-avatar-assistant">
        <Bot size={14} />
      </div>
      <div className="ai-msg-content">
        <div className="ai-msg-bubble ai-msg-bubble-assistant">
          {parts.map((text, i) => (
            <div key={i}>
              {text.trim() && <div className="ai-msg-text">{text.trim()}</div>}
              {commands[i] && (
                <AiCommandBlock
                  messageId={message.id}
                  index={i}
                  command={commands[i]}
                  result={message.executionResults?.[i]}
                />
              )}
            </div>
          ))}
          {message.streaming && <span className="ai-msg-cursor">▋</span>}
          {!message.streaming && !message.content.trim() && (
            <div className="ai-msg-empty">{t('ai.stoppedEmpty')}</div>
          )}
        </div>
        <div className="ai-msg-actions">
          {message.content.trim() && (
            <button
              className="ai-msg-action-btn"
              type="button"
              onClick={handleCopy}
              title={t('ai.copy')}
            >
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
          )}
          {canRetry && (
            <button
              className="ai-msg-action-btn ai-msg-retry-btn"
              type="button"
              onClick={handleRetry}
              title={t('ai.retry')}
            >
              <RotateCcw size={12} />
              {t('ai.retry')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
