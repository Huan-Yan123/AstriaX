mod commands;
mod lifecycle;
#[cfg(debug_assertions)]
mod smoke;
mod webui;

use astriax_core::{storage, Launcher};
use serde_json::json;
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, AtomicU64},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager};

pub struct Desktop {
    launcher: Launcher,
    webviews: Mutex<HashSet<String>>,
    visible: Mutex<Option<String>>,
    webview_gate: tokio::sync::Mutex<()>,
    webview_revision: AtomicU64,
    quitting: AtomicBool,
    shutdown_pending: AtomicBool,
    last_crash: serde_json::Value,
}
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            lifecycle::show(app)
        }))
        .invoke_handler(tauri::generate_handler![commands::launcher_request])
        .setup(|app| {
            let install = if cfg!(debug_assertions) {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .join(".tauri-dev")
            } else {
                std::env::current_exe()?.parent().unwrap().to_path_buf()
            };
            std::fs::create_dir_all(&install)?;
            let pointer = std::fs::read_to_string(install.join("data-root.txt"))
                .ok()
                .map(|s| std::path::PathBuf::from(s.trim_start_matches('\u{feff}').trim()))
                .filter(|p| p.is_dir());
            let root = std::env::var_os("ASTRIAX_DATA_ROOT")
                .map(std::path::PathBuf::from)
                .or(pointer)
                .unwrap_or_else(|| install.join("data"));
            let handle = app.handle().clone();
            let launcher = Launcher::open(
                install,
                root,
                Arc::new(move |event, value| {
                    let _ = handle.emit_to("main", event, value);
                }),
            )?;
            let marker = launcher
                .store
                .blocking_lock()
                .root
                .join("logs/session.json");
            let previous = storage::read_json::<serde_json::Value>(&marker).unwrap_or_default();
            let last_crash =
                json!({"crashed":previous["active"]==true,"startedAt":previous["startedAt"]});
            storage::atomic_json(&marker, &json!({"active":true,"startedAt":chrono_now()}))?;
            app.manage(Desktop {
                launcher,
                webviews: Mutex::new(HashSet::new()),
                visible: Mutex::new(None),
                webview_gate: tokio::sync::Mutex::new(()),
                webview_revision: AtomicU64::new(0),
                quitting: AtomicBool::new(false),
                shutdown_pending: AtomicBool::new(false),
                last_crash,
            });
            lifecycle::tray(app.handle())?;
            Ok(())
        })
        .on_window_event(lifecycle::window_event)
        .build(tauri::generate_context!())
        .expect("无法初始化 AstriaX；检查数据目录与 Windows WebView2");
    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let state = handle.state::<Desktop>();
            if !state.quitting.load(std::sync::atomic::Ordering::SeqCst) {
                api.prevent_exit();
                lifecycle::quit(handle);
            }
        }
    });
}
fn chrono_now() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
