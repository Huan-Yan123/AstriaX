use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Kind {
    #[serde(rename = "a")]
    AstrBot,
    #[serde(rename = "n")]
    NapCat,
}
impl Kind {
    pub fn key(self) -> &'static str {
        match self {
            Self::AstrBot => "a",
            Self::NapCat => "n",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::AstrBot => "AstrBot",
            Self::NapCat => "NapCat",
        }
    }
    pub fn ports(self) -> std::ops::RangeInclusive<u16> {
        match self {
            Self::AstrBot => 6100..=6199,
            Self::NapCat => 6200..=6299,
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: Kind,
    pub name: String,
    pub template_version: u64,
    pub port: u16,
    pub dir: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qq_account: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_started_at: Option<String>,
    #[serde(
        default,
        rename = "lastLogOffset",
        skip_serializing_if = "Option::is_none"
    )]
    pub log_start_offset: Option<u64>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InstanceIndex {
    pub instances: Vec<Instance>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    #[serde(rename = "type")]
    pub kind: Kind,
    pub tag: String,
    pub dir: String,
    pub installed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size_mb: Option<f64>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}
pub fn segment(value: &str) -> Result<&str> {
    let reserved = value.split('.').next().unwrap_or("").to_ascii_uppercase();
    if value.is_empty()
        || value.len() > 180
        || value.starts_with('.')
        || value.ends_with(['.', ' '])
        || value
            .chars()
            .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
        || matches!(reserved.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (reserved.len() == 4
            && (reserved.starts_with("COM") || reserved.starts_with("LPT"))
            && reserved.as_bytes()[3].is_ascii_digit())
    {
        return Err(Error::Invalid(format!("不合法的路径字段：{value}")));
    }
    Ok(value)
}
pub fn arg_string<'a>(p: &'a Value, key: &str) -> Result<&'a str> {
    p.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::Invalid(format!("缺少参数 {key}")))
}
pub fn parse<T: serde::de::DeserializeOwned>(p: Value) -> Result<T> {
    serde_json::from_value(p).map_err(|e| Error::Invalid(e.to_string()))
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
