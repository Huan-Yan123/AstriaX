use crate::{Error, Result};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
};

pub fn append(file: &Path, bytes: &[u8]) -> Result<()> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent)?;
    }
    // Bound the current log. Rotation retains one previous segment and offset readers fall back.
    if fs::metadata(file)
        .map(|m| m.len() > 10 * 1024 * 1024)
        .unwrap_or(false)
    {
        let old = file.with_extension("log.1");
        let _ = fs::remove_file(&old);
        let _ = fs::rename(file, old);
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)?
        .write_all(bytes)?;
    Ok(())
}
pub fn decode(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.into(),
        Err(_) => encoding_rs::GBK.decode(bytes).0.into_owned(),
    }
}
pub fn tail(file: &Path, offset: u64) -> Result<String> {
    if !file.exists() {
        return Ok(String::new());
    }
    let mut file = File::open(file)?;
    let size = file.metadata()?.len();
    let offset = if offset <= size { offset } else { 0 };
    file.seek(SeekFrom::Start(offset.max(size.saturating_sub(256 * 1024))))?;
    let mut bytes = vec![];
    file.take(256 * 1024).read_to_end(&mut bytes)?;
    Ok(decode(&bytes))
}
pub fn audit(root: &Path, channel: &str, ok: bool) -> Result<()> {
    let file = root
        .join("logs/audit")
        .join(format!("{}.log", chrono::Local::now().format("%Y-%m-%d")));
    append(
        &file,
        format!(
            "{} {} {}\n",
            crate::domain::now(),
            channel,
            if ok { "OK" } else { "ERROR" }
        )
        .as_bytes(),
    )
}
pub fn audit_days(root: &Path) -> Result<Value> {
    let dir = root.join("logs/audit");
    let mut dates = vec![];
    if dir.exists() {
        for e in fs::read_dir(dir)? {
            let name = e?.file_name().to_string_lossy().into_owned();
            if name.ends_with(".log") {
                dates.push(name.trim_end_matches(".log").to_string());
            }
        }
    }
    dates.sort_by(|a, b| b.cmp(a));
    Ok(json!(dates))
}
pub fn audit_read(root: &Path, date: Option<&str>) -> Result<Value> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let date = date.unwrap_or(&today);
    if chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").is_err() || date.len() != 10 {
        return Err(Error::Invalid("日期格式应为 YYYY-MM-DD".into()));
    }
    Ok(json!(tail(
        &root.join("logs/audit").join(format!("{date}.log")),
        0
    )?))
}
pub fn export(root: &Path) -> Result<Value> {
    let dir = root.join("logs");
    fs::create_dir_all(&dir)?;
    let target = dir.join(format!("astriax-logs-{}.zip", uuid::Uuid::new_v4()));
    let mut zip = zip::ZipWriter::new(File::create(&target)?);
    for entry in walkdir::WalkDir::new(&dir).follow_links(false) {
        let entry = entry.map_err(|e| Error::Storage(e.to_string()))?;
        if !entry.file_type().is_file() || entry.path().extension().is_some_and(|s| s == "zip") {
            continue;
        }
        crate::storage::reject_link(entry.path())?;
        let rel = entry
            .path()
            .strip_prefix(&dir)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        zip.start_file(
            rel,
            zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated),
        )?;
        std::io::copy(&mut File::open(entry.path())?, &mut zip)?;
    }
    zip.finish()?.sync_all()?;
    Ok(json!(target))
}
