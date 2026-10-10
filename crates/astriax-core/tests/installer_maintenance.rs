use astriax_core::{
    maintenance,
    storage::{atomic_json, Store},
};
use serde_json::json;
use std::{fs, io::Read};

#[tokio::test]
async fn upgrade_snapshots_user_state_preserves_runtime_and_cleans_electron_files() {
    let temp = tempfile::tempdir().unwrap();
    let install = temp.path().join("app");
    let root = temp.path().join("中文数据");
    let scope = format!("installer-test-{}", uuid::Uuid::new_v4());
    fs::create_dir_all(install.join("resources")).unwrap();
    fs::write(install.join("resources/app.asar"), "old Electron").unwrap();
    fs::write(install.join("AstriaX.exe"), "old app").unwrap();
    fs::write(install.join("ffmpeg.dll"), "old DLL").unwrap();
    atomic_json(
        &root.join("config.json"),
        &json!({"dataRoot":root,"custom":"保留"}),
    )
    .unwrap();
    fs::create_dir_all(root.join("instances/instance/data/plugins")).unwrap();
    fs::write(
        root.join("instances/instance/data/plugins/中文.txt"),
        "插件数据",
    )
    .unwrap();
    fs::create_dir_all(root.join("runtimes/a/v1")).unwrap();
    fs::write(root.join("runtimes/a/v1/main.py"), "upstream").unwrap();
    let result = maintenance::prepare(&install, &root, std::process::id())
        .await
        .unwrap();
    assert!(maintenance::check_startup(&root).is_err());
    let backup = result["backup"].as_str().unwrap();
    let mut zip = zip::ZipArchive::new(fs::File::open(backup).unwrap()).unwrap();
    let mut text = String::new();
    zip.by_name("data/instances/instance/data/plugins/中文.txt")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, "插件数据");
    assert!(zip.by_name("data/runtimes/a/v1/main.py").is_err());
    assert!(zip.by_name("app/AstriaX.exe").is_ok());
    fs::write(install.join("astriax-desktop.exe"), "new Rust app").unwrap();
    maintenance::commit(&install, &root, &scope).unwrap();
    assert_eq!(
        fs::read_to_string(install.join("astriax-desktop.exe")).unwrap(),
        "new Rust app"
    );
    assert!(!install.join("resources/app.asar").exists());
    assert!(!install.join("AstriaX.exe").exists());
    assert!(!install.join("ffmpeg.dll").exists());
    assert!(maintenance::check_startup(&root).is_ok());
    assert!(root.join("runtimes/a/v1/main.py").exists());
    maintenance::remove(&install, &root, false, &scope, std::process::id())
        .await
        .unwrap();
    assert!(root.join("config.json").exists());
    assert_eq!(
        maintenance::paths::data_root(&install, &scope).unwrap(),
        root
    );
    fs::write(root.join("unrelated.txt"), "用户文件").unwrap();
    atomic_json(&root.join("rust-version-cache.json"), &json!({})).unwrap();
    fs::create_dir_all(root.join(".transactions")).unwrap();
    maintenance::remove(&install, &root, true, &scope, std::process::id())
        .await
        .unwrap();
    assert!(!root.join("config.json").exists());
    assert!(!root.join("instances").exists());
    assert!(!root.join("runtimes").exists());
    assert!(!root.join("rust-version-cache.json").exists());
    assert!(!root.join(".transactions").exists());
    assert!(root.join("unrelated.txt").exists());
    assert!(std::path::Path::new(backup).is_file());
}

#[tokio::test]
async fn maintenance_refuses_active_storage_and_unsafe_roots() {
    let temp = tempfile::tempdir().unwrap();
    let install = temp.path().join("app");
    let root = temp.path().join("data");
    let lock = Store::open(root.clone()).unwrap();
    assert!(maintenance::prepare(&install, &root, std::process::id())
        .await
        .is_err());
    assert!(
        maintenance::remove(&install, &root, true, "test", std::process::id())
            .await
            .is_err()
    );
    drop(lock);
    assert!(maintenance::paths::validate_root(&install, temp.path()).is_err());
    assert!(maintenance::paths::validate_root(&install, &root.join("..")).is_err());
    #[cfg(windows)]
    assert!(maintenance::paths::validate_root(
        &install,
        &std::path::PathBuf::from(temp.path().to_string_lossy().to_uppercase())
    )
    .is_err());
    assert!(
        maintenance::snapshot::create(&install, &temp.path().join("AstriaX-update-backups"))
            .is_err()
    );
}
