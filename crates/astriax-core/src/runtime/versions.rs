use crate::{
    domain::Kind,
    storage::{atomic_json, read_json},
    Error, Launcher, Result,
};
use serde_json::{json, Value};
use std::cmp::Ordering;

pub fn compare(a: &str, b: &str, kind: Kind) -> Ordering {
    if kind == Kind::AstrBot {
        if let (Ok(a), Ok(b)) = (
            a.trim_start_matches('v').parse::<pep440_rs::Version>(),
            b.trim_start_matches('v').parse::<pep440_rs::Version>(),
        ) {
            return a.cmp(&b);
        }
    }
    if let (Ok(a), Ok(b)) = (
        a.trim_start_matches(['v', 'V']).parse::<semver::Version>(),
        b.trim_start_matches(['v', 'V']).parse::<semver::Version>(),
    ) {
        return a.cmp_precedence(&b);
    }
    let parts = |s: &str| {
        s.trim_start_matches(['v', 'V'])
            .split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let (a, b) = (parts(a), parts(b));
    for i in 0..a.len().max(b.len()) {
        let cmp = a.get(i).unwrap_or(&0).cmp(b.get(i).unwrap_or(&0));
        if cmp != Ordering::Equal {
            return cmp;
        }
    }
    Ordering::Equal
}
pub async fn list(app: &Launcher, p: Value) -> Result<Value> {
    let kind: Kind = crate::domain::parse(p["type"].clone())?;
    let root = app.root().await;
    let source = crate::sources::selected(
        &root,
        kind == Kind::AstrBot,
        p["base"].as_str().filter(|s| !s.is_empty() && *s != "pypi"),
    )?;
    let base = source[if kind == Kind::AstrBot {
        "indexUrl"
    } else {
        "base"
    }]
    .as_str()
    .unwrap_or("");
    let key = format!(
        "{}|{base}|{}",
        kind.key(),
        p["includePrerelease"].as_bool().unwrap_or(false)
    );
    let cache_file = root.join("rust-version-cache.json");
    let cache: Value = if cache_file.exists() {
        read_json(&cache_file)?
    } else {
        json!({})
    };
    if p["noCache"] != true
        && cache[&key]["at"]
            .as_i64()
            .is_some_and(|at| chrono::Utc::now().timestamp() - at < 3600)
    {
        return Ok(cache[&key]["items"].clone());
    }
    let mut items = vec![];
    if kind == Kind::AstrBot {
        let metadata = source["jsonApi"]
            .as_str()
            .unwrap_or("https://pypi.org/pypi/{pkg}/json")
            .replace("{pkg}", "astrbot");
        let data: Value = app
            .client
            .get(metadata)
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let releases = data["releases"]
            .as_object()
            .ok_or_else(|| Error::Network("PyPI 返回无效版本列表".into()))?;
        for (tag, files) in releases {
            let Ok(ver) = tag.parse::<pep440_rs::Version>() else {
                continue;
            };
            let prerelease = ver.is_pre();
            if prerelease && p["includePrerelease"] != true {
                continue;
            }
            let Some(file) = files.as_array().and_then(|a| {
                a.iter().find(|f| {
                    f["yanked"] != true
                        && f["filename"].as_str().is_some_and(|s| s.ends_with(".whl"))
                })
            }) else {
                continue;
            };
            items.push(json!({"tag":format!("v{tag}"), "assetName":"pypi:astrbot", "assetUrl":file["url"], "sha256":file["digests"]["sha256"], "sizeMB":file["size"].as_f64().unwrap_or(0.) / 1048576., "publishedAt":file["upload_time_iso_8601"], "prerelease":prerelease, "from":source["label"], "base":base, "kind":"pypi"}));
        }
    } else if source["mode"] == "files" {
        let data: Value = app
            .client
            .get(format!("{base}versions.json"))
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        for item in data["napcat"]
            .as_array()
            .ok_or_else(|| Error::Network("文件源没有 NapCat 版本清单".into()))?
        {
            let tag = crate::domain::arg_string(item, "tag")?;
            let asset = crate::domain::arg_string(item, "asset")?;
            let target = reqwest::Url::parse(base)
                .map_err(|e| Error::Invalid(e.to_string()))?
                .join(asset)
                .map_err(|e| Error::Invalid(e.to_string()))?;
            items.push(json!({"tag":tag, "assetName":asset, "assetUrl":target.as_str(), "sha256":item["sha256"], "sizeMB":item["size"].as_f64().unwrap_or(0.) / 1048576., "from":source["label"], "base":base, "kind":"zip"}));
        }
    } else {
        let data: Value = app
            .client
            .get(format!(
                "{base}https://api.github.com/repos/NapNeko/NapCatQQ/releases?per_page=100"
            ))
            .timeout(std::time::Duration::from_secs(30))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        for release in data
            .as_array()
            .ok_or_else(|| Error::Network("GitHub 返回无效版本列表".into()))?
        {
            if release["draft"] == true
                || (release["prerelease"] == true && p["includePrerelease"] != true)
            {
                continue;
            }
            let Some(asset) = release["assets"].as_array().and_then(|a| {
                a.iter().find(|a| {
                    a["name"]
                        .as_str()
                        .is_some_and(|s| s.eq_ignore_ascii_case("NapCat.Shell.zip"))
                })
            }) else {
                continue;
            };
            items.push(json!({"tag":release["tag_name"], "assetName":asset["name"], "assetUrl":format!("{base}{}",asset["browser_download_url"].as_str().unwrap_or("")), "sha256":asset["digest"].as_str().and_then(|s| s.strip_prefix("sha256:")), "sizeMB":asset["size"].as_f64().unwrap_or(0.) / 1048576., "publishedAt":release["published_at"], "prerelease":release["prerelease"], "from":source["label"], "base":base, "kind":"zip"}));
        }
    }
    items.sort_by(|a, b| {
        compare(
            b["tag"].as_str().unwrap_or(""),
            a["tag"].as_str().unwrap_or(""),
            kind,
        )
    });
    let _store = app.store.lock().await;
    let mut cache: Value = if cache_file.exists() {
        read_json(&cache_file)?
    } else {
        json!({})
    };
    cache[&key] = json!({"at":chrono::Utc::now().timestamp(), "items":items});
    atomic_json(&cache_file, &cache)?;
    Ok(json!(items))
}
