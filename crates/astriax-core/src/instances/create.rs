use crate::{
    domain::{parse, Instance, Kind},
    storage::{atomic_bytes, atomic_json},
    Error, Launcher, Result,
};
use serde_json::{json, Value};
use std::fs;

pub async fn create(app: &Launcher, p: Value) -> Result<Value> {
    let kind: Kind = parse(p["type"].clone())?;
    if kind == Kind::NapCat && crate::platform::qq_status()["ok"] != true {
        return Err(Error::Invalid("请先安装符合要求的 QQ NT".into()));
    }
    let mut store = app.store.lock().await;
    if store.config["dataRoot"].as_str().is_none() {
        return Err(Error::Invalid("请先完成数据目录设置".into()));
    }
    if kind == Kind::AstrBot && !crate::runtime::python::exe(&store.root).is_file() {
        return Err(Error::Invalid("请先安装内置 Python".into()));
    }
    let versions = store.runtimes()?;
    let chosen = if let Some(tag) = p["tag"].as_str() {
        versions.iter().find(|r| r.kind == kind && r.tag == tag)
    } else {
        versions.iter().find(|r| r.kind == kind)
    }
    .ok_or_else(|| Error::Invalid("请先下载所选运行时版本".into()))?;
    let tag = chosen.tag.clone();
    let _runtime = app
        .runtime_lock(kind, &tag)
        .await
        .try_read_owned()
        .map_err(|_| Error::Busy("运行时正在修改".into()))?;
    let taken = store
        .index
        .instances
        .iter()
        .map(|r| r.port)
        .collect::<Vec<_>>();
    let mut port = None;
    let requested = p["port"].as_u64().and_then(|n| u16::try_from(n).ok());
    if !p["port"].is_null() && requested.is_none() {
        return Err(Error::Invalid("端口必须是 1–65535 的整数".into()));
    }
    let range = kind.ports();
    let candidates = if let Some(n) = requested {
        if !range.contains(&n) {
            return Err(Error::Invalid("端口不在该类型的分配范围内".into()));
        }
        vec![n]
    } else {
        range.collect()
    };
    for n in candidates {
        if !taken.contains(&n) && crate::process::port_free(n).await {
            port = Some(n);
            break;
        }
    }
    let port = port.ok_or_else(|| Error::Busy("没有可用端口".into()))?;
    let typed = p["name"].as_str().unwrap_or("").trim();
    let name = if typed.is_empty() {
        (1..)
            .map(|i| {
                if i == 1 {
                    format!("{} 实例", kind.label())
                } else {
                    format!("{} 实例{i}", kind.label())
                }
            })
            .find(|s| !store.index.instances.iter().any(|r| r.name == *s))
            .unwrap()
    } else {
        typed.into()
    };
    if store.index.instances.iter().any(|r| r.name == name) {
        return Err(Error::Invalid("实例名称已存在".into()));
    }
    let account = p["qqAccount"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if account
        .as_ref()
        .is_some_and(|a| !(5..=12).contains(&a.len()) || !a.bytes().all(|c| c.is_ascii_digit()))
    {
        return Err(Error::Invalid("QQ 号必须是 5–12 位数字".into()));
    }
    let id = format!(
        "{}_{}",
        kind.key(),
        &uuid::Uuid::new_v4().simple().to_string()[..10]
    );
    let dir = store.root.join("instances").join(kind.label()).join(&id);
    let now = crate::domain::now();
    let rec = Instance {
        id: id.clone(),
        kind,
        name,
        template_version: 1,
        port,
        dir: dir.to_string_lossy().into_owned(),
        status: "stopped".into(),
        qq_account: account,
        runtime_version: crate::runtime::metadata::version(kind, &store.runtime_dir(kind, &tag)?),
        last_started_at: None,
        log_start_offset: None,
        created_at: now.clone(),
        updated_at: now,
        extra: Default::default(),
    };
    let stage = tempfile::Builder::new()
        .prefix(".create-")
        .tempdir_in(&store.root)?;
    let payload = stage.path().join("instance");
    fs::create_dir_all(&payload)?;
    atomic_json(
        &payload.join("instance.json"),
        &json!({"id":rec.id,"type":kind,"name":rec.name,"runtimeTag":tag,"port":port,"createdAt":rec.created_at}),
    )?;
    if kind == Kind::AstrBot {
        atomic_bytes(&payload.join(".astrbot"), b"")?;
    }
    let mut index = store.index.clone();
    index.instances.push(rec.clone());
    let index_stage = stage.path().join("instances.json");
    atomic_json(&index_stage, &index)?;
    crate::transaction::replace(
        &store.root,
        vec![
            (payload, dir),
            (index_stage, store.root.join("instances.json")),
        ],
    )?;
    store.index = index;
    let mut result = serde_json::to_value(rec)?;
    result["tag"] = json!(tag);
    Ok(result)
}
