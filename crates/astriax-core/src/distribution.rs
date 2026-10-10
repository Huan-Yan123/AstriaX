//! Keep release locations separate from download policy and UI labels.
pub const RELEASES: &str = "https://github.com/Soffd/AstriaX/releases/download/";
pub const MANIFEST_URL: &str =
    "https://github.com/Soffd/AstriaX/releases/latest/download/tauri-latest.json";
// Third-party package mirror, independent from the launcher update feed.
pub const FILES_BASE: &str = "https://raw.githubusercontent.com/Huan-Yan123/AstriaX/main/files/";
pub const ACCELERATORS: &[&str] = &[
    "https://gh-proxy.com/",
    "https://ghfast.top/",
    "https://ghproxy.net/",
    "https://cors.isteed.cc/",
    "https://github.moeyy.xyz/",
    "https://gh.llkk.cc/",
    "",
];
