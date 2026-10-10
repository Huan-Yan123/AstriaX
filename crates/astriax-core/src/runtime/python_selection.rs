use super::python_probe::{probe, Python};
use crate::{
    storage::{atomic_json, read_json},
    Error, Launcher, Result,
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
};

fn record(root: &Path) -> PathBuf {
    root.join("runtime/python-selection.json")
}
pub fn bundled(root: &Path) -> PathBuf {
    root.join("runtime/python/python.exe")
}
pub fn selected(root: &Path) -> Result<Option<Python>> {
    if !record(root).exists() {
        return Ok(None);
    }
    let mut python: Python = read_json(&record(root))?;
    if python.source == "bundled" {
        python.exe = bundled(root);
    }
    Ok(Some(python))
}
pub fn exe(root: &Path) -> PathBuf {
    selected(root)
        .ok()
        .flatten()
        .map(|p| p.exe)
        .unwrap_or_else(|| bundled(root))
}
pub async fn validate(root: &Path) -> Result<Python> {
    let selected = selected(root)?;
    let path = selected
        .as_ref()
        .map(|p| p.exe.clone())
        .unwrap_or_else(|| bundled(root));
    let mut python = probe(&path).await?;
    python.source = selected
        .map(|p| p.source)
        .unwrap_or_else(|| "bundled".into());
    Ok(python)
}
fn candidates(root: &Path) -> Vec<(PathBuf, &'static str)> {
    let mut paths = vec![(bundled(root), "bundled")];
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in if cfg!(windows) {
                vec!["python.exe", "python3.exe", "py.exe"]
            } else {
                vec!["python3", "python"]
            } {
                let file = dir.join(name);
                // Windows Store execution aliases are placeholders, not interpreters.
                if file.metadata().is_ok_and(|m| m.is_file() && m.len() > 0) {
                    paths.push((file, "system"));
                }
            }
        }
    }
    let mut seen = HashSet::new();
    paths.retain(|(p, _)| seen.insert(p.to_string_lossy().to_lowercase()));
    paths
}
pub async fn status(app: &Launcher, rediscover: bool) -> Result<Value> {
    let root = app.root().await;
    if !rediscover && selected(&root)?.is_some() {
        return match validate(&root).await {
            Ok(p) => Ok(json!({"ready":true,"version":p.version,"exe":p.exe,"source":p.source})),
            Err(e) => {
                Ok(json!({"ready":false,"version":"","reason":e.to_string(),"exe":exe(&root)}))
            }
        };
    }
    let _python = app
        .python_gate
        .try_write()
        .map_err(|_| Error::Busy("Python 正在使用，暂时不能重新检测".into()))?;
    assert_idle(app).await?;
    let mut paths = candidates(&root);
    if rediscover {
        paths.sort_by_key(|(_, source)| usize::from(*source == "bundled"));
    }
    for (path, source) in paths {
        if let Ok(mut python) = probe(&path).await {
            python.source = source.into();
            atomic_json(&record(&root), &python)?;
            return Ok(
                json!({"ready":true,"version":python.version,"exe":python.exe,"source":source}),
            );
        }
    }
    Ok(
        json!({"ready":false,"version":"","source":"none","reason":"未找到可用的 64 位 Python 3.12+，可指定解释器路径或下载"}),
    )
}
pub async fn select(app: &Launcher, path: &Path) -> Result<Value> {
    let _python = app
        .python_gate
        .try_write()
        .map_err(|_| Error::Busy("Python 正在使用".into()))?;
    assert_idle(app).await?;
    let path = if path.is_dir() {
        path.join("python.exe")
    } else {
        path.to_path_buf()
    };
    let mut python = probe(&path).await?;
    python.source = "manual".into();
    atomic_json(&record(&app.root().await), &python)?;
    Ok(json!({"ready":true,"version":python.version,"exe":python.exe,"source":python.source}))
}
pub async fn compatible(root: &Path, runtime: &Path) -> Result<Python> {
    let python = validate(root).await?;
    if runtime.join("python-abi.json").exists() {
        let metadata: Value = read_json(&runtime.join("python-abi.json"))?;
        let abi = |v: &str| v.split('.').take(2).collect::<Vec<_>>().join(".");
        if abi(metadata["version"].as_str().unwrap_or("")) != abi(&python.version) {
            return Err(Error::Invalid(
                "Python 主次版本已改变，请重新安装此 AstrBot 版本及依赖".into(),
            ));
        }
    }
    Ok(python)
}
pub async fn assert_idle(app: &Launcher) -> Result<()> {
    let records = app.store.lock().await.index.instances.clone();
    for rec in records
        .into_iter()
        .filter(|r| r.kind == crate::domain::Kind::AstrBot)
    {
        if app.processes.active(&rec.id).await || !crate::process::port_free(rec.port).await {
            return Err(Error::Busy("请先停止 AstrBot 实例再更换 Python".into()));
        }
    }
    Ok(())
}
