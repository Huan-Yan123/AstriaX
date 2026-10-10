use crate::{
    storage::{atomic_json, reject_link},
    Error, Result,
};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    io::Write,
    path::Path,
};
use zip::{write::SimpleFileOptions, ZipWriter};

pub const DATA_ENTRIES: &[&str] = &[
    "config.json",
    "instances.json",
    "runtimes.json",
    "mirrors.json",
    "python-sources.json",
    "update-download.json",
    "rust-version-cache.json",
    ".transactions",
    "instances",
    "runtime",
    "runtimes",
    "logs",
    "cache",
    "tmp",
    "backups",
];
fn append(
    zip: &mut ZipWriter<File>,
    base: &Path,
    prefix: &str,
    exclude: impl Fn(&Path) -> bool,
) -> Result<()> {
    if !base.is_dir() {
        return Ok(());
    }
    for entry in walkdir::WalkDir::new(base)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| !exclude(e.path()))
    {
        let entry = entry.map_err(|e| Error::Storage(e.to_string()))?;
        reject_link(entry.path())?;
        if !entry.file_type().is_file() {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(base)
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let name = format!("{prefix}/{}", relative.to_string_lossy().replace('\\', "/"));
        zip.start_file(
            name,
            SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated),
        )?;
        std::io::copy(&mut File::open(entry.path())?, zip)?;
    }
    Ok(())
}
pub fn create(install: &Path, root: &Path) -> Result<Value> {
    let folder = install
        .parent()
        .ok_or_else(|| Error::Invalid("安装路径缺少父目录".into()))?
        .join("AstriaX-update-backups")
        .join(format!(
            "{}-{}",
            chrono::Utc::now().format("%Y%m%d-%H%M%S"),
            uuid::Uuid::new_v4()
        ));
    if super::paths::contains(&folder, root) || super::paths::contains(&folder, install) {
        return Err(Error::Invalid(
            "升级备份目录不能位于应用数据或安装目录中".into(),
        ));
    }
    fs::create_dir_all(&folder)?;
    let file = folder.join("upgrade.zip");
    let part = folder.join("upgrade.part");
    let result = (|| {
        let mut zip = ZipWriter::new(File::create(&part)?);
        let skip_app = |path: &Path| {
            super::paths::contains(path, root)
                || path
                    .strip_prefix(install)
                    .ok()
                    .and_then(|p| p.components().next())
                    .is_some_and(|p| {
                        matches!(p.as_os_str().to_str(), Some("data" | "update-backups"))
                    })
        };
        append(&mut zip, install, "app", skip_app)?;
        // Runtime packages are preserved in place; snapshot user state and configuration.
        let skip_data = |path: &Path| {
            path.strip_prefix(root)
                .ok()
                .and_then(|p| p.components().next())
                .is_some_and(|p| {
                    matches!(
                        p.as_os_str().to_str(),
                        Some(
                            "runtime"
                                | "runtimes"
                                | "backups"
                                | "cache"
                                | "tmp"
                                | "logs"
                                | ".astriax.lock"
                                | ".astriax-maintenance.json"
                                | ".transactions"
                                | "rust-version-cache.json"
                        )
                    )
                })
        };
        append(&mut zip, root, "data", skip_data)?;
        let manifest = json!({"format":"astriax-upgrade-1","version":env!("CARGO_PKG_VERSION"),"installDir":install,"dataRoot":root,"runtimePackagesIncluded":false});
        zip.start_file("manifest.json", SimpleFileOptions::default())?;
        zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;
        zip.finish()?.sync_all()?;
        fs::rename(&part, &file)?;
        let hash = crate::updater::hash_file(&file)?;
        atomic_json(
            &folder.join("manifest.json"),
            &json!({"file":file,"sha256":hash,"dataRoot":root}),
        )?;
        Ok(json!({"file":file,"sha256":hash}))
    })();
    if result.is_err() {
        let _ = fs::remove_file(part);
    }
    result
}
