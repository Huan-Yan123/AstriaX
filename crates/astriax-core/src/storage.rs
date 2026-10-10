use crate::{
    domain::{segment, InstanceIndex, Kind, Runtime},
    Error, Result,
};
use fs2::FileExt;
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = fs::read(path)?;
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
    Ok(serde_json::from_slice(bytes)?)
}
pub fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| Error::Invalid("路径没有父目录".into()))?;
    fs::create_dir_all(parent)?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent)?;
    tmp.write_all(bytes)?;
    tmp.as_file().sync_all()?;
    tmp.persist(path)
        .map_err(|e| Error::Storage(e.to_string()))?;
    Ok(())
}
pub fn atomic_json(path: &Path, value: &impl Serialize) -> Result<()> {
    atomic_bytes(path, &serde_json::to_vec_pretty(value)?)
}
pub fn quarantine(path: &Path) -> Result<PathBuf> {
    let target = path.with_file_name(format!(
        "{}.corrupt-{}",
        path.file_name().unwrap().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    fs::rename(path, &target)?;
    Ok(target)
}
// Validate each existing ancestor, including junctions. Never follow reparse points in managed trees.
pub fn checked_path(root: &Path, path: &Path) -> Result<PathBuf> {
    let root = fs::canonicalize(root)?;
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    };
    let mut ancestor = absolute.as_path();
    while !ancestor.exists() {
        ancestor = ancestor
            .parent()
            .ok_or_else(|| Error::Invalid("路径越界".into()))?;
    }
    if !fs::canonicalize(ancestor)?.starts_with(&root) {
        return Err(Error::Invalid("路径不在受管理的数据目录内".into()));
    }
    for part in absolute.components() {
        if matches!(part, std::path::Component::ParentDir) {
            return Err(Error::Invalid("路径含 ..".into()));
        }
    }
    Ok(absolute)
}
pub fn reject_link(path: &Path) -> Result<()> {
    let m = fs::symlink_metadata(path)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if m.file_attributes() & 0x400 != 0 {
            return Err(Error::Invalid(format!(
                "不允许重解析点：{}",
                path.display()
            )));
        }
    }
    if m.file_type().is_symlink() {
        return Err(Error::Invalid("不允许符号链接".into()));
    }
    Ok(())
}
pub struct Store {
    pub root: PathBuf,
    pub config: Value,
    pub index: InstanceIndex,
    _lock: File,
}
impl Store {
    pub fn open(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(root.join(".astriax.lock"))?;
        lock.try_lock_exclusive()
            .map_err(|_| Error::Busy("此数据目录已由另一个 Rust 启动器使用".into()))?;
        crate::transaction::recover(&root)?;
        let config = if root.join("config.json").exists() {
            read_json(&root.join("config.json"))?
        } else {
            json!({})
        };
        let index = if root.join("instances.json").exists() {
            read_json(&root.join("instances.json"))?
        } else {
            InstanceIndex::default()
        };
        Ok(Self {
            root,
            config,
            index,
            _lock: lock,
        })
    }
    pub fn save_index(&self) -> Result<()> {
        atomic_json(&self.root.join("instances.json"), &self.index)
    }
    pub fn save_config(&self) -> Result<()> {
        atomic_json(&self.root.join("config.json"), &self.config)
    }
    pub fn runtime_dir(&self, kind: Kind, tag: &str) -> Result<PathBuf> {
        checked_path(
            &self.root,
            &self
                .root
                .join("runtimes")
                .join(kind.key())
                .join(segment(tag)?),
        )
    }
    pub fn instance(&self, id: &str) -> Result<crate::domain::Instance> {
        segment(id)?;
        let rec = self
            .index
            .instances
            .iter()
            .find(|r| r.id == id)
            .cloned()
            .ok_or_else(|| Error::Invalid("实例不存在".into()))?;
        let path = checked_path(&self.root, Path::new(&rec.dir))?;
        let base = self.root.join("instances");
        if path
            .strip_prefix(&base)
            .map(|p| p.components().count() < 1)
            .unwrap_or(true)
        {
            return Err(Error::Invalid("实例目录不在 instances 下".into()));
        }
        if path.file_name().and_then(|s| s.to_str()) != Some(id) {
            return Err(Error::Invalid("实例目录与 ID 不一致".into()));
        }
        reject_link(&path)?;
        Ok(rec)
    }
    pub fn tag(&self, id: &str) -> Result<String> {
        let rec = self.instance(id)?;
        let meta: Value = read_json(&Path::new(&rec.dir).join("instance.json"))?;
        Ok(segment(
            meta["runtimeTag"]
                .as_str()
                .ok_or_else(|| Error::Invalid("实例未绑定运行时".into()))?,
        )?
        .into())
    }
    pub fn runtimes(&self) -> Result<Vec<Runtime>> {
        let manifest = self.root.join("runtimes.json");
        let mut result: Vec<Runtime> = if manifest.exists() {
            let j: Value = read_json(&manifest)?;
            serde_json::from_value(j["versions"].clone())?
        } else {
            vec![]
        };
        result.retain(|r| {
            self.runtime_dir(r.kind, &r.tag)
                .map(|p| runtime_ready(r.kind, &p))
                .unwrap_or(false)
        });
        for runtime in &mut result {
            runtime.dir = self
                .runtime_dir(runtime.kind, &runtime.tag)?
                .to_string_lossy()
                .into_owned();
        }
        for kind in [Kind::AstrBot, Kind::NapCat] {
            let dir = self.root.join("runtimes").join(kind.key());
            if !dir.exists() {
                continue;
            }
            for e in fs::read_dir(dir)? {
                let e = e?;
                let tag = e.file_name().to_string_lossy().into_owned();
                if segment(&tag).is_err()
                    || !e.file_type()?.is_dir()
                    || result.iter().any(|r| r.kind == kind && r.tag == tag)
                {
                    continue;
                }
                reject_link(&e.path())?;
                if !runtime_ready(kind, &e.path()) {
                    continue;
                }
                result.push(Runtime {
                    kind,
                    tag,
                    dir: e.path().to_string_lossy().into_owned(),
                    installed_at: crate::domain::now(),
                    from: None,
                    size_mb: None,
                    extra: Default::default(),
                });
            }
        }
        result.sort_by(|a, b| crate::runtime::versions::compare(&b.tag, &a.tag, a.kind));
        Ok(result)
    }
}
pub fn runtime_ready(kind: Kind, dir: &Path) -> bool {
    match kind {
        Kind::AstrBot => dir.join("main.py").is_file() || dir.join("astrbot/__init__.py").is_file(),
        Kind::NapCat => {
            (dir.join("napcat.mjs").is_file()
                && dir.join("NapCatWinBootMain.exe").is_file()
                && dir.join("NapCatWinBootHook.dll").is_file()
                && dir.join("qqnt.json").is_file())
                || (dir.join("node.exe").is_file() && dir.join("index.js").is_file())
        }
    }
}
