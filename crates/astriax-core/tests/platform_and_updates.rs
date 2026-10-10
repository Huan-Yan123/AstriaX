use astriax_core::{
    domain::Kind, platform_qq::read_version, runtime::versions::compare, storage::atomic_json,
    updater::valid_manifest,
};
use serde_json::json;
use std::fs;

#[test]
fn pending_update_revalidates_downloaded_bytes_and_survives_navigation() {
    let Some(downloads) = dirs::download_dir().filter(|p| p.is_dir()) else {
        return;
    };
    let files = tempfile::Builder::new()
        .prefix("astriax-update-test-")
        .tempdir_in(downloads)
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let package = files.path().join("AstriaX-Tauri-9.0.0-setup.exe");
    fs::write(&package, b"MZ offline test package").unwrap();
    atomic_json(&root.path().join("update-download.json"), &json!({
        "path":package,"version":"9.0.0","url":"https://github.com/Soffd/AstriaX/releases/download/v9.0.0/AstriaX.exe",
        "sha256":astriax_core::updater::hash_file(&package).unwrap()
    })).unwrap();
    assert_eq!(
        astriax_core::updater::pending(root.path()).unwrap()["version"],
        "9.0.0"
    );
    fs::write(&package, b"MZ modified file").unwrap();
    assert!(astriax_core::updater::pending(root.path()).is_err());
    assert!(astriax_core::updater::downloaded(root.path()).is_err());
}

#[test]
fn qq_update_marker_and_package_fallback_match_upstream_layouts() {
    let root = tempfile::tempdir().unwrap();
    atomic_json(
        &root.path().join("versions/config.json"),
        &json!({"curVersion":"9.9.31-49738"}),
    )
    .unwrap();
    assert_eq!(
        read_version(root.path()),
        Some(("9.9.31-49738".into(), 49738))
    );
    atomic_json(
        &root.path().join("versions/config.json"),
        &json!({"curVersion":"9.9.31"}),
    )
    .unwrap();
    atomic_json(
        &root
            .path()
            .join("versions/9.9.31/resources/app/package.json"),
        &json!({"version":"9.9.31","buildVersion":"49738"}),
    )
    .unwrap();
    assert_eq!(read_version(root.path()), Some(("9.9.31".into(), 49738)));
    fs::remove_file(root.path().join("versions/config.json")).unwrap();
    atomic_json(
        &root
            .path()
            .join("resources/app/versions/9.9.32/package.json"),
        &json!({"version":"9.9.32","buildVersion":50000}),
    )
    .unwrap();
    assert_eq!(read_version(root.path()), Some(("9.9.32".into(), 50000)));
}
#[test]
fn malformed_qq_version_cannot_escape_installation_directory() {
    let root = tempfile::tempdir().unwrap();
    atomic_json(
        &root.path().join("versions/config.json"),
        &json!({"curVersion":"../external","buildId":"49738"}),
    )
    .unwrap();
    assert_eq!(read_version(root.path()).unwrap().1, 49738);
    atomic_json(
        &root.path().join("versions/config.json"),
        &json!({"curVersion":"../external"}),
    )
    .unwrap();
    assert!(read_version(root.path()).is_none());
}
#[test]
fn update_manifest_requires_native_runtime_valid_version_url_and_hash() {
    let valid = json!({"runtime":"tauri","version":"1.0.2","url":"https://github.com/Soffd/AstriaX/releases/download/v1.0.2/AstriaX_1.0.2_x64-setup.exe","sha256":"a".repeat(64)});
    assert!(valid_manifest(&valid));
    for (key, value) in [
        ("runtime", json!("electron")),
        ("sha256", json!("")),
        ("version", json!("latest")),
        ("url", json!("file:///setup.exe")),
        ("url", json!("https://user:pass@example.com/setup.exe")),
        (
            "url",
            json!("https://github.com/Huan-Yan123/AstriaX/releases/download/v1.0.2/setup.exe"),
        ),
        (
            "url",
            json!("https://github.com/Soffd/AstriaX/releases/download/v1.0.2/page.html"),
        ),
        (
            "url",
            json!("https://github.com/Soffd/AstriaX/releases/download/../../../../other/project/setup.exe"),
        ),
    ] {
        let mut manifest = valid.clone();
        manifest[key] = value;
        assert!(!valid_manifest(&manifest));
    }
    assert!(compare("1.0.2-rc.1", "1.0.2", Kind::NapCat).is_lt());
    assert!(compare("v4.20.0", "v4.9.0", Kind::NapCat).is_gt());
    assert!(compare("4.28.1rc1", "4.28.1", Kind::AstrBot).is_lt());
}
