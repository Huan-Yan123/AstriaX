//! Remove only the Electron uninstall record belonging to this installation.
use crate::Result;
use std::path::Path;

pub fn remove(install: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use winreg::{enums::*, RegKey};
        let base = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            for view in [KEY_WOW64_64KEY, KEY_WOW64_32KEY] {
                let Ok(parent) =
                    RegKey::predef(hive).open_subkey_with_flags(base, KEY_READ | KEY_WRITE | view)
                else {
                    continue;
                };
                let names = parent.enum_keys().flatten().collect::<Vec<_>>();
                for name in names {
                    // Electron builder uses a GUID; Tauri owns the product name key.
                    if !name.starts_with('{') {
                        continue;
                    }
                    let Ok(key) = parent.open_subkey(&name) else {
                        continue;
                    };
                    let display = key
                        .get_value::<String, _>("DisplayName")
                        .unwrap_or_default();
                    let location = key
                        .get_value::<String, _>("InstallLocation")
                        .unwrap_or_default();
                    if matches!(display.as_str(), "AstriaX" | "MXBot")
                        && Path::new(&location).canonicalize().ok().as_deref()
                            == Some(install.canonicalize()?.as_path())
                    {
                        drop(key);
                        parent.delete_subkey_all(&name)?;
                    }
                }
            }
        }
    }
    #[cfg(not(windows))]
    let _ = install;
    Ok(())
}
