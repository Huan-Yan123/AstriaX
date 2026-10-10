use crate::{
    domain::{arg_string, parse, segment, Kind, Runtime},
    process::run,
    storage::{atomic_json, runtime_ready},
    tasks::Task,
    Error, Launcher, Result,
};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub async fn install(app: &Launcher, p: Value, imported: bool) -> Result<Value> {
    let kind: Kind = parse(p["type"].clone())?;
    let tag = if imported {
        format!("v{}", arg_string(&p, "version")?.trim_start_matches('v'))
    } else {
        arg_string(&p, "tag")?.to_string()
    };
    segment(&tag)?;
    let _runtime = app
        .runtime_lock(kind, &tag)
        .await
        .try_write_owned()
        .map_err(|_| Error::Busy("运行时正在启动或修改".into()))?;
    let task = app.tasks.runtime(kind, &tag, app.emit.clone())?;
    let result = inner(app, &p, kind, &tag, imported, &task).await;
    task.finish(&result);
    result
}
async fn inner(
    app: &Launcher,
    p: &Value,
    kind: Kind,
    tag: &str,
    imported: bool,
    task: &Task,
) -> Result<Value> {
    let root = app.root().await;
    assert_unused(app, kind, tag).await?;
    let parent = root.join("runtimes").join(kind.key());
    fs::create_dir_all(&parent)?;
    let work = tempfile::Builder::new()
        .prefix(".install-")
        .tempdir_in(&parent)?;
    let stage = work.path().join("payload");
    fs::create_dir_all(&stage)?;
    fs::create_dir_all(root.join("tmp"))?;
    let mut origin = json!("本地导入");
    let mut wheel = None;
    if imported {
        let file = PathBuf::from(arg_string(p, "file")?);
        let probe = super::import::probe(&file)?;
        if probe["kind"] != json!(kind) {
            return Err(Error::Invalid(
                probe["reason"]
                    .as_str()
                    .unwrap_or("压缩包类型不匹配")
                    .into(),
            ));
        }
        if let Some(version) = probe["version"].as_str().filter(|s| !s.is_empty()) {
            if super::versions::compare(version, tag, kind) != std::cmp::Ordering::Equal {
                return Err(Error::Invalid(format!(
                    "导入包实际版本 {version} 与填写版本 {tag} 不一致"
                )));
            }
        }
        if file.extension().is_some_and(|s| s == "whl") {
            wheel = Some(file);
        } else {
            unpack(&file, &stage, task).await?;
        }
    } else if kind == Kind::NapCat {
        let request = super::versions::list(
            app,
            json!({"type":kind,"base":p["base"],"includePrerelease":true}),
        );
        let versions = tokio::select! { _ = task.token.cancelled() => return Err(Error::Cancelled), result = request => result? };
        let item = versions
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["tag"] == tag)
            .ok_or_else(|| Error::Invalid("指定来源没有此版本".into()))?;
        origin = item["from"].clone();
        let archive = work.path().join("runtime.zip");
        super::download::to_file(
            app,
            arg_string(item, "assetUrl")?,
            &archive,
            item["sha256"].as_str(),
            task,
        )
        .await?;
        unpack(&archive, &stage, task).await?;
    }
    let stage = normalize(stage, kind)?;
    if kind == Kind::AstrBot {
        let _python = app.python_gate.read().await;
        let source = crate::sources::selected(
            &root,
            true,
            p["base"].as_str().filter(|s| !s.is_empty() && *s != "pypi"),
        )?;
        origin = source["label"].clone();
        let mut args = vec![
            "-m".into(),
            "pip".into(),
            "install".into(),
            "--disable-pip-version-check".into(),
            "--no-warn-script-location".into(),
            "--target".into(),
            stage.to_string_lossy().into_owned(),
            "--index-url".into(),
            arg_string(&source, "indexUrl")?.into(),
        ];
        if let Some(file) = wheel {
            args.push(file.to_string_lossy().into_owned());
        } else if imported && stage.join("main.py").exists() {
            let requirements = stage.join("requirements.txt");
            if !requirements.is_file() {
                return Err(Error::Invalid("源码包缺少 requirements.txt".into()));
            }
            args.extend(["-r".into(), requirements.to_string_lossy().into_owned()]);
        } else {
            args.push(format!("astrbot=={}", tag.trim_start_matches('v')));
        }
        task.progress("unpack", "使用所选 Python 源安装完整依赖", 0, None);
        let spec = super::python::pip_spec(&root, &stage, args)?;
        run(
            &spec,
            &task.token,
            &root.join("logs").join(format!("install-a-{tag}.log")),
        )
        .await?;
        atomic_json(
            &stage.join("mxbot-runtime.json"),
            &json!({"kind":if stage.join("main.py").exists(){"source"}else{"pypi"},"version":tag.trim_start_matches('v')}),
        )?;
    }
    if !runtime_ready(kind, &stage) {
        return Err(Error::Invalid(
            "运行时缺少必要的上游入口文件，未注册此版本".into(),
        ));
    }
    if let Some(actual) = super::metadata::version(kind, &stage) {
        if super::versions::compare(&actual, tag, kind) != std::cmp::Ordering::Equal {
            return Err(Error::Invalid(format!(
                "上游包实际版本 {actual} 与请求版本 {tag} 不一致，未替换运行时"
            )));
        }
    }
    task.check()?;
    register(
        app,
        kind,
        tag,
        &stage,
        origin.as_str().unwrap_or("本地导入"),
    )
    .await
}
pub async fn unpack(file: &Path, dest: &Path, task: &Task) -> Result<()> {
    task.progress("unpack", "校验并解压", 0, None);
    let (file, dest, token) = (file.to_path_buf(), dest.to_path_buf(), task.token.clone());
    tokio::task::spawn_blocking(move || crate::archive::extract_zip(&file, &dest, &token))
        .await
        .map_err(|e| Error::Storage(e.to_string()))?
}
fn normalize(mut dir: PathBuf, kind: Kind) -> Result<PathBuf> {
    for _ in 0..4 {
        if runtime_ready(kind, &dir)
            || dir.join("main.py").is_file()
            || dir.join("napcat.mjs").is_file()
        {
            return Ok(dir);
        }
        let entries = fs::read_dir(&dir)?.collect::<std::io::Result<Vec<_>>>()?;
        let dirs = entries
            .iter()
            .filter(|e| e.path().is_dir() && e.file_name() != "__MACOSX")
            .collect::<Vec<_>>();
        if dirs.len() != 1 {
            break;
        }
        dir = dirs[0].path();
    }
    Ok(dir)
}
pub async fn assert_unused(app: &Launcher, kind: Kind, tag: &str) -> Result<()> {
    let records = {
        let store = app.store.lock().await;
        store
            .index
            .instances
            .iter()
            .filter(|r| {
                r.kind == kind
                    && store
                        .tag(&r.id)
                        .ok()
                        .as_deref()
                        .is_none_or(|binding| binding == tag)
            })
            .cloned()
            .collect::<Vec<_>>()
    };
    for rec in records {
        if app.processes.active(&rec.id).await || !crate::process::port_free(rec.port).await {
            return Err(Error::Busy(format!(
                "{} 仍在使用此运行时，请先停止",
                rec.name
            )));
        }
    }
    Ok(())
}
pub(super) async fn register(
    app: &Launcher,
    kind: Kind,
    tag: &str,
    stage: &Path,
    from: &str,
) -> Result<Value> {
    let store = app.store.lock().await;
    let dir = store.runtime_dir(kind, tag)?;
    let mut versions = store.runtimes()?;
    versions.retain(|r| !(r.kind == kind && r.tag == tag));
    let bytes = walkdir::WalkDir::new(stage)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .try_fold(0u64, |sum, e| e.metadata().map(|m| sum + m.len()))
        .map_err(|e| Error::Storage(e.to_string()))?;
    let rt = Runtime {
        kind,
        tag: tag.into(),
        dir: dir.to_string_lossy().into_owned(),
        installed_at: crate::domain::now(),
        from: Some(from.into()),
        size_mb: Some(bytes as f64 / 1048576.),
        extra: Default::default(),
    };
    versions.push(rt);
    let index_stage = stage.parent().unwrap().join("runtimes-index.json");
    atomic_json(&index_stage, &json!({"versions":versions}))?;
    crate::transaction::replace(
        &store.root,
        vec![
            (stage.into(), dir),
            (index_stage, store.root.join("runtimes.json")),
        ],
    )?;
    Ok(json!({"ok":true,"tag":tag,"from":from,"depsOk":true}))
}

pub use super::pip::install_pip;
