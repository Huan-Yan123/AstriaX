use crate::{
    storage::{atomic_bytes, atomic_json, read_json, reject_link},
    Error, Result,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
pub const SCOPE: &str = "fun.huanyan.astriax";
pub fn contains(path: &Path, base: &Path) -> bool {
    #[cfg(windows)]
    {
        let normalize = |p: &Path| {
            p.to_string_lossy()
                .replace('\\', "/")
                .replace("//?/UNC/", "//")
                .trim_start_matches("//?/")
                .trim_end_matches('/')
                .to_lowercase()
        };
        let (path, base) = (normalize(path), normalize(base));
        path == base || path.starts_with(&(base + "/"))
    }
    #[cfg(not(windows))]
    path.starts_with(base)
}

pub fn data_root(install: &Path, scope: &str) -> Result<PathBuf> {
    if install.join("data-root.txt").is_file() {
        let raw = fs::read_to_string(install.join("data-root.txt"))?;
        let path = PathBuf::from(raw.trim_start_matches('\u{feff}').trim());
        if !path.is_absolute() {
            return Err(Error::Invalid("数据目录指针必须是绝对路径".into()));
        }
        return Ok(path);
    }
    if let Some(path) = registered_root(install, scope) {
        return Ok(path);
    }
    Ok(install.join("data"))
}
pub fn validate_root(install: &Path, root: &Path) -> Result<()> {
    for path in [install, root] {
        if !path.is_absolute()
            || path
                .components()
                .any(|p| matches!(p, std::path::Component::ParentDir))
        {
            return Err(Error::Invalid(
                "安装和数据路径必须是绝对路径且不含 ..".into(),
            ));
        }
        for ancestor in path.ancestors().filter(|p| p.exists()) {
            reject_link(ancestor)?;
        }
    }
    if !root.is_absolute()
        || root.parent().is_none()
        || root == install
        || contains(install, root)
        || root.join(".git").exists()
        || root.join("Windows").is_dir()
        || root.join("Program Files").is_dir()
        || dirs::home_dir().as_deref() == Some(root)
    {
        return Err(Error::Invalid(
            "数据路径过于宽泛，拒绝对该目录执行安装维护".into(),
        ));
    }
    if root.exists() {
        reject_link(root)?;
    }
    Ok(())
}
pub fn write_ini(report: &Path, root: &Path, backup: &Path, error: &str) -> Result<()> {
    let clean = |s: String| s.replace(['\r', '\n', '\0'], " ");
    let raw = format!(
        "[maintenance]\r\nroot={}\r\nbackup={}\r\nerror={}\r\n",
        clean(root.display().to_string()),
        clean(backup.display().to_string()),
        clean(error.into())
    );
    let bytes: Vec<u8> = std::iter::once(0xfeffu16)
        .chain(raw.encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect();
    atomic_bytes(report, &bytes)
}
pub fn record_root(install: &Path, root: &Path, scope: &str) -> Result<()> {
    atomic_json(
        &install.join("installation.json"),
        &json!({"runtime":"tauri","scope":scope,"dataRoot":root,"installDir":install}),
    )?;
    #[cfg(windows)]
    {
        let (key, _) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .create_subkey(format!("Software\\AstriaX\\{scope}"))?;
        key.set_value("InstallDir", &install.to_string_lossy().as_ref())?;
        key.set_value("DataRoot", &root.to_string_lossy().as_ref())?;
    }
    Ok(())
}
pub fn sync_root(install: &Path, root: &Path) -> Result<()> {
    if install.join("installation.json").is_file() {
        let info: Value = read_json(&install.join("installation.json"))?;
        record_root(install, root, info["scope"].as_str().unwrap_or(SCOPE))?;
    }
    Ok(())
}
fn registered_root(install: &Path, scope: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        if let Ok(key) = hkcu.open_subkey(format!("Software\\AstriaX\\{scope}")) {
            let location: String = key.get_value("InstallDir").ok()?;
            if Path::new(&location) == install {
                return key
                    .get_value::<String, _>("DataRoot")
                    .ok()
                    .map(PathBuf::from);
            }
        }
        if install.join("resources/app.asar").is_file() {
            return hkcu
                .open_subkey("Software\\MXBot")
                .ok()?
                .get_value::<String, _>("DataRoot")
                .ok()
                .map(PathBuf::from);
        }
    }
    #[cfg(not(windows))]
    let _ = (install, scope);
    None
}
pub fn clear_registration(install: &Path, scope: &str) -> Result<()> {
    #[cfg(windows)]
    {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let key = format!("Software\\AstriaX\\{scope}");
        if hkcu
            .open_subkey(&key)
            .ok()
            .and_then(|k| k.get_value::<String, _>("InstallDir").ok())
            .is_some_and(|p| Path::new(&p) == install)
        {
            hkcu.delete_subkey_all(key)?;
        }
    }
    #[cfg(not(windows))]
    let _ = (install, scope);
    Ok(())
}
pub fn owner_alive(owner: u32, started: u64) -> bool {
    let mut system = sysinfo::System::new();
    system.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(owner)]),
        true,
    );
    system
        .process(sysinfo::Pid::from_u32(owner))
        .is_some_and(|p| p.start_time() == started)
}
pub fn start_time(owner: u32) -> Result<u64> {
    let mut system = sysinfo::System::new();
    system.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[sysinfo::Pid::from_u32(owner)]),
        true,
    );
    system
        .process(sysinfo::Pid::from_u32(owner))
        .map(|p| p.start_time())
        .ok_or_else(|| Error::Invalid("安装器进程不存在".into()))
}
