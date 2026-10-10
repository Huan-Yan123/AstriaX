//! Offline installer operations share Rust storage, locking and path validation.
mod legacy_registration;
pub mod paths;
pub mod snapshot;
pub mod uninstall;
use crate::{
    storage::{atomic_bytes, atomic_json, read_json, Store},
    Error, Result,
};
use serde_json::{json, Value};
use std::{fs, path::Path};

fn marker(root: &Path) -> std::path::PathBuf {
    root.join(".astriax-maintenance.json")
}
pub fn check_startup(root: &Path) -> Result<()> {
    if !marker(root).is_file() {
        return Ok(());
    }
    let lease: Value = read_json(&marker(root))?;
    if paths::owner_alive(
        lease["pid"].as_u64().unwrap_or(0) as u32,
        lease["started"].as_u64().unwrap_or(0),
    ) {
        return Err(Error::Busy(
            "安装器正在升级或卸载，请完成安装后再打开启动器".into(),
        ));
    }
    fs::remove_file(marker(root))?;
    Ok(())
}
async fn idle(install: &Path, root: &Path, owner: u32) -> Result<Option<Store>> {
    paths::validate_root(install, root)?;
    let mut system = sysinfo::System::new_all();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    for process in system.processes().values() {
        if process.pid().as_u32() != std::process::id()
            && process.pid().as_u32() != owner
            && process.exe().is_some_and(|p| paths::contains(p, install))
        {
            return Err(Error::Busy(
                "安装目录中的程序仍在运行，请退出启动器及实例后重试".into(),
            ));
        }
    }
    if !root.exists() {
        return Ok(None);
    }
    let store = Store::open(root.to_path_buf())?;
    for instance in &store.index.instances {
        if !crate::process::port_free(instance.port).await {
            return Err(Error::Busy(format!(
                "实例 {} 的端口仍被占用，不能维护数据",
                instance.name
            )));
        }
    }
    Ok(Some(store))
}
pub async fn prepare(install: &Path, root: &Path, owner: u32) -> Result<Value> {
    if marker(root).exists() {
        let lease: Value = read_json(&marker(root))?;
        if lease["pid"] != owner
            && paths::owner_alive(
                lease["pid"].as_u64().unwrap_or(0) as u32,
                lease["started"].as_u64().unwrap_or(0),
            )
        {
            return Err(Error::Busy("另一安装器正在维护此数据目录".into()));
        }
    }
    let _store = idle(install, root, owner).await?;
    let snapshot = if install.is_dir() && fs::read_dir(install)?.next().is_some() || root.is_dir() {
        snapshot::create(install, root)?
    } else {
        json!({"file":"","sha256":""})
    };
    if root.exists() {
        atomic_json(
            &marker(root),
            &json!({"pid":owner,"started":paths::start_time(owner)?}),
        )?;
    }
    Ok(json!({"root":root,"backup":snapshot["file"],"sha256":snapshot["sha256"]}))
}
pub fn commit(install: &Path, root: &Path, scope: &str) -> Result<()> {
    paths::validate_root(install, root)?;
    fs::create_dir_all(install)?;
    atomic_bytes(
        &install.join("data-root.txt"),
        root.to_string_lossy().as_bytes(),
    )?;
    paths::record_root(install, root, scope)?;
    uninstall::prune_legacy(install)?;
    if marker(root).exists() {
        fs::remove_file(marker(root))?;
    }
    Ok(())
}
pub async fn remove(
    install: &Path,
    root: &Path,
    delete_data: bool,
    scope: &str,
    owner: u32,
) -> Result<()> {
    let store = idle(install, root, owner).await?;
    if delete_data {
        uninstall::remove_data(install, root)?;
    }
    drop(store);
    if marker(root).exists() {
        fs::remove_file(marker(root))?;
    }
    if delete_data && root.exists() {
        let lock = root.join(".astriax.lock");
        if lock.is_file() {
            fs::remove_file(lock)?;
        }
        if fs::read_dir(root)?.next().is_none() {
            fs::remove_dir(root)?;
        }
    }
    paths::clear_registration(install, scope)?;
    for name in if delete_data {
        vec!["data-root.txt", "installation.json"]
    } else {
        vec!["installation.json"]
    } {
        let path = install.join(name);
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}
pub async fn command(args: &[String]) -> Result<()> {
    if args.len() != 7 {
        return Err(Error::Invalid(
            "maintenance: action install scope report owner".into(),
        ));
    }
    let (action, install, scope, report) =
        (&args[2], Path::new(&args[3]), &args[4], Path::new(&args[5]));
    crate::domain::segment(scope)?;
    let owner: u32 = args[6]
        .parse()
        .map_err(|_| Error::Invalid("安装器 PID 无效".into()))?;
    let state_file = report.with_extension("json");
    let previous: Value = read_json(&state_file).unwrap_or_default();
    let root = if action == "commit"
        || (action == "prepare"
            && previous["root"]
                .as_str()
                .is_some_and(|p| Path::new(p).exists()))
    {
        previous["root"]
            .as_str()
            .map(std::path::PathBuf::from)
            .ok_or_else(|| Error::Invalid("安装维护状态丢失".into()))?
    } else {
        paths::data_root(install, scope)?
    };
    let result = match action.as_str() {
        "prepare" => {
            if previous["preparedInstall"] == install.to_string_lossy().as_ref() {
                Ok(previous.clone())
            } else {
                prepare(install, &root, owner).await
            }
        }
        "commit" => {
            commit(install, &root, scope).map(|_| json!({"root":root,"backup":previous["backup"]}))
        }
        "check" => idle(install, &root, owner)
            .await
            .map(|_| json!({"root":root})),
        "keep" | "delete" => remove(install, &root, action == "delete", scope, owner)
            .await
            .map(|_| json!({"root":root})),
        _ => Err(Error::Unsupported("未知安装维护操作".into())),
    };
    match &result {
        Ok(value) => {
            let mut value = value.clone();
            if action == "prepare" {
                value["preparedInstall"] = json!(install);
            }
            atomic_json(&state_file, &value)?;
            paths::write_ini(
                report,
                &root,
                Path::new(value["backup"].as_str().unwrap_or("")),
                "",
            )?;
        }
        Err(error) => {
            paths::write_ini(report, &root, Path::new(""), &error.to_string())?;
        }
    }
    result.map(|_| ())
}
