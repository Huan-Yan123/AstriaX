use crate::{
    storage::{atomic_json, read_json},
    Error, Launcher, Result,
};
use serde_json::{json, Value};
use std::path::Path;

fn raw(root: &Path, python: bool) -> Result<Value> {
    let file = root.join(if python {
        "python-sources.json"
    } else {
        "mirrors.json"
    });
    if file.exists() {
        read_json(&file)
    } else {
        Ok(json!({"custom":[], "pref": if python { json!("") } else { json!({"a":"", "n":""}) }}))
    }
}
pub fn state(root: &Path, python: bool) -> Result<Value> {
    let raw = raw(root, python)?;
    let mut sources = if python {
        vec![
            json!({"label":"Python源", "indexUrl":"https://pypi.org/simple/", "jsonApi":"https://pypi.org/pypi/{pkg}/json", "builtin":true}),
            json!({"label":"腾讯源", "indexUrl":"https://mirrors.cloud.tencent.com/pypi/simple/", "builtin":true}),
        ]
    } else {
        vec![
            json!({"label":"GitHub 直连", "base":"", "mode":"proxy", "builtin":true}),
            json!({"label":"gh-proxy.com", "base":"https://gh-proxy.com/", "mode":"proxy", "builtin":true}),
            json!({"label":"cors.isteed.cc", "base":"https://cors.isteed.cc/", "mode":"proxy", "builtin":true}),
            json!({"label":"AstriaX官方源", "base":crate::distribution::FILES_BASE, "mode":"files", "builtin":true, "hideBase":true}),
        ]
    };
    sources.extend(raw["custom"].as_array().cloned().unwrap_or_default());
    Ok(if python {
        json!({"sources":sources, "pref":raw["pref"]})
    } else {
        json!({"mirrors":sources, "pref":raw["pref"]})
    })
}
pub fn url(value: &str) -> Result<String> {
    let u = reqwest::Url::parse(value).map_err(|_| Error::Invalid("源地址不合法".into()))?;
    if !matches!(u.scheme(), "http" | "https")
        || !u.username().is_empty()
        || u.password().is_some()
        || u.host_str().is_none()
    {
        return Err(Error::Invalid("仅支持不含凭据的 HTTP(S) 地址".into()));
    }
    Ok(value.trim_end_matches('/').to_string() + "/")
}
pub fn change(root: &Path, python: bool, op: &str, p: Value) -> Result<Value> {
    let mut raw = raw(root, python)?;
    let field = if python { "indexUrl" } else { "base" };
    match op {
        "add" => {
            let label = p["label"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| Error::Invalid("请输入来源名称".into()))?;
            let source_url = url(p[field].as_str().unwrap_or(""))?;
            let st = state(root, python)?;
            let all = st[if python { "sources" } else { "mirrors" }]
                .as_array()
                .unwrap();
            if all
                .iter()
                .any(|s| s[field] == source_url || s["label"] == label)
            {
                return Err(Error::Invalid("来源名称或地址已存在".into()));
            }
            let mut source = json!({"label":label, field:source_url, "builtin":false});
            if !python {
                source["mode"] = json!(p["mode"]
                    .as_str()
                    .filter(|m| matches!(*m, "proxy" | "files"))
                    .unwrap_or("proxy"));
            }
            raw["custom"]
                .as_array_mut()
                .ok_or_else(|| Error::Storage("来源文件 custom 字段无效".into()))?
                .push(source);
        }
        "remove" => {
            let selected = p
                .as_str()
                .ok_or_else(|| Error::Invalid("来源地址缺失".into()))?;
            raw["custom"]
                .as_array_mut()
                .ok_or_else(|| Error::Storage("来源文件无效".into()))?
                .retain(|s| s[field] != selected);
            if python && raw["pref"] == selected {
                raw["pref"] = json!("");
            }
            if !python {
                for kind in ["a", "n"] {
                    if raw["pref"][kind] == selected {
                        raw["pref"][kind] = json!("");
                    }
                }
            }
        }
        "pref" => {
            let st = state(root, python)?;
            let list = st[if python { "sources" } else { "mirrors" }]
                .as_array()
                .unwrap();
            if python {
                let v = p.as_str().unwrap_or("");
                if !v.is_empty() && !list.iter().any(|s| s[field] == v || s["label"] == v) {
                    return Err(Error::Invalid("来源不存在".into()));
                }
                raw["pref"] = json!(v);
            } else {
                for kind in ["a", "n"] {
                    if let Some(v) = p[kind].as_str() {
                        if !v.is_empty() && !list.iter().any(|s| s[field] == v) {
                            return Err(Error::Invalid("来源不存在".into()));
                        }
                        raw["pref"][kind] = json!(v);
                    }
                }
            }
        }
        _ => return Err(Error::Invalid("未知来源操作".into())),
    }
    atomic_json(
        &root.join(if python {
            "python-sources.json"
        } else {
            "mirrors.json"
        }),
        &raw,
    )?;
    state(root, python)
}
pub fn selected(root: &Path, python: bool, explicit: Option<&str>) -> Result<Value> {
    let st = state(root, python)?;
    let pref = if python {
        st["pref"].as_str()
    } else {
        st["pref"]["n"].as_str()
    };
    let wanted = explicit.or(pref).unwrap_or("");
    let list = st[if python { "sources" } else { "mirrors" }]
        .as_array()
        .unwrap();
    if wanted.is_empty() {
        return Ok(list[0].clone());
    }
    list.iter()
        .find(|s| s[if python { "indexUrl" } else { "base" }] == wanted || s["label"] == wanted)
        .cloned()
        .ok_or_else(|| Error::Invalid(format!("找不到指定来源 {wanted}")))
}
pub async fn test(app: &Launcher, python: bool) -> Result<Value> {
    let st = state(&app.root().await, python)?;
    let client = crate::network::client(app).await?;
    let mut pending = futures_util::stream::FuturesUnordered::new();
    for source in st[if python { "sources" } else { "mirrors" }]
        .as_array()
        .unwrap()
    {
        let source = source.clone();
        let client = client.clone();
        pending.push(async move {
            let start = std::time::Instant::now();
            let target = if python {
                format!("{}astrbot/", source["indexUrl"].as_str().unwrap())
            } else if source["mode"] == "files" {
                format!("{}versions.json", source["base"].as_str().unwrap())
            } else {
                format!(
                    "{}https://api.github.com/repos/NapNeko/NapCatQQ/releases?per_page=1",
                    source["base"].as_str().unwrap()
                )
            };
            let response = client
                .get(target)
                .timeout(std::time::Duration::from_secs(10))
                .send()
                .await;
            let result: Result<()> = async {
                let r = response?.error_for_status()?;
                if python {
                    if !r.text().await?.contains("astrbot") {
                        return Err(Error::Network("所选 Python 源没有 AstrBot 索引".into()));
                    }
                } else {
                    let v = r.json::<Value>().await?;
                    if !v.is_array() && !v["napcat"].is_array() {
                        return Err(Error::Network("所选来源返回的版本清单无效".into()));
                    }
                }
                Ok(())
            }
            .await;
            let ok = result.is_ok();
            let reason = result.err().map(|e| e.to_string()).unwrap_or_default();
            let mut result = source;
            result["ok"] = json!(ok);
            result["status"] = json!(if ok { "ok" } else { "down" });
            result["reason"] = json!(reason);
            result["ms"] = json!(start.elapsed().as_millis());
            result
        });
    }
    use futures_util::StreamExt;
    let mut result = vec![];
    while let Some(v) = pending.next().await {
        result.push(v);
    }
    Ok(json!(result))
}
