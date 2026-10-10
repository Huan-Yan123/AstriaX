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
        Self::Network(e.to_string())
    }
}
impl From<zip::result::ZipError> for Error {
    fn from(e: zip::result::ZipError) -> Self {
        Self::Invalid(e.to_string())
    }
}
pub type Result<T> = std::result::Result<T, Error>;
