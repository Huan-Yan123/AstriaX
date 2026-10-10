use crate::{
    storage::{atomic_bytes, atomic_json, read_json, Store},
    Error, Launcher, Result,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub async fn move_root(app: &Launcher, target: &str) -> Result<Value> {
    let _gate = app
        .root_gate
        .try_write()
        .map_err(|_| Error::Busy("数据目录仍有操作正在执行，请稍后重试迁移".into()))?;
    let task = app
        .tasks
        .begin("migration".into(), "migration", "data", app.emit.clone())?;
    let result = migrate(app, PathBuf::from(target), &task).await;
    task.finish(&result);
    result
}
async fn migrate(app: &Launcher, target: PathBuf, task: &crate::tasks::Task) -> Result<Value> {
    if !target.is_absolute() || target.parent().is_none() {
        return Err(Error::Invalid("请选择绝对路径的数据子目录".into()));
    }
    let source = app.root().await;
    let src = fs::canonicalize(&source)?;
    fs::create_dir_all(&target)?;
    crate::storage::reject_link(&target)?;
    let dest = fs::canonicalize(&target)?;
    if src == dest {
        return Ok(json!({"ok":true,"dataRoot":source}));
    }
    if src.starts_with(&dest) || dest.starts_with(&src) {
        return Err(Error::Invalid("新旧数据目录不能互相包含".into()));
    }
    // Failed/cancelled staging leaves only the reusable root lock.
    if fs::read_dir(&target)?.any(|e| e.map(|e| e.file_name() != ".astriax.lock").unwrap_or(true)) {
        return Err(Error::Invalid(
            "目标数据目录必须为空，避免覆盖已有文件".into(),
        ));
    }
    let records = app.store.lock().await.index.instances.clone();
    for r in &records {
        if app.processes.active(&r.id).await || !crate::process::port_free(r.port).await {
            return Err(Error::Busy(format!("请先停止 {}", r.name)));
        }
    }
    // Hold the destination lock before copying so a second launcher cannot use partial data.
    let mut next = Store::open(target.clone())?;
    let stage = tempfile::Builder::new()
        .prefix(".migration-")
        .tempdir_in(&target)?;
    let payload = stage.path().join("payload");
    let (from, to, token) = (source.clone(), payload.clone(), task.token.clone());
    task.progress("unpack", "复制并校验数据目录", 0, None);
    tokio::task::spawn_blocking(move || copy(&from, &to, &token))
        .await
        .map_err(|e| Error::Storage(e.to_string()))??;
    next.config = if payload.join("config.json").exists() {
        read_json(&payload.join("config.json"))?
    } else {
        json!({})
    };
    if payload.join("instances.json").exists() {
        next.index = read_json(&payload.join("instances.json"))?;
    }
    for r in &mut next.index.instances {
        let canonical = fs::canonicalize(&r.dir)?;
        let rel = canonical
            .strip_prefix(&src)
            .map_err(|_| Error::Invalid("实例路径不属于旧数据根".into()))?;
        r.dir = target.join(rel).to_string_lossy().into_owned();
    }
    // Legacy runtime manifests also contain absolute paths.
    if payload.join("runtimes.json").exists() {
        let mut manifest: Value = read_json(&payload.join("runtimes.json"))?;
        if let Some(items) = manifest["versions"].as_array_mut() {
            for item in items {
                if let Some(dir) = item["dir"].as_str() {
                    let canonical = fs::canonicalize(dir)?;
                    let rel = canonical
                        .strip_prefix(&src)
                        .map_err(|_| Error::Invalid("运行时路径不属于旧数据根".into()))?;
                    item["dir"] = json!(target.join(rel));
                }
            }
        }
        atomic_json(&payload.join("runtimes.json"), &manifest)?;
    }
    next.config["dataRoot"] = json!(target);
    atomic_json(&payload.join("config.json"), &next.config)?;
    atomic_json(&payload.join("instances.json"), &next.index)?;
    let pairs = fs::read_dir(&payload)?
        .map(|entry| {
            let entry = entry?;
            Ok((entry.path(), target.join(entry.file_name())))
        })
        .collect::<std::io::Result<Vec<_>>>()?;
    task.check()?;
    crate::transaction::replace(&target, pairs)?;
    atomic_bytes(
        &app.install_dir.join("data-root.txt"),
        target.to_string_lossy().as_bytes(),
    )?;
    *app.store.lock().await = next;
    Ok(json!({"ok":true,"dataRoot":target,"oldDataRoot":source,"oldDataRetained":true}))
}
fn copy(from: &Path, to: &Path, token: &tokio_util::sync::CancellationToken) -> Result<()> {
    for entry in walkdir::WalkDir::new(from)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            !matches!(
                e.file_name().to_str(),
                Some(".astriax.lock" | ".transactions")
            )
        })
    {
        if token.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let entry = entry.map_err(|e| Error::Storage(e.to_string()))?;
        crate::storage::reject_link(entry.path())?;
        let path = to.join(entry.path().strip_prefix(from).unwrap());
        if entry.file_type().is_dir() {
            fs::create_dir_all(path)?;
        } else {
            fs::copy(entry.path(), &path)?;
            if crate::updater::hash_file(entry.path())? != crate::updater::hash_file(&path)? {
                return Err(Error::Storage("迁移文件校验失败".into()));
            }
        }
    }
    Ok(())
}
