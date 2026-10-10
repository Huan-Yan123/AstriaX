mod create;
mod lifecycle;
mod mutations;
mod update;
use crate::{Launcher, Result};
pub use create::create;
pub use lifecycle::{shutdown, start, stop};
pub use mutations::{remove, set_runtime};
use serde_json::{json, Value};
pub use update::update;

pub async fn list(app: &Launcher) -> Result<Value> {
    let records = app.store.lock().await.index.instances.clone();
    let mut out = vec![];
    for mut rec in records {
        let tag = app.store.lock().await.tag(&rec.id).ok();
        if let Some(binding) = &tag {
            let runtime = app.store.lock().await.runtime_dir(rec.kind, binding)?;
            rec.runtime_version = crate::runtime::metadata::version(rec.kind, &runtime);
        }
        let active = app.processes.active(&rec.id).await;
        if rec.status != "starting" || !app.tasks.contains(&format!("instance:{}", rec.id)) {
            rec.status = if active
                && app
                    .processes
                    .owns_port(&rec.id, rec.port)
                    .await
                    .unwrap_or(false)
                && crate::process::listening(rec.port).await
            {
                "running"
            } else if active || !crate::process::port_free(rec.port).await {
                "error"
            } else {
                "stopped"
            }
            .into();
        }
        let mut value = serde_json::to_value(rec)?;
        value["runtimeTag"] = json!(tag);
        out.push(value);
    }
    Ok(json!(out))
}
