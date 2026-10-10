mod migration;
use crate::{
    storage::{atomic_bytes, atomic_json},
    Error, Launcher, Result,
};
pub use migration::move_root;
use serde_json::{json, Value};
use std::path::Path;

pub async fn set(app: &Launcher, p: Value) -> Result<Value> {
    if !p.is_object() {
        return Err(Error::Invalid("配置必须是对象".into()));
    }
    validate(&p)?;
    if let Some(root) = p["dataRoot"].as_str() {
        if Path::new(root) != app.root().await {
            move_root(app, root).await?;
        }
    }
    let _gate = app.root_gate.write().await;
    let mut store = app.store.lock().await;
    let mut config = store.config.clone();
    if !config.is_object() {
        return Err(Error::Storage("config.json 不是对象".into()));
    }
    for (k, v) in p.as_object().unwrap() {
        if k != "dataRoot" {
            config[k] = v.clone();
        }
    }
    config["dataRoot"] = json!(store.root);
    if config["backupKeep"].is_null() {
        config["backupKeep"] = json!(5);
    }
    if config["portMin"].is_null() {
        config["portMin"] = json!(6100);
    }
    if config["portMax"].is_null() {
        config["portMax"] = json!(6199);
    }
    atomic_json(&store.root.join("config.json"), &config)?;
    store.config = config.clone();
    atomic_bytes(
        &app.install_dir.join("data-root.txt"),
        store.root.to_string_lossy().as_bytes(),
    )?;
    Ok(config)
}

fn validate(p: &Value) -> Result<()> {
    for (k, v) in p.as_object().unwrap() {
        match k.as_str() {
            "closePolicy" => {
                if !matches!(v.as_str(), Some("tray" | "quit")) {
                    return Err(Error::Invalid("关闭策略无效".into()));
                }
            }
            "backupKeep" => {
                if !v.as_u64().is_some_and(|n| (1..=100).contains(&n)) {
                    return Err(Error::Invalid("备份保留数量须为 1–100".into()));
                }
            }
            "portMin" | "portMax" => {
                if !v.as_u64().is_some_and(|n| (1..=65535).contains(&n)) {
                    return Err(Error::Invalid("端口无效".into()));
                }
            }
            "dataRoot" => {}
            _ => {}
        }
    }
    Ok(())
}
