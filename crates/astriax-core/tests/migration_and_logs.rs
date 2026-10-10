use astriax_core::{
    storage::{atomic_json, Store},
    Launcher,
};
use serde_json::json;
use std::{fs, sync::Arc};

#[tokio::test]
async fn migration_commits_verified_copy_and_retains_source() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("原数据");
    let target = directory.path().join("新数据");
    let app = Launcher::open(directory.path().into(), source.clone(), Arc::new(|_, _| {})).unwrap();
    app.call(
        "config:set",
        json!({"dataRoot":source,"customField":"保留"}),
    )
    .await
    .unwrap();
    fs::create_dir_all(source.join("data/plugins")).unwrap();
    fs::write(source.join("data/plugins/中文.txt"), "上游文件").unwrap();
    app.call("config:moveDataRoot", json!(target))
        .await
        .unwrap();
    assert_eq!(app.root().await, target);
    assert_eq!(
        app.call("config:get", json!(null)).await.unwrap()["customField"],
        "保留"
    );
    assert_eq!(
        fs::read(source.join("data/plugins/中文.txt")).unwrap(),
        fs::read(target.join("data/plugins/中文.txt")).unwrap()
    );
    assert!(Store::open(target).is_err());
    assert!(Store::open(source).is_ok());
}

#[tokio::test]
async fn bad_patch_and_failed_copy_leave_old_root_selected_and_target_reusable() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    let target = directory.path().join("target");
    let app = Launcher::open(directory.path().into(), source.clone(), Arc::new(|_, _| {})).unwrap();
    assert!(app
        .call("config:set", json!({"dataRoot":target,"backupKeep":0}))
        .await
        .is_err());
    assert!(!target.exists());
    fs::write(source.join("instances.json"), b"broken json").unwrap();
    assert!(app
        .call("config:moveDataRoot", json!(target))
        .await
        .is_err());
    assert_eq!(app.root().await, source);
    assert!(!target.join("instances.json").exists());
    atomic_json(&source.join("instances.json"), &json!({"instances":[]})).unwrap();
    app.call("config:moveDataRoot", json!(target))
        .await
        .unwrap();
}

#[tokio::test]
async fn migration_does_not_overwrite_existing_target_or_nested_root() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    let target = directory.path().join("target");
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("private.txt"), "existing").unwrap();
    let app = Launcher::open(directory.path().into(), source.clone(), Arc::new(|_, _| {})).unwrap();
    assert!(app
        .call("config:moveDataRoot", json!(target))
        .await
        .is_err());
    assert!(app
        .call("config:moveDataRoot", json!(source.join("nested")))
        .await
        .is_err());
    assert_eq!(
        fs::read_to_string(target.join("private.txt")).unwrap(),
        "existing"
    );
}

#[tokio::test]
async fn napcat_uses_upstream_get_route_bearer_and_nested_gbk_logs() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = [0u8; 4096];
        let n = socket.read(&mut request).await.unwrap();
        let request = String::from_utf8_lossy(&request[..n]).to_lowercase();
        assert!(request.starts_with("get /getlogrealtime http/1.1"));
        assert!(request.contains("authorization: bearer existing-token"));
        let body = encoding_rs::GBK
            .encode(r#"{"data":{"text":"中文上游日志"}}"#)
            .0
            .into_owned();
        socket
            .write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        socket.write_all(&body).await.unwrap();
    });
    assert_eq!(
        astriax_core::napcat_logs::fetch(&reqwest::Client::new(), port, "existing-token")
            .await
            .unwrap(),
        "中文上游日志"
    );
    server.await.unwrap();
}

#[test]
fn versions_are_read_from_upstream_contents_instead_of_directory_names() {
    use astriax_core::{domain::Kind, runtime::metadata};
    let directory = tempfile::tempdir().unwrap();
    assert!(metadata::version(Kind::AstrBot, directory.path()).is_none());
    fs::create_dir(directory.path().join("astrbot-4.28.1.dist-info")).unwrap();
    fs::write(
        directory.path().join("astrbot-4.28.1.dist-info/METADATA"),
        "Name: astrbot\nVersion: 4.28.1\n",
    )
    .unwrap();
    assert_eq!(
        metadata::version(Kind::AstrBot, directory.path()).as_deref(),
        Some("4.28.1")
    );
    fs::write(
        directory.path().join("napcat.mjs"),
        r#"const Vu = typeof Oj < "u" && "4.18.19" || "1.0.0-dev";"#,
    )
    .unwrap();
    assert_eq!(
        metadata::version(Kind::NapCat, directory.path()).as_deref(),
        Some("4.18.19")
    );
}
