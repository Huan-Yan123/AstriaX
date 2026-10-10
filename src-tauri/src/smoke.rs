//! Debug-only desktop verification. Never included in release builds.
use crate::{webui, Desktop};
use astriax_core::{Error, Result};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub async fn ready(app: &AppHandle, payload: Value) -> Result<Value> {
    if std::env::var("ASTRIAX_SMOKE_TEST").as_deref() != Ok("1") {
        return Ok(Value::Null);
    }
    if payload["ping"] != "pong" {
        return Err(Error::Process("Vue 到 Rust 的 ping 验证失败".into()));
    }
    let state = app.state::<Desktop>();
    let root = state.launcher.root().await;
    let embedded = std::env::var("ASTRIAX_WEBUI_SMOKE").as_deref() == Ok("1");
    if embedded {
        webui::open(app, "a_smoke").await?;
        let view = app
            .get_webview("webui-a_smoke")
            .ok_or_else(|| Error::Process("未创建内嵌 WebUI".into()))?;
        if view.window().label() != "main" {
            return Err(Error::Process("WebUI 未嵌入主窗口".into()));
        }
        for _ in 0..100 {
            if root.join("remote-unsafe.txt").exists() {
                return Err(Error::Process("第三方页面获得了启动器权限".into()));
            }
            if root.join("remote-denied.txt").exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        if !root.join("remote-denied.txt").exists() {
            return Err(Error::Process("第三方页面权限验证超时".into()));
        }
        for _ in 0..100 {
            if app.get_webview("webui-a_smoke").is_none() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        if app.get_webview("webui-a_smoke").is_some() {
            return Err(Error::Process("内嵌 WebUI 的 Esc 关闭验证超时".into()));
        }
        state.launcher.store.lock().await.index.instances.clear();
    }
    astriax_core::storage::atomic_json(
        &root.join("smoke.json"),
        &json!({"vueBridge":true,"ping":payload["ping"],"embeddedWebui":embedded,"remoteDenied":embedded,"webuiShortcut":embedded}),
    )?;
    Ok(json!({"smokePending":true}))
}
pub async fn finish(app: &AppHandle) -> Result<Value> {
    if std::env::var("ASTRIAX_SMOKE_TEST").as_deref() == Ok("1") {
        let root = app.state::<Desktop>().launcher.root().await;
        let mut report: Value = astriax_core::storage::read_json(&root.join("smoke.json"))?;
        report["mainCommandsAfterWebui"] = json!(true);
        astriax_core::storage::atomic_json(&root.join("smoke.json"), &report)?;
        crate::lifecycle::quit(app);
    }
    Ok(Value::Null)
}
