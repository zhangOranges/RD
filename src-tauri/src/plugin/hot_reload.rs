//! 插件热重载文件监听。
//!
//! 使用 notify crate 监听多个目录：
//!  1. `${appDataDir}/plugins/` — 用户安装后的运行目录（用户侧插件、内置插件副本）
//!  2. `{src-tauri}/resources/plugins/` — 开发模式下内置插件源目录（开发者直接改源文件即可触发，
//!     无需手动 copy 或重启主程序）
//!
//! 文件变更后 500ms debounce，emit `plugin:hot-reload` 事件给前端。

use std::path::{Path, PathBuf};
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
/// 路径形如：
///   - `.../plugins/plugin-id@1.0.0/main.js`       (运行时安装目录：含 @version)
///   - `.../resources/plugins/plugin-id/index.html` (开发模式源目录：不带 @version)
fn extract_plugin_id(path: &Path) -> Option<String> {
    // 向上查找包含 `plugins` 的路径段
    let components: Vec<_> = path.components().collect();
    for (i, comp) in components.iter().enumerate() {
        if comp.as_os_str() == "plugins" {
            if let Some(next) = components.get(i + 1) {
                let dir_name = next.as_os_str().to_string_lossy().to_string();
                // plugin-id@1.0.0 → plugin-id（支持运行时安装路径）
                if let Some(idx) = dir_name.find('@') {
                    return Some(dir_name[..idx].to_string());
                }
                // resources/plugins/plugin-id/ → 直接返回目录名（源目录）
                return Some(dir_name);
            }
        }
    }
    None
}

/// 检查是否是需要监听的文件
fn is_watched_file(path: &Path) -> bool {
    if path.is_dir() {
        return false;
    }
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    // 监听这些文件：插件的关键入口
    if file_name == "manifest.json"
        || file_name == "main.js"
        || file_name == "ui.js"
        || file_name == "index.html"
        || file_name == "ui.css"
        || file_name == "icon.svg"
    {
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

/// 启动文件监听。可传入多个目录（如运行时目录 + 开发模式源目录），
/// 一个 watcher 实例对所有目录做递归监听。
///
/// 不存在的目录会跳过（不创建），避免生产环境下 `src-tauri/resources/plugins/` 路径没意义时
/// 创建一个空目录污染文件系统。
pub fn start_watching(app: &AppHandle, dirs: &[PathBuf]) {
    let valid_dirs: Vec<PathBuf> = dirs
        .iter()
        .filter(|d| d.exists() && d.is_dir())
        .cloned()
        .collect();
    if valid_dirs.is_empty() {
        // 至少保证原行为：若第一个（运行时）目录不存在则创建它。
        if let Some(plugins_dir) = dirs.first() {
            let _ = std::fs::create_dir_all(plugins_dir);
        }
        return;
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
            // 对每个有效目录做递归监听；同一个 watcher 可以 watch 多个目录
            for dir in &valid_dirs {
                if let Err(e) = w.watch(dir, RecursiveMode::Recursive) {
                    eprintln!(
                        "[hot_reload] 监听目录 {} 失败: {}",
                        dir.display(),
                        e
                    );
                }
            }

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
