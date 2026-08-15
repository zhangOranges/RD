//! 插件热重载文件监听。
//!
//! 使用 notify crate 监听 `${appDataDir}/plugins/` 目录树，
//! 文件变更后 500ms debounce，emit `plugin:hot-reload` 事件给前端。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{EventKind, RecursiveMode, Watcher};
use tauri::async_runtime::spawn;
use tauri::{AppHandle, Emitter};

/// 全局 watcher 保持引用，防止 drop 后停止监听
static WATCHER_HANDLE: Mutex<Option<notify::RecommendedWatcher>> = Mutex::new(None);

/// 上次变更时间戳，用于 debounce
static LAST_CHANGE: Mutex<Option<Instant>> = Mutex::new(None);

/// debounce 间隔
const DEBOUNCE_MS: u64 = 500;

/// 从变更路径中提取插件 ID
/// 路径形如 `.../plugins/plugin-id@1.0.0/main.js`
fn extract_plugin_id(path: &std::path::Path) -> Option<String> {
    // 向上查找包含 `plugins` 的路径段
    let components: Vec<_> = path.components().collect();
    for (i, comp) in components.iter().enumerate() {
        if comp.as_os_str() == "plugins" {
            if let Some(next) = components.get(i + 1) {
                let dir_name = next.as_os_str().to_string_lossy().to_string();
                // plugin-id@1.0.0 → plugin-id
                if let Some(idx) = dir_name.find('@') {
                    return Some(dir_name[..idx].to_string());
                }
                return Some(dir_name);
            }
        }
    }
    None
}

/// 检查是否是需要监听的文件
fn is_watched_file(path: &std::path::Path) -> bool {
    if path.is_dir() {
        return false;
    }
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    // 监听这些文件
    if file_name == "manifest.json" || file_name == "main.js" || file_name == "index.html" {
        return true;
    }
    // assets 目录下的文件
    if path.to_string_lossy().contains("assets/") {
        return true;
    }
    // config.schema.json
    if file_name == "config.schema.json" {
        return true;
    }
    false
}

/// 启动文件监听
pub fn start_watching(app: &AppHandle, plugins_dir: PathBuf) {
    if !plugins_dir.exists() {
        let _ = std::fs::create_dir_all(&plugins_dir);
    }

    let app_handle = app.clone();

    let watcher = notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        if let Ok(event) = res {
            // 只处理文件变更
            let should_trigger = match event.kind {
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                    event.paths.iter().any(|p| is_watched_file(p))
                }
                _ => false,
            };

            if !should_trigger {
                return;
            }

            // 提取插件 ID
            let Some(pid) = event.paths.iter().find_map(|p| extract_plugin_id(p)) else {
                return;
            };

            // debounce：检查上次变更时间
            let now = Instant::now();
            let should_fire = {
                let mut last = LAST_CHANGE.lock().unwrap_or_else(|e| e.into_inner());
                if let Some(t) = *last {
                    if now.duration_since(t) < Duration::from_millis(DEBOUNCE_MS) {
                        *last = Some(now);
                        false
                    } else {
                        *last = Some(now);
                        true
                    }
                } else {
                    *last = Some(now);
                    true
                }
            };

            if !should_fire {
                return;
            }

            // debounce 延迟：500ms 后 emit（让连续写入合并）
            let app_clone = app_handle.clone();
            spawn(async move {
                tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
                let _ = app_clone.emit("plugin:hot-reload", &pid);
            });
        }
    });

    match watcher {
        Ok(mut w) => {
            let _ = w.watch(&plugins_dir, RecursiveMode::Recursive);

            // 替换旧 watcher
            let mut guard = WATCHER_HANDLE.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some(w);
        }
        Err(e) => {
            eprintln!("[hot_reload] 启动文件监听失败: {}", e);
        }
    }
}

/// 停止文件监听
pub fn stop_watching() {
    let mut guard = WATCHER_HANDLE.lock().unwrap_or_else(|e| e.into_inner());
    *guard = None;
}
