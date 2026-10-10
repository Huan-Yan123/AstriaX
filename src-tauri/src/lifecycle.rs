use crate::Desktop;
use serde_json::json;
use std::sync::atomic::Ordering;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

pub fn show(app: &AppHandle) {
    if let Some(w) = app.get_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}
pub fn quit(app: &AppHandle) {
    let state = app.state::<Desktop>();
    if state.shutdown_pending.swap(true, Ordering::SeqCst) {
        return;
    }
    let launcher = state.launcher.clone();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match astriax_core::instances::shutdown(&launcher).await {
            Ok(()) => {
                let root = launcher.root().await;
                if let Err(e) = astriax_core::storage::atomic_json(
                    &root.join("logs/session.json"),
                    &json!({"active":false}),
                ) {
                    let _ = handle.emit_to("main", "desktop:error", e.to_string());
                }
                handle
                    .state::<Desktop>()
                    .quitting
                    .store(true, Ordering::SeqCst);
                handle.exit(0);
            }
            Err(e) => {
                handle
                    .state::<Desktop>()
                    .shutdown_pending
                    .store(false, Ordering::SeqCst);
                show(&handle);
                let _ = handle.emit_to("main", "desktop:error", e.to_string());
            }
        }
    });
}
pub fn request_close(app: &AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let policy = handle.state::<Desktop>().launcher.store.lock().await.config["closePolicy"]
            .as_str()
            .map(str::to_string);
        match policy.as_deref() {
            Some("tray") => {
                if let Some(w) = handle.get_window("main") {
                    let _ = w.hide();
                }
            }
            Some("quit") => quit(&handle),
            _ => {
                let ids = handle
                    .state::<Desktop>()
                    .webviews
                    .lock()
                    .unwrap()
                    .iter()
                    .cloned()
                    .collect::<Vec<_>>();
                for id in ids {
                    let _ = crate::webui::close(&handle, &id);
                }
                let _ = handle.emit_to("main", "close:ask", ());
            }
        }
    });
}
pub fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() != "main" {
        return;
    }
    match event {
        tauri::WindowEvent::CloseRequested { api, .. } => {
            if !window.state::<Desktop>().quitting.load(Ordering::SeqCst) {
                api.prevent_close();
                request_close(window.app_handle());
            }
        }
        tauri::WindowEvent::Resized(_) => {
            crate::webui::resize(window);
            let _ = window.emit(
                "window:maximize-change",
                window.is_maximized().unwrap_or(false),
            );
        }
        _ => {}
    }
}
pub fn tray(app: &AppHandle) -> tauri::Result<()> {
    let show_item = MenuItem::with_id(app, "show", "打开 AstriaX", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出（停止全部实例）", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .tooltip("AstriaX")
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show(app),
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::DoubleClick { .. }) {
                show(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}
