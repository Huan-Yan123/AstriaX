use crate::{process::LaunchSpec, Error, Launcher, Result};
use serde_json::Value;

pub fn validate(config: &Value) -> Result<()> {
    if let Some(mode) = config.get("proxyMode") {
        if !matches!(mode.as_str(), Some("system" | "direct" | "manual")) {
            return Err(Error::Invalid("网络代理模式无效".into()));
        }
    }
    if let Some(address) = config.get("proxyUrl") {
        let address = address
            .as_str()
            .ok_or_else(|| Error::Invalid("代理地址须为文本".into()))?;
        if !address.is_empty() {
            let url = reqwest::Url::parse(address).map_err(|_| {
                Error::Invalid("代理地址格式错误，请填写 http://127.0.0.1:端口".into())
            })?;
            if !matches!(url.scheme(), "http" | "https")
                || url.host_str().is_none()
                || url.port_or_known_default().is_none()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(Error::Invalid("请使用 HTTP/HTTPS 代理地址与端口".into()));
            }
        }
    }
    Ok(())
}

fn address(value: &str) -> String {
    if value.contains("://") {
        value.into()
    } else {
        format!("http://{value}")
    }
}

fn server_for(server: &str, scheme: &str) -> Option<String> {
    if !server.contains('=') {
        return (!server.trim().is_empty()).then(|| address(server.trim()));
    }
    server.split(';').find_map(|part| {
        let (protocol, value) = part.trim().split_once('=')?;
        (protocol.eq_ignore_ascii_case(scheme) && !value.is_empty()).then(|| address(value))
    })
}

#[cfg(windows)]
fn system_server() -> Option<String> {
    let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
        .ok()?;
    if key.get_value::<u32, _>("ProxyEnable").ok()? != 1 {
        return None;
    }
    key.get_value("ProxyServer").ok()
}
#[cfg(not(windows))]
fn system_server() -> Option<String> {
    None
}

fn proxy_for(config: &Value, scheme: &str, server: Option<&str>) -> Option<String> {
    match config["proxyMode"].as_str().unwrap_or("system") {
        "direct" => None,
        "manual" => config["proxyUrl"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        _ => std::env::var(format!("{}_PROXY", scheme.to_uppercase()))
            .ok()
            .or_else(|| std::env::var(format!("{scheme}_proxy")).ok())
            .or_else(|| std::env::var("ALL_PROXY").ok())
            .filter(|s| !s.is_empty())
            .or_else(|| server.and_then(|s| server_for(s, scheme))),
    }
}

pub async fn client(app: &Launcher) -> Result<reqwest::Client> {
    let config = app.store.lock().await.config.clone();
    let server = system_server();
    let http = proxy_for(&config, "http", server.as_deref());
    let https = proxy_for(&config, "https", server.as_deref());
    Ok(reqwest::Client::builder()
        .user_agent(concat!("AstriaX/", env!("CARGO_PKG_VERSION"), " Rust"))
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(600))
        .no_proxy()
        .proxy(reqwest::Proxy::custom(move |url| {
            if matches!(
                url.host_str(),
                Some("localhost" | "127.0.0.1" | "::1" | "[::1]")
            ) {
                return None;
            }
            match url.scheme() {
                "https" => https.clone(),
                "http" => http.clone(),
                _ => None,
            }
        }))
        .build()?)
}

pub async fn configure_pip(app: &Launcher, spec: &mut LaunchSpec) {
    let config = app.store.lock().await.config.clone();
    let server = system_server();
    for scheme in ["http", "https"] {
        let proxy = proxy_for(&config, scheme, server.as_deref()).unwrap_or_default();
        spec.env
            .insert(format!("{}_PROXY", scheme.to_uppercase()), proxy.clone());
        spec.env.insert(format!("{scheme}_proxy"), proxy);
    }
    // Override pip configuration and inherited catch-all proxies consistently.
    spec.env.insert("ALL_PROXY".into(), String::new());
    spec.env.insert("all_proxy".into(), String::new());
    spec.env.insert("PIP_PROXY".into(), String::new());
    spec.env
        .insert("NO_PROXY".into(), "localhost,127.0.0.1,::1".into());
    spec.env
        .insert("no_proxy".into(), "localhost,127.0.0.1,::1".into());
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn windows_proxy_formats_and_validation() {
        assert_eq!(
            server_for("127.0.0.1:7890", "https"),
            Some("http://127.0.0.1:7890".into())
        );
        assert_eq!(
            server_for("http=localhost:8080;https=localhost:8081", "https"),
            Some("http://localhost:8081".into())
        );
        assert_eq!(server_for("http=localhost:8080", "https"), None);
        assert!(
            validate(&json!({"proxyMode":"manual","proxyUrl":"http://127.0.0.1:7890"})).is_ok()
        );
        assert!(validate(&json!({"proxyUrl":"ftp://localhost"})).is_err());
        assert!(validate(&json!({"proxyMode":"unknown"})).is_err());
        assert_eq!(
            proxy_for(
                &json!({"proxyMode":"direct"}),
                "https",
                Some("localhost:7890")
            ),
            None
        );
    }
}
