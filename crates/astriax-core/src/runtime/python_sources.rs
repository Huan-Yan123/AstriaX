//! Python interpreter archives are separate from the PyPI package indexes.
use crate::{
    storage::{atomic_json, read_json},
    Error, Launcher, Result,
};
use futures_util::{stream, StreamExt};
use serde_json::{json, Value};
use std::{
    path::Path,
    time::{Duration, Instant},
};

const FILE: &str = "python-runtime-sources.json";
const CACHE: &str = "python-runtime-cache.json";

pub fn state(root: &Path) -> Result<Value> {
    let raw: Value = if root.join(FILE).exists() {
        read_json(&root.join(FILE))?
    } else {
        json!({"custom":[],"pref":""})
    };
    let mut sources = vec![
        json!({"label":"Python 官方","base":"https://www.python.org/ftp/python/","builtin":true}),
        json!({"label":"华为云镜像","base":"https://mirrors.huaweicloud.com/python/","builtin":true}),
    ];
    sources.extend(raw["custom"].as_array().cloned().unwrap_or_default());
    let pref = raw["pref"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("https://www.python.org/ftp/python/");
    Ok(json!({"sources":sources,"pref":pref}))
}

pub fn selected(root: &Path, explicit: Option<&str>) -> Result<Value> {
    let st = state(root)?;
    let base = explicit.unwrap_or(st["pref"].as_str().unwrap());
    st["sources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["base"] == base)
        .cloned()
        .ok_or_else(|| Error::Invalid("Python 下载源不存在，请重新选择".into()))
}

pub fn change(root: &Path, op: &str, p: Value) -> Result<Value> {
    let mut raw: Value = if root.join(FILE).exists() {
        read_json(&root.join(FILE))?
    } else {
        json!({"custom":[],"pref":""})
    };
    let st = state(root)?;
    let custom = raw["custom"]
        .as_array_mut()
        .ok_or_else(|| Error::Storage("Python 下载源配置无效".into()))?;
    match op {
        "sourceAdd" => {
            let label = p["label"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| Error::Invalid("请填写源名称".into()))?
                .trim();
            let base = crate::sources::url(p["base"].as_str().unwrap_or(""))?;
            let url = reqwest::Url::parse(&base).unwrap();
            if url.query().is_some() || url.fragment().is_some() {
                return Err(Error::Invalid(
                    "请填写 Python 文件目录地址，不包含查询参数或锚点".into(),
                ));
            }
            if st["sources"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["base"] == base || s["label"] == label)
            {
                return Err(Error::Invalid("源名称或地址已存在".into()));
            }
            custom.push(json!({"label":label,"base":base,"builtin":false}));
        }
        "sourceRemove" => {
            let base = p
                .as_str()
                .ok_or_else(|| Error::Invalid("源地址缺失".into()))?;
            if st["sources"]
                .as_array()
                .unwrap()
                .iter()
                .any(|s| s["base"] == base && s["builtin"] == true)
            {
                return Err(Error::Invalid("内置源不能删除".into()));
            }
            custom.retain(|s| s["base"] != base);
            if raw["pref"] == base {
                raw["pref"] = json!("");
            }
        }
        "sourcePref" => {
            let base = p
                .as_str()
                .ok_or_else(|| Error::Invalid("源地址缺失".into()))?;
            selected(root, Some(base))?;
            raw["pref"] = json!(base);
        }
        _ => return Err(Error::Invalid("未知 Python 下载源操作".into())),
    }
    atomic_json(&root.join(FILE), &raw)?;
    state(root)
}

pub fn version(value: &str) -> Result<semver::Version> {
    let v =
        semver::Version::parse(value).map_err(|_| Error::Invalid("Python 版本号无效".into()))?;
    if (v.major, v.minor) < (3, 12) || !v.pre.is_empty() || !v.build.is_empty() {
        return Err(Error::Invalid("请选择 Python 3.12+ 正式版".into()));
    }
    Ok(v)
}

fn links(html: &str, base: &reqwest::Url) -> Vec<reqwest::Url> {
    let regex = regex::Regex::new(r#"(?i)href\s*=\s*["']([^"']+)["']"#).unwrap();
    regex
        .captures_iter(html)
        .filter_map(|c| base.join(&c[1].replace("&amp;", "&")).ok())
        .filter(|u| {
            u.origin() == base.origin()
                && u.path().starts_with(base.path())
                && u.query().is_none()
                && u.fragment().is_none()
                && u.username().is_empty()
                && u.password().is_none()
        })
        .collect()
}

fn directories(html: &str, base: &str) -> Result<Vec<String>> {
    let base = reqwest::Url::parse(base).map_err(|e| Error::Invalid(e.to_string()))?;
    let mut versions: Vec<_> = links(html, &base)
        .into_iter()
        .filter_map(|u| {
            let relative = u.path().strip_prefix(base.path())?.trim_end_matches('/');
            if relative.contains('/') {
                return None;
            }
            version(relative).ok()
        })
        .collect();
    versions.sort_by(|a, b| b.cmp(a));
    versions.dedup();
    if versions.len() > 300 {
        return Err(Error::Network(
            "源目录包含过多版本，请使用 Python 下载目录".into(),
        ));
    }
    Ok(versions.iter().map(ToString::to_string).collect())
}

async fn index(client: &reqwest::Client, url: &str) -> Result<String> {
    let response = client
        .get(url)
        .timeout(Duration::from_secs(15))
        .send()
        .await?
        .error_for_status()?;
    let mut stream = response.bytes_stream();
    let mut data = Vec::new();
    while let Some(chunk) = stream.next().await {
        data.extend_from_slice(&chunk?);
        if data.len() > 2 * 1024 * 1024 {
            return Err(Error::Network("源目录响应超过 2 MiB".into()));
        }
    }
    String::from_utf8(data).map_err(|_| Error::Network("Python 源没有返回有效的目录列表".into()))
}

async fn item(client: &reqwest::Client, base: &str, ver: &str) -> Result<Option<Value>> {
    version(ver)?;
    let dir = format!("{base}{ver}/");
    let html = index(client, &dir).await?;
    let expected = format!("python-{ver}-embed-amd64.zip");
    let url = reqwest::Url::parse(&dir).unwrap();
    Ok(links(&html, &url)
        .into_iter()
        .find(|u| u.path() == format!("{}{expected}", url.path()))
        .map(|u| json!({"version":ver,"assetName":expected,"assetUrl":u.as_str(),"base":base})))
}

pub fn preferred(items: &[Value]) -> Option<&Value> {
    // Retain the established 3.12 ABI by default; users may explicitly choose newer versions.
    items
        .iter()
        .find(|v| {
            v["version"]
                .as_str()
                .is_some_and(|v| v.starts_with("3.12."))
        })
        .or_else(|| items.first())
}

async fn catalog(client: &reqwest::Client, base: &str) -> Result<Value> {
    let dirs = directories(&index(client, base).await?, base)?;
    if dirs.is_empty() {
        return Err(Error::Network("源没有提供 Python 3.12+ 版本目录".into()));
    }
    let mut requests = stream::iter(
        dirs.into_iter()
            .map(|ver| async move { item(client, base, &ver).await }),
    )
    .buffer_unordered(6);
    let mut items = vec![];
    let mut failures = vec![];
    while let Some(result) = requests.next().await {
        match result {
            Ok(Some(v)) => items.push(v),
            Ok(None) => {}
            Err(e) => failures.push(e.to_string()),
        }
    }
    items.sort_by(|a, b| {
        version(b["version"].as_str().unwrap())
            .unwrap()
            .cmp(&version(a["version"].as_str().unwrap()).unwrap())
    });
    if items.is_empty() {
        return Err(Error::Network(format!(
            "该源没有可下载的 Windows 64 位 Python 嵌入式包{}",
            failures
                .first()
                .map(|e| format!("：{e}"))
                .unwrap_or_default()
        )));
    }
    let warning = if failures.is_empty() {
        String::new()
    } else {
        format!(
            "{} 个版本目录读取失败，当前列表可能不完整：{}",
            failures.len(),
            failures[0]
        )
    };
    Ok(json!({"versions":items,"warning":warning}))
}

pub async fn versions(app: &Launcher, p: Value) -> Result<Value> {
    let root = app.root().await;
    let source = selected(&root, p["base"].as_str())?;
    let base = source["base"].as_str().unwrap();
    let cache_file = root.join(CACHE);
    let cache: Value = read_json(&cache_file)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let cached = &cache[base]["data"];
    let valid = cached["versions"].as_array().is_some_and(|items| {
        !items.is_empty()
            && items.iter().all(|v| {
                v["version"].as_str().is_some_and(|ver| {
                    version(ver).is_ok()
                        && v["base"] == base
                        && v["assetUrl"] == format!("{base}{ver}/python-{ver}-embed-amd64.zip")
                })
            })
    });
    if p["noCache"] != true
        && cache[base]["at"]
            .as_i64()
            .is_some_and(|at| (0..3600).contains(&(chrono::Utc::now().timestamp() - at)))
        && valid
    {
        return Ok(cache[base]["data"].clone());
    }
    let data = catalog(&crate::network::client(app).await?, base).await?;
    let _store = app.store.lock().await;
    let mut cache: Value = read_json(&cache_file)
        .ok()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    cache[base] = json!({"at":chrono::Utc::now().timestamp(),"data":data});
    atomic_json(&cache_file, &cache)?;
    Ok(data)
}

pub async fn resolve(app: &Launcher, p: &Value) -> Result<Value> {
    let source = selected(&app.root().await, p["base"].as_str())?;
    if let Some(ver) = p["version"].as_str() {
        return item(
            &crate::network::client(app).await?,
            source["base"].as_str().unwrap(),
            ver,
        )
        .await?
        .ok_or_else(|| Error::Network("所选源没有此版本的 Windows 64 位嵌入式包".into()));
    }
    let list = versions(app, json!({"base":source["base"]})).await?;
    preferred(list["versions"].as_array().unwrap())
        .cloned()
        .ok_or_else(|| Error::Network("没有可下载的 Python 版本".into()))
}

async fn sample(client: &reqwest::Client, url: &str) -> Result<()> {
    let response = client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-3")
        .timeout(Duration::from_secs(10))
        .send()
        .await?
        .error_for_status()?;
    let mut stream = response.bytes_stream();
    let mut prefix = Vec::new();
    while prefix.len() < 4 {
        let chunk = stream
            .next()
            .await
            .ok_or_else(|| Error::Network("下载包响应不完整".into()))??;
        prefix.extend_from_slice(&chunk[..chunk.len().min(4 - prefix.len())]);
    }
    if prefix != b"PK\x03\x04" {
        return Err(Error::Network(
            "下载地址返回的不是 ZIP 包，可能是拦截或登录页面".into(),
        ));
    }
    Ok(())
}

pub async fn test(app: &Launcher) -> Result<Value> {
    let st = state(&app.root().await)?;
    let mut pending = stream::iter(st["sources"].as_array().unwrap().iter().cloned().map(
        |source| async move {
            let mut successes = 0;
            let mut elapsed = 0;
            let mut reasons = vec![];
            let data = versions(app, json!({"base":source["base"]})).await;
            match data {
                Ok(data) => {
                    let chosen = preferred(data["versions"].as_array().unwrap()).unwrap();
                    match crate::network::client(app).await {
                        Ok(client) => {
                            for _ in 0..3 {
                                let start = Instant::now();
                                match sample(&client, chosen["assetUrl"].as_str().unwrap()).await {
                                    Ok(()) => {
                                        successes += 1;
                                        elapsed += start.elapsed().as_millis();
                                    }
                                    Err(e) => reasons.push(e.to_string()),
                                }
                            }
                        }
                        Err(e) => reasons.push(e.to_string()),
                    }
                }
                Err(e) => reasons.push(e.to_string()),
            }
            let mut result = source;
            result["status"] = json!(if successes == 3 {
                "ok"
            } else if successes > 0 {
                "unstable"
            } else {
                "down"
            });
            result["successes"] = json!(successes);
            result["attempts"] = json!(3);
            result["ms"] = json!(elapsed.checked_div(successes));
            result["reason"] = json!(reasons.first().cloned().unwrap_or_default());
            result
        },
    ))
    .buffer_unordered(3);
    let mut results = vec![];
    while let Some(result) = pending.next().await {
        results.push(result);
    }
    Ok(json!(results))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    async fn connection_test_rejects_html_even_with_http_success() {
        for body in [b"PK\x03\x04".as_slice(), b"<html>blocked</html>".as_slice()] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}/python.zip", listener.local_addr().unwrap());
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .into_bytes()
            .into_iter()
            .chain(body.iter().copied())
            .collect::<Vec<_>>();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0; 4096];
                let count = socket.read(&mut request).await.unwrap();
                assert!(String::from_utf8_lossy(&request[..count])
                    .to_lowercase()
                    .contains("range: bytes=0-3"));
                socket.write_all(&response).await.unwrap();
            });
            let result = sample(
                &reqwest::Client::builder().no_proxy().build().unwrap(),
                &url,
            )
            .await;
            assert_eq!(result.is_ok(), body == b"PK\x03\x04");
            if let Err(error) = result {
                assert!(error.to_string().contains("不是 ZIP"));
            }
            server.await.unwrap();
        }
    }
    #[test]
    fn extracts_only_supported_stable_versions_inside_the_source() {
        let items = directories(r#"<a href='3.12.10/'>a</a><a href='3.14.1/'>b</a><a href='3.11.9/'>old</a><a href='3.15.0rc1/'>pre</a><a href='https://other.test/3.14.2/'>escape</a><a href='../3.14.3/'>escape</a>"#, "https://source.test/python/").unwrap();
        assert_eq!(items, vec!["3.14.1", "3.12.10"]);
    }
}
