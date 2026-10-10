use super::install::{assert_unused, register};
use crate::{
    domain::{arg_string, segment, Kind},
    process::run,
    storage::runtime_ready,
    Error, Launcher, Result,
};
use serde_json::Value;

pub async fn install_pip(app: &Launcher, p: Value) -> Result<Value> {
    let tag = segment(arg_string(&p, "tag")?)?;
    let _runtime = app
        .runtime_lock(Kind::AstrBot, tag)
        .await
        .try_write_owned()
        .map_err(|_| Error::Busy("此运行时正在使用".into()))?;
    let task = app.tasks.runtime(Kind::AstrBot, tag, app.emit.clone())?;
    let result = async {
        assert_unused(app, Kind::AstrBot, tag).await?;
        let spec = arg_string(&p, "packageSpec")?;
        if spec.len() > 1024 || spec.starts_with('-') || spec.contains(['\n', '\r', '\0']) {
            return Err(Error::Invalid("请填写一个有效的 pip 包规格".into()));
        }
        let root = app.root().await;
        let dir = app.store.lock().await.runtime_dir(Kind::AstrBot, tag)?;
        if !runtime_ready(Kind::AstrBot, &dir) {
            return Err(Error::Invalid("指定运行时尚未安装".into()));
        }
        let stage = tempfile::Builder::new()
            .prefix(".pip-")
            .tempdir_in(dir.parent().unwrap())?;
        let payload = stage.path().join("payload");
        let (from, to, token) = (dir.clone(), payload.clone(), task.token.clone());
        tokio::task::spawn_blocking(move || crate::archive::copy_tree(&from, &to, &token))
            .await
            .map_err(|e| Error::Storage(e.to_string()))??;
        let source = crate::sources::selected(&root, true, None)?;
        let args = vec![
            "-m".into(),
            "pip".into(),
            "install".into(),
            "--upgrade".into(),
            "--target".into(),
            payload.to_string_lossy().into_owned(),
            "--index-url".into(),
            arg_string(&source, "indexUrl")?.into(),
            spec.into(),
        ];
        let _python = app.python_gate.read().await;
        run(
            &super::python::pip_spec(&root, &payload, args)?,
            &task.token,
            &root.join("logs/pip-install.log"),
        )
        .await?;
        task.check()?;
        register(
            app,
            Kind::AstrBot,
            tag,
            &payload,
            source["label"].as_str().unwrap_or("Python源"),
        )
        .await
    }
    .await;
    task.finish(&result);
    result
}
