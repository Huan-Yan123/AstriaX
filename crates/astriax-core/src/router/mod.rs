mod backups;
mod instances;
mod runtimes;
use crate::{domain::segment, Error, Launcher, Result};
use serde_json::{json, Value};
fn string(p: &Value) -> Result<&str> {
    p.as_str()
        .ok_or_else(|| Error::Invalid("需要字符串参数".into()))
}
pub async fn dispatch(app: &Launcher, channel: &str, p: Value) -> Result<Value> {
    match channel {
        "app:ping" => Ok(json!("pong")),
        "app:version" => Ok(json!(crate::updater::VERSION)),
        "paths:defaults" => {
            let root = app.root().await;
            Ok(
                json!({"dataRoot":root,"appDataRoot":root,"homeDataRoot":root,"portMin":6100,"portMax":6199,"backupKeep":5}),
            )
        }
        "config:get" => Ok(app.store.lock().await.config.clone()),
        "config:set" => crate::settings::set(app, p).await,
        "config:moveDataRoot" => crate::settings::move_root(app, string(&p)?).await,
        "config:moving" => Ok(
            json!({"active":app.tasks.contains("migration"),"startedAt":app.tasks.progress_for("migration").map(|v|v["startedAt"].clone())}),
        ),
        channel if channel.starts_with("instance:") => instances::dispatch(app, channel, p).await,
        channel
            if [
                "runtime:",
                "runtimes:",
                "versions:",
                "templates:",
                "python:",
                "qq:",
                "download:",
            ]
            .iter()
            .any(|prefix| channel.starts_with(prefix)) =>
        {
            runtimes::dispatch(app, channel, p).await
        }
        "mirrors:state" | "pysrc:state" => {
            let root = app.root().await;
            let py = channel.starts_with("pysrc");
            let mut state = crate::sources::state(&root, py)?;
            if py {
                state["active"] = crate::sources::selected(&root, true, None)?;
            }
            Ok(state)
        }
        "mirrors:test" | "pysrc:test" => {
            crate::sources::test(app, channel.starts_with("pysrc")).await
        }
        "mirrors:add" | "mirrors:remove" | "mirrors:pref" | "pysrc:add" | "pysrc:remove"
        | "pysrc:pref" => {
            let store = app.store.lock().await;
            crate::sources::change(
                &store.root,
                channel.starts_with("pysrc"),
                channel.split(':').nth(1).unwrap(),
                p,
            )
        }
        channel if channel.starts_with("backup:") => backups::dispatch(app, channel, p).await,
        "audit:days" => crate::logs::audit_days(&app.root().await),
        "audit:read" => crate::logs::audit_read(&app.root().await, p.as_str()),
        "logs:exportBusy" => Ok(json!(app.tasks.contains("log-export"))),
        "logs:export" => {
            let _task = app
                .tasks
                .begin("log-export".into(), "logs", "export", app.emit.clone())?;
            let root = app.root().await;
            tokio::task::spawn_blocking(move || crate::logs::export(&root))
                .await
                .map_err(|e| Error::Storage(e.to_string()))?
        }
        "stats:overview" => {
            let list = crate::instances::list(app).await?;
            let root = app.root().await;
            let system=tokio::task::spawn_blocking(move||{
                let mut sys=sysinfo::System::new();sys.refresh_memory();sys.refresh_cpu_all();
                let disks=sysinfo::Disks::new_with_refreshed_list();let disk=disks.iter().filter(|d|root.starts_with(d.mount_point())).max_by_key(|d|d.mount_point().as_os_str().len());
                json!({"totalMemMB":sys.total_memory()/1048576,"freeMemMB":sys.available_memory()/1048576,"totalDiskMB":disk.map(|d|d.total_space()/1048576),"freeDiskMB":disk.map(|d|d.available_space()/1048576),"cpuModel":sys.cpus().first().map(|c|c.brand()),"osVersion":sysinfo::System::long_os_version()})
            }).await.map_err(|e|Error::Storage(e.to_string()))?;
            Ok(json!({"system":system,"perInstance":list}))
        }
        "app:checkUpdate" => crate::updater::check(app, p).await,
        "app:downloadUpdate" => crate::updater::download(app, p).await,
        "app:skipVersion" => {
            let mut s = app.store.lock().await;
            s.config["skippedAppVersion"] = json!(segment(string(&p)?)?);
            s.save_config()?;
            Ok(json!({"ok":true}))
        }
        _ => Err(Error::Unsupported(format!("此接口需要桌面宿主：{channel}"))),
    }
}
