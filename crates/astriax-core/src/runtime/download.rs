use crate::{tasks::Task, Error, Launcher, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use std::path::Path;
use tokio::io::AsyncWriteExt;

pub async fn to_file(
    app: &Launcher,
    url: &str,
    path: &Path,
    sha256: Option<&str>,
    task: &Task,
) -> Result<()> {
    crate::sources::url(url)?;
    let response = tokio::select! { _ = task.token.cancelled() => return Err(Error::Cancelled), r = app.client.get(url).send() => r? }.error_for_status()?;
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
