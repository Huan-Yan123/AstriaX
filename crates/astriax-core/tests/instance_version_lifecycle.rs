#![cfg(windows)]
use astriax_core::{process, storage::atomic_bytes, Launcher};
use serde_json::json;
use std::{fs, sync::Arc};

#[tokio::test]
async fn running_instance_switch_restarts_owned_service_and_retains_data() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("data");
    let app = Launcher::open(dir.path().into(), root.clone(), Arc::new(|_, _| {})).unwrap();
    app.call("config:set", json!({"dataRoot":root}))
        .await
        .unwrap();
    fs::create_dir_all(root.join("runtime/python")).unwrap();
    // The offline HTTP fixture occupies the executable slot, not a real Python/AstrBot install.
    fs::copy(
        env!("CARGO_BIN_EXE_astriax-process-fixture"),
        root.join("runtime/python/python.exe"),
    )
    .unwrap();
    atomic_bytes(
        &root.join("runtime/python/python312._pth"),
        b".\nimport site\n",
    )
    .unwrap();
    for tag in ["v4.28.1", "v4.28.2"] {
        atomic_bytes(
            &root.join("runtimes/a").join(tag).join("main.py"),
            b"# fixture",
        )
        .unwrap();
    }
    let record = app
        .call(
            "instance:create",
            json!({"type":"a","name":"版本切换验证","tag":"v4.28.1"}),
        )
        .await
        .unwrap();
    let id = record["id"].as_str().unwrap();
    let instance = std::path::Path::new(record["dir"].as_str().unwrap());
    atomic_bytes(&instance.join("data/dist/index.html"), b"fixture").unwrap();
    atomic_bytes(&instance.join("data/dist/assets/version"), b"4.29.0").unwrap();
    atomic_bytes(&instance.join("data/user.db"), b"retained payload").unwrap();
    app.call("instance:start", json!(id)).await.unwrap();
    let switched = app
        .call(
            "instance:setRuntime",
            json!({"id":id,"type":"a","tag":"v4.28.2"}),
        )
        .await
        .unwrap();
    assert_eq!(switched["changed"], true);
    assert_eq!(switched["restarted"], true);
    assert_eq!(switched["from"], "v4.28.1");
    assert_eq!(switched["to"], "v4.28.2");
    assert_eq!(
        fs::read(instance.join("data/user.db")).unwrap(),
        b"retained payload"
    );
    let list = app.call("instance:list", json!(null)).await.unwrap();
    assert_eq!(list[0]["status"], "running");
    assert_eq!(list[0]["runtimeTag"], "v4.28.2");
    app.call("instance:stop", json!(id)).await.unwrap();
    assert!(process::port_free(record["port"].as_u64().unwrap() as u16).await);
}
