use crate::{storage::reject_link, Error, Result};
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use tokio_util::sync::CancellationToken;

pub const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;
pub const MAX_FILES: usize = 100_000;
pub fn relative(name: &str) -> Result<PathBuf> {
    let normalized = name.replace('\\', "/");
    if normalized.starts_with('/') || normalized.split('/').any(|s| s == ".." || s.contains(':')) {
        return Err(Error::Invalid(format!("归档路径越界：{name}")));
    }
    let mut path = PathBuf::new();
    for s in normalized.split('/').filter(|s| !s.is_empty() && *s != ".") {
        // Dotfiles are allowed in archives, but device names and trailing dots remain forbidden.
        if s.starts_with('.') {
            if s == ".."
                || s.ends_with(['.', ' '])
                || s.chars()
                    .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
            {
                return Err(Error::Invalid("归档路径无效".into()));
            }
        } else {
            crate::domain::segment(s)?;
        }
        path.push(s);
    }
    if path.as_os_str().is_empty() {
        return Err(Error::Invalid("归档包含空路径".into()));
    }
    Ok(path)
}
pub fn extract_zip(file: &Path, dest: &Path, token: &CancellationToken) -> Result<()> {
    let mut zip = zip::ZipArchive::new(File::open(file)?)?;
    if zip.len() > MAX_FILES {
        return Err(Error::Invalid("归档文件数量超限".into()));
    }
    let mut names = HashSet::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        if token.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let entry = zip.by_index(i)?;
        let rel = relative(entry.name())?;
        if !names.insert(rel.to_string_lossy().to_lowercase()) {
            return Err(Error::Invalid("归档包含重复路径或大小写碰撞".into()));
        }
        if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err(Error::Invalid("归档包含符号链接".into()));
        }
        total = total
            .checked_add(entry.size())
            .ok_or_else(|| Error::Invalid("归档长度溢出".into()))?;
        if total > MAX_BYTES {
            return Err(Error::Invalid("归档解压大小超过 4 GiB".into()));
        }
    }
    fs::create_dir_all(dest)?;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let path = dest.join(relative(entry.name())?);
        if entry.is_dir() {
            fs::create_dir_all(path)?;
            continue;
        }
        fs::create_dir_all(path.parent().unwrap())?;
        let mut output = File::create(&path)?;
        let mut buffer = [0; 65536];
        let mut written = 0u64;
        loop {
            if token.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let n = entry.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            written += n as u64;
            if written > entry.size() {
                return Err(Error::Invalid("归档实际长度不符".into()));
            }
            output.write_all(&buffer[..n])?;
        }
    }
    Ok(())
}
pub fn copy_tree(from: &Path, to: &Path, token: &CancellationToken) -> Result<()> {
    for entry in walkdir::WalkDir::new(from).follow_links(false) {
        if token.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let entry = entry.map_err(|e| Error::Storage(e.to_string()))?;
        reject_link(entry.path())?;
        let dest = to.join(entry.path().strip_prefix(from).unwrap());
        if entry.file_type().is_dir() {
            fs::create_dir_all(dest)?;
        } else {
            fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}
