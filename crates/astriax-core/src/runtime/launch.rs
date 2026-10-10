use crate::{
    domain::{Instance, Kind},
    process::LaunchSpec,
    storage::runtime_ready,
    Error, Result,
};
use std::{collections::HashMap, fs, path::Path};

pub fn spec(root: &Path, rec: &Instance, runtime: &Path, qq: Option<&str>) -> Result<LaunchSpec> {
    if !runtime_ready(rec.kind, runtime) {
        return Err(Error::Invalid(format!(
            "{} 运行时不完整，请重新安装",
            rec.kind.label()
        )));
    }
    let instance = Path::new(&rec.dir);
    match rec.kind {
        Kind::AstrBot => {
            let program = super::python::exe(root);
            if !program.is_file() {
                return Err(Error::Invalid("内置 Python 尚未安装".into()));
            }
            super::python::prepare(program.parent().unwrap())?;
            if !instance.join(".astrbot").exists() {
                crate::storage::atomic_bytes(&instance.join(".astrbot"), b"")?;
            }
            let args = if runtime.join("main.py").is_file() {
                vec![
                    runtime.join("main.py").to_string_lossy().into_owned(),
                    "--port".into(),
                    rec.port.to_string(),
                ]
            } else {
                vec![
                    "-m".into(),
                    "astrbot.cli".into(),
                    "run".into(),
                    "--port".into(),
                    rec.port.to_string(),
                ]
            };
            Ok(LaunchSpec {
                program,
                args,
                cwd: instance.into(),
                env: HashMap::from([
                    ("MXBOT_SITE".into(), runtime.to_string_lossy().into_owned()),
                    ("PYTHONPATH".into(), runtime.to_string_lossy().into_owned()),
                    ("DASHBOARD_PORT".into(), rec.port.to_string()),
                    ("PYTHONUTF8".into(), "1".into()),
                    ("PYTHONUNBUFFERED".into(), "1".into()),
                    (
                        "TMP".into(),
                        root.join("tmp").to_string_lossy().into_owned(),
                    ),
                    (
                        "TEMP".into(),
                        root.join("tmp").to_string_lossy().into_owned(),
                    ),
                ]),
            })
        }
        Kind::NapCat => {
            let qq = qq.ok_or_else(|| Error::Invalid("未检测到符合要求的 QQ NT".into()))?;
            let injector = runtime.join("NapCatWinBootMain.exe");
            if !injector.is_file()
                && runtime.join("node.exe").is_file()
                && runtime.join("index.js").is_file()
            {
                return Ok(LaunchSpec {
                    program: runtime.join("node.exe"),
                    args: vec!["./index.js".into()],
                    cwd: runtime.into(),
                    env: HashMap::from([
                        ("NAPCAT_FORCE_NODE_PROCESS".into(), "1".into()),
                        ("NAPCAT_WORKDIR".into(), rec.dir.clone()),
                        ("NAPCAT_WEBUI_PREFERRED_PORT".into(), rec.port.to_string()),
                    ]),
                });
            }
            let hook = runtime.join("NapCatWinBootHook.dll");
            let main = runtime.join("napcat.mjs");
            let load = runtime.join("loadNapCat.js");
            let uri = reqwest::Url::from_file_path(&main)
                .map_err(|_| Error::Invalid("NapCat 路径无法转换为 URI".into()))?;
            let script = format!(
                "(async () => {{await import({})}})()\r\n",
                serde_json::to_string(uri.as_str())?
            );
            if fs::read_to_string(&load).ok().as_deref() != Some(&script) {
                crate::storage::atomic_bytes(&load, script.as_bytes())?;
            }
            let mut args = vec![qq.into(), hook.to_string_lossy().into_owned()];
            if let Some(account) = &rec.qq_account {
                if !(5..=12).contains(&account.len())
                    || !account.bytes().all(|c| c.is_ascii_digit())
                {
                    return Err(Error::Invalid("QQ 号必须是 5–12 位数字".into()));
                }
                args.push(account.clone());
            }
            Ok(LaunchSpec {
                program: injector.clone(),
                args,
                cwd: runtime.into(),
                env: HashMap::from([
                    (
                        "NAPCAT_PATCH_PACKAGE".into(),
                        runtime.join("qqnt.json").to_string_lossy().into_owned(),
                    ),
                    (
                        "NAPCAT_LOAD_PATH".into(),
                        load.to_string_lossy().into_owned(),
                    ),
                    (
                        "NAPCAT_INJECT_PATH".into(),
                        hook.to_string_lossy().into_owned(),
                    ),
                    (
                        "NAPCAT_LAUNCHER_PATH".into(),
                        injector.to_string_lossy().into_owned(),
                    ),
                    (
                        "NAPCAT_MAIN_PATH".into(),
                        main.to_string_lossy().into_owned(),
                    ),
                    ("NAPCAT_WORKDIR".into(), rec.dir.clone()),
                    ("NAPCAT_WEBUI_PREFERRED_PORT".into(), rec.port.to_string()),
                ]),
            })
        }
    }
}
