//! QQ NT discovery and version metadata, separate from process ownership.
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn number(value: &Value) -> Option<u64> {
    value
        .as_u64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|n| *n > 0)
}
fn package_info(dir: &Path, version: &str) -> Option<(String, u64)> {
    // Directory names come from upstream JSON, never accept paths here.
    crate::domain::segment(version).ok()?;
    for file in [
        dir.join("versions")
            .join(version)
            .join("resources/app/package.json"),
        dir.join("resources/app/versions")
            .join(version)
            .join("package.json"),
    ] {
        if let Ok(value) = crate::storage::read_json::<Value>(&file) {
            if let Some(build) = number(&value["buildVersion"]) {
                return Some((value["version"].as_str().unwrap_or(version).into(), build));
            }
        }
    }
    None
}
pub fn read_version(dir: &Path) -> Option<(String, u64)> {
    let config =
        crate::storage::read_json::<Value>(&dir.join("versions/config.json")).unwrap_or_default();
    if let Some(version) = config["curVersion"].as_str() {
        if let Some((_, build)) = version.rsplit_once('-') {
            if let Ok(build) = build.parse::<u64>() {
                if build > 0 {
                    return Some((version.into(), build));
                }
            }
        }
        if let Some(info) = package_info(dir, version) {
            return Some(info);
        }
    }
    if let Some(build) = number(&config["buildId"]) {
        return Some((config["curVersion"].as_str().unwrap_or("").into(), build));
    }
    let mut found = Vec::new();
    for base in [dir.join("versions"), dir.join("resources/app/versions")] {
        if let Ok(entries) = std::fs::read_dir(base) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with(|c: char| c.is_ascii_digit()) && entry.path().is_dir() {
                    if let Some(info) = package_info(dir, &name) {
                        found.push(info);
                    }
                }
            }
        }
    }
    found.into_iter().max_by_key(|(_, build)| *build)
}
fn candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        for path in [
            "SOFTWARE\\WOW6432Node\\Tencent\\QQNT",
            "SOFTWARE\\Tencent\\QQNT",
        ] {
            if let Ok(key) = hklm.open_subkey(path) {
                if let Ok(value) = key.get_value::<String, _>("Install") {
                    candidates.push(PathBuf::from(value.trim_matches('"')));
                }
            }
        }
        for path in [
            "SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ",
            "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ",
        ] {
            if let Ok(key) = hklm.open_subkey(path) {
                if let Ok(value) = key.get_value::<String, _>("UninstallString") {
                    let exe = value.trim();
                    let exe = if let Some(rest) = exe.strip_prefix('"') {
                        rest.split('"').next().unwrap_or(rest)
                    } else {
                        exe
                    };
                    if let Some(parent) = Path::new(exe).parent() {
                        candidates.push(parent.to_path_buf());
                    }
                }
            }
        }
    }
    candidates.extend(
        [
            r"C:\Program Files\Tencent\QQNT",
            r"C:\Program Files (x86)\Tencent\QQNT",
            r"D:\QQ",
            r"E:\QQ",
        ]
        .map(PathBuf::from),
    );
    candidates
}
pub fn status() -> Value {
    let mut fallback = None;
    for dir in candidates() {
        let exe = dir.join("QQ.exe");
        if !exe.is_file() {
            continue;
        }
        let (version, build) = read_version(&dir).unwrap_or_default();
        let result = json!({"ok":build>=40768,"installed":true,"exe":exe,"dir":dir,"version":version,"build":build,"minBuild":40768,"reason":if build>=40768 {""} else {"QQ 版本未知或过低，需要 build ≥40768"}});
        if build >= 40768 {
            return result;
        }
        if fallback.is_none() {
            fallback = Some(result);
        }
    }
    fallback.unwrap_or_else(|| json!({"ok":false,"installed":false,"reason":"未检测到 QQ，请先安装 QQ NT","minBuild":40768}))
}
