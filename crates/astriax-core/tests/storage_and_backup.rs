use astriax_core::{
    archive, backup,
    domain::{segment, Kind},
    storage::{atomic_json, read_json, Store},
    transaction,
};
use serde_json::{json, Value};
use std::{fs, io::Write};

#[test]
fn reads_bom_and_preserves_unknown_fields() {
    let d = tempfile::tempdir().unwrap();
    let index = json!({"instances":[],"future":{"enabled":true}});
    let mut bytes = vec![0xef, 0xbb, 0xbf];
    bytes.extend(serde_json::to_vec(&index).unwrap());
    fs::write(d.path().join("instances.json"), bytes).unwrap();
    let s = Store::open(d.path().into()).unwrap();
    s.save_index().unwrap();
    assert_eq!(
        read_json::<Value>(&d.path().join("instances.json")).unwrap()["future"],
        index["future"]
    );
}
#[test]
fn corrupt_index_is_not_overwritten() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("instances.json");
    fs::write(&p, b"{broken").unwrap();
    assert!(Store::open(d.path().into()).is_err());
    assert_eq!(fs::read(p).unwrap(), b"{broken");
}
#[test]
fn exclusive_root_lock_releases_on_drop() {
    let d = tempfile::tempdir().unwrap();
    let s = Store::open(d.path().into()).unwrap();
    assert!(Store::open(d.path().into()).is_err());
    drop(s);
    assert!(Store::open(d.path().into()).is_ok());
}
#[test]
fn validates_windows_paths() {
    for name in [
        "..", "../x", "C:evil", "a/b", "a\\b", "CON", "nul.txt", "COM1", "LPT9.txt", "v1.", "v1 ",
        "x\0x",
    ] {
        assert!(segment(name).is_err(), "{name}");
    }
    for name in ["v4.28.1", "4.2rc1", "a_01234", "中文实例"] {
        assert!(segment(name).is_ok());
    }
    for path in [
        "../evil",
        "C:/evil",
        "/evil",
        "data/../../evil",
        "data/file:ads",
    ] {
        assert!(archive::relative(path).is_err());
    }
    assert_eq!(
        archive::relative("data\\中文.json").unwrap(),
        std::path::PathBuf::from("data/中文.json")
    );
}
#[test]
fn pep440_and_segment_versions() {
    use astriax_core::runtime::versions::compare;
    use std::cmp::Ordering;
    for (a, b) in [
        ("1.0.dev1", "1.0a1"),
        ("1.0rc1", "1.0"),
        ("1.0", "1.0.post1"),
    ] {
        assert_eq!(compare(a, b, Kind::AstrBot), Ordering::Less);
    }
    assert_eq!(compare("v1.0.0", "1.0", Kind::NapCat), Ordering::Equal);
}
#[test]
fn transaction_recovers_partial_replace() {
    let d = tempfile::tempdir().unwrap();
    let dest = d.path().join("data");
    fs::create_dir(&dest).unwrap();
    fs::write(dest.join("old"), "original").unwrap();
    let txn = d.path().join(".transactions/test");
    fs::create_dir_all(&txn).unwrap();
    let old = txn.join("old-0");
    let stage = d.path().join("stage");
    fs::rename(&dest, &old).unwrap();
    fs::create_dir(&dest).unwrap();
    fs::write(dest.join("new"), "half commit").unwrap();
    atomic_json(&txn.join("journal.json"),&json!({"committed":false,"moves":[{"dest":dest,"stage":stage,"old":old,"had_original":true}]})).unwrap();
    transaction::recover(d.path()).unwrap();
    assert_eq!(fs::read_to_string(dest.join("old")).unwrap(), "original");
    assert!(!dest.join("new").exists());
}
#[test]
fn transaction_rolls_back_when_second_move_fails() {
    let d = tempfile::tempdir().unwrap();
    let a = d.path().join("a");
    let stage = d.path().join("new");
    fs::write(&a, "old").unwrap();
    fs::write(&stage, "new").unwrap();
    assert!(transaction::replace(
        d.path(),
        vec![
            (stage, a.clone()),
            (d.path().join("missing"), d.path().join("b"))
        ]
    )
    .is_err());
    assert_eq!(fs::read_to_string(a).unwrap(), "old");
    assert!(!d.path().join("b").exists());
}
#[test]
fn backup_roundtrip_chinese_streaming() {
    let d = tempfile::tempdir().unwrap();
    fs::create_dir(d.path().join("data")).unwrap();
    fs::write(d.path().join("data/中文.json"), "你好 AstrBot").unwrap();
    atomic_json(
        &d.path().join("instance.json"),
        &json!({"runtimeTag":"v4.28.1"}),
    )
    .unwrap();
    let result = backup::make(d.path(), 1, 5).unwrap();
    let stage = tempfile::tempdir().unwrap();
    let manifest = backup::decode(
        std::path::Path::new(result["file"].as_str().unwrap()),
        stage.path(),
    )
    .unwrap();
    assert_eq!(manifest["scope"], "data");
    assert_eq!(manifest["files"], 2);
    assert_eq!(
        fs::read_to_string(stage.path().join("data/中文.json")).unwrap(),
        "你好 AstrBot"
    );
}
#[test]
fn rejects_archive_traversal_and_case_collisions() {
    for names in [vec!["../escaped"], vec!["data/Test.json", "data/test.json"]] {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("bad.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&file).unwrap());
        for name in names {
            zip.start_file(name, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(b"bad").unwrap();
        }
        zip.finish().unwrap();
        let dest = d.path().join("out");
        assert!(
            archive::extract_zip(&file, &dest, &tokio_util::sync::CancellationToken::new())
                .is_err()
        );
        assert!(!dest.exists());
    }
}
#[test]
fn reads_electron_generated_backup_fixture() {
    let d = tempfile::tempdir().unwrap();
    let file = d.path().join("old.tar.gz");
    fs::write(
        &file,
        include_bytes!("../../../tests/fixtures/rust-rewrite/electron-data.tar.gz"),
    )
    .unwrap();
    let out = d.path().join("out");
    let manifest = backup::decode(&file, &out).unwrap();
    assert_eq!(manifest["files"], 2);
    assert_eq!(
        fs::read_to_string(out.join("data/中文.json")).unwrap(),
        "{\"message\":\"你好\"}"
    );
}
#[test]
fn reads_legacy_sidecar_compressed_hash() {
    let d = tempfile::tempdir().unwrap();
    let file = d.path().join("legacy.tar.gz");
    fs::write(
        &file,
        include_bytes!("../../../tests/fixtures/rust-rewrite/electron-legacy.tar.gz"),
    )
    .unwrap();
    fs::write(
        d.path().join("legacy.json"),
        include_bytes!("../../../tests/fixtures/rust-rewrite/electron-legacy.json"),
    )
    .unwrap();
    assert!(backup::decode(&file, &d.path().join("out")).is_ok());
}
