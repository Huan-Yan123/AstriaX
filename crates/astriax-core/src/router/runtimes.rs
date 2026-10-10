use crate::{
    domain::{arg_string, parse, segment, Kind},
    Error, Launcher, Result,
};
use serde_json::{json, Value};
use std::fs;
fn string(p: &Value) -> Result<&str> {
    p.as_str()
        .ok_or_else(|| Error::Invalid("需要字符串参数".into()))
}
pub(super) async fn dispatch(app: &Launcher, channel: &str, p: Value) -> Result<Value> {
    match channel {
        "runtime:install" => crate::runtime::install::install(app, p, false).await,
        "runtimes:importFile" => crate::runtime::install::install(app, p, true).await,
        "runtime:installPip" => crate::runtime::install::install_pip(app, p).await,
        "runtimes:probeFile" => {
            let file = std::path::PathBuf::from(string(&p)?);
            tokio::task::spawn_blocking(move || crate::runtime::import::probe(&file))
                .await
                .map_err(|e| Error::Storage(e.to_string()))?
        }
        "runtimes:list" => Ok(json!(app.store.lock().await.runtimes()?)),
        "runtimes:cancel" => {
            if p["type"] == "python" && p["tag"] == "python" {
                return Ok(json!({"ok":app.tasks.cancel("python:python")}));
            }
            let kind: Kind = parse(p["type"].clone())?;
            let tag = arg_string(&p, "tag")?;
            Ok(json!({"ok":app.tasks.cancel(&format!("{}:{tag}",kind.key()))}))
        }
        "runtimes:remove" => remove_runtime(app, p).await,
        "versions:list" => crate::runtime::versions::list(app, p).await,
        "versions:prewarm" => {
            let (a, n) = tokio::join!(
                crate::runtime::versions::list(app, json!({"type":"a"})),
                crate::runtime::versions::list(app, json!({"type":"n"}))
            );
            Ok(json!({"ok":a.is_ok()&&n.is_ok()}))
        }
        "templates:status" => {
            let r = app.store.lock().await.runtimes()?;
            Ok(
                json!({"a":{"ready":r.iter().any(|r|r.kind==Kind::AstrBot),"version":1},"n":{"ready":r.iter().any(|r|r.kind==Kind::NapCat),"version":1}}),
            )
        }
        "templates:download" => {
            let kind: Kind = parse(p)?;
            let versions = crate::runtime::versions::list(app, json!({"type":kind})).await?;
            let tag = versions[0]["tag"]
                .as_str()
                .ok_or_else(|| Error::Network("没有可安装版本".into()))?;
            crate::runtime::install::install(app, json!({"type":kind,"tag":tag}), false).await
        }
        "python:status" => crate::runtime::python_selection::status(app, false).await,
        "python:discover" => crate::runtime::python_selection::status(app, true).await,
        "python:select" => {
            crate::runtime::python_selection::select(app, std::path::Path::new(string(&p)?)).await
        }
        "python:install" => crate::runtime::python::install(app).await,
        "qq:status" => Ok(crate::platform::qq_status()),
        "download:sessions" => Ok(json!(app.tasks.snapshot())),
        _ => Err(Error::Unsupported(format!("未知接口：{channel}"))),
    }
}
async fn remove_runtime(app: &Launcher, p: Value) -> Result<Value> {
    let kind: Kind = parse(p["type"].clone())?;
    let tag = segment(arg_string(&p, "tag")?)?;
    let _runtime = app
        .runtime_lock(kind, tag)
        .await
        .try_write_owned()
        .map_err(|_| Error::Busy("运行时正在使用".into()))?;
    let _task = app.tasks.begin(
        format!("{}:{tag}", kind.key()),
        "runtime-management",
        tag,
        app.emit.clone(),
    )?;
    crate::runtime::install::assert_unused(app, kind, tag).await?;
    let store = app.store.lock().await;
    let mut used_by = vec![];
    let mut unknown_binding = vec![];
    for instance in store.index.instances.iter().filter(|r| r.kind == kind) {
        match store.tag(&instance.id) {
            Ok(binding) if binding == tag => used_by.push(instance.name.clone()),
            Err(_) => unknown_binding.push(instance.name.clone()),
            _ => {}
        }
    }
    for r in &store.index.instances {
        if r.kind == kind && store.tag(&r.id).is_err() && !crate::process::port_free(r.port).await {
            return Err(Error::Busy(
                "运行中的实例版本绑定损坏，不能删除运行时".into(),
            ));
        }
    }
    let dir = store.runtime_dir(kind, tag)?;
    if !dir.exists() {
        return Ok(
            json!({"ok":true,"removed":false,"usedBy":used_by,"unknownBinding":unknown_binding}),
        );
    }
    let stage = tempfile::Builder::new()
        .prefix(".remove-")
        .tempdir_in(&store.root)?;
    let empty = stage.path().join("empty");
    fs::create_dir(&empty)?;
    let mut versions = store.runtimes()?;
    versions.retain(|r| !(r.kind == kind && r.tag == tag));
    let index = stage.path().join("index.json");
    crate::storage::atomic_json(&index, &json!({"versions":versions}))?;
    crate::transaction::replace(
        &store.root,
        vec![
            (empty, dir.clone()),
            (index, store.root.join("runtimes.json")),
        ],
    )?;
    fs::remove_dir(dir)?;
    Ok(json!({"ok":true,"removed":true,"usedBy":used_by,"unknownBinding":unknown_binding}))
}
