//! Diagnose official/mirror catalogs and download availability in an isolated data root.
//! cargo run -p astriax-core --example probe-python [HTTP proxy URL] [--install]
use astriax_core::{runtime::python_sources, Launcher};
use serde_json::json;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
#[tokio::main]
async fn main() -> astriax_core::Result<()> {
    let dir = tempfile::tempdir()?;
    let install_requested = std::env::args().any(|arg| arg == "--install");
    let download_events = Arc::new(AtomicUsize::new(0));
    let recorded = download_events.clone();
    let app = Launcher::open(
        dir.path().into(),
        dir.path().join("data"),
        Arc::new(move |channel, p| {
            if channel == "download:progress" {
                if p["phase"] == "downloading" && p["got"].as_u64().unwrap_or(0) > 0 {
                    recorded.fetch_add(1, Ordering::Relaxed);
                }
                println!(
                    "Python progress: {}",
                    json!({"phase":p["phase"],"percent":p["percent"],"label":p["label"]})
                );
            }
        }),
    )?;
    if let Some(proxy) = std::env::args().skip(1).find(|arg| arg != "--install") {
        app.call("config:set", json!({"proxyMode":"manual","proxyUrl":proxy}))
            .await?;
    }
    let state = app.call("python:sources", serde_json::Value::Null).await?;
    for source in state["sources"].as_array().unwrap() {
        let list = app
            .call(
                "python:versions",
                json!({"base":source["base"],"noCache":true}),
            )
            .await;
        match list {
            Ok(data) => println!(
                "{}: {}",
                source["label"],
                json!({"versions":data["versions"].as_array().unwrap().iter().map(|v| &v["version"]).collect::<Vec<_>>(),"warning":data["warning"],"default":python_sources::preferred(data["versions"].as_array().unwrap())})
            ),
            Err(error) => println!("{}: {error}", source["label"]),
        }
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &app.call("python:sourceTest", serde_json::Value::Null)
                .await?
        )?
    );
    if install_requested {
        let list = app.call("python:versions", serde_json::Value::Null).await?;
        let selected = list["versions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["version"].as_str().unwrap().starts_with("3.13."))
            .ok_or_else(|| astriax_core::Error::Invalid("No 3.13 fixture version found".into()))?;
        let installed = app
            .call(
                "python:install",
                json!({"base":selected["base"],"version":selected["version"]}),
            )
            .await?;
        assert_eq!(installed["version"], selected["version"]);
        assert!(download_events.load(Ordering::Relaxed) > 0);
        println!("Isolated actual Python installation: {installed}");
    }
    Ok(())
}
