use crate::{
    process::{run, LaunchSpec},
    storage::atomic_bytes,
    Error, Launcher, Result,
};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

pub fn exe(root: &Path) -> PathBuf {
    super::python_selection::exe(root)
}
pub fn prepare(dir: &Path) -> Result<()> {
    let files = fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            name.len() > 11
                && name.starts_with("python")
                && name.ends_with("._pth")
                && name[6..name.len() - 5].chars().all(|c| c.is_ascii_digit())
        })
        .map(|e| e.path())
        .collect::<Vec<_>>();
    if files.len() != 1 {
        return Err(Error::Invalid(
            "Python 包应包含一个有效的 pythonXY._pth 配置".into(),
        ));
    }
    let file = &files[0];
    let raw = fs::read_to_string(file)?;
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
    atomic_bytes(file, (lines.join("\n") + "\n").as_bytes())?;
    atomic_bytes(
        &dir.join("Lib/site-packages/sitecustomize.py"),
        include_bytes!("../../resources/sitecustomize.py"),
    )?;
    Ok(())
}
pub async fn pip_spec(root: &Path, target: &Path, mut args: Vec<String>) -> Result<LaunchSpec> {
    let python = super::python_selection::validate(root).await?;
    let program = python.exe;
    if python.source != "bundled" {
        args.splice(0..0, ["-X".into(), "utf8".into(), "-u".into(), "-I".into()]);
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
pub async fn install(app: &Launcher, p: Value) -> Result<Value> {
    let _python = app
        .python_gate
        .try_write()
        .map_err(|_| Error::Busy("Python 正在启动实例或安装依赖".into()))?;
    let task = app
        .tasks
        .begin("python:python".into(), "python", "python", app.emit.clone())?;
    let result = install_inner(app, &task, &p).await;
    task.finish(&result);
    result
}
async fn install_inner(app: &Launcher, task: &crate::tasks::Task, p: &Value) -> Result<Value> {
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
    task.progress("start", "读取所选源的 Python 版本", 0, None);
    let package = tokio::select! { _ = task.token.cancelled() => return Err(Error::Cancelled), result = super::python_sources::resolve(app, p) => result? };
    let version = package["version"].as_str().unwrap();
    super::download::to_file(
        app,
        package["assetUrl"].as_str().unwrap(),
        &archive,
        None,
        task,
    )
    .await?;
    task.progress("unpack", &format!("解压 Python {version}"), 0, None);
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
    let mut spec = LaunchSpec {
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
    crate::network::configure_pip(app, &mut spec).await;
    let pip_source = crate::sources::selected(&root, true, None)?;
    spec.args.extend([
        "--index-url".into(),
        pip_source["indexUrl"].as_str().unwrap().into(),
    ]);
    crate::process::run_with_progress(&spec, task, &root.join("logs/python-install.log")).await?;
    let mut check = spec;
    check.args = vec!["-m".into(), "pip".into(), "--version".into()];
    run(&check, &task.token, &root.join("logs/python-install.log")).await?;
    task.check()?;
    let mut python = super::python_probe::probe(&dest.join("python.exe")).await?;
    if python.version != version {
        return Err(Error::Invalid(format!(
            "下载源返回的 Python 版本不符：选择 {version}，实际 {}",
            python.version
        )));
    }
    python.exe = parent.join("python/python.exe");
    python.source = "bundled".into();
    let selection = stage.path().join("python-selection.json");
    crate::storage::atomic_json(&selection, &python)?;
    crate::transaction::replace(
        &root,
        vec![
            (dest, parent.join("python")),
            (selection, parent.join("python-selection.json")),
        ],
    )?;
    Ok(
        serde_json::json!({"ok":true,"ready":true,"installed":true,"version":python.version,"exe":python.exe,"source":python.source}),
    )
}
