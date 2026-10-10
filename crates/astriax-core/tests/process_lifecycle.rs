#![cfg(windows)]
use astriax_core::{
    process::{self, LaunchSpec, ProcessManager},
    Launcher,
};
use serde_json::json;
use std::{collections::HashMap, sync::Arc};

fn port() -> u16 {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    listener.local_addr().unwrap().port()
}
fn spec(port: u16, child: Option<u16>, dir: &std::path::Path) -> LaunchSpec {
    let mut args = vec!["--port".into(), port.to_string()];
    if let Some(child) = child {
        args.extend(["--child-port".into(), child.to_string()]);
    }
    LaunchSpec {
        program: env!("CARGO_BIN_EXE_astriax-process-fixture").into(),
        args,
        cwd: dir.into(),
        env: HashMap::new(),
    }
}
async fn wait(port: u16) {
    for _ in 0..100 {
        if process::listening(port).await {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    panic!("fixture did not start");
}
#[tokio::test]
async fn job_stops_descendants_and_preserves_unrelated_listener() {
    let d = tempfile::tempdir().unwrap();
    let pm = ProcessManager::default();
    let (p, child) = (port(), port());
    let unrelated = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let other = unrelated.local_addr().unwrap().port();
    pm.spawn(
        "owned",
        &spec(p, Some(child), d.path()),
        d.path().join("process.log"),
    )
    .await
    .unwrap();
    wait(p).await;
    wait(child).await;
    assert!(pm.active("owned").await);
    assert!(pm.owns_port("owned", p).await.unwrap());
    assert!(pm.owns_port("owned", child).await.unwrap());
    assert!(!pm.owns_port("owned", other).await.unwrap());
    pm.stop("owned", p).await.unwrap();
    assert!(process::port_free(p).await);
    assert!(process::port_free(child).await);
    assert!(pm.stop("unknown", other).await.is_err());
    assert!(!process::port_free(other).await);
    assert!(astriax_core::logs::tail(&d.path().join("process.log"), 0)
        .unwrap()
        .contains("中文日志验证"));
}
#[tokio::test]
async fn cancellation_reaps_external_process_tree() {
    let d = tempfile::tempdir().unwrap();
    let (p, child) = (port(), port());
    let token = tokio_util::sync::CancellationToken::new();
    let cancel = token.clone();
    let launch = spec(p, Some(child), d.path());
    let log = d.path().join("pip.log");
    let worker = tokio::spawn(async move { process::run(&launch, &token, &log).await });
    wait(p).await;
    wait(child).await;
    cancel.cancel();
    assert!(matches!(
        worker.await.unwrap(),
        Err(astriax_core::Error::Cancelled)
    ));
    for _ in 0..100 {
        if process::port_free(p).await && process::port_free(child).await {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    }
    panic!("cancelled processes still own ports");
}
#[tokio::test]
async fn first_run_and_instances_use_shared_runtime_without_copy() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path().join("data");
    let app = Launcher::open(d.path().into(), root.clone(), Arc::new(|_, _| {})).unwrap();
    app.call("config:set", json!({"dataRoot":root}))
        .await
        .unwrap();
    std::fs::create_dir_all(root.join("runtime/python")).unwrap();
    std::fs::write(root.join("runtime/python/python.exe"), b"fixture").unwrap();
    std::fs::create_dir_all(root.join("runtimes/a/v4.28.1/astrbot")).unwrap();
    std::fs::write(root.join("runtimes/a/v4.28.1/astrbot/__init__.py"), b"").unwrap();
    let rec = app
        .call(
            "instance:create",
            json!({"type":"a","name":"独立实例","tag":"v4.28.1"}),
        )
        .await
        .unwrap();
    assert!(!std::path::Path::new(rec["dir"].as_str().unwrap())
        .join("runtime")
        .exists());
    let list = app.call("instance:list", json!(null)).await.unwrap();
    assert_eq!(list[0]["runtimeTag"], "v4.28.1");
    assert!(app
        .call("instance:create", json!({"type":"a","name":"独立实例"}))
        .await
        .is_err());
    let removed = app
        .call("runtimes:remove", json!({"type":"a","tag":"v4.28.1"}))
        .await
        .unwrap();
    assert_eq!(removed["usedBy"], json!(["独立实例"]));
    assert!(removed["unknownBinding"].as_array().unwrap().is_empty());
    app.call("instance:remove", rec["id"].clone())
        .await
        .unwrap();
    assert!(app
        .call("instance:list", json!(null))
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
}
