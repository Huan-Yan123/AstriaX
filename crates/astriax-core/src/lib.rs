pub mod archive;
pub mod backup;
pub mod credentials;
pub mod distribution;
pub mod domain;
pub mod error;
pub mod instances;
pub mod logs;
pub mod maintenance;
pub mod napcat_logs;
pub mod platform;
pub mod platform_ports;
pub mod platform_qq;
pub mod process;
pub mod router;
pub mod runtime;
pub mod settings;
pub mod sources;
pub mod storage;
pub mod tasks;
pub mod transaction;
pub mod updater;

pub use error::{Error, Result};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};
use tokio::sync::{Mutex, RwLock};

pub type EventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;
#[derive(Clone)]
pub struct Launcher {
    pub store: Arc<Mutex<storage::Store>>,
    pub processes: Arc<process::ProcessManager>,
    pub tasks: Arc<tasks::Tasks>,
    // Every root-dependent operation takes a read lease; migration takes the write lease.
    pub root_gate: Arc<RwLock<()>>,
    pub python_gate: Arc<RwLock<()>>,
    runtime_locks: Arc<Mutex<std::collections::HashMap<String, Arc<RwLock<()>>>>>,
    pub client: reqwest::Client,
    pub emit: EventSink,
    pub install_dir: PathBuf,
}
impl Launcher {
    pub fn open(install_dir: PathBuf, data_root: PathBuf, emit: EventSink) -> Result<Self> {
        let store = storage::Store::open(data_root)?;
        let client = reqwest::Client::builder()
            .user_agent(concat!("AstriaX/", env!("CARGO_PKG_VERSION"), " Rust"))
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(600))
            .build()?;
        Ok(Self {
            store: Arc::new(Mutex::new(store)),
            processes: Arc::new(process::ProcessManager::default()),
            tasks: Arc::new(tasks::Tasks::default()),
            root_gate: Arc::new(RwLock::new(())),
            python_gate: Arc::new(RwLock::new(())),
            runtime_locks: Arc::new(Mutex::new(Default::default())),
            client,
            emit,
            install_dir,
        })
    }
    pub async fn root(&self) -> PathBuf {
        self.store.lock().await.root.clone()
    }
    pub async fn runtime_lock(&self, kind: domain::Kind, tag: &str) -> Arc<RwLock<()>> {
        self.runtime_locks
            .lock()
            .await
            .entry(format!("{}:{tag}", kind.key()))
            .or_default()
            .clone()
    }
    pub async fn call(&self, channel: &str, p: Value) -> Result<Value> {
        let result = if matches!(
            channel,
            "config:moveDataRoot"
                | "config:set"
                | "config:moving"
                | "runtimes:cancel"
                | "download:sessions"
                | "logs:exportBusy"
        ) {
            router::dispatch(self, channel, p).await
        } else {
            let _lease = self.root_gate.read().await;
            router::dispatch(self, channel, p).await
        };
        // Never log command payloads: they can contain credentials or private source URLs.
        let root = self.root().await;
        let _ = logs::audit(&root, channel, result.is_ok());
        result
    }
}
