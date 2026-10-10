use crate::Desktop;
use astriax_core::{domain::Kind, Error, Result};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl,
};

const TOP: f64 = 78.;
pub async fn open(app: &AppHandle, id: &str) -> Result<Value> {
    let state = app.state::<Desktop>();
    let _gate = state.webview_gate.lock().await;
    let rec = state.launcher.store.lock().await.instance(id)?;
    if !astriax_core::process::listening(rec.port).await {
        return Err(Error::Process("实例 WebUI 尚未就绪".into()));
    }
    // Keep one upstream view so an old page cannot reappear after a switch.
    let previous = state
        .webviews
        .lock()
        .unwrap()
        .iter()
        .cloned()
        .collect::<Vec<_>>();
    for old in previous {
        close(app, &old)?;
    }
    let revision = state.webview_revision.fetch_add(1, Ordering::SeqCst) + 1;
    let window = app
        .get_window("main")
        .ok_or_else(|| Error::Process("主窗口不存在".into()))?;
    let mut url: tauri::Url = format!(
        "http://127.0.0.1:{}/{}",
        rec.port,
        if rec.kind == Kind::NapCat {
            "webui/"
        } else {
            ""
        }
    )
    .parse()
    .map_err(desktop_error)?;
    if rec.kind == Kind::NapCat {
        if let Some(token) = astriax_core::credentials::token(&rec)? {
            url.query_pairs_mut().append_pair("token", &token);
        }
    }
    let label = format!("webui-{id}");
    let port = rec.port;
    let close_app = app.clone();
    let close_id = id.to_string();
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(url))
        .on_navigation(move |url| {
            if url.scheme() == "astriax-webui-close" {
                let handle = close_app.clone();
                let id = close_id.clone();
                tauri::async_runtime::spawn(async move {
                    // Return from navigation before destroying its native controller.
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    let state = handle.state::<Desktop>();
                    let _gate = state.webview_gate.lock().await;
                    if state.webview_revision.load(Ordering::SeqCst) == revision {
                        let _ = close(&handle, &id);
                    }
                });
                return false;
            }
            url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port() == Some(port)
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .initialization_script(
            r#"window.addEventListener('keydown', event => {
            if (event.key === 'Escape' || (event.ctrlKey && event.key.toLowerCase() === 'w')) {
                event.preventDefault();
                window.location.href = 'astriax-webui-close://dismiss';
            }
        });"#,
        );
    let size = window
        .inner_size()
        .map_err(desktop_error)?
        .to_logical::<f64>(window.scale_factor().map_err(desktop_error)?);
    let view = window
        .add_child(
            builder,
            LogicalPosition::new(0., TOP),
            LogicalSize::new(size.width, (size.height - TOP).max(1.)),
        )
        .map_err(desktop_error)?;
    view.set_zoom(0.75).map_err(desktop_error)?;
    if state.webview_revision.load(Ordering::SeqCst) != revision {
        view.close().map_err(desktop_error)?;
        return Err(Error::Cancelled);
    }
    state.webviews.lock().unwrap().insert(id.into());
    *state.visible.lock().unwrap() = Some(id.into());
    Ok(json!({"ok":true}))
}
pub fn resize(window: &tauri::Window) {
    let state = window.state::<Desktop>();
    let visible = state.visible.lock().unwrap().clone();
    if let Some(view) =
        visible.and_then(|id| window.app_handle().get_webview(&format!("webui-{id}")))
    {
        if let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
            let size = size.to_logical::<f64>(scale);
            let _ = view.set_bounds(tauri::Rect {
                position: LogicalPosition::new(0., TOP).into(),
                size: LogicalSize::new(size.width, (size.height - TOP).max(1.)).into(),
            });
        }
    }
}
pub fn close(app: &AppHandle, id: &str) -> Result<Value> {
    astriax_core::domain::segment(id)?;
    app.state::<Desktop>()
        .webview_revision
        .fetch_add(1, Ordering::SeqCst);
    if let Some(view) = app.get_webview(&format!("webui-{id}")) {
        view.close().map_err(desktop_error)?;
    }
    let state = app.state::<Desktop>();
    state.webviews.lock().unwrap().remove(id);
    let mut visible = state.visible.lock().unwrap();
    if visible.as_deref() == Some(id) {
        *visible = None;
    }
    drop(visible);
    let _ = app.emit_to("main", "webui:closed", ());
    Ok(json!({"ok":true}))
}
pub fn desktop_error(e: impl std::fmt::Display) -> Error {
    Error::Process(e.to_string())
}
