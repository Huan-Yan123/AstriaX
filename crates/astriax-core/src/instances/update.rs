use crate::{domain::arg_string, storage::runtime_ready, Error, Launcher, Result};
use serde_json::{json, Value};

pub async fn update(app: &Launcher, p: Value) -> Result<Value> {
    let id = arg_string(&p, "id")?;
    let task = app
        .tasks
        .begin(format!("instance:{id}"), "instance", id, app.emit.clone())?;
    let (rec, previous) = {
        let store = app.store.lock().await;
        (store.instance(id)?, store.tag(id).ok())
    };
    if app.processes.active(id).await || !crate::process::port_free(rec.port).await {
        return Err(Error::Busy("请先停止实例再更新".into()));
    }
    let versions = tokio::select! {
        _ = task.token.cancelled() => return Err(Error::Cancelled),
        versions = crate::runtime::versions::list(app, json!({"type":rec.kind,"noCache":true})) => versions?,
    };
    let latest = versions
        .as_array()
        .and_then(|v| v.first())
        .ok_or_else(|| Error::Network("没有可用版本".into()))?;
    let tag = arg_string(latest, "tag")?;
    if previous.as_deref().is_some_and(|old| {
        crate::runtime::versions::compare(tag, old, rec.kind) != std::cmp::Ordering::Greater
    }) {
        return Ok(json!({"updated":false,"from":previous,"to":tag,"reason":"已是最新版本"}));
    }
    let installed = {
        let store = app.store.lock().await;
        runtime_ready(rec.kind, &store.runtime_dir(rec.kind, tag)?)
    };
    if !installed {
        crate::runtime::install::install(app, json!({"type":rec.kind,"tag":tag}), false).await?;
    }
    task.check()?;
    super::mutations::switch_runtime(app, json!({"id":id,"type":rec.kind,"tag":tag})).await?;
    Ok(json!({"updated":true,"from":previous,"to":tag}))
}
