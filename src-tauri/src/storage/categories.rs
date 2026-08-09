use std::path::{Path, PathBuf};

/// 主机分类（分组）配置。
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct CategoryConfig {
    pub id: String,
    pub name: String,
    /// 排序序号（越小越靠前）。
    pub order: i32,
}

fn categories_file(base_dir: &Path) -> PathBuf {
    base_dir.join("categories.json")
}

/// 读取全部分类。文件不存在时返回包含默认分类的集合。
pub fn list_categories(base_dir: &Path) -> anyhow::Result<Vec<CategoryConfig>> {
    let path = categories_file(base_dir);
    if !path.exists() {
        return Ok(default_categories());
    }
    let data = std::fs::read_to_string(&path)?;
    if data.trim().is_empty() {
        return Ok(default_categories());
    }
    let cats: Vec<CategoryConfig> = serde_json::from_str(&data)?;
    // 确保默认分类始终存在
    Ok(merge_defaults(cats))
}

/// 保存（新增或更新）一条分类配置。
pub fn save_category(base_dir: &Path, cat: CategoryConfig) -> anyhow::Result<()> {
    let mut cats = list_categories(base_dir)?;
    if let Some(existing) = cats.iter_mut().find(|c| c.id == cat.id) {
        *existing = cat;
    } else {
        cats.push(cat);
    }
    write_categories(base_dir, &cats)
}

/// 按 id 删除分类配置。
/// 内置默认分类不可删除（返回错误）。
pub fn delete_category(base_dir: &Path, id: &str) -> anyhow::Result<()> {
    if id == "default" {
        anyhow::bail!("默认分类不可删除");
    }
    let mut cats = list_categories(base_dir)?;
    let before = cats.len();
    cats.retain(|c| c.id != id);
    if cats.len() == before {
        return Ok(());
    }
    write_categories(base_dir, &cats)
}

fn write_categories(base_dir: &Path, cats: &[CategoryConfig]) -> anyhow::Result<()> {
    let path = categories_file(base_dir);
    let data = serde_json::to_string_pretty(cats)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

fn default_categories() -> Vec<CategoryConfig> {
    vec![CategoryConfig {
        id: "default".to_string(),
        name: "默认".to_string(),
        order: 0,
    }]
}

fn merge_defaults(mut cats: Vec<CategoryConfig>) -> Vec<CategoryConfig> {
    if !cats.iter().any(|c| c.id == "default") {
        cats.insert(
            0,
            CategoryConfig {
                id: "default".to_string(),
                name: "默认".to_string(),
                order: 0,
            },
        );
    }
    cats
}
