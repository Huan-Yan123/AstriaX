//! Prepare release metadata locally; uploading/publishing is a separate explicit action.
use astriax_core::{storage::atomic_json, updater::hash_file, Error, Result};
use serde_json::json;
use std::{fs, path::Path};

fn prepare(args: &[String]) -> Result<()> {
    if args.len() < 4 {
        return Err(Error::Invalid(
            "Usage: astriax-release <installer.exe> <version> <manifest.json> [notes.txt]".into(),
        ));
    }
    let installer = Path::new(&args[1]);
    let version = astriax_core::domain::segment(&args[2])?;
    let name = installer
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| Error::Invalid("安装包名称无效".into()))?;
    if !name.ends_with(".exe") || !installer.is_file() {
        return Err(Error::Invalid("请选择 Tauri 安装包 exe".into()));
    }
    let mut url =
        reqwest::Url::parse("https://github.com/Huan-Yan123/AstriaX/releases/download/").unwrap();
    url.path_segments_mut()
        .unwrap()
        .pop_if_empty()
        .push(&format!("v{version}"))
        .push(name);
    let notes = args
        .get(4)
        .map(fs::read_to_string)
        .transpose()?
        .unwrap_or_default();
    atomic_json(
        Path::new(&args[3]),
        &json!({"runtime":"tauri","version":version,"url":url.as_str(),"sha256":hash_file(installer)?,"sizeMB":fs::metadata(installer)?.len() as f64 / 1048576.,"notes":notes}),
    )?;
    println!("{}", args[3]);
    Ok(())
}
fn main() {
    if let Err(error) = prepare(&std::env::args().collect::<Vec<_>>()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
