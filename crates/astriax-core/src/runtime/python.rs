use crate::{
    process::{run, LaunchSpec},
    storage::atomic_bytes,
    Error, Launcher, Result,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

pub const VERSION: &str = "3.12.10";
pub fn exe(root: &Path) -> PathBuf {
    root.join("runtime/python/python.exe")
}
pub fn prepare(dir: &Path) -> Result<()> {
    let file = dir.join("python312._pth");
    let raw = fs::read_to_string(&file)?;
    let mut lines: Vec<String> = raw
        .lines()
        .map(|s| {
            if s.trim() == "#import site" {
                "import site".into()
            } else {
                s.into()
            }
        })
        .collect();
    for s in [".", "Lib/site-packages", "import site"] {
        if !lines.iter().any(|l| l == s) {
            lines.push(s.into());
        }
    }
    atomic_bytes(&file, (lines.join("\n") + "\n").as_bytes())?;
    atomic_bytes(
        &dir.join("Lib/site-packages/sitecustomize.py"),
        include_bytes!("../../resources/sitecustomize.py"),
    )?;
    Ok(())
}
pub fn pip_spec(root: &Path, target: &Path, args: Vec<String>) -> Result<LaunchSpec> {
    let program = exe(root);
    if !program.is_file() {
        return Err(Error::Invalid("请先在下载页安装内置 Python 3.12".into()));
    }
    Ok(LaunchSpec {
        program,
        args,
        cwd: target.to_path_buf(),
        env: HashMap::from([
            ("PYTHONUTF8".into(), "1".into()),
            ("PYTHONUNBUFFERED".into(), "1".into()),
            ("PIP_DISABLE_PIP_VERSION_CHECK".into(), "1".into()),
            ("PIP_NO_INPUT".into(), "1".into()),
            ("MXBOT_SITE".into(), target.to_string_lossy().into_owned()),
            (
                "TMP".into(),
                root.join("tmp").to_string_lossy().into_owned(),
            ),
            (
                "TEMP".into(),
                root.join("tmp").to_string_lossy().into_owned(),
            ),
        ]),
    })
}
pub async fn install(app: &Launcher) -> Result<Value> {
    let _python = app
        .python_gate
        .try_write()
        .map_err(|_| Error::Busy("Python 正在启动实例或安装依赖".into()))?;
    let task = app
        .tasks
        .begin("python:python".into(), "python", "python", app.emit.clone())?;
    let result = install_inner(app, &task).await;
    task.finish(&result);
    result
}
async fn install_inner(app: &Launcher, task: &crate::tasks::Task) -> Result<Value> {
    let root = app.root().await;
    let parent = root.join("runtime");
    fs::create_dir_all(&parent)?;
    let records = app.store.lock().await.index.instances.clone();
    for rec in records
        .into_iter()
        .filter(|r| r.kind == crate::domain::Kind::AstrBot)
    {
        if app.processes.active(&rec.id).await || !crate::process::port_free(rec.port).await {
            return Err(Error::Busy("请先停止 AstrBot 实例再安装 Python".into()));
        }
    }
    let stage = tempfile::Builder::new()
        .prefix(".python-stage-")
        .tempdir_in(&parent)?;
    let archive = stage.path().join("python.zip");
    let mut downloaded = false;
    let mut last = None;
    for url in [
        format!("https://www.python.org/ftp/python/{VERSION}/python-{VERSION}-embed-amd64.zip"),
        format!(
            "https://mirrors.huaweicloud.com/python/{VERSION}/python-{VERSION}-embed-amd64.zip"
        ),
    ] {
        task.check()?;
        match super::download::to_file(app, &url, &archive, None, task).await {
            Ok(()) => {
                downloaded = true;
                break;
            }
            Err(e) => last = Some(e),
        }
    }
    if !downloaded {
        return Err(last.unwrap_or_else(|| Error::Network("无法下载 Python".into())));
    }
    let dest = stage.path().join("python");
    let zip_path = archive.clone();
    let dest_copy = dest.clone();
    let token = task.token.clone();
    tokio::task::spawn_blocking(move || crate::archive::extract_zip(&zip_path, &dest_copy, &token))
        .await
        .map_err(|e| Error::Storage(e.to_string()))??;
    prepare(&dest)?;
    fs::create_dir_all(root.join("tmp"))?;
    let get_pip = dest.join("get-pip.py");
    super::download::to_file(
        app,
        "https://bootstrap.pypa.io/get-pip.py",
        &get_pip,
        None,
        task,
    )
    .await?;
    task.progress("unpack", "安装 pip、setuptools、wheel", 0, None);
    let spec = LaunchSpec {
        program: dest.join("python.exe"),
        args: vec![
            get_pip.to_string_lossy().into_owned(),
            "--no-warn-script-location".into(),
            "pip".into(),
            "setuptools".into(),
            "wheel".into(),
        ],
        cwd: dest.clone(),
        env: HashMap::from([
            ("PYTHONUTF8".into(), "1".into()),
            ("PIP_NO_INPUT".into(), "1".into()),
            ("PIP_DISABLE_PIP_VERSION_CHECK".into(), "1".into()),
        ]),
    };
    run(&spec, &task.token, &root.join("logs/python-install.log")).await?;
    let mut check = spec;
    check.args = vec!["-m".into(), "pip".into(), "--version".into()];
    run(&check, &task.token, &root.join("logs/python-install.log")).await?;
    task.check()?;
    crate::transaction::replace(&root, vec![(dest, parent.join("python"))])?;
    Ok(json!({"ok":true,"ready":true,"installed":true,"version":VERSION}))
}
