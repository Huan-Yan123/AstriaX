use crate::{domain::segment, Error, Launcher, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs::File, io::Read, path::Path};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
fn valid_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|c| c.is_ascii_hexdigit())
}
pub fn valid_manifest(value: &Value) -> bool {
    value["runtime"] == "tauri"
        && value["version"]
            .as_str()
            .is_some_and(|v| v.parse::<semver::Version>().is_ok())
        && value["sha256"].as_str().is_some_and(valid_hash)
        && value["url"].as_str().is_some_and(valid_release_url)
}
pub fn valid_release_url(value: &str) -> bool {
    crate::sources::url(value).is_ok()
        && value.starts_with(crate::distribution::RELEASES)
        && value.ends_with(".exe")
        && !value.contains(['?', '#'])
        && reqwest::Url::parse(value)
            .is_ok_and(|url| url.path().starts_with("/Soffd/AstriaX/releases/download/"))
}
pub fn hash_file(file: &Path) -> Result<String> {
    let mut f = File::open(file)?;
    let mut hash = Sha256::new();
    let mut b = [0u8; 65536];
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            break;
        }
        hash.update(&b[..n]);
    }
    Ok(hex::encode(hash.finalize()))
}
pub async fn check(app: &Launcher, p: Value) -> Result<Value> {
    let last = app.store.lock().await.config["lastUpdateCheckAt"]
        .as_i64()
        .unwrap_or(0);
    let now = chrono::Utc::now().timestamp_millis();
    if p["force"] != true && now - last < 86_400_000 {
        return Ok(json!({"hasUpdate":false,"currentVersion":VERSION,"throttled":true}));
    }
    let raw = crate::distribution::MANIFEST_URL;
    let mut requests = futures_util::stream::FuturesUnordered::new();
    for prefix in crate::distribution::ACCELERATORS {
        let client = app.client.clone();
        let url = format!("{prefix}{raw}");
        requests.push(async move {
            client
                .get(url)
                .timeout(std::time::Duration::from_secs(12))
                .send()
                .await?
                .error_for_status()?
                .json::<Value>()
                .await
        });
    }
    use futures_util::StreamExt;
    let mut manifest = None;
    while let Some(response) = requests.next().await {
        if let Ok(m) = response {
            if valid_manifest(&m) {
                manifest = Some(m);
                break;
            }
        }
    }
    let mut store = app.store.lock().await;
    if let Some(m) = manifest {
        store.config["lastUpdateCheckAt"] = json!(now);
        store.save_config()?;
        let version = m["version"].as_str().unwrap();
        let newer =
            crate::runtime::versions::compare(version, VERSION, crate::domain::Kind::NapCat)
                == std::cmp::Ordering::Greater;
        let skipped = store.config["skippedAppVersion"] == version;
        Ok(
            json!({"hasUpdate":newer&&!skipped,"currentVersion":VERSION,"latestVersion":version,"url":m["url"],"sha256":m["sha256"],"sizeMB":m["sizeMB"],"notes":m["notes"],"available":true}),
        )
    } else {
        Ok(json!({"hasUpdate":false,"currentVersion":VERSION,"available":false}))
    }
}
pub async fn download(app: &Launcher, p: Value) -> Result<Value> {
    let version = segment(crate::domain::arg_string(&p, "version")?)?;
    let url = crate::domain::arg_string(&p, "url")?;
    if !valid_release_url(url) {
        return Err(Error::Invalid(
            "安装包必须来自 Soffd/AstriaX 的 Release".into(),
        ));
    }
    let sha256 = p["sha256"]
        .as_str()
        .filter(|v| valid_hash(v))
        .ok_or_else(|| Error::Invalid("更新清单缺少有效 SHA-256，无法校验安装包".into()))?;
    let root = app.root().await;
    let task = app
        .tasks
        .begin("app-update".into(), "app-update", version, app.emit.clone())?;
    let dir = dirs::download_dir().ok_or_else(|| Error::Storage("找不到系统下载目录".into()))?;
    std::fs::create_dir_all(&dir)?;
    let target = dir.join(format!("AstriaX-Tauri-{version}-setup.exe"));
    let part = tempfile::NamedTempFile::new_in(&dir)?;
    let path = part.path().to_path_buf();
    let urls = download_candidates(url);
    let result = verified_download(app, urls, &path, sha256, &task).await;
    if let Err(e) = result {
        let _ = crate::logs::audit(&root, "update:download-failed", false);
        task.progress("error", &e.to_string(), 0, None);
        return Err(e);
    }
    part.persist(&target)
        .map_err(|e| Error::Storage(e.to_string()))?;
    crate::storage::atomic_json(
        &root.join("update-download.json"),
        &json!({"path":target,"version":version,"url":url,"sha256":sha256}),
    )?;
    task.finish(&Ok(json!(target)));
    Ok(json!(target))
}
pub fn downloaded(root: &Path) -> Result<std::path::PathBuf> {
    let record: Value = crate::storage::read_json(&root.join("update-download.json"))?;
    let manifest = json!({"runtime":"tauri","version":record["version"],"url":record["url"],"sha256":record["sha256"]});
    if !valid_manifest(&manifest) {
        return Err(Error::Invalid("已下载更新的校验记录无效".into()));
    }
    let file = std::path::PathBuf::from(crate::domain::arg_string(&record, "path")?);
    let downloads =
        dirs::download_dir().ok_or_else(|| Error::Storage("找不到系统下载目录".into()))?;
    crate::storage::checked_path(&downloads, &file)?;
    if hash_file(&file)? != record["sha256"].as_str().unwrap() {
        return Err(Error::Invalid("安装包已改变，请重新下载更新".into()));
    }
    let mut magic = [0u8; 2];
    File::open(&file)?.read_exact(&mut magic)?;
    if magic != *b"MZ" {
        return Err(Error::Invalid("安装包不是 PE 文件".into()));
    }
    Ok(file)
}
pub fn pending(root: &Path) -> Result<Value> {
    if !root.join("update-download.json").is_file() {
        return Ok(Value::Null);
    }
    let record: Value = crate::storage::read_json(&root.join("update-download.json"))?;
    if crate::runtime::versions::compare(
        record["version"].as_str().unwrap_or(""),
        VERSION,
        crate::domain::Kind::NapCat,
    ) != std::cmp::Ordering::Greater
    {
        return Ok(Value::Null);
    }
    Ok(json!({"path":downloaded(root)?,"version":record["version"]}))
}
async fn verified_download(
    app: &Launcher,
    mut urls: Vec<String>,
    path: &Path,
    sha256: &str,
    task: &crate::tasks::Task,
) -> Result<()> {
    let mut failure = Error::Network("全部安装包下载源不可用".into());
    while !urls.is_empty() {
        let selected = fastest(app, urls.clone(), task).await?;
        urls.retain(|u| u != &selected);
        match crate::runtime::download::to_file(app, &selected, path, Some(sha256), task).await {
            Ok(()) => {
                let mut magic = [0u8; 2];
                File::open(path)?.read_exact(&mut magic)?;
                if magic == *b"MZ" {
                    return Ok(());
                }
                failure = Error::Invalid("下载的安装包不是 PE 文件".into());
            }
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(error) => failure = error,
        }
        task.progress("downloading", "此下载源失败，正在切换来源", 0, None);
    }
    Err(failure)
}
fn download_candidates(url: &str) -> Vec<String> {
    if url.starts_with("https://github.com/") {
        crate::distribution::ACCELERATORS
            .iter()
            .map(|prefix| format!("{prefix}{url}"))
            .collect()
    } else {
        vec![url.into()]
    }
}
async fn fastest(app: &Launcher, urls: Vec<String>, task: &crate::tasks::Task) -> Result<String> {
    use futures_util::{stream::FuturesUnordered, StreamExt};
    let mut probes = FuturesUnordered::new();
    for url in urls {
        crate::sources::url(&url)?;
        let client = app.client.clone();
        probes.push(async move {
            let response = client
                .get(&url)
                .header(reqwest::header::RANGE, "bytes=0-1")
                .timeout(std::time::Duration::from_secs(8))
                .send()
                .await?
                .error_for_status()?;
            // Verify actual file bytes, rejecting a proxy's HTML error page.
            let mut stream = response.bytes_stream();
            let mut magic = Vec::new();
            while magic.len() < 2 {
                let chunk = stream
                    .next()
                    .await
                    .ok_or_else(|| Error::Network("安装包探测没有内容".into()))??;
                magic.extend_from_slice(&chunk[..chunk.len().min(2 - magic.len())]);
            }
            if magic != b"MZ" {
                return Err(Error::Network("安装包探测不是 PE 文件".into()));
            }
            Ok::<String, Error>(url)
        });
    }
    loop {
        let next = tokio::select! { _ = task.token.cancelled() => return Err(Error::Cancelled), next = probes.next() => next };
        match next {
            Some(Ok(url)) => return Ok(url),
            Some(Err(_)) => continue,
            None => return Err(Error::Network("全部安装包下载源不可用".into())),
        }
    }
}
