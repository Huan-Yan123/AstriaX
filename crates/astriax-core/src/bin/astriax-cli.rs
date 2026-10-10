use astriax_core::{Error, Launcher};
use std::sync::Arc;
#[tokio::main]
async fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() < 3 {
        eprintln!("Usage: astriax-cli <isolated-data-root> <channel> [json-payload]");
        std::process::exit(2);
    }
    let root = std::path::PathBuf::from(&args[1]);
    let parent = root.parent().unwrap_or(std::path::Path::new("."));
    let result = async {
        let app = Launcher::open(
            parent.into(),
            root.clone(),
            Arc::new(|event, payload| {
                eprintln!("{}", serde_json::json!({"event":event,"payload":payload}));
            }),
        )?;
        let payload = serde_json::from_str(args.get(3).map(String::as_str).unwrap_or("null"))
            .map_err(|e| Error::Invalid(e.to_string()))?;
        let output = app.call(&args[2], payload).await?;
        println!("{}", serde_json::to_string_pretty(&output)?);
        if args[2] == "instance:start" {
            tokio::signal::ctrl_c().await?;
            astriax_core::instances::shutdown(&app).await?;
        }
        Ok::<(), Error>(())
    }
    .await;
    if let Err(error) = result {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
