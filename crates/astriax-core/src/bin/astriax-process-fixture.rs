// Offline integration fixture; this binary is not included in desktop bundles.
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::Command,
};
fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.iter().any(|a| a == "-c") {
        let exe = std::env::current_exe().unwrap();
        let info: serde_json::Value = std::fs::read(exe.with_extension("probe.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        println!(
            "{}",
            serde_json::json!({"exe":exe,"version":info["version"].as_str().unwrap_or("3.12.10"),"bits":info["bits"].as_u64().unwrap_or(64),"implementation":"cpython","pip":info["pip"].as_bool().unwrap_or(true)})
        );
        return;
    }
    let port = args
        .iter()
        .position(|a| a == "--port")
        .and_then(|i| args.get(i + 1))
        .unwrap()
        .parse::<u16>()
        .unwrap();
    let listener = TcpListener::bind(("127.0.0.1", port)).unwrap();
    let mut child = None;
    if let Some(i) = args.iter().position(|a| a == "--child-port") {
        child = Some(
            Command::new(std::env::current_exe().unwrap())
                .args(["--port", &args[i + 1]])
                .spawn()
                .unwrap(),
        );
    }
    println!("实例已启动：中文日志验证");
    for mut stream in listener.incoming().flatten() {
        let mut b = [0u8; 1024];
        let _ = stream.read(&mut b);
        let _ = stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
    }
    if let Some(mut child) = child {
        let _ = child.kill();
    }
}
