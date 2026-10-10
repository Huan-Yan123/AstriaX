use astriax_core::{
    domain::Kind, platform_qq::read_version, runtime::versions::compare, storage::atomic_json,
    updater::valid_manifest,
};
use serde_json::json;
use std::fs;

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
    let valid = json!({"runtime":"tauri","version":"1.0.2","url":"https://github.com/example/releases/setup.exe","sha256":"a".repeat(64)});
    assert!(valid_manifest(&valid));
    for (key, value) in [
        ("runtime", json!("electron")),
        ("sha256", json!("")),
        ("version", json!("latest")),
        ("url", json!("file:///setup.exe")),
        ("url", json!("https://user:pass@example.com/setup.exe")),
    ] {
        let mut manifest = valid.clone();
        manifest[key] = value;
        assert!(!valid_manifest(&manifest));
    }
    assert!(compare("1.0.2-rc.1", "1.0.2", Kind::NapCat).is_lt());
    assert!(compare("v4.20.0", "v4.9.0", Kind::NapCat).is_gt());
    assert!(compare("4.28.1rc1", "4.28.1", Kind::AstrBot).is_lt());
}
