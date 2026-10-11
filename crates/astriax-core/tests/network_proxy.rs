use astriax_core::{network, Launcher};
use serde_json::json;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[tokio::test]
async fn manual_proxy_forwards_remote_downloads_and_changes_apply_without_restart() {
    let install = tempfile::tempdir().unwrap();
    let root = tempfile::tempdir().unwrap();
    let app = Launcher::open(
        install.path().into(),
        root.path().into(),
        Arc::new(|_, _| {}),
    )
    .unwrap();
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", proxy.local_addr().unwrap());
    app.call(
        "config:set",
        json!({"proxyMode":"manual", "proxyUrl":address,"closePolicy":"ask"}),
    )
    .await
    .unwrap();
    let handler = tokio::spawn(async move {
        let (mut socket, _) = proxy.accept().await.unwrap();
        let mut buffer = [0; 4096];
        let count = socket.read(&mut buffer).await.unwrap();
        let request = String::from_utf8_lossy(&buffer[..count]).into_owned();
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nConnection: close\r\n\r\nwheel")
            .await
            .unwrap();
        request
    });
    let body = network::client(&app)
        .await
        .unwrap()
        .get("http://unresolved.example/resource")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(body, "wheel");
    assert!(handler
        .await
        .unwrap()
        .starts_with("GET http://unresolved.example/resource "));
    let mut spec = astriax_core::process::LaunchSpec {
        program: "python.exe".into(),
        args: vec![],
        cwd: root.path().into(),
        env: Default::default(),
    };
    network::configure_pip(&app, &mut spec).await;
    assert_eq!(spec.env["HTTPS_PROXY"], address);
    app.call("config:set", json!({"proxyMode":"direct"}))
        .await
        .unwrap();
    network::configure_pip(&app, &mut spec).await;
    assert_eq!(spec.env["HTTPS_PROXY"], "");
    assert_eq!(app.store.lock().await.config["closePolicy"], "ask");
}

#[tokio::test]
async fn https_uses_proxy_connect_and_preserves_the_proxy_error_cause() {
    let root = tempfile::tempdir().unwrap();
    let app = Launcher::open(
        root.path().into(),
        root.path().join("data"),
        Arc::new(|_, _| {}),
    )
    .unwrap();
    let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    app.call(
        "config:set",
        json!({"proxyMode":"manual", "proxyUrl":format!("http://{}", proxy.local_addr().unwrap())}),
    )
    .await
    .unwrap();
    astriax_core::storage::atomic_json(
        &app.root().await.join("mirrors.json"),
        &json!({"custom":[{"label":"mirror","base":"https://mirror.invalid/","mode":"proxy"}],"pref":{"n":"https://mirror.invalid/"}}),
    ).unwrap();
    let handler = tokio::spawn(async move {
        let (mut socket, _) = proxy.accept().await.unwrap();
        let mut buffer = [0; 4096];
        let count = socket.read(&mut buffer).await.unwrap();
        let request = String::from_utf8_lossy(&buffer[..count]).into_owned();
        socket
            .write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
            .await
            .unwrap();
        request
    });
    // An empty base explicitly selects direct GitHub even if a mirror is preferred.
    let error = app
        .call(
            "versions:list",
            json!({"type":"n","base":"","noCache":true}),
        )
        .await
        .unwrap_err();
    assert!(handler
        .await
        .unwrap()
        .starts_with("CONNECT api.github.com:443 "));
    let message = error.to_string();
    assert!(
        message.contains("proxy authorization required"),
        "{message}"
    );
}
