use crate::{Error, Launcher, Result};
use serde_json::{json, Value};
use std::{fs, path::Path};
fn string(p: &Value) -> Result<&str> {
    p.as_str()
        .ok_or_else(|| Error::Invalid("需要字符串参数".into()))
}
pub(super) async fn dispatch(app: &Launcher, channel: &str, p: Value) -> Result<Value> {
    match channel {
        "backup:make" => {
            let id = string(&p)?;
            let _task =
                app.tasks
                    .begin(format!("instance:{id}"), "instance", id, app.emit.clone())?;
            let (rec, keep) = {
                let s = app.store.lock().await;
                (
                    s.instance(id)?,
                    s.config["backupKeep"].as_u64().unwrap_or(5) as usize,
                )
            };
            // Prevent snapshots of a database while its service may be writing.
            app.processes.stop(id, rec.port).await?;
            tokio::task::spawn_blocking(move || {
                crate::backup::make(Path::new(&rec.dir), rec.template_version, keep)
            })
            .await
            .map_err(|e| Error::Storage(e.to_string()))?
        }
        "backup:list" => {
            let s = app.store.lock().await;
            for r in &s.index.instances {
                crate::storage::checked_path(&s.root, Path::new(&r.dir))?;
            }
            crate::backup::list(&s.index.instances)
        }
        "backup:restore" => crate::backup::restore(app, p).await,
        "backup:del" => {
            let s = app.store.lock().await;
            let file =
                crate::backup::validate_file(&s.root, &s.index.instances, Path::new(string(&p)?))?;
            fs::remove_file(&file)?;
            let side = file.with_file_name(
                file.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .replace(".tar.gz", ".json"),
            );
            if side.exists() {
                fs::remove_file(side)?;
            }
            Ok(json!({"ok":true}))
        }
        "backup:updateList" => update_backups(app).await,
        _ => Err(Error::Unsupported(format!("未知接口：{channel}"))),
    }
}
async fn update_backups(app: &Launcher) -> Result<Value> {
    let mut items = vec![];
    for base in [
        app.install_dir.join("update-backups"),
        app.root().await.join("backups/update"),
    ] {
        if !base.is_dir() {
            continue;
        }
        for entry in walkdir::WalkDir::new(&base)
            .max_depth(2)
            .follow_links(false)
        {
            let entry = entry.map_err(|e| Error::Storage(e.to_string()))?;
            if entry.file_type().is_file() && entry.path().extension().is_some_and(|s| s == "gz") {
                crate::storage::reject_link(entry.path())?;
                items.push(json!({"file":entry.path(),"folder":entry.path().parent(),"sizeMB":entry.metadata().map_err(|e|Error::Storage(e.to_string()))?.len() as f64/1048576.,"stamp":entry.path().parent().and_then(|p|p.file_name()),"manualOnly":true}));
            }
        }
    }
    Ok(json!(items))
}
