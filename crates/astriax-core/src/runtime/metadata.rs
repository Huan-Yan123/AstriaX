//! Versions come from upstream package contents; directory tags are only bindings.
use crate::domain::Kind;
use std::{fs, io::Read, path::Path};

fn limited(path: &Path) -> Option<String> {
    let mut text = String::new();
    fs::File::open(path)
        .ok()?
        .take(16 * 1024 * 1024)
        .read_to_string(&mut text)
        .ok()?;
    Some(text)
}
pub fn version(kind: Kind, dir: &Path) -> Option<String> {
    if kind == Kind::NapCat {
        return napcat_version(&limited(&dir.join("napcat.mjs"))?);
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if (name.starts_with("astrbot-") || name.starts_with("astrbot_"))
                && name.ends_with(".dist-info")
            {
                if let Some(text) = limited(&entry.path().join("METADATA")) {
                    if let Some(v) = text.lines().find_map(|line| line.strip_prefix("Version: ")) {
                        return clean(v);
                    }
                }
            }
        }
    }
    if let Some(text) = limited(&dir.join("astrbot/__init__.py")) {
        let re = regex::Regex::new(r#"(?m)^\s*__version__\s*=\s*["']([^"']+)["']"#).ok()?;
        if let Some(c) = re.captures(&text) {
            return clean(&c[1]);
        }
    }
    None
}
pub fn clean(value: &str) -> Option<String> {
    let value = value.trim().trim_start_matches('v');
    let re = regex::Regex::new(r"^\d+\.\d+\.\d+(?:[-+.a-zA-Z0-9]+)?$").ok()?;
    re.is_match(value).then(|| value.to_string())
}
pub fn napcat_version(text: &str) -> Option<String> {
    let re = regex::Regex::new(r#"typeof\s+\w+\s*<\s*"u"\s*&&\s*"([^"]+)"\s*\|\|\s*"1\.0\.0-dev""#)
        .ok()?;
    clean(&re.captures(text)?[1])
}
