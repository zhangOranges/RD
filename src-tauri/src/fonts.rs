//! 系统字体获取模块
//! 扫描系统字体目录，通过 ttf-parser 从字体文件内部 name 表读取真实 family name
//! （文件名仅作为 fallback），确保 CSS font-family 能正确匹配到字体，
//! 从而 Nerd Font 等私有区字符也能正常渲染。

use std::collections::HashSet;
use std::path::Path;

/// 支持的字体文件扩展名
const FONT_EXTENSIONS: &[&str] = &["ttf", "ttc", "otf", "woff", "woff2"];

/// Windows 系统字体目录
#[cfg(target_os = "windows")]
fn get_font_directories() -> Vec<std::path::PathBuf> {
    let mut dirs = Vec::new();

    // 系统字体目录
    if let Some(windows_dir) = std::env::var_os("windir") {
        let fonts_dir = Path::new(&windows_dir).join("Fonts");
        if fonts_dir.exists() {
            dirs.push(fonts_dir);
        }
    }

    // 用户字体目录（Windows 10 1809+）
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let user_fonts = Path::new(&local_app_data)
            .join("Microsoft")
            .join("Windows")
            .join("Fonts");
        if user_fonts.exists() {
            dirs.push(user_fonts);
        }
    }

    dirs
}

/// macOS 系统字体目录
#[cfg(target_os = "macos")]
fn get_font_directories() -> Vec<std::path::PathBuf> {
    let mut dirs = vec![
        Path::new("/System/Library/Fonts").to_path_buf(),
        Path::new("/Library/Fonts").to_path_buf(),
    ];

    // 用户字体目录
    if let Some(home) = dirs::home_dir() {
        let user_fonts = home.join("Library/Fonts");
        if user_fonts.exists() {
            dirs.push(user_fonts);
        }
    }

    dirs.into_iter().filter(|p| p.exists()).collect()
}

/// Linux 系统字体目录
#[cfg(target_os = "linux")]
fn get_font_directories() -> Vec<std::path::PathBuf> {
    let mut dirs = vec![
        Path::new("/usr/share/fonts").to_path_buf(),
        Path::new("/usr/local/share/fonts").to_path_buf(),
        Path::new("/usr/share/fonts/truetype").to_path_buf(),
        Path::new("/usr/share/fonts/opentype").to_path_buf(),
    ];

    // 用户字体目录
    if let Some(home) = dirs::home_dir() {
        let user_fonts = home.join(".local/share/fonts");
        if user_fonts.exists() {
            dirs.push(user_fonts);
        }
    }

    dirs.into_iter().filter(|p| p.exists()).collect()
}

/// 常见字体样式后缀（文件名 fallback 时从字体文件名中移除）
const FONT_STYLE_SUFFIXES: &[&str] = &[
    "-Regular",
    "-Bold",
    "-Italic",
    "-BoldItalic",
    "-Light",
    "-Medium",
    "-Semibold",
    "-Black",
    "-Thin",
    "-ExtraLight",
    "-ExtraBold",
    " Regular",
    " Bold",
    " Italic",
    " BoldItalic",
    " Light",
    " Medium",
    " Semibold",
    " Black",
    " Thin",
    " ExtraLight",
    " ExtraBold",
    "Windows",
    "Windows Compatible",
    "-Win",
    "-GDI",
];

/// 从字体文件名提取字体名称（仅作为 ttf-parser 失败时的 fallback）
fn extract_font_name_from_filename(filename: &str) -> Option<String> {
    let path = Path::new(filename);
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();

    if !FONT_EXTENSIONS.contains(&ext.as_str()) {
        return None;
    }

    // 获取文件名（不含扩展名）
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();

    if stem.is_empty() {
        return None;
    }

    // 清理字体名称：下划线改为空格，连字符保留
    let mut cleaned = stem.replace('_', " ");

    // 移除常见样式后缀（不区分大小写）——注意这里不再移除 "Nerd"/"Nerd Font"，
    // 因为那不是样式后缀，而是字体家族本身的一部分
    let mut changed = true;
    while changed {
        changed = false;
        for suffix in FONT_STYLE_SUFFIXES {
            let lower = cleaned.to_lowercase();
            let suffix_lower = suffix.to_lowercase();
            if lower.ends_with(&suffix_lower) {
                cleaned = cleaned[..cleaned.len() - suffix.len()].to_string();
                cleaned = cleaned.trim_end().to_string();
                changed = true;
                break;
            }
        }
    }

    // 处理连字符：将连字符替换为空格，但保留 CamelCase 边界
    let mut result = String::new();
    let chars: Vec<char> = cleaned.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        if c == '-' {
            result.push(' ');
        } else if i > 0 && c.is_uppercase() && chars[i - 1].is_lowercase() {
            // CamelCase 边界：小写后接大写，加空格
            result.push(' ');
            result.push(c);
        } else {
            result.push(c);
        }
    }

    let result = result.trim().to_string();
    if result.is_empty() {
        return None;
    }

    Some(result)
}

/// 从字体文件内部的 name 表读取真实的 Typographic Family Name（nameID = 16）
/// 若不存在则回退到 Font Family Name（nameID = 1）。
/// TTC/OTC 字体会尝试读取每个 face，返回去重后的全部 family 名称。
fn read_family_names_from_font(data: &[u8]) -> Vec<String> {
    let mut names = Vec::<String>::new();
    let mut seen = HashSet::<String>::new();

    // 判断是否为 TTC（TrueType Collection），文件头是 "ttcf"
    let is_collection = data.len() >= 4 && &data[..4] == b"ttcf";

    /// name_id 常量（来自 OpenType spec name 表）
    const NAME_ID_FAMILY: u16 = 1; // Font Family Name
    const NAME_ID_TYPOGRAPHIC_FAMILY: u16 = 16; // Typographic Family Name (WWS 级别)

    fn parse_face(
        face_data: &[u8],
        face_index: u32,
        names: &mut Vec<String>,
        seen: &mut HashSet<String>,
    ) {
        if let Ok(face) = ttf_parser::Face::parse(face_data, face_index) {
            // 优先使用 Typographic Family Name (nameID=16)，
            // 它是 WWS/家族级别的正确名称（例如 "JetBrainsMono Nerd Font"）；
            // 没有则回退到 Family Name (nameID=1)。
            for &nid in &[NAME_ID_TYPOGRAPHIC_FAMILY, NAME_ID_FAMILY] {
                // 收集所有 name_id = nid 的记录，用于分级挑选
                let records: Vec<_> = face
                    .names()
                    .into_iter()
                    .filter(|r| r.name_id == nid)
                    .collect();

                // 把 ttf_parser::PlatformId 枚举转成平台编号常量（参考 OpenType spec）
                // platform_id: Unicode=0, Macintosh=1, ISO=2, Windows=3, Custom=4
                fn platform_num(pid: ttf_parser::PlatformId) -> u16 {
                    match pid {
                        ttf_parser::PlatformId::Unicode => 0,
                        ttf_parser::PlatformId::Macintosh => 1,
                        ttf_parser::PlatformId::Iso => 2,
                        ttf_parser::PlatformId::Windows => 3,
                        ttf_parser::PlatformId::Custom => 4,
                    }
                }

                // 判断 Windows/Mac 平台下 language_id 是否为英语（避免中文名在 CSS 匹配失败）。
                // Unicode 平台（platform 0）默认视为通用/英语（其 language_id 通常是 0xFFFF 或 0）。
                fn is_english_language(pid_num: u16, language_id: u16) -> bool {
                    match pid_num {
                        0 => true, // Unicode 平台：不区分语言
                        3 => {
                            // Windows：主语言 ID = language_id & 0x3FF；LANG_ENGLISH = 9
                            (language_id & 0x3FF) == 9
                        }
                        1 => {
                            // Macintosh：langEnglish = 0
                            language_id == 0
                        }
                        _ => false,
                    }
                }

                // 1. 优先：Unicode 平台 + 英语
                if let Some(s) = records.iter().find_map(|r| {
                    let pid_num = platform_num(r.platform_id);
                    // Unicode (platform 0) 或 Windows Unicode BMP (platform 3, encoding 1)
                    let is_unicode = (pid_num == 0) || (pid_num == 3 && r.encoding_id == 1);
                    let is_en = is_english_language(pid_num, r.language_id);
                    if is_unicode && is_en {
                        let s = r.to_string()?.trim().to_string();
                        if s.is_empty() {
                            None
                        } else {
                            Some(s)
                        }
                    } else {
                        None
                    }
                }) {
                    if seen.insert(s.clone()) {
                        names.push(s);
                    }
                    return;
                }

                // 2. 次优先：Unicode 平台（任意语言）
                if let Some(s) = records.iter().find_map(|r| {
                    let pid_num = platform_num(r.platform_id);
                    let is_unicode = (pid_num == 0) || (pid_num == 3 && r.encoding_id == 1);
                    if is_unicode {
                        let s = r.to_string()?.trim().to_string();
                        if s.is_empty() {
                            None
                        } else {
                            Some(s)
                        }
                    } else {
                        None
                    }
                }) {
                    if seen.insert(s.clone()) {
                        names.push(s);
                    }
                    return;
                }

                // 3. 兜底：任何能转字符串的记录
                if let Some(s) = records.iter().find_map(|r| {
                    let s = r.to_string()?.trim().to_string();
                    if s.is_empty() {
                        None
                    } else {
                        Some(s)
                    }
                }) {
                    if seen.insert(s.clone()) {
                        names.push(s);
                    }
                    return;
                }
            }
        }
    }

    if is_collection {
        // TTC：尝试索引 0..32 直到失败（ttf-parser 未提供 face 数 API）
        for i in 0..32u32 {
            if ttf_parser::Face::parse(data, i).is_err() {
                break;
            }
            parse_face(data, i, &mut names, &mut seen);
        }
    } else {
        parse_face(data, 0, &mut names, &mut seen);
    }

    names
}

/// 扫描指定目录下的字体文件，返回真实的 family name 列表
fn scan_font_dir(dir: &Path) -> Vec<String> {
    let mut fonts = Vec::new();
    let mut seen = HashSet::new();

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();

            if path.is_dir() {
                // 递归扫描子目录
                let sub_fonts = scan_font_dir(&path);
                for font in sub_fonts {
                    if seen.insert(font.clone()) {
                        fonts.push(font);
                    }
                }
            } else if path.is_file() {
                // 先检查扩展名
                let ext_matches = path
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| FONT_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
                    .unwrap_or(false);
                if !ext_matches {
                    continue;
                }

                // 1. 优先：从字体文件内部读取真实 family name
                if let Ok(bytes) = std::fs::read(&path) {
                    let parsed_names = read_family_names_from_font(&bytes);
                    if !parsed_names.is_empty() {
                        for name in parsed_names {
                            if seen.insert(name.clone()) {
                                fonts.push(name);
                            }
                        }
                        continue;
                    }
                }

                // 2. fallback：基于文件名猜测（兼容损坏/未知格式的字体）
                if let Some(file_name) = path.file_name().and_then(|f| f.to_str()) {
                    if let Some(name) = extract_font_name_from_filename(file_name) {
                        if seen.insert(name.clone()) {
                            fonts.push(name);
                        }
                    }
                }
            }
        }
    }

    fonts
}

/// 内部实现：获取系统所有已安装的字体名称列表
fn get_system_fonts_impl() -> Result<Vec<String>, String> {
    let dirs = get_font_directories();
    let mut all_fonts = Vec::new();
    let mut seen = HashSet::new();

    for dir in &dirs {
        let fonts = scan_font_dir(dir);
        for font in fonts {
            if seen.insert(font.clone()) {
                all_fonts.push(font);
            }
        }
    }

    // 按字母顺序排序
    all_fonts.sort();

    Ok(all_fonts)
}

/// 获取系统所有已安装的字体名称列表
#[tauri::command]
pub async fn get_system_fonts() -> Result<Vec<String>, String> {
    get_system_fonts_impl()
}

/// 检查指定字体是否在系统中存在
#[tauri::command]
pub async fn check_font_available(font_family: String) -> Result<bool, String> {
    let system_fonts = get_system_fonts_impl()?;

    // 提取第一个字体（去掉引号和空格）
    let primary = font_family
        .split(',')
        .next()
        .map(|s| s.trim().trim_matches('"').trim_matches('\'').to_string())
        .unwrap_or_default();

    if primary.is_empty() {
        return Ok(false);
    }

    // 检查字体名是否在系统字体列表中（不区分大小写）
    let primary_lower = primary.to_lowercase();
    Ok(system_fonts
        .iter()
        .any(|f| f.to_lowercase() == primary_lower))
}
