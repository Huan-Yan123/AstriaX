use astriax_core::{storage::atomic_json, transaction, Launcher};
use serde_json::json;
use std::{fs, sync::Arc};
use tokio_util::sync::CancellationToken;

#[test]
fn deferred_removal_is_committed_before_cleanup_and_resumes_after_cancellation() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("runtimes/a/v1");
    fs::create_dir_all(&runtime).unwrap();
    fs::write(runtime.join("payload"), "old runtime").unwrap();
    let empty = root.path().join("empty");
    fs::create_dir(&empty).unwrap();
    let index = root.path().join("index");
    atomic_json(&index, &json!({"versions":[]})).unwrap();
    transaction::replace_deferred(
        root.path(),
        vec![
            (empty, runtime.clone()),
            (index, root.path().join("runtimes.json")),
        ],
    )
    .unwrap();
    assert!(!runtime.join("payload").exists());
    let queued = fs::read_dir(root.path().join(".trash"))
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    assert!(queued.join("old-0/payload").exists());
    let stopped = CancellationToken::new();
    stopped.cancel();
    assert!(matches!(
        transaction::clean_trash(root.path(), &stopped),
        Err(astriax_core::Error::Cancelled)
    ));
    assert!(queued.join("journal.json").exists());
    // Simulate stopping after commit, before the transaction could enter .trash.
    let stranded = root.path().join(".transactions/stranded");
    fs::rename(&queued, &stranded).unwrap();
    transaction::recover(root.path()).unwrap();
    assert!(!stranded.exists());
    assert!(root.path().join(".trash/stranded/old-0/payload").exists());
    transaction::clean_trash(root.path(), &CancellationToken::new()).unwrap();
    assert_eq!(fs::read_dir(root.path().join(".trash")).unwrap().count(), 0);
}

#[test]
fn failed_deferred_commit_restores_runtime_and_unmarked_trash_is_preserved() {
    let root = tempfile::tempdir().unwrap();
    let runtime = root.path().join("runtime");
    fs::create_dir(&runtime).unwrap();
    fs::write(runtime.join("payload"), "retained").unwrap();
    let empty = root.path().join("empty");
    fs::create_dir(&empty).unwrap();
    assert!(transaction::replace_deferred(
        root.path(),
        vec![
            (empty, runtime.clone()),
            (root.path().join("missing-stage"), root.path().join("index"))
        ]
    )
    .is_err());
    assert_eq!(
        fs::read_to_string(runtime.join("payload")).unwrap(),
        "retained"
    );
    fs::create_dir_all(root.path().join(".trash/unmarked")).unwrap();
    fs::write(root.path().join(".trash/unmarked/keep"), "unknown").unwrap();
    assert!(transaction::clean_trash(root.path(), &CancellationToken::new()).is_err());
    assert!(root.path().join(".trash/unmarked/keep").exists());
}

#[tokio::test(flavor = "current_thread")]
async fn both_runtime_kinds_disappear_immediately_and_shutdown_does_not_wait_for_payload() {
    let root = tempfile::tempdir().unwrap();
    let app = Launcher::open(
        root.path().into(),
        root.path().join("data"),
        Arc::new(|_, _| {}),
    )
    .unwrap();
    let data = app.root().await;
    for (kind, entry) in [("a", "main.py"), ("n", "napcat.mjs")] {
        let runtime = data.join("runtimes").join(kind).join("v1");
        fs::create_dir_all(&runtime).unwrap();
        fs::write(runtime.join(entry), "entry").unwrap();
        for i in 0..1000 {
            fs::write(runtime.join(format!("file-{i}")), "payload").unwrap();
        }
        let before = std::time::Instant::now();
        let removed = tokio::time::timeout(
            std::time::Duration::from_secs(3),
            app.call("runtimes:remove", json!({"type":kind,"tag":"v1"})),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(removed["removed"], true);
        assert!(!runtime.exists());
        let config = tokio::time::timeout(
            std::time::Duration::from_millis(500),
            app.call("config:get", json!(null)),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(config.is_object());
        assert!(app
            .call("runtimes:list", json!(null))
            .await
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            astriax_core::instances::shutdown(&app),
        )
        .await
        .unwrap()
        .unwrap();
        println!(
            "{kind}: delete plus config/list/shutdown {:?}",
            before.elapsed()
        );
    }
    // Resume any cleanup cancelled by exit, without bringing deleted versions back.
    drop(app);
    let reopened = Launcher::open(root.path().into(), data, Arc::new(|_, _| {})).unwrap();
    assert!(reopened
        .call("runtimes:list", json!(null))
        .await
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    astriax_core::instances::shutdown(&reopened).await.unwrap();
}
