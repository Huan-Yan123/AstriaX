use crate::{Error, Launcher, Result};
use serde_json::{json, Value};
fn string(p: &Value) -> Result<&str> {
    p.as_str()
        .ok_or_else(|| Error::Invalid("需要字符串参数".into()))
}
pub(super) async fn dispatch(app: &Launcher, channel: &str, p: Value) -> Result<Value> {
    match channel {
        "instance:list" => crate::instances::list(app).await,
        "instance:create" => crate::instances::create(app, p).await,
        "instance:start" => crate::instances::start(app, string(&p)?).await,
        "instance:stop" => crate::instances::stop(app, string(&p)?).await,
        "instance:remove" => crate::instances::remove(app, string(&p)?).await,
        "instance:setRuntime" => crate::instances::set_runtime(app, p).await,
        "instance:update" => crate::instances::update(app, p).await,
        "instance:log" => {
            let (root, rec) = {
                let s = app.store.lock().await;
                (s.root.clone(), s.instance(string(&p)?)?)
            };
            Ok(json!(crate::logs::tail(
                &root.join("logs/instances").join(format!("{}.log", rec.id)),
                rec.log_start_offset.unwrap_or(0)
            )?))
        }
        "instance:creds" | "instance:resetCreds" => {
            let id = string(&p)?;
            let _task =
                app.tasks
                    .begin(format!("instance:{id}"), "instance", id, app.emit.clone())?;
            let (rec, root) = {
                let s = app.store.lock().await;
                (s.instance(id)?, s.root.clone())
            };
            let reset = channel == "instance:resetCreds";
            if reset {
                app.processes.stop(id, rec.port).await?;
            }
            tokio::task::spawn_blocking(move || {
                if reset {
                    crate::credentials::reset(&rec)
                } else {
                    crate::credentials::read(&root, &rec)
                }
            })
            .await
            .map_err(|e| Error::Storage(e.to_string()))?
        }
        _ => Err(Error::Unsupported(format!("未知接口：{channel}"))),
    }
}
