use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
#[serde(tag = "code", content = "message")]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Busy(String),
    #[error("操作已取消")]
    Cancelled,
    #[error("{0}")]
    Storage(String),
    #[error("{0}")]
    Network(String),
    #[error("{0}")]
    Process(String),
    #[error("{0}")]
    Unsupported(String),
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Self::Storage(e.to_string())
    }
}
impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Self::Storage(e.to_string())
    }
}
impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        // Display includes only the request URL; retain the underlying TLS/proxy cause.
        let mut details = vec![e.to_string()];
        let mut cause = std::error::Error::source(&e);
        while let Some(error) = cause {
            let message = error.to_string();
            if !details.contains(&message) {
                details.push(message);
            }
            cause = error.source();
        }
        let detail = details.join("：");
        let category = if detail.contains("proxy authorization required") {
            "代理需要身份验证，请检查代理账号与密码"
        } else if detail.contains("certificate") || detail.contains("UnknownIssuer") {
            "TLS 证书验证失败，请检查系统信任证书和代理证书"
        } else if e.is_timeout() {
            "连接或下载超时，请检查网络与代理端口"
        } else if e.is_connect() {
            "连接失败，请检查代理是否启动、端口是否正确及网络是否可用"
        } else if e.is_status() {
            "服务器返回错误状态"
        } else if e.is_body() {
            "下载连接中断或响应不完整"
        } else {
            "网络请求失败"
        };
        Self::Network(format!("{category}：{detail}"))
    }
}
impl From<zip::result::ZipError> for Error {
    fn from(e: zip::result::ZipError) -> Self {
        Self::Invalid(e.to_string())
    }
}
pub type Result<T> = std::result::Result<T, Error>;
