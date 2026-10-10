// Read-only inspection deliberately does not acquire a writer or run recovery.
fn main() {
    let path = std::env::args_os()
        .nth(1)
        .map(std::path::PathBuf::from)
        .expect("用法：astriax-inspect <数据根>");
    match astriax_core::storage::read_json::<astriax_core::domain::InstanceIndex>(
        &path.join("instances.json"),
    ) {
        Ok(index) => println!("{}", serde_json::to_string_pretty(&index).unwrap()),
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}
