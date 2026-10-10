use crate::Desktop;
use astriax_core::{Error, Result};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Manager};

pub async fn install(app: &AppHandle) -> Result<Value> {
    let state = app.state::<Desktop>();
    let root = state.launcher.root().await;
    let installer = astriax_core::updater::downloaded(&root)?;
    if state.shutdown_pending.swap(true, Ordering::SeqCst) {
        return Err(Error::Busy("应用正在退出或更新".into()));
    }
    let result = async {
        astriax_core::instances::shutdown(&state.launcher).await?;
        astriax_core::storage::atomic_json(
            &root.join("logs/session.json"),
            &json!({"active":false}),
        )?;
        let install = state.launcher.install_dir.clone();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            std::process::Command::new(installer)
                .arg("/UPDATE")
                // NSIS requires /D= to be the last, unquoted raw argument.
                .raw_arg(format!("/D={}", install.display()))
                .spawn()?;
        }
        #[cfg(not(windows))]
        {
            let _ = (installer, install);
            return Err(Error::Unsupported("当前更新安装器仅支持 Windows".into()));
        }
        #[cfg(windows)]
        {
            state.quitting.store(true, Ordering::SeqCst);
            app.exit(0);
            Ok(Value::Null)
        }
    }
    .await;
    if result.is_err() {
        state.shutdown_pending.store(false, Ordering::SeqCst);
    }
    result
}
