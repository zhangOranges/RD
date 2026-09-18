//! AI 对话核心：调用 OpenAI 兼容协议的流式接口，逐 token 通过 Tauri 事件推送给前端。
//!
//! 流式协议（Rust → 前端 Tauri 事件）：
//! - `ai:token`  payload: { stream_id, delta }
//! - `ai:done`   payload: { stream_id }
//! - `ai:error`  payload: { stream_id, error }

use futures_util::StreamExt;
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, State};

use super::models::{decode_key, get_model, AiModelState};
use super::prompt::{build_request, ChatContext, ChatMessage};
use crate::ai::gen_id;
use crate::{debug_log, LogLevel};

/// 前端调用：发起一次流式对话，返回 stream_id 用于事件过滤。
#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    state: State<'_, AiModelState>,
    model_id: String,
    messages: Vec<ChatMessage>,
    context: ChatContext,
) -> Result<String, String> {
    let base_dir = state.base_dir();
    if base_dir.as_os_str().is_empty() {
        return Err("AI 存储未初始化".to_string());
    }
    let model = get_model(&base_dir, &model_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("模型不存在: {}", model_id))?;

    let stream_id = gen_id();
    // 注册活跃 stream
    state.add_stream(&stream_id);

    let app_clone = app.clone();
    let model_clone = model.clone();
    let msgs = messages;
    let ctx = context;
    let stream_id_clone = stream_id.clone();
    let active_streams = state.active_streams.clone();

    // 在后台任务中执行流式请求，主命令立即返回 stream_id
    tauri::async_runtime::spawn(async move {
        let result = stream_chat(
            &app_clone,
            &stream_id_clone,
            &model_clone,
            &msgs,
            &ctx,
            &active_streams,
        )
        .await;
        // 无论成功或失败，移除活跃标记
        active_streams.lock().unwrap().remove(&stream_id_clone);
        match result {
            Ok(true) => {
                // 正常完成
                let _ = app_clone.emit(
                    "ai:done",
                    serde_json::json!({ "streamId": stream_id_clone }),
                );
            }
            Ok(false) => {
                // 被用户取消
                let _ = app_clone.emit(
                    "ai:done",
                    serde_json::json!({ "streamId": stream_id_clone, "cancelled": true }),
                );
            }
            Err(e) => {
                let _ = app_clone.emit(
                    "ai:error",
                    serde_json::json!({ "streamId": stream_id_clone, "error": e }),
                );
            }
        }
    });

    debug_log(
        &app,
        LogLevel::Info,
        &format!(
            "ai_chat_stream 启动: stream_id={} model={}",
            stream_id, model.model
        ),
    );
    Ok(stream_id)
}

/// 前端调用：取消正在进行的流式对话。
#[tauri::command]
pub async fn ai_chat_stop(
    app: AppHandle,
    state: State<'_, AiModelState>,
    stream_id: String,
) -> Result<(), String> {
    state.remove_stream(&stream_id);
    debug_log(
        &app,
        LogLevel::Info,
        &format!("ai_chat_stop: stream_id={}", stream_id),
    );
    Ok(())
}

/// 执行一次流式对话，逐 token emit `ai:token`。
/// 返回 Ok(true) 正常完成，Ok(false) 被用户取消。
async fn stream_chat(
    app: &AppHandle,
    stream_id: &str,
    model: &super::models::AiModelConfig,
    messages: &[ChatMessage],
    ctx: &ChatContext,
    active_streams: &Arc<Mutex<HashSet<String>>>,
) -> Result<bool, String> {
    let api_key = decode_key(&model.api_key);
    if api_key.is_empty() {
        return Err("API Key 为空".to_string());
    }

    let url = format!("{}/chat/completions", model.base_url.trim_end_matches('/'));
    let body = build_request(model, messages, ctx, true);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&body).map_err(|e| format!("序列化请求失败: {}", e))?)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let status_code = status.as_u16();
        let text = resp.text().await.unwrap_or_default();
        let msg = match status_code {
            401 => "认证失败：API Key 无效或已过期".to_string(),
            429 => "请求过于频繁，已触发限流".to_string(),
            _ => format!("HTTP {}: {}", status_code, text),
        };
        return Err(msg);
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    while let Some(chunk_result) = stream.next().await {
        // 检查是否被用户取消
        if !active_streams.lock().unwrap().contains(stream_id) {
            debug_log(
                app,
                LogLevel::Info,
                &format!("ai stream 被取消: {}", stream_id),
            );
            return Ok(false);
        }

        let chunk = chunk_result.map_err(|e| format!("读取流失败: {}", e))?;
        let text = String::from_utf8_lossy(&chunk);
        buffer.push_str(&text);

        // SSE 以 \n\n 分隔事件
        while let Some(idx) = buffer.find("\n\n") {
            let event = buffer[..idx].to_string();
            buffer = buffer[idx + 2..].to_string();

            // 每个事件可能有多行，取 data: 开头的行
            for line in event.lines() {
                let line = line.trim();
                if !line.starts_with("data:") {
                    continue;
                }
                let data = line[5..].trim();
                if data == "[DONE]" {
                    return Ok(true);
                }
                if data.is_empty() {
                    continue;
                }
                // 解析 JSON，提取 content delta
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(delta) = json
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("delta"))
                        .and_then(|d| d.get("content"))
                        .and_then(|c| c.as_str())
                    {
                        if !delta.is_empty() {
                            let _ = app.emit(
                                "ai:token",
                                serde_json::json!({ "streamId": stream_id, "delta": delta }),
                            );
                        }
                    }
                }
            }
        }
    }

    Ok(true)
}

/// 测试模型连接（非流式）：发 "ping" 返回模型回复。
pub async fn test_connection(
    model: &super::models::AiModelConfig,
    app: &AppHandle,
) -> Result<String, String> {
    let api_key = decode_key(&model.api_key);
    if api_key.is_empty() {
        return Err("API Key 为空".to_string());
    }

    let url = format!("{}/chat/completions", model.base_url.trim_end_matches('/'));
    let ctx = ChatContext {
        host_name: "test".to_string(),
        os: "linux".to_string(),
        shell: "bash".to_string(),
        cwd: "~".to_string(),
    };
    let body = build_request(
        model,
        &[ChatMessage {
            role: "user".to_string(),
            content: "ping".to_string(),
        }],
        &ctx,
        false,
    );

    debug_log(
        app,
        LogLevel::Info,
        &format!("ai_test_model 开始: model={} url={}", model.model, url),
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .body(serde_json::to_string(&body).map_err(|e| format!("序列化请求失败: {}", e))?)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;

    let status = resp.status();
    if !status.is_success() {
        let status_code = status.as_u16();
        let text = resp.text().await.unwrap_or_default();
        let msg = match status_code {
            401 => "认证失败：API Key 无效或已过期".to_string(),
            429 => "请求过于频繁，已触发限流".to_string(),
            _ => format!("HTTP {}: {}", status_code, text),
        };
        debug_log(
            app,
            LogLevel::Error,
            &format!("ai_test_model 失败: {}", msg),
        );
        return Err(msg);
    }

    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("解析响应失败: {}", e))?;
    let content = json
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();

    debug_log(app, LogLevel::Info, "ai_test_model 成功");
    Ok(content)
}
