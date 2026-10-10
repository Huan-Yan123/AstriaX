use crate::{
    domain::{segment, Kind},
    storage::runtime_ready,
    Error, Launcher, Result,
};
use serde_json::{json, Value};
use std::{fs, path::Path};

pub async fn start(app: &Launcher, id: &str) -> Result<Value> {
    segment(id)?;
    let task = app
        .tasks
        .begin(format!("instance:{id}"), "instance", id, app.emit.clone())?;
    start_with_task(app, id, &task).await
}
pub(super) async fn start_with_task(
    app: &Launcher,
    id: &str,
    task: &crate::tasks::Task,
) -> Result<Value> {
    task.check()?;
    let (rec, root, tag) = {
        let store = app.store.lock().await;
        (store.instance(id)?, store.root.clone(), store.tag(id)?)
    };
    let _runtime = app
        .runtime_lock(rec.kind, &tag)
        .await
        .try_read_owned()
        .map_err(|_| Error::Busy("运行时正在安装或删除".into()))?;
    let _python = app.python_gate.read().await;
    if app.processes.active(id).await {
        return Err(Error::Busy("实例已启动".into()));
    }
    if !crate::process::port_free(rec.port).await {
        return Err(Error::Busy(format!("端口 {} 被占用，未启动实例", rec.port)));
    }
    status(app, id, "starting").await?;
    let result = async {
        let runtime = app.store.lock().await.runtime_dir(rec.kind, &tag)?;
        if !runtime_ready(rec.kind, &runtime) {
            return Err(Error::Invalid("运行时缺少上游入口，需重新安装".into()));
        }
        if rec.kind == Kind::AstrBot {
            crate::runtime::python_selection::compatible(&root, &runtime).await?;
            crate::runtime::dashboard::ensure(app, Path::new(&rec.dir), &tag, task).await?;
        }
        let qq = if rec.kind == Kind::NapCat {
            let q = crate::platform::qq_status();
            if q["ok"] != true {
                return Err(Error::Invalid(
                    q["reason"].as_str().unwrap_or("QQ 检测失败").into(),
                ));
            }
            q["exe"].as_str().map(str::to_string)
        } else {
            None
        };
        let spec = crate::runtime::launch::spec(&root, &rec, &runtime, qq.as_deref())?;
        fs::create_dir_all(root.join("tmp"))?;
        let log = root.join("logs/instances").join(format!("{id}.log"));
        let offset = fs::metadata(&log).map(|m| m.len()).unwrap_or(0);
        let pid = app.processes.spawn(id, &spec, log.clone()).await?;
        if rec.kind == Kind::NapCat {
            app.processes
                .collect_napcat(id, app.client.clone(), rec.clone(), log)
                .await;
        }
        {
            let mut store = app.store.lock().await;
            let r = store
                .index
                .instances
                .iter_mut()
                .find(|r| r.id == id)
                .unwrap();
            r.last_started_at = Some(crate::domain::now());
            r.log_start_offset = Some(offset);
            store.save_index()?;
        }
        for _ in 0..180 {
            task.check()?;
            if !app.processes.active(id).await {
                return Err(Error::Process(
                    "进程已退出或 QQ 未纳入受控 Job；请查看日志".into(),
                ));
            }
            if crate::process::listening(rec.port).await {
                if !app.processes.owns_port(id, rec.port).await? {
                    return Err(Error::Process(
                        "监听端口不属于此实例的受控进程，无法确认就绪".into(),
                    ));
                }
                let url = format!("http://127.0.0.1:{}/", rec.port);
                if app
                    .client
                    .get(&url)
                    .timeout(std::time::Duration::from_secs(2))
                    .send()
                    .await
                    .is_ok()
                {
                    status(app, id, "running").await?;
                    return Ok(json!({"ok":true,"pid":pid,"port":rec.port}));
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        Err(Error::Process(
            "WebUI 启动超过 90 秒，请查看本次日志".into(),
        ))
    }
    .await;
    if result.is_err() {
        let _ = app.processes.stop(id, rec.port).await;
        status(app, id, "error").await?;
    }
    result
}
pub async fn stop(app: &Launcher, id: &str) -> Result<Value> {
    let _task = app
        .tasks
        .begin(format!("instance:{id}"), "instance", id, app.emit.clone())?;
    let rec = app.store.lock().await.instance(id)?;
    app.processes.stop(id, rec.port).await?;
    status(app, id, "stopped").await?;
    Ok(json!({"ok":true}))
}
pub(super) async fn status(app: &Launcher, id: &str, status: &str) -> Result<()> {
    let mut store = app.store.lock().await;
    if let Some(r) = store.index.instances.iter_mut().find(|r| r.id == id) {
        r.status = status.into();
        r.updated_at = crate::domain::now();
    }
    store.save_index()
}
pub async fn shutdown(app: &Launcher) -> Result<()> {
    app.tasks.cancel_all();
    for _ in 0..100 {
        if app.tasks.is_empty() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    if !app.tasks.is_empty() {
        return Err(Error::Busy("后台任务仍在收尾，请稍后退出".into()));
    }
    let records = app.store.lock().await.index.instances.clone();
    for r in records {
        app.processes.stop(&r.id, r.port).await?;
        status(app, &r.id, "stopped").await?;
    }
    Ok(())
}
