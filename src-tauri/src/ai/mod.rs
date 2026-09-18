//! AI 终端智能体模块：模型管理 + 流式对话。
//!
//! - `models`：AI 模型配置的增删改查，持久化到 `{base_dir}/ai-models.json`
//! - `chat`：调用 OpenAI 兼容协议的 `/chat/completions`（stream=true），
//!   逐 token 通过 Tauri 事件 `ai:token` / `ai:done` / `ai:error` 推送给前端
//! - `prompt`：system prompt 构造

pub mod chat;
pub mod models;
pub mod prompt;

pub use models::{AiModelConfig, AiModelState};

/// 创建 AI 模块状态（持有 base_dir 路径 + 并发锁）。
pub fn new_state() -> AiModelState {
    models::new_state()
}

/// 生成一个简单的唯一 ID（时间戳 + 随机后缀）。
pub fn gen_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let rand: u32 = {
        // 用 nanos 低位做简单随机，避免引入 rand 依赖
        ((nanos & 0xffff_ffff) as u32).wrapping_mul(2654435761)
    };
    format!("{:x}{:08x}", nanos, rand)
}
