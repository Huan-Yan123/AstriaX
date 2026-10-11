use astriax_core::{
    runtime::{python, python_sources},
    storage::atomic_json,
    Launcher,
};
use serde_json::{json, Value};
use std::{
    fs,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn source(slow: bool) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/python/", listener.local_addr().unwrap());
    let handler = tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buffer = [0; 4096];
                let count = socket.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..count]);
                let path = request.split_whitespace().nth(1).unwrap();
                if path.ends_with(".zip") && slow {
                    let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 524288\r\nConnection: close\r\n\r\n").await;
                    for _ in 0..32 {
                        if socket.write_all(&[0; 16384]).await.is_err() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(120)).await;
                    }
                    return;
                }
                let (status, body) = match path {
                    "/python/" => ("200 OK", "<a href='3.12.10/'>a</a><a href='3.12.11/'>source only</a><a href='3.14.1/'>b</a><a href='3.15.0rc1/'>pre</a><a href='3.11.9/'>old</a>"),
                    "/python/3.12.10/" => ("200 OK", "<a href='python-3.12.10-embed-amd64.zip'>zip</a>"),
                    "/python/3.14.1/" => ("200 OK", "<a href='python-3.14.1-embed-amd64.zip'>zip</a><a href='python-3.14.2rc1-embed-amd64.zip'>pre</a>"),
                    "/python/3.12.11/" => ("200 OK", "<a href='Python-3.12.11.tgz'>sources</a>"),
                    _ => ("404 Not Found", "file not found"),
                };
                let response = format!(
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = socket.write_all(response.as_bytes()).await;
            });
        }
    });
    (base, handler)
}

#[tokio::test]
async fn custom_source_preferences_and_dynamic_versions_keep_only_downloadable_archives() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let app = Launcher::open(temp.path().join("app"), root.clone(), Arc::new(|_, _| {})).unwrap();
    let (base, server) = source(false).await;
    app.call("config:set", json!({"proxyMode":"direct"}))
        .await
        .unwrap();
    app.call(
        "python:sourceAdd",
        json!({"label":"测试镜像", "base":base.trim_end_matches('/')}),
    )
    .await
    .unwrap();
    app.call("python:sourcePref", json!(base)).await.unwrap();
    assert_eq!(
        app.call("python:sources", Value::Null).await.unwrap()["pref"],
        base
    );
    assert!(app
        .call("python:sourceAdd", json!({"label":"重复地址", "base":base}))
        .await
        .is_err());
    assert!(app
        .call(
            "python:sourceRemove",
            json!("https://www.python.org/ftp/python/")
        )
        .await
        .is_err());
    fs::write(root.join("python-runtime-cache.json"), "broken cache").unwrap();
    let catalog = app
        .call("python:versions", json!({"noCache":true}))
        .await
        .unwrap();
    assert_eq!(
        catalog["versions"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v["version"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["3.14.1", "3.12.10"]
    );
    assert_eq!(
        python_sources::preferred(catalog["versions"].as_array().unwrap()).unwrap()["version"],
        "3.12.10"
    );
    let resolved = python_sources::resolve(
        &app,
        &json!({"base":base,"version":"3.14.1", "assetUrl":"https://other.invalid/evil.zip"}),
    )
    .await
    .unwrap();
    assert_eq!(
        resolved["assetUrl"],
        format!("{base}3.14.1/python-3.14.1-embed-amd64.zip")
    );
    assert!(
        python_sources::resolve(&app, &json!({"base":base,"version":"3.12.11"}))
            .await
            .unwrap_err()
            .to_string()
            .contains("嵌入式包")
    );
    server.abort();
    // A cached catalog is available offline; explicit refresh reports the connection failure.
    assert_eq!(
        app.call("python:versions", Value::Null).await.unwrap(),
        catalog
    );
    assert!(app
        .call("python:versions", json!({"noCache":true}))
        .await
        .is_err());
    app.call("python:sourceRemove", json!(base)).await.unwrap();
    assert_eq!(
        python_sources::selected(&root, None).unwrap()["base"],
        "https://www.python.org/ftp/python/"
    );
}

#[tokio::test]
async fn cancelling_python_download_emits_byte_progress_and_keeps_previous_environment() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let events = Arc::new(Mutex::new(Vec::<Value>::new()));
    let collected = events.clone();
    let app = Arc::new(
        Launcher::open(
            temp.path().join("app"),
            root.clone(),
            Arc::new(move |channel, p| {
                if channel == "download:progress" {
                    collected.lock().unwrap().push(p);
                }
            }),
        )
        .unwrap(),
    );
    let (base, server) = source(true).await;
    app.call("config:set", json!({"proxyMode":"direct"}))
        .await
        .unwrap();
    python_sources::change(&root, "sourceAdd", json!({"label":"测试镜像", "base":base})).unwrap();
    fs::create_dir_all(root.join("runtime/python")).unwrap();
    fs::write(root.join("runtime/python/keep.txt"), "old runtime").unwrap();
    let selection = root.join("runtime/python-selection.json");
    atomic_json(
        &selection,
        &json!({"source":"bundled","version":"3.12.10","exe":"old-python.exe"}),
    )
    .unwrap();
    let before = fs::read(&selection).unwrap();
    let installing = app.clone();
    let install = tokio::spawn(async move {
        installing
            .call("python:install", json!({"base":base,"version":"3.14.1"}))
            .await
    });
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e["phase"] == "downloading" && e["got"].as_u64().unwrap_or(0) > 0)
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(
        app.call("runtimes:cancel", json!({"type":"python","tag":"python"}))
            .await
            .unwrap()["ok"],
        true
    );
    let result = tokio::time::timeout(Duration::from_secs(3), install)
        .await
        .unwrap()
        .unwrap();
    assert!(result.unwrap_err().to_string().contains("取消"));
    assert_eq!(fs::read(&selection).unwrap(), before);
    assert_eq!(
        fs::read_to_string(root.join("runtime/python/keep.txt")).unwrap(),
        "old runtime"
    );
    assert!(!app.tasks.contains("python:python"));
    let events = events.lock().unwrap();
    assert!(events.iter().any(
        |e| e["percent"].as_f64().is_some_and(|n| n > 0. && n < 100.)
            && e["label"].as_str().unwrap_or("").contains("3.14.1")
    ));
    assert_eq!(events.last().unwrap()["phase"], "error");
    assert!(!fs::read_dir(root.join("runtime"))
        .unwrap()
        .flatten()
        .any(|e| e
            .file_name()
            .to_string_lossy()
            .starts_with(".python-stage-")));
    server.abort();
}

#[test]
fn embedded_python_preparation_uses_the_archives_actual_pth_file() {
    for minor in ["312", "313", "314"] {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(format!("python{minor}._pth"));
        fs::write(&file, format!("python{minor}.zip\n.\n#import site\n")).unwrap();
        python::prepare(dir.path()).unwrap();
        let content = fs::read_to_string(file).unwrap();
        assert!(content.contains(&format!("python{minor}.zip")));
        assert!(content.contains("\nimport site\n"));
        assert!(content.contains("Lib/site-packages"));
        assert!(dir
            .path()
            .join("Lib/site-packages/sitecustomize.py")
            .exists());
    }
    let dir = tempfile::tempdir().unwrap();
    assert!(python::prepare(dir.path()).is_err());
}
