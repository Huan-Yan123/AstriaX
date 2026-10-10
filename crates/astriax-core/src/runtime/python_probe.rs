//! Probe the interpreter itself; directory names and registry labels are not versions.
use crate::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Python {
    pub exe: PathBuf,
    pub version: String,
    pub bits: u16,
    pub implementation: String,
    pub pip: bool,
    #[serde(default)]
    pub source: String,
}
pub fn supported(python: &Python) -> bool {
    let numbers: Vec<u32> = python
        .version
        .split('.')
        .filter_map(|v| v.parse().ok())
        .collect();
    numbers.len() >= 2
        && (numbers[0], numbers[1]) >= (3, 12)
        && python.bits == 64
        && python.implementation == "cpython"
        && python.pip
}
pub async fn probe(path: &Path) -> Result<Python> {
    let mut command = tokio::process::Command::new(path);
    command.args(["-I", "-c", "import sys,struct,json,importlib.util;print(json.dumps(dict(exe=sys.executable,version='.'.join(map(str,sys.version_info[:3])),bits=struct.calcsize('P')*8,implementation=sys.implementation.name,pip=importlib.util.find_spec('pip') is not None)))"])
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(std::time::Duration::from_secs(4), command.output())
        .await
        .map_err(|_| Error::Process("Python 检测超时".into()))??;
    if !output.status.success() {
        return Err(Error::Invalid("Python 解释器无法运行".into()));
    }
    let python: Python = serde_json::from_slice(&output.stdout)
        .map_err(|_| Error::Invalid("Python 未返回有效的解释器信息".into()))?;
    if !supported(&python) {
        return Err(Error::Invalid(format!(
            "需要 64 位 CPython 3.12 或更高版本且包含 pip；检测到 {}（{} 位，pip={}）",
            python.version, python.bits, python.pip
        )));
    }
    if !python.exe.is_file() {
        return Err(Error::Invalid("Python 返回的解释器路径无效".into()));
    }
    Ok(python)
}
