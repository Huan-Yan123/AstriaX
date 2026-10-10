use crate::{Error, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

pub fn probe(file: &Path) -> Result<Value> {
    let mut input = File::open(file)?;
    let size = input.metadata()?.len();
    if size > crate::archive::MAX_BYTES {
        return Err(Error::Invalid("导入包超过 4 GiB".into()));
    }
    let mut hash = Sha256::new();
    let mut buf = [0u8; 65536];
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
    }
    input.seek(SeekFrom::Start(0))?;
    let mut zip = zip::ZipArchive::new(input)?;
    let names = zip.file_names().map(str::to_string).collect::<Vec<_>>();
    let astrbot = names.iter().any(|s| s.ends_with("astrbot/__init__.py"));
    let napcat = names.iter().any(|s| s.ends_with("napcat.mjs"));
    let kind = if astrbot {
        Some("a")
    } else if napcat {
        Some("n")
    } else {
        None
    };
    let mut version = String::new();
    if astrbot {
        if let Some(name) = names
            .iter()
            .find(|s| s.to_lowercase().contains("astrbot-") && s.ends_with(".dist-info/METADATA"))
        {
            let mut text = String::new();
            zip.by_name(name)?.take(65536).read_to_string(&mut text)?;
            version = text
                .lines()
                .find_map(|s| s.strip_prefix("Version: "))
                .unwrap_or("")
                .into();
        }
    } else if napcat {
        if let Some(name) = names.iter().find(|s| s.ends_with("napcat.mjs")) {
            let mut text = String::new();
            zip.by_name(name)?
                .take(16 * 1024 * 1024)
                .read_to_string(&mut text)?;
            version = super::metadata::napcat_version(&text).unwrap_or_default();
        }
    }
    Ok(
        json!({"kind":kind,"version":version,"reason":if kind.is_some(){"已识别上游运行时"}else{"未识别后端入口；Dashboard 包不能作为运行时"},"entries":names.iter().take(100).collect::<Vec<_>>(),"sample":names.iter().take(12).collect::<Vec<_>>(),"sizeBytes":size,"sizeMB":size as f64/1048576.,"sha256":hex::encode(hash.finalize())}),
    )
}
