use crate::{
    domain::{arg_string, segment},
    storage::{atomic_json, read_json, runtime_ready},
    Error, Launcher, Result,
};
use serde_json::{json, Value};
use std::{fs, path::Path};

pub async fn remove(app: &Launcher, id: &str) -> Result<Value> {
    let _task = app
        .tasks
        .begin(format!("instance:{id}"), "instance", id, app.emit.clone())?;
    let rec = app.store.lock().await.instance(id)?;
    app.processes.stop(id, rec.port).await?;
    let mut store = app.store.lock().await;
    let dir = crate::storage::checked_path(&store.root, Path::new(&rec.dir))?;
    let trash = store
        .root
        .join(format!(".deleted-{}", uuid::Uuid::new_v4()));
    // Remove the index only after the directory has been moved. Restore it if index save fails.
    fs::rename(&dir, &trash)?;
    let old = store.index.clone();
    store.index.instances.retain(|r| r.id != id);
    if let Err(e) = store.save_index() {
        store.index = old;
        fs::rename(&trash, &dir)?;
        return Err(e);
    }
    drop(store);
    tokio::task::spawn_blocking(move || fs::remove_dir_all(trash));
    Ok(json!({"ok":true}))
}
pub async fn set_runtime(app: &Launcher, p: Value) -> Result<Value> {
    let id = arg_string(&p, "id")?;
    let task = app
        .tasks
        .begin(format!("instance:{id}"), "instance", id, app.emit.clone())?;
    let running = app.processes.active(id).await;
    let mut result = switch_runtime(app, p.clone()).await?;
    if running {
        match super::lifecycle::start_with_task(app, id, &task).await {
            Ok(_) => result["restarted"] = json!(true),
            Err(error) => result["restartError"] = json!(error.to_string()),
        }
    }
    Ok(result)
}
pub(super) async fn switch_runtime(app: &Launcher, p: Value) -> Result<Value> {
    let id = arg_string(&p, "id")?;
    let tag = segment(arg_string(&p, "tag")?)?;
    let old = app.store.lock().await.tag(id).ok();
    let rec = app.store.lock().await.instance(id)?;
    if p["type"] != json!(rec.kind) {
        return Err(Error::Invalid("运行时类型和实例不一致".into()));
    }
    let _runtime = app
        .runtime_lock(rec.kind, tag)
        .await
        .try_read_owned()
        .map_err(|_| Error::Busy("运行时正在修改".into()))?;
    app.processes.stop(id, rec.port).await?;
    let mut store = app.store.lock().await;
    if !runtime_ready(rec.kind, &store.runtime_dir(rec.kind, tag)?) {
        return Err(Error::Invalid("所选运行时不完整".into()));
    }
    let meta_path = Path::new(&rec.dir).join("instance.json");
    let mut meta: Value = read_json(&meta_path)?;
    meta["runtimeTag"] = json!(tag);
    let mut index = store.index.clone();
    let r = index.instances.iter_mut().find(|r| r.id == id).unwrap();
    r.runtime_version =
        crate::runtime::metadata::version(rec.kind, &store.runtime_dir(rec.kind, tag)?);
    r.status = "stopped".into();
    r.updated_at = crate::domain::now();
    let stage = tempfile::Builder::new()
        .prefix(".switch-")
        .tempdir_in(&store.root)?;
    let meta_stage = stage.path().join("meta.json");
    let index_stage = stage.path().join("index.json");
    atomic_json(&meta_stage, &meta)?;
    atomic_json(&index_stage, &index)?;
    crate::transaction::replace(
        &store.root,
        vec![
            (meta_stage, meta_path),
            (index_stage, store.root.join("instances.json")),
        ],
    )?;
    store.index = index;
    Ok(
        json!({"ok":true,"tag":tag,"changed":old.as_deref()!=Some(tag),"from":old,"to":tag,"restarted":false}),
    )
}
