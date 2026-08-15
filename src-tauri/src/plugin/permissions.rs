pub const ALL_PERMISSIONS: &[&str] = &[
    "network.http",
    "storage.read",
    "storage.write",
    "file.local.read",
    "file.local.write",
    "server.read",
    "server.write",
    "server.manage",
    "ssh.run",
    "sftp.operate",
    "ui.notification",
    "ui.dialog",
    "ui.inject-menu",
    "theme.read",
    "tunnel.manage",
    "log.read",
    "updater.manage",
];

/// 高危权限（4 项）：在远程主机或本机执行任意操作的能力。
pub const HIGH_RISK_PERMISSIONS: &[&str] =
    &["ssh.run", "server.write", "sftp.operate", "tunnel.manage"];

/// 中风险权限：可访问网络/文件系统/管理配置。
pub const MEDIUM_RISK_PERMISSIONS: &[&str] = &[
    "network.http",
    "file.local.write",
    "server.manage",
    "updater.manage",
];

pub fn is_valid_permission(p: &str) -> bool {
    ALL_PERMISSIONS.contains(&p)
}

/// 返回权限的风险等级："high" / "medium" / "low"。
pub fn risk_level(perm: &str) -> &'static str {
    if HIGH_RISK_PERMISSIONS.contains(&perm) {
        "high"
    } else if MEDIUM_RISK_PERMISSIONS.contains(&perm) {
        "medium"
    } else {
        "low"
    }
}

/// 内核层权限校验：检查 perm 是否合法且在 granted 列表中。
/// 失败返回 `Err("PERMISSION_DENIED: ...")`。
pub fn assert_perm(granted: &[String], perm: &str) -> Result<(), String> {
    if !is_valid_permission(perm) {
        return Err(format!("PERMISSION_DENIED: invalid permission {}", perm));
    }
    if !granted.iter().any(|g| g == perm) {
        return Err(format!("PERMISSION_DENIED: {} not granted", perm));
    }
    Ok(())
}

/// 返回权限的中文说明。
pub fn permission_description(perm: &str) -> &'static str {
    match perm {
        "network.http" => "发起 HTTP/HTTPS 网络请求",
        "storage.read" => "读取插件持久化存储",
        "storage.write" => "写入插件持久化存储",
        "file.local.read" => "读取本地文件",
        "file.local.write" => "写入本地文件",
        "server.read" => "读取主机配置和连接状态",
        "server.write" => "修改主机配置（增删改）",
        "server.manage" => "管理主机分类和全局开关",
        "ssh.run" => "在远程主机上执行 SSH 命令",
        "sftp.operate" => "操作远程文件（上传/下载/删除/重命名）",
        "ui.notification" => "显示通知提示",
        "ui.dialog" => "弹出确认/输入对话框",
        "ui.inject-menu" => "注入工具栏/侧边栏菜单项",
        "theme.read" => "读取当前主题信息",
        "tunnel.manage" => "管理端口转发规则（含远程转发）",
        "log.read" => "读取内核日志",
        "updater.manage" => "管理应用更新",
        _ => "未知权限",
    }
}

/// 旧版权限校验入口（已废弃，请改用 `assert_perm`）。
/// 仅校验 perm 字符串是否合法，不检查是否已授予。
#[deprecated(note = "使用 assert_perm 进行完整权限校验")]
#[allow(dead_code)]
pub fn check(_plugin_id: &str, perm: &str) -> Result<(), String> {
    if is_valid_permission(perm) {
        Ok(())
    } else {
        Err(format!("PERMISSION_DENIED: invalid permission {}", perm))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_all_permissions_count() {
        // 原始 15 项 + log.read + updater.manage = 17 项，与前端 PluginPermission 类型对齐
        assert_eq!(ALL_PERMISSIONS.len(), 17, "ALL_PERMISSIONS 应为 17 项");
    }

    #[test]
    fn test_includes_log_read_and_updater_manage() {
        assert!(ALL_PERMISSIONS.contains(&"log.read"));
        assert!(ALL_PERMISSIONS.contains(&"updater.manage"));
    }

    #[test]
    fn test_high_risk_permissions() {
        assert_eq!(HIGH_RISK_PERMISSIONS.len(), 4);
        for p in HIGH_RISK_PERMISSIONS {
            assert!(ALL_PERMISSIONS.contains(p));
        }
    }

    #[test]
    fn test_risk_level() {
        assert_eq!(risk_level("ssh.run"), "high");
        assert_eq!(risk_level("server.write"), "high");
        assert_eq!(risk_level("sftp.operate"), "high");
        assert_eq!(risk_level("tunnel.manage"), "high");
        assert_eq!(risk_level("network.http"), "medium");
        assert_eq!(risk_level("file.local.write"), "medium");
        assert_eq!(risk_level("server.manage"), "medium");
        assert_eq!(risk_level("updater.manage"), "medium");
        assert_eq!(risk_level("storage.read"), "low");
        assert_eq!(risk_level("theme.read"), "low");
    }

    #[test]
    fn test_assert_perm_ok() {
        let granted = vec!["storage.read".to_string(), "ssh.run".to_string()];
        assert!(assert_perm(&granted, "storage.read").is_ok());
        assert!(assert_perm(&granted, "ssh.run").is_ok());
    }

    #[test]
    fn test_assert_perm_invalid() {
        let granted = vec!["storage.read".to_string()];
        let r = assert_perm(&granted, "system.root");
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("invalid permission"));
    }

    #[test]
    fn test_assert_perm_not_granted() {
        let granted = vec!["storage.read".to_string()];
        let r = assert_perm(&granted, "ssh.run");
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("not granted"));
    }

    #[test]
    fn test_permission_description() {
        assert_eq!(
            permission_description("ssh.run"),
            "在远程主机上执行 SSH 命令"
        );
        assert_eq!(permission_description("unknown.perm"), "未知权限");
    }
}
