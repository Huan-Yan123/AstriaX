use astriax_core::{
    runtime::{python_probe, python_selection},
    storage::atomic_json,
    Launcher,
};
use serde_json::json;
use std::{fs, sync::Arc};

#[tokio::test]
async fn manual_python_is_probed_and_failed_selection_retains_previous_interpreter() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let app = Launcher::open(temp.path().join("app"), root.clone(), Arc::new(|_, _| {})).unwrap();
    let exe = temp.path().join("custom-python.exe");
    fs::copy(env!("CARGO_BIN_EXE_astriax-process-fixture"), &exe).unwrap();
    let result = python_selection::select(&app, &exe).await.unwrap();
    assert_eq!(result["source"], "manual");
    assert_eq!(result["version"], "3.12.10");
    let before = fs::read(root.join("runtime/python-selection.json")).unwrap();
    for unsupported in [
        json!({"version":"3.11.9"}),
        json!({"bits":32}),
        json!({"pip":false}),
    ] {
        atomic_json(&exe.with_extension("probe.json"), &unsupported).unwrap();
        assert!(python_selection::select(&app, &exe).await.is_err());
        assert_eq!(
            before,
            fs::read(root.join("runtime/python-selection.json")).unwrap()
        );
    }
    fs::remove_file(exe.with_extension("probe.json")).unwrap();
    let runtime = root.join("runtimes/a/test");
    atomic_json(
        &runtime.join("python-abi.json"),
        &json!({"version":"3.13.1"}),
    )
    .unwrap();
    assert!(python_selection::compatible(&root, &runtime).await.is_err());
    atomic_json(
        &runtime.join("python-abi.json"),
        &json!({"version":"3.12.1"}),
    )
    .unwrap();
    assert!(python_selection::compatible(&root, &runtime).await.is_ok());
    // The external installation remains unmodified.
    assert!(!temp.path().join("python312._pth").exists());
    assert!(!temp.path().join("Lib").exists());
}

#[tokio::test]
async fn path_discovery_skips_old_python_and_registers_supported_interpreter() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("old");
    let new = temp.path().join("new");
    for folder in [&old, &new] {
        fs::create_dir(folder).unwrap();
        fs::copy(
            env!("CARGO_BIN_EXE_astriax-process-fixture"),
            folder.join(if cfg!(windows) {
                "python.exe"
            } else {
                "python3"
            }),
        )
        .unwrap();
    }
    atomic_json(
        &old.join(if cfg!(windows) {
            "python.probe.json"
        } else {
            "python3.probe.json"
        }),
        &json!({"version":"3.9.0"}),
    )
    .unwrap();
    let previous = std::env::var_os("PATH");
    std::env::set_var("PATH", std::env::join_paths([&old, &new]).unwrap());
    let app = Launcher::open(
        temp.path().join("app"),
        temp.path().join("data"),
        Arc::new(|_, _| {}),
    )
    .unwrap();
    let result = python_selection::status(&app, false).await;
    match previous {
        Some(p) => std::env::set_var("PATH", p),
        None => std::env::remove_var("PATH"),
    }
    let result = result.unwrap();
    assert_eq!(result["source"], "system");
    assert!(result["exe"].as_str().unwrap().contains("new"));
    let python = python_probe::probe(&new.join(if cfg!(windows) {
        "python.exe"
    } else {
        "python3"
    }))
    .await
    .unwrap();
    assert!(python_probe::supported(&python));
}
