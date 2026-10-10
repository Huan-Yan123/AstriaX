use super::{paths, snapshot::DATA_ENTRIES};
use crate::{storage::reject_link, Error, Result};
use std::{fs, path::Path};

pub fn remove_data(install: &Path, root: &Path) -> Result<()> {
    paths::validate_root(install, root)?;
    if !root.exists() {
        return Ok(());
    }
    // Only remove known managed entries. An unrelated file in the chosen root is retained.
    let targets = DATA_ENTRIES
        .iter()
        .map(|n| root.join(n))
        .filter(|p| p.exists())
        .collect::<Vec<_>>();
    for path in &targets {
        for entry in walkdir::WalkDir::new(path).follow_links(false) {
            let entry = entry.map_err(|e| Error::Storage(e.to_string()))?;
            reject_link(entry.path())?;
        }
    }
    let trash = tempfile::Builder::new()
        .prefix(".uninstall-trash-")
        .tempdir_in(root)?;
    let mut moved = vec![];
    for target in targets {
        let dest = trash.path().join(target.file_name().unwrap());
        if let Err(error) = fs::rename(&target, &dest) {
            for (original, staged) in moved.into_iter().rev() {
                let _ = fs::rename(staged, original);
            }
            return Err(error.into());
        }
        moved.push((target, dest));
    }
    trash.close()?;
    Ok(())
}
pub fn prune_legacy(install: &Path) -> Result<()> {
    if !install.join("resources/app.asar").is_file() {
        return Ok(());
    }
    if !install.join("astriax-desktop.exe").is_file() {
        return Err(Error::Invalid(
            "新 Rust 桌面程序尚未写入，拒绝清理旧启动器".into(),
        ));
    }
    super::legacy_registration::remove(install)?;
    let names = [
        "AstriaX.exe",
        "MXBot.exe",
        "chrome_100_percent.pak",
        "chrome_200_percent.pak",
        "d3dcompiler_47.dll",
        "ffmpeg.dll",
        "icudtl.dat",
        "libEGL.dll",
        "libGLESv2.dll",
        "resources.pak",
        "snapshot_blob.bin",
        "v8_context_snapshot.bin",
        "vk_swiftshader.dll",
        "vk_swiftshader_icd.json",
        "vulkan-1.dll",
        "LICENSE.electron.txt",
        "LICENSES.chromium.html",
        "locales",
        "resources/app.asar",
        "resources/app.asar.unpacked",
        "resources/elevate.exe",
    ];
    for name in names {
        let path = install.join(name);
        if !path.exists() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&path).follow_links(false) {
            reject_link(entry.map_err(|e| Error::Storage(e.to_string()))?.path())?;
        }
        if path.is_dir() {
            fs::remove_dir_all(path)?;
        } else {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}
