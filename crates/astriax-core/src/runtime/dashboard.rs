use crate::{domain::Kind, tasks::Task, Error, Launcher, Result};
use std::{fs, path::Path};

fn ready(dir: &Path, version: &str) -> bool {
    dir.join("index.html").is_file()
        && fs::read_to_string(dir.join("assets/version"))
            .ok()
            .is_some_and(|v| {
                super::versions::compare(v.trim(), version, Kind::AstrBot)
                    != std::cmp::Ordering::Less
            })
}
pub async fn ensure(app: &Launcher, instance: &Path, version: &str, task: &Task) -> Result<()> {
    let dist = instance.join("data/dist");
    if ready(&dist, version) {
        return Ok(());
    }
    let root = app.root().await;
    let cache = root.join("cache/dashboard");
    fs::create_dir_all(&cache)?;
    let tag = crate::domain::segment(version)?;
    let archive = cache.join(format!("{tag}.zip"));
    if !archive.is_file() {
        let mut last = None;
        let mut success = false;
        for url in [format!("https://astrbot-registry.soulter.top/download/astrbot-dashboard/v{}/dist.zip",version.trim_start_matches('v')),format!("https://gh-proxy.com/https://github.com/AstrBotDevs/AstrBot/releases/download/v{0}/AstrBot-v{0}-dashboard.zip",version.trim_start_matches('v'))] {
            let part=cache.join(format!("{tag}-{}.part",uuid::Uuid::new_v4()));
            match super::download::to_file(app,&url,&part,None,task).await {
                Ok(()) => { fs::rename(&part,&archive)?; success=true; break; }
                Err(e) => { let _=fs::remove_file(part); last=Some(e); task.check()?; }
            }
        }
        if !success {
            return Err(last.unwrap_or_else(|| Error::Network("Dashboard 下载失败".into())));
        }
    }
    let stage = tempfile::Builder::new()
        .prefix(".dashboard-")
        .tempdir_in(&cache)?;
    if let Err(e) = super::install::unpack(&archive, stage.path(), task).await {
        let _ = fs::remove_file(&archive);
        return Err(e);
    }
    let payload = if stage.path().join("dist").is_dir() {
        stage.path().join("dist")
    } else {
        stage.path().to_path_buf()
    };
    if !ready(&payload, version) {
        let _ = fs::remove_file(&archive);
        return Err(Error::Invalid(
            "Dashboard 版本不匹配或缺少 assets/version".into(),
        ));
    }
    task.check()?;
    crate::transaction::replace(&root, vec![(payload, dist)])
}
