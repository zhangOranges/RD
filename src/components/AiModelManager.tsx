import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Star, Pencil, Check, Loader2 } from 'lucide-react';
import { useAiStore } from '../store/aiStore';
import { useToastStore } from './Toast';
import type { AiModelConfig } from '../types/ai';
import '../styles/ai-model-manager.css';

const genId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const EMPTY_MODEL: AiModelConfig = {
  id: '',
  name: '',
  provider: 'openai-compatible',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.3,
  maxTokens: 2048,
  isDefault: false,
};

export function AiModelManager() {
  const { t } = useTranslation();
  const models = useAiStore((s) => s.models);
  const loadModels = useAiStore((s) => s.loadModels);
  const saveModel = useAiStore((s) => s.saveModel);
  const deleteModel = useAiStore((s) => s.deleteModel);
  const setDefaultModel = useAiStore((s) => s.setDefaultModel);
  const testModel = useAiStore((s) => s.testModel);
  const pushToast = useToastStore((s) => s.push);

  const [editing, setEditing] = useState<AiModelConfig | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const handleAdd = () => {
    setEditing({ ...EMPTY_MODEL, id: genId(), name: '' });
    setTestResult(null);
  };

  const handleEdit = (m: AiModelConfig) => {
    setEditing({ ...m });
    setTestResult(null);
  };

  const handleDelete = async (m: AiModelConfig) => {
    if (!window.confirm(t('ai.deleteModelConfirm', { name: m.name }))) return;
    try {
      await deleteModel(m.id);
      pushToast('success', t('ai.modelDeleted'));
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : String(e));
    }
  };

  const handleSetDefault = async (id: string) => {
    try {
      await setDefaultModel(id);
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : String(e));
    }
  };

  const handleSave = async () => {
    if (!editing) return;
    if (!editing.name.trim() || !editing.baseUrl.trim() || !editing.model.trim()) {
      pushToast('error', t('ai.fillRequired'));
      return;
    }
    if (!editing.apiKey && !models.find((m) => m.id === editing.id)) {
      pushToast('error', t('ai.apiKeyRequired'));
      return;
    }
    try {
      await saveModel(editing);
      pushToast('success', t('ai.modelSaved'));
      setEditing(null);
    } catch (e) {
      pushToast('error', e instanceof Error ? e.message : String(e));
    }
  };

  const handleTest = async () => {
    if (!editing) return;
    setTesting(true);
    setTestResult(null);
    // 先保存再测试（确保 apiKey 已入库）
    try {
      await saveModel(editing);
      const res = await testModel(editing.id);
      setTestResult(res);
      if (res.ok) {
        pushToast('success', t('ai.testSuccess'));
      } else {
        pushToast('error', t('ai.testFailed', { error: res.msg }));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setTestResult({ ok: false, msg });
      pushToast('error', msg);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="ai-model-manager">
      <div className="ai-mm-header">
        <button className="btn btn-primary" type="button" onClick={handleAdd}>
          <Plus size={14} />
          {t('ai.addModel')}
        </button>
      </div>

      {models.length === 0 && !editing && (
        <div className="ai-mm-empty">{t('ai.noModels')}</div>
      )}

      <div className="ai-mm-list">
        {models.map((m) => (
          <div key={m.id} className={`ai-mm-card ${m.isDefault ? 'is-default' : ''}`}>
            <div className="ai-mm-card-info">
              <div className="ai-mm-card-name">
                {m.isDefault && <Star size={13} className="ai-mm-star" fill="currentColor" />}
                {m.name}
              </div>
              <div className="ai-mm-card-sub">
                {m.model} · {m.baseUrl}
              </div>
            </div>
            <div className="ai-mm-card-actions">
              {!m.isDefault && (
                <button
                  className="ai-mm-icon-btn"
                  type="button"
                  title={t('ai.setDefault')}
                  onClick={() => handleSetDefault(m.id)}
                >
                  <Star size={14} />
                </button>
              )}
              <button
                className="ai-mm-icon-btn"
                type="button"
                title={t('common.edit')}
                onClick={() => handleEdit(m)}
              >
                <Pencil size={14} />
              </button>
              <button
                className="ai-mm-icon-btn ai-mm-danger"
                type="button"
                title={t('common.delete')}
                onClick={() => handleDelete(m)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {editing && (
        <div className="ai-mm-editor">
          <h3 className="ai-mm-editor-title">
            {models.find((m) => m.id === editing.id) ? t('ai.editModel') : t('ai.addModel')}
          </h3>

          <div className="form-group">
            <label className="form-label">{t('ai.modelName')} *</label>
            <input
              className="form-input"
              type="text"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder={t('ai.modelNamePlaceholder')}
            />
          </div>

          <div className="form-group">
            <label className="form-label">{t('ai.baseUrl')} *</label>
            <input
              className="form-input"
              type="text"
              value={editing.baseUrl}
              onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
              placeholder="https://api.deepseek.com/v1"
            />
          </div>

          <div className="form-group">
            <label className="form-label">{t('ai.apiKey')} {models.find((m) => m.id === editing.id) ? '' : '*'}</label>
            <input
              className="form-input"
              type="password"
              value={editing.apiKey || ''}
              onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
              placeholder={t('ai.apiKeyPlaceholder')}
            />
            {models.find((m) => m.id === editing.id) && (
              <small className="form-hint">{t('ai.apiKeyHint')}</small>
            )}
          </div>

          <div className="form-group">
            <label className="form-label">{t('ai.modelId')} *</label>
            <input
              className="form-input"
              type="text"
              value={editing.model}
              onChange={(e) => setEditing({ ...editing, model: e.target.value })}
              placeholder="deepseek-chat / gpt-4o-mini"
            />
          </div>

          <div className="form-row">
            <div className="form-group form-group-half">
              <label className="form-label">{t('ai.temperature')}: {editing.temperature.toFixed(1)}</label>
              <input
                className="form-input"
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={editing.temperature}
                onChange={(e) => setEditing({ ...editing, temperature: parseFloat(e.target.value) })}
              />
            </div>
            <div className="form-group form-group-half">
              <label className="form-label">{t('ai.maxTokens')}</label>
              <input
                className="form-input"
                type="number"
                min={128}
                max={32768}
                value={editing.maxTokens}
                onChange={(e) => setEditing({ ...editing, maxTokens: parseInt(e.target.value, 10) || 2048 })}
              />
            </div>
          </div>

          {testResult && (
            <div className={`ai-mm-test-result ${testResult.ok ? 'ok' : 'err'}`}>
              {testResult.ok ? t('ai.testSuccess') : t('ai.testFailed', { error: testResult.msg })}
            </div>
          )}

          <div className="ai-mm-editor-actions">
            <button
              className="btn btn-secondary"
              type="button"
              onClick={handleTest}
              disabled={testing}
            >
              {testing ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
              {t('ai.testConnection')}
            </button>
            <div className="ai-mm-editor-actions-right">
              <button
                className="btn btn-secondary"
                type="button"
                onClick={() => setEditing(null)}
              >
                {t('common.cancel')}
              </button>
              <button className="btn btn-primary" type="button" onClick={handleSave}>
                {t('common.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
