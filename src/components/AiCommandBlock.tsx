import { useState } from 'react';
import { Copy, Play, Check, AlertTriangle, Loader2 } from 'lucide-react';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { useTranslation } from 'react-i18next';
import { useToastStore } from './Toast';
import { useAiStore, isDangerousCommand } from '../store/aiStore';
import type { AiExecutionResult } from '../types/ai';

interface AiCommandBlockProps {
  messageId: string;
  index: number;
  command: string;
  result?: AiExecutionResult;
}

export function AiCommandBlock({ messageId, index, command, result }: AiCommandBlockProps) {
  const { t } = useTranslation();
  const executeCommand = useAiStore((s) => s.executeCommand);
  const [copied, setCopied] = useState(false);
  const [executing, setExecuting] = useState(false);

  const dangerous = isDangerousCommand(command);

  const handleCopy = async () => {
    try {
      await writeText(command);
      setCopied(true);
      useToastStore.getState().push('success', t('ai.copied'));
      setTimeout(() => setCopied(false), 1500);
    } catch {
      useToastStore.getState().push('error', t('ai.copyFailed'));
    }
  };

  const handleExecute = async () => {
    if (dangerous) {
      const ok = window.confirm(t('ai.confirmDangerous', { command }));
      if (!ok) return;
    }
    setExecuting(true);
    // 确保"执行中"状态至少显示 300ms，避免一闪而过
    await Promise.all([
      executeCommand(messageId, index, command),
      new Promise((r) => setTimeout(r, 300)),
    ]);
    setExecuting(false);
  };

  return (
    <div className="ai-cmd-block">
      <div className="ai-cmd-header">
        <span className="ai-cmd-lang">bash</span>
        {dangerous && (
          <span className="ai-cmd-danger">
            <AlertTriangle size={12} />
            {t('ai.dangerous')}
          </span>
        )}
      </div>
      <pre className="ai-cmd-code">
        <code>{command}</code>
      </pre>
      <div className="ai-cmd-actions">
        <button
          className="ai-cmd-btn"
          type="button"
          onClick={handleCopy}
          title={t('ai.copy')}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? t('ai.copied') : t('ai.copy')}
        </button>
        <button
          className="ai-cmd-btn ai-cmd-execute"
          type="button"
          onClick={handleExecute}
          disabled={executing}
          title={t('ai.execute')}
        >
          {executing ? (
            <Loader2 size={13} className="spin" />
          ) : (
            <Play size={13} />
          )}
          {executing ? t('ai.executing') : t('ai.execute')}
        </button>
      </div>
      {result && (
        <div
          className={`ai-cmd-result ${result.success ? 'ai-cmd-result-ok' : 'ai-cmd-result-err'}`}
        >
          <div className="ai-cmd-result-label">
            {result.success
              ? t('ai.sentToTerminal')
              : t('ai.executeFailed')}
          </div>
          {!result.success && result.output && (
            <pre className="ai-cmd-result-output">
              <code>{result.output}</code>
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
