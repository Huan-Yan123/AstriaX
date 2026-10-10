//! Execute the adapter with a real interpreter when Python is available on this test host.
use astriax_core::runtime::python_probe;
use std::{fs, path::PathBuf};

#[tokio::test]
async fn external_python_loads_target_pth_dependencies_and_preserves_upstream_arguments() {
    let paths = std::env::var_os("PATH").unwrap_or_default();
    let mut found = None;
    for dir in std::env::split_paths(&paths) {
        let exe = dir.join(if cfg!(windows) {
            "python.exe"
        } else {
            "python3"
        });
        if exe.is_file() && python_probe::probe(&exe).await.is_ok() {
            found = Some(exe);
            break;
        }
    }
    let Some(exe) = found else {
        eprintln!("No Python 3.12+ on host: external adapter integration skipped");
        return;
    };
    let python = python_probe::probe(&exe).await.unwrap();
    let temp = tempfile::tempdir().unwrap();
    let runtime = temp.path().join("中文 runtime");
    fs::create_dir_all(runtime.join("extra")).unwrap();
    fs::write(runtime.join("target.pth"), "extra\n").unwrap();
    fs::write(runtime.join("extra/dependency.py"), "value = '中文输出'\n").unwrap();
    fs::write(runtime.join("main.py"), "import dependency,sys,json\nprint(json.dumps(dict(value=dependency.value,args=sys.argv[1:],utf8=sys.flags.utf8_mode),ensure_ascii=False))\n").unwrap();
    let before = fs::metadata(&python.exe).unwrap().modified().unwrap();
    let output = tokio::process::Command::new(&exe)
        .args([
            "-X",
            "utf8",
            "-u",
            "-I",
            "-c",
            include_str!("../resources/python-launch.py"),
        ])
        .arg(&runtime)
        .arg("file")
        .arg(runtime.join("main.py"))
        .args(["--port", "6155"])
        .current_dir(temp.path())
        .output()
        .await
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["value"], "中文输出");
    assert_eq!(result["args"], serde_json::json!(["--port", "6155"]));
    assert_eq!(result["utf8"], 1);
    assert_eq!(
        before,
        fs::metadata(PathBuf::from(&python.exe))
            .unwrap()
            .modified()
            .unwrap()
    );
}
