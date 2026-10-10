use crate::{lifecycle, webui, Desktop};
use astriax_core::{domain::arg_string, Error, Result};
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Manager, State, Webview};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
pub async fn launcher_request(
    app: AppHandle,
    webview: Webview,
    state: State<'_, Desktop>,
    channel: String,
    payload: Value,
) -> Result<Value> {
    // Custom commands are checked explicitly: capabilities alone do not restrict every custom command.
    if webview.label() != "main" {
        return Err(Error::Invalid("第三方 WebUI 无权调用启动器接口".into()));
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| Error::Process("主窗口不存在".into()))?;
    let text = || {
        payload
            .as_str()
            .ok_or_else(|| Error::Invalid("缺少字符串参数".into()))
    };
    match channel.as_str() {
        "desktop:ready" => {
            #[cfg(debug_assertions)]
            {
                return crate::smoke::ready(&app, payload).await;
            }
            #[cfg(not(debug_assertions))]
            {
                Ok(Value::Null)
            }
        }
        "desktop:finish" => {
            #[cfg(debug_assertions)]
            {
                return crate::smoke::finish(&app).await;
            }
            #[cfg(not(debug_assertions))]
            {
                Ok(Value::Null)
            }
        }
        "window:minimize" => {
            window.minimize().map_err(webui::desktop_error)?;
            Ok(Value::Null)
        }
        "window:toggleMaximize" => {
            if window.is_maximized().map_err(webui::desktop_error)? {
                window.unmaximize()
            } else {
                window.maximize()
            }
            .map_err(webui::desktop_error)?;
            Ok(Value::Null)
        }
        "window:isMaximized" => Ok(json!(window
            .is_maximized()
            .map_err(webui::desktop_error)?)),
        "window:close" => {
            lifecycle::request_close(&app);
            Ok(Value::Null)
        }
        "close:answer" => {
            match text()? {
                "tray" => window.hide().map_err(webui::desktop_error)?,
                "quit" => lifecycle::quit(&app),
                _ => return Err(Error::Invalid("关闭策略无效".into())),
            }
            Ok(Value::Null)
        }
        "dialog:pickDataDir" | "runtimes:pickFile" | "python:pickFile" => {
            let folder = channel == "dialog:pickDataDir";
            let python = channel == "python:pickFile";
            let handle = app.clone();
            let selected = tauri::async_runtime::spawn_blocking(move || {
                let picker = handle.dialog().file();
                if folder {
                    picker.blocking_pick_folder()
                } else if python {
                    picker
                        .add_filter("Python 解释器", &["exe"])
                        .blocking_pick_file()
                } else {
                    picker
                        .add_filter("运行时压缩包", &["zip", "whl"])
                        .blocking_pick_file()
                }
            })
            .await
            .map_err(webui::desktop_error)?;
            match selected {
                Some(file) => Ok(json!(file.into_path().map_err(webui::desktop_error)?)),
                None => Ok(Value::Null),
            }
        }
        "app:openExternal" => {
            let url = text()?;
            astriax_core::sources::url(url)?;
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(webui::desktop_error)?;
            Ok(Value::Null)
        }
        "shell:showItem" | "backup:openFolder" => {
            let file = Path::new(text()?);
            let root = state.launcher.root().await;
            let downloads = app.path().download_dir().map_err(webui::desktop_error)?;
            if astriax_core::storage::checked_path(&root, file).is_err()
                && astriax_core::storage::checked_path(&downloads, file).is_err()
            {
                return Err(Error::Invalid("路径不属于数据目录或下载目录".into()));
            }
            if channel == "shell:showItem" {
                app.opener()
                    .reveal_item_in_dir(file)
                    .map_err(webui::desktop_error)?;
            } else {
                app.opener()
                    .open_path(file.to_string_lossy(), None::<&str>)
                    .map_err(webui::desktop_error)?;
            }
            Ok(Value::Null)
        }
        "webui:open" => webui::open(&app, text()?).await,
        "webui:close" => webui::close(&app, text()?),
        "webui:list" => Ok(json!(state
            .webviews
            .lock()
            .unwrap()
            .iter()
            .collect::<Vec<_>>())),
        "webui:visible" => Ok(json!(state.visible.lock().unwrap().clone())),
        "app:lastCrash" => Ok(state.last_crash.clone()),
        "app:installUpdate" => crate::update::install(&app).await,
        _ => {
            let id = match channel.as_str() {
                "instance:stop" | "instance:remove" => payload.as_str().map(str::to_string),
                "instance:setRuntime" => Some(arg_string(&payload, "id")?.into()),
                "backup:restore" => Some(arg_string(&payload, "instanceId")?.into()),
                _ => None,
            };
            let result = state.launcher.call(&channel, payload).await?;
            if let Some(id) = id {
                let _ = webui::close(&app, &id);
            }
            Ok(result)
        }
    }
}
