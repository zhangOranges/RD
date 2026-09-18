//! AI 模型配置的持久化与 CRUD。
//!
//! 存储文件：`{base_dir}/ai-models.json`
//! 结构：`{ "models": [AiModelConfig, ...] }`
//!
//! API Key 以 base64 编码存储（与凭据不同，不走系统密钥链，
//! 因为模型配置需要随应用一起迁移）。日志中绝不输出 apiKey 明文。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::{debug_log, LogLevel};

const AI_MODELS_FILE: &str = "ai-models.json";

/// AI 模型配置（含 apiKey 明文，仅后端持有）。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelConfig {
    pub id: String,
    pub name: String,
    pub provider: String, // "openai-compatible"
    pub base_url: String,
    #[serde(default)]
    pub api_key: String, // base64 编码
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub is_default: bool,
}

/// 前端可见的模型配置（apiKey 脱敏为 null）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelConfigSafe {
    pub id: String,
    pub name: String,
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub temperature: f32,
    pub max_tokens: u32,
    pub is_default: bool,
}

impl From<&AiModelConfig> for AiModelConfigSafe {
    fn from(c: &AiModelConfig) -> Self {
        Self {
            id: c.id.clone(),
            name: c.name.clone(),
            provider: c.provider.clone(),
            base_url: c.base_url.clone(),
            model: c.model.clone(),
            temperature: c.temperature,
            max_tokens: c.max_tokens,
            is_default: c.is_default,
        }
    }
}

/// AI 模型存储状态。
pub struct AiModelState {
    base_dir: Mutex<PathBuf>,
    /// 活跃的流式请求 stream_id 集合，用于支持取消
    pub active_streams: Arc<Mutex<HashSet<String>>>,
}

impl AiModelState {
    pub fn base_dir(&self) -> PathBuf {
        self.base_dir.lock().unwrap().clone()
    }

    /// 注册一个活跃的 stream_id
    pub fn add_stream(&self, id: &str) {
        self.active_streams.lock().unwrap().insert(id.to_string());
    }

    /// 移除一个 stream_id（正常完成或被取消时调用）
    pub fn remove_stream(&self, id: &str) {
        self.active_streams.lock().unwrap().remove(id);
    }

    /// 检查 stream_id 是否仍然活跃（未被取消）
    pub fn is_stream_active(&self, id: &str) -> bool {
        self.active_streams.lock().unwrap().contains(id)
    }
}

/// 创建 AiModelState，base_dir 由调用方（lib.rs setup）注入。
pub fn new_state() -> AiModelState {
    AiModelState {
        base_dir: Mutex::new(PathBuf::new()),
        active_streams: Arc::new(Mutex::new(HashSet::new())),
    }
}

/// 设置 base_dir（在 lib.rs setup 中调用一次）。
pub fn set_base_dir(state: &AiModelState, dir: &Path) {
    let mut guard = state.base_dir.lock().unwrap();
    *guard = dir.to_path_buf();
}

fn models_file(base_dir: &Path) -> PathBuf {
    base_dir.join(AI_MODELS_FILE)
}

#[derive(Serialize, Deserialize, Default)]
struct ModelsFile {
    models: Vec<AiModelConfig>,
}

fn read_models(base_dir: &Path) -> anyhow::Result<Vec<AiModelConfig>> {
    let path = models_file(base_dir);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let data = std::fs::read_to_string(&path)?;
    if data.trim().is_empty() {
        return Ok(Vec::new());
    }
    let file: ModelsFile = serde_json::from_str(&data)?;
    Ok(file.models)
}

fn write_models(base_dir: &Path, models: &[AiModelConfig]) -> anyhow::Result<()> {
    let path = models_file(base_dir);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = ModelsFile {
        models: models.to_vec(),
    };
    let data = serde_json::to_string_pretty(&file)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// 对 apiKey 做 base64 编码（存储用）。
fn encode_key(key: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD.encode(key.as_bytes())
}

/// 对 apiKey 做 base64 解码（调用 API 时用）。
pub fn decode_key(encoded: &str) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    STANDARD
        .decode(encoded)
        .map(|b| String::from_utf8_lossy(&b).to_string())
        .unwrap_or_default()
}

/// 脱敏：仅显示前 4 后 4 位，用于日志。
pub fn mask_key(key: &str) -> String {
    if key.len() <= 8 {
        return "****".to_string();
    }
    format!("{}...{}", &key[..4], &key[key.len() - 4..])
}

// ===== CRUD 内部函数（供 commands 调用） =====

pub fn list_all(base_dir: &Path) -> anyhow::Result<Vec<AiModelConfig>> {
    read_models(base_dir)
}

pub fn get_model(base_dir: &Path, id: &str) -> anyhow::Result<Option<AiModelConfig>> {
    let models = read_models(base_dir)?;
    Ok(models.into_iter().find(|m| m.id == id))
}

pub fn save_model(base_dir: &Path, mut config: AiModelConfig) -> anyhow::Result<()> {
    let mut models = read_models(base_dir)?;
    // 如果设为默认，取消其他模型的默认标记
    if config.is_default {
        for m in models.iter_mut() {
            m.is_default = false;
        }
    }
    // 处理 apiKey：如果前端传了空字符串，保留旧值；否则重新编码
    let config_id = config.id.clone();
    if config.api_key.is_empty() {
        if let Some(existing) = models.iter().find(|m| m.id == config_id) {
            config.api_key = existing.api_key.clone();
        }
    } else {
        // 前端传入的是明文 apiKey，编码后存储
        config.api_key = encode_key(&config.api_key);
    }

    if let Some(pos) = models.iter().position(|m| m.id == config.id) {
        models[pos] = config;
    } else {
        // 新增模型：如果没有任何默认模型，自动设为默认
        if models.is_empty() {
            config.is_default = true;
        }
        models.push(config);
    }
    write_models(base_dir, &models)
}

pub fn delete_model(base_dir: &Path, id: &str) -> anyhow::Result<()> {
    let mut models = read_models(base_dir)?;
    models.retain(|m| m.id != id);
    // 如果删除的是默认模型，把第一个设为默认
    if !models.is_empty() && !models.iter().any(|m| m.is_default) {
        models[0].is_default = true;
    }
    write_models(base_dir, &models)
}

pub fn set_default(base_dir: &Path, id: &str) -> anyhow::Result<()> {
    let mut models = read_models(base_dir)?;
    for m in models.iter_mut() {
        m.is_default = m.id == id;
    }
    write_models(base_dir, &models)
}

pub fn get_default(base_dir: &Path) -> anyhow::Result<Option<AiModelConfig>> {
    let models = read_models(base_dir)?;
    Ok(models.into_iter().find(|m| m.is_default))
}

// ===== Tauri commands =====

use tauri::{AppHandle, State};

#[tauri::command]
pub async fn ai_list_models(
    state: State<'_, AiModelState>,
    app: AppHandle,
) -> Result<Vec<AiModelConfigSafe>, String> {
    let base_dir = state.base_dir();
    if base_dir.as_os_str().is_empty() {
        return Ok(Vec::new());
    }
    list_all(&base_dir)
        .map(|models| models.iter().map(AiModelConfigSafe::from).collect())
        .map_err(|e| {
            let msg = e.to_string();
            debug_log(
                &app,
                LogLevel::Error,
                &format!("ai_list_models 失败: {}", msg),
            );
            msg
        })
}

#[tauri::command]
pub async fn ai_save_model(
    config: AiModelConfig,
    state: State<'_, AiModelState>,
    app: AppHandle,
) -> Result<(), String> {
    let base_dir = state.base_dir();
    if base_dir.as_os_str().is_empty() {
        return Err("AI 存储未初始化".to_string());
    }
    let id = config.id.clone();
    let name = config.name.clone();
    save_model(&base_dir, config).map_err(|e| {
        let msg = e.to_string();
        debug_log(
            &app,
            LogLevel::Error,
            &format!("ai_save_model 失败: id={} name={} - {}", id, name, msg),
        );
        msg
    })?;
    debug_log(
        &app,
        LogLevel::Info,
        &format!("ai_save_model 完成: id={} name={}", id, name),
    );
    Ok(())
}

#[tauri::command]
pub async fn ai_delete_model(
    id: String,
    state: State<'_, AiModelState>,
    app: AppHandle,
) -> Result<(), String> {
    let base_dir = state.base_dir();
    if base_dir.as_os_str().is_empty() {
        return Err("AI 存储未初始化".to_string());
    }
    delete_model(&base_dir, &id).map_err(|e| {
        let msg = e.to_string();
        debug_log(
            &app,
            LogLevel::Error,
            &format!("ai_delete_model 失败: id={} - {}", id, msg),
        );
        msg
    })?;
    debug_log(
        &app,
        LogLevel::Info,
        &format!("ai_delete_model 完成: id={}", id),
    );
    Ok(())
}

#[tauri::command]
pub async fn ai_set_default_model(
    id: String,
    state: State<'_, AiModelState>,
    app: AppHandle,
) -> Result<(), String> {
    let base_dir = state.base_dir();
    if base_dir.as_os_str().is_empty() {
        return Err("AI 存储未初始化".to_string());
    }
    set_default(&base_dir, &id).map_err(|e| {
        let msg = e.to_string();
        debug_log(
            &app,
            LogLevel::Error,
            &format!("ai_set_default_model 失败: id={} - {}", id, msg),
        );
        msg
    })?;
    Ok(())
}

/// 测试模型连接：发一条 "ping" 消息，返回模型回复。
#[tauri::command]
pub async fn ai_test_model(
    id: String,
    state: State<'_, AiModelState>,
    app: AppHandle,
) -> Result<String, String> {
    let base_dir = state.base_dir();
    if base_dir.as_os_str().is_empty() {
        return Err("AI 存储未初始化".to_string());
    }
    let model = get_model(&base_dir, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("模型不存在: {}", id))?;
    // 复用 chat 模块的非流式调用
    crate::ai::chat::test_connection(&model, &app).await
}
