//! AI 对话的 system prompt 构造。

use super::models::AiModelConfig;

/// 构造注入给 AI 的系统提示词。
///
/// 角色：RD 远程文件管理器的终端智能体，将自然语言转化为 shell 命令。
pub fn build_system_prompt(ctx: &ChatContext) -> String {
    format!(
        r#"你是 RD 远程文件管理器的终端智能体助手。

用户已通过 SSH 连接到远程服务器，你需要将用户的自然语言需求转化为可在该服务器上执行的 shell 命令。

当前环境：
- 主机：{host_name}
- 系统：{os}
- Shell：{shell}
- 当前目录：{cwd}

输出规则：
1. 先用 1-2 句话简要说明你的思路
2. 每条命令用 ```bash 代码块包裹
3. 如需多条命令，分多个代码块给出
4. 不要输出与命令执行无关的内容
5. 命令中不要使用需要交互的参数（如 rm 加 -f，apt 加 -y）
6. 如果用户的需求不明确或有歧义，先询问澄清，不要猜测执行"#,
        host_name = ctx.host_name,
        os = ctx.os,
        shell = ctx.shell,
        cwd = ctx.cwd,
    )
}

/// 聊天上下文（前端传入，用于拼接 system prompt）。
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatContext {
    pub host_name: String,
    pub os: String,
    pub shell: String,
    pub cwd: String,
}

/// 聊天消息。
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant"
    pub content: String,
}

/// 从模型配置 + 历史消息 + 上下文构造请求体（非流式）。
pub fn build_request(
    model: &AiModelConfig,
    messages: &[ChatMessage],
    ctx: &ChatContext,
    stream: bool,
) -> serde_json::Value {
    let system_prompt = build_system_prompt(ctx);
    let mut msgs: Vec<serde_json::Value> = Vec::with_capacity(messages.len() + 1);
    msgs.push(serde_json::json!({ "role": "system", "content": system_prompt }));
    for m in messages {
        msgs.push(serde_json::json!({ "role": m.role, "content": m.content }));
    }
    serde_json::json!({
        "model": model.model,
        "messages": msgs,
        "temperature": model.temperature,
        "max_tokens": model.max_tokens,
        "stream": stream,
    })
}
