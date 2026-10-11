use crate::{tasks::Task, Error, Launcher, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::io::AsyncWriteExt;

pub async fn wheel_url(app: &Launcher, index: &str, filename: &str, task: &Task) -> Result<String> {
    let client = crate::network::client(app).await?;
    let target = format!("{}astrbot/", index.trim_end_matches('/').to_owned() + "/");
    let request = async {
        let response = client.get(&target).send().await?.error_for_status()?;
        let base = response.url().clone();
        let html = response.text().await?;
        find_wheel(&html, &base, filename)
    };
    tokio::select! { _ = task.token.cancelled() => Err(Error::Cancelled), result = request => result }
}

fn find_wheel(html: &str, base: &reqwest::Url, filename: &str) -> Result<String> {
    let links = regex::Regex::new(r#"(?i)href\s*=\s*["']([^"']+)["']"#).unwrap();
    for link in links.captures_iter(html) {
        let raw = link[1].replace("&amp;", "&");
        if let Ok(mut url) = base.join(&raw) {
            if url.path_segments().and_then(|mut s| s.next_back()) == Some(filename) {
                crate::sources::url(url.as_str())?;
                url.set_fragment(None);
                return Ok(url.into());
            }
        }
    }
    Err(Error::Network(format!(
        "所选 Python 源没有提供 {filename}，请换源后重试"
    )))
}

pub async fn to_file(
    app: &Launcher,
    url: &str,
    path: &Path,
    sha256: Option<&str>,
    task: &Task,
) -> Result<()> {
    crate::sources::url(url)?;
    let client = crate::network::client(app).await?;
    task.progress("downloading", "正在连接下载服务器", 0, None);
    let response = tokio::select! { _ = task.token.cancelled() => return Err(Error::Cancelled), r = client.get(url).send() => r? }.error_for_status()?;
    let total = response.content_length();
    let mut stream = response.bytes_stream();
    let mut out = tokio::fs::File::create(path).await?;
    let mut hash = Sha256::new();
    let mut got = 0;
    let mut last = std::time::Instant::now();
    loop {
        let chunk = tokio::select! { _ = task.token.cancelled() => return Err(Error::Cancelled), chunk = stream.next() => chunk };
        let Some(chunk) = chunk else {
            break;
        };
        let chunk = chunk?;
        got += chunk.len() as u64;
        if got > crate::archive::MAX_BYTES {
            return Err(Error::Invalid("下载文件超过 4 GiB".into()));
        }
        hash.update(&chunk);
        out.write_all(&chunk).await?;
        if last.elapsed().as_millis() >= 100 {
            task.progress("downloading", "下载中", got, total);
            last = std::time::Instant::now();
        }
    }
    out.sync_all().await?;
    task.check()?;
    if total.is_some_and(|n| n != got) {
        return Err(Error::Network("下载长度不完整".into()));
    }
    if let Some(expected) = sha256 {
        if !hex::encode(hash.finalize()).eq_ignore_ascii_case(expected) {
            return Err(Error::Invalid("下载文件 SHA-256 校验失败".into()));
        }
    }
    task.progress("verify", "下载已校验", got, total);
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn wheel_download_keeps_selected_index_host() {
        let base = reqwest::Url::parse("https://mirror.example/simple/astrbot/").unwrap();
        let url = super::find_wheel(
            "<a href='../../packages/astrbot-4.0-py3-none-any.whl#sha256=abc'>wheel</a>",
            &base,
            "astrbot-4.0-py3-none-any.whl",
        )
        .unwrap();
        assert_eq!(
            url,
            "https://mirror.example/packages/astrbot-4.0-py3-none-any.whl"
        );
        assert!(super::find_wheel("", &base, "missing.whl").is_err());
    }
}
