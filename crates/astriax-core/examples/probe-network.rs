// Diagnose without locking or modifying the user's actual data root.
// cargo run -p astriax-core --example probe-network [HTTP proxy URL]
use astriax_core::{sources, Launcher};
use serde_json::json;
use std::sync::Arc;
#[tokio::main]
async fn main() -> astriax_core::Result<()> {
    let dir = tempfile::tempdir()?;
    let app = Launcher::open(
        dir.path().into(),
        dir.path().join("data"),
        Arc::new(|_, _| {}),
    )?;
    if let Some(proxy) = std::env::args().nth(1) {
        app.call(
            "config:set",
            json!({"proxyMode":"manual", "proxyUrl":proxy}),
        )
        .await?;
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&sources::test(&app, false).await?)?
    );
    let versions = app
        .call(
            "versions:list",
            json!({"type":"n", "base":"", "noCache":true}),
        )
        .await?;
    println!(
        "NapCat versions: {}",
        versions.as_array().map_or(0, Vec::len)
    );
    if let Some(first) = versions.as_array().and_then(|v| v.first()) {
        println!("Latest: {} ({})", first["tag"], first["assetName"]);
    }
    Ok(())
}
