//! Installer-only helper: no desktop framework or administrator manifest.
#![cfg_attr(windows, windows_subsystem = "windows")]
fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let runtime = tokio::runtime::Runtime::new().expect("maintenance runtime");
    if let Err(error) = runtime.block_on(astriax_core::maintenance::command(&args)) {
        if let (Some(install), Some(report)) = (args.get(3), args.get(5)) {
            let root = std::path::Path::new(install).join("data");
            let _ = astriax_core::maintenance::paths::write_ini(
                std::path::Path::new(report),
                &root,
                std::path::Path::new(""),
                &error.to_string(),
            );
        }
        // NSIS consumes the UTF-16 INI; stderr remains useful for CLI diagnosis.
        eprintln!("{error}");
        std::process::exit(1);
    }
}
