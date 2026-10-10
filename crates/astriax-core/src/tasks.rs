use crate::{domain::Kind, Error, EventSink, Result};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio_util::sync::CancellationToken;

#[derive(Default)]
pub struct Tasks {
    active: Mutex<HashMap<String, Entry>>,
}
struct Entry {
    token: CancellationToken,
    progress: Value,
}
pub struct Task {
    pub key: String,
    pub token: CancellationToken,
    owner: Arc<Tasks>,
    emit: EventSink,
}
fn event(emit: &EventSink, progress: Value) {
    match progress["type"].as_str() {
        Some("a" | "n" | "python") => emit("download:progress", progress),
        Some("app-update") => emit("update:progress", progress),
        _ => {}
    }
}
impl Tasks {
    pub fn begin(
        self: &Arc<Self>,
        key: String,
        kind: &str,
        tag: &str,
        emit: EventSink,
    ) -> Result<Task> {
        let mut active = self.active.lock().unwrap();
        if active.contains_key(&key) {
            return Err(Error::Busy("此操作已在执行，请等待完成或取消".into()));
        }
        let token = CancellationToken::new();
        let progress = json!({ "type": kind, "tag": tag, "phase": "start", "percent": 0, "got": 0, "startedAt": chrono::Utc::now().timestamp_millis() });
        active.insert(
            key.clone(),
            Entry {
                token: token.clone(),
                progress: progress.clone(),
            },
        );
        drop(active);
        event(&emit, progress);
        Ok(Task {
            key,
            token,
            owner: self.clone(),
            emit,
        })
    }
    pub fn runtime(self: &Arc<Self>, kind: Kind, tag: &str, emit: EventSink) -> Result<Task> {
        self.begin(format!("{}:{tag}", kind.key()), kind.key(), tag, emit)
    }
    pub fn cancel(&self, key: &str) -> bool {
        let active = self.active.lock().unwrap();
        if let Some(entry) = active.get(key) {
            entry.token.cancel();
            true
        } else {
            false
        }
    }
    pub fn contains(&self, key: &str) -> bool {
        self.active.lock().unwrap().contains_key(key)
    }
    pub fn progress_for(&self, key: &str) -> Option<Value> {
        self.active
            .lock()
            .unwrap()
            .get(key)
            .map(|e| e.progress.clone())
    }
    pub fn snapshot(&self) -> Vec<Value> {
        self.active
            .lock()
            .unwrap()
            .values()
            .filter(|e| matches!(e.progress["type"].as_str(), Some("a" | "n" | "python")))
            .map(|e| e.progress.clone())
            .collect()
    }
    pub fn cancel_all(&self) {
        for e in self.active.lock().unwrap().values() {
            e.token.cancel();
        }
    }
    pub fn is_empty(&self) -> bool {
        self.active.lock().unwrap().is_empty()
    }
}
impl Task {
    pub fn set_sink(&mut self, emit: EventSink) {
        self.emit = emit;
    }
    pub fn check(&self) -> Result<()> {
        if self.token.is_cancelled() {
            Err(Error::Cancelled)
        } else {
            Ok(())
        }
    }
    pub fn progress(&self, phase: &str, label: &str, got: u64, total: Option<u64>) {
        let mut active = self.owner.active.lock().unwrap();
        let Some(entry) = active.get_mut(&self.key) else {
            return;
        };
        entry.progress["phase"] = json!(phase);
        entry.progress["label"] = json!(label);
        entry.progress["error"] = if phase == "error" {
            json!(label)
        } else {
            Value::Null
        };
        entry.progress["done"] = json!(phase == "done");
        entry.progress["got"] = json!(got);
        entry.progress["total"] = json!(total);
        entry.progress["percent"] = json!(total
            .filter(|n| *n > 0)
            .map(|n| (got as f64 / n as f64 * 100.).min(100.))
            .unwrap_or(0.));
        let elapsed = (chrono::Utc::now().timestamp_millis()
            - entry.progress["startedAt"].as_i64().unwrap_or(0))
        .max(1) as f64
            / 1000.;
        entry.progress["bytesPerSec"] = json!(got as f64 / elapsed);
        entry.progress["gotText"] = json!(format!("{:.1} MB", got as f64 / 1048576.));
        entry.progress["speedText"] = json!(format!("{:.1} MB/s", got as f64 / elapsed / 1048576.));
        let progress = entry.progress.clone();
        drop(active);
        event(&self.emit, progress);
    }
    pub fn finish(&self, result: &Result<Value>) {
        self.progress(
            if result.is_ok() { "done" } else { "error" },
            &result
                .as_ref()
                .err()
                .map(ToString::to_string)
                .unwrap_or_default(),
            0,
            None,
        );
    }
}
impl Drop for Task {
    fn drop(&mut self) {
        self.owner.active.lock().unwrap().remove(&self.key);
    }
}
