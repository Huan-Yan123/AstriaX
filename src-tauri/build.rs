fn main() {
    let manifest = include_str!("app.manifest");
    let manifest = if std::env::var("PROFILE").as_deref() == Ok("debug") {
        manifest.replace("requireAdministrator", "asInvoker")
    } else {
        manifest.to_string()
    };
    let windows = tauri_build::WindowsAttributes::new().app_manifest(manifest);
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows))
        .expect("Tauri build failed");
}
