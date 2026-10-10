use crate::{
    storage::{atomic_json, checked_path, read_json, reject_link},
    Result,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Serialize, Deserialize)]
struct Move {
    dest: PathBuf,
    stage: PathBuf,
    old: PathBuf,
    had_original: bool,
}
#[derive(Serialize, Deserialize)]
struct Journal {
    committed: bool,
    moves: Vec<Move>,
}
fn remove(path: &Path) -> Result<()> {
    if !path.exists() {
        return Ok(());
    }
    reject_link(path)?;
    if path.is_dir() {
        fs::remove_dir_all(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}
fn rollback(root: &Path, journal: &Journal) -> Result<()> {
    for m in journal.moves.iter().rev() {
        for p in [&m.dest, &m.stage, &m.old] {
            checked_path(root, p)?;
        }
        if m.old.exists() {
            remove(&m.dest)?;
            fs::rename(&m.old, &m.dest)?;
        } else if !m.had_original && !m.stage.exists() {
            remove(&m.dest)?;
        }
    }
    Ok(())
}
pub fn replace(root: &Path, pairs: Vec<(PathBuf, PathBuf)>) -> Result<()> {
    let txn = root
        .join(".transactions")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&txn)?;
    let mut journal = Journal {
        committed: false,
        moves: vec![],
    };
    for (i, (stage, dest)) in pairs.into_iter().enumerate() {
        checked_path(root, &stage)?;
        checked_path(root, &dest)?;
        if dest == root
            || journal
                .moves
                .iter()
                .any(|m| dest.starts_with(&m.dest) || m.dest.starts_with(&dest))
        {
            return Err(crate::Error::Invalid(
                "事务目标不能是数据根或互相嵌套".into(),
            ));
        }
        if dest.exists() {
            reject_link(&dest)?;
        }
        journal.moves.push(Move {
            had_original: dest.exists(),
            dest,
            stage,
            old: txn.join(format!("old-{i}")),
        });
    }
    let log = txn.join("journal.json");
    atomic_json(&log, &journal)?;
    let result = (|| -> Result<()> {
        for m in &journal.moves {
            if m.had_original {
                fs::rename(&m.dest, &m.old)?;
            }
            if let Some(parent) = m.dest.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::rename(&m.stage, &m.dest)?;
        }
        journal.committed = true;
        atomic_json(&log, &journal)?;
        Ok(())
    })();
    if let Err(e) = result {
        rollback(root, &journal)?;
        // Leave recovery evidence when any rollback/cleanup step fails.
        fs::remove_dir_all(&txn)?;
        return Err(e);
    }
    // Cleanup failure cannot turn an already committed operation into a reported failure.
    let _ = fs::remove_dir_all(txn);
    Ok(())
}
pub fn recover(root: &Path) -> Result<()> {
    let dir = root.join(".transactions");
    if !dir.exists() {
        return Ok(());
    }
    reject_link(&dir)?;
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        reject_link(&path)?;
        let log = path.join("journal.json");
        if !log.exists() {
            continue;
        }
        let journal: Journal = read_json(&log)?;
        if !journal.committed {
            rollback(root, &journal)?;
        }
        fs::remove_dir_all(path)?;
    }
    Ok(())
}
