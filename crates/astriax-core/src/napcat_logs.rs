//! Upstream NapCat HTTP logs belong to QQ, not the injector's stdout.
use crate::{credentials, domain::Instance, logs, Error, Result};
use futures_util::StreamExt;
use serde_json::Value;
use std::{path::PathBuf, time::Duration};
use tokio_util::sync::CancellationToken;

const LIMIT: usize = 256 * 1024;
fn text(value: &Value, depth: usize) -> Option<&str> {
    if depth > 8 {
        return None;
    }
    if let Some(s) = value.as_str() {
        return Some(s);
    }
    for key in ["data", "text", "log", "content"] {
        if let Some(s) = value.get(key).and_then(|v| text(v, depth + 1)) {
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    None
}
pub async fn fetch(client: &reqwest::Client, port: u16, token: &str) -> Result<String> {
    for endpoint in ["GetLogRealTime", "GetLog"] {
        let response = match client
            .get(format!("http://127.0.0.1:{port}/{endpoint}"))
            .bearer_auth(token)
            .timeout(Duration::from_secs(3))
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => r,
            _ => continue,
        };
        let mut stream = response.bytes_stream();
        let mut bytes = Vec::new();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            if bytes.len() + chunk.len() > LIMIT {
                return Err(Error::Invalid("NapCat 日志响应过大".into()));
            }
            bytes.extend_from_slice(&chunk);
        }
        let decoded = logs::decode(&bytes);
        let result = match serde_json::from_str::<Value>(&decoded) {
            Ok(v) => text(&v, 0).unwrap_or("").to_string(),
            Err(_) => decoded,
        };
        if !result.is_empty() {
            return Ok(result);
        }
    }
    Ok(String::new())
}
pub fn collect(
    client: reqwest::Client,
    rec: Instance,
    file: PathBuf,
    token: CancellationToken,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut previous = String::new();
        loop {
            let operation = async {
                if let Ok(Some(auth)) = credentials::token(&rec) {
                    if let Ok(current) = fetch(&client, rec.port, &auth).await {
                        let delta = current.strip_prefix(&previous).unwrap_or(&current);
                        if !delta.trim().is_empty() {
                            let _ = logs::append(&file, format!("[napcat] {delta}\n").as_bytes());
                        }
                        previous = current;
                    }
                }
            };
            tokio::select! { _ = token.cancelled() => break, _ = operation => {} }
            tokio::select! { _ = token.cancelled() => break, _ = tokio::time::sleep(Duration::from_secs(3)) => {} }
        }
    })
}
