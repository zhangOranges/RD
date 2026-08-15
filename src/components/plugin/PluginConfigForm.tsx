import { useState, useEffect, useCallback } from 'react';
import type { PluginManifest } from '../../types/plugin';

/**
 * configSchema 字段类型定义（与插件开发设计.md §6.2 对齐）
 * 支持 6 种字段：string / string+password / string+textarea / number / boolean / string+enum / object 分组
 */
export interface ConfigFieldSchema {
  type: 'string' | 'number' | 'boolean' | 'object';
  label?: string;
  description?: string;
  format?: 'password' | 'textarea' | 'input'; // string 子类型
  enum?: string[]; // string+enum
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
}

export interface ConfigSchemaGroup {
  [fieldKey: string]: ConfigFieldSchema | ConfigSchemaGroup;
}

interface Props {
  manifest: PluginManifest;
  initialConfig: Record<string, unknown>;
  onSave: (config: Record<string, unknown>) => Promise<void>;
  disabled?: boolean;
}

export function PluginConfigForm({ manifest, initialConfig, onSave, disabled }: Props) {
  const [config, setConfig] = useState<Record<string, unknown>>(initialConfig);
  const [saving, setSaving] = useState(false);

  useEffect(() => setConfig(initialConfig), [initialConfig]);

  const handleChange = useCallback((key: string, value: unknown) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await onSave(config);
    } finally {
      setSaving(false);
    }
  }, [config, onSave]);

  const schema = manifest.configSchema as ConfigSchemaGroup | undefined;
  if (!schema || Object.keys(schema).length === 0) {
    return <div className="settings-empty">该插件无可配置项</div>;
  }

  return (
    <div className="settings-pane">
      <div className="settings-pane-title">插件配置 - {manifest.name}</div>
      {Object.entries(schema).map(([key, field]) =>
        renderField(key, field, config[key], handleChange, disabled),
      )}
      <div className="settings-row">
        <button
          type="button"
          className="settings-btn"
          onClick={handleSave}
          disabled={disabled || saving}
        >
          {saving ? '保存中…' : '保存配置'}
        </button>
      </div>
    </div>
  );
}

function renderField(
  key: string,
  field: ConfigFieldSchema | ConfigSchemaGroup,
  value: unknown,
  onChange: (key: string, value: unknown) => void,
  disabled?: boolean,
) {
  // 如果是 object 类型且有子字段，递归渲染分组
  if (typeof field === 'object' && !('type' in field)) {
    const subValue =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined;
    return (
      <div key={key} className="settings-section-divider">
        <span>{key}</span>
        {Object.entries(field).map(([subKey, subField]) =>
          renderField(`${key}.${subKey}`, subField, getSubValue(subValue, subKey), onChange, disabled),
        )}
      </div>
    );
  }

  const f = field as ConfigFieldSchema;

  switch (f.type) {
    case 'string':
      if (f.enum) {
        return (
          <div key={key} className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">{f.label ?? key}</div>
              {f.description && <div className="settings-row-desc">{f.description}</div>}
            </div>
            <select
              className="settings-select"
              value={String(value ?? f.default ?? '')}
              onChange={(e) => onChange(key, e.target.value)}
              disabled={disabled}
            >
              {f.enum.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
        );
      }
      if (f.format === 'textarea') {
        return (
          <div key={key} className="settings-row">
            <div className="settings-row-main">
              <div className="settings-row-label">{f.label ?? key}</div>
              {f.description && <div className="settings-row-desc">{f.description}</div>}
            </div>
            <textarea
              className="settings-textarea"
              value={String(value ?? f.default ?? '')}
              onChange={(e) => onChange(key, e.target.value)}
              disabled={disabled}
              placeholder={f.placeholder}
            />
          </div>
        );
      }
      return (
        <div key={key} className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-label">{f.label ?? key}</div>
            {f.description && <div className="settings-row-desc">{f.description}</div>}
          </div>
          <input
            type={f.format === 'password' ? 'password' : 'text'}
            className="settings-input"
            value={String(value ?? f.default ?? '')}
            onChange={(e) => onChange(key, e.target.value)}
            disabled={disabled}
            placeholder={f.placeholder}
          />
        </div>
      );
    case 'number':
      return (
        <div key={key} className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-label">{f.label ?? key}</div>
            {f.description && <div className="settings-row-desc">{f.description}</div>}
          </div>
          <input
            type="number"
            className="settings-input"
            value={Number(value ?? f.default ?? 0)}
            min={f.min}
            max={f.max}
            step={f.step ?? 1}
            onChange={(e) => onChange(key, Number(e.target.value))}
            disabled={disabled}
          />
        </div>
      );
    case 'boolean':
      return (
        <div key={key} className="settings-row">
          <div className="settings-row-main">
            <div className="settings-row-label">{f.label ?? key}</div>
            {f.description && <div className="settings-row-desc">{f.description}</div>}
          </div>
          <label className="form-switch">
            <input
              type="checkbox"
              checked={Boolean(value ?? f.default ?? false)}
              onChange={(e) => onChange(key, e.target.checked)}
              disabled={disabled}
            />
            <span className="form-switch-track" aria-hidden="true" />
          </label>
        </div>
      );
    case 'object':
      return (
        <div key={key} className="settings-section-divider">
          <span>{f.label ?? key}</span>
        </div>
      );
    default:
      return null;
  }
}

function getSubValue(parent: unknown, subKey: string): unknown {
  return typeof parent === 'object' && parent !== null
    ? (parent as Record<string, unknown>)[subKey]
    : undefined;
}
