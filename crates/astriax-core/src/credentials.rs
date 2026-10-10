use crate::{
    domain::{Instance, Kind},
    storage::{atomic_bytes, atomic_json, read_json},
    Error, Result,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

pub fn reset(rec: &Instance) -> Result<Value> {
    let dir = Path::new(&rec.dir);
    let file = dir.join(if rec.kind == Kind::AstrBot {
        "data/cmd_config.json"
    } else {
        "config/webui.json"
    });
    let mut config = if file.exists() {
        match read_json::<Value>(&file) {
            Ok(v) if v.is_object() => v,
            _ => {
                crate::storage::quarantine(&file)?;
                json!({})
            }
        }
    } else {
        json!({})
    };
    let result = if rec.kind == Kind::AstrBot {
        let salt = uuid::Uuid::new_v4();
        let mut digest = [0u8; 32];
        pbkdf2::pbkdf2_hmac::<Sha256>(b"astrbot", salt.as_bytes(), 600_000, &mut digest);
        if !config["dashboard"].is_object() {
            config["dashboard"] = json!({});
        }
        let d = &mut config["dashboard"];
        d["username"] = json!("astrbot");
        d["pbkdf2_password"] = json!(format!(
            "pbkdf2_sha256$600000${}${}",
            hex::encode(salt.as_bytes()),
            hex::encode(digest)
        ));
        d["password"] = json!(hex::encode(md5::Md5::digest(b"astrbot")));
        d["password_storage_upgraded"] = json!(true);
        d["password_change_required"] = json!(false);
        atomic_bytes(&dir.join(".astrbot"), b"")?;
        json!([{"label":"用户名","value":"astrbot"},{"label":"密码","value":"astrbot"}])
    } else {
        config["token"] = json!("114514");
        json!([{"label":"Token","value":"114514"}])
    };
    atomic_json(&file, &config)?;
    Ok(result)
}
fn verify(raw: &str, hash: &str) -> bool {
    let p = hash.split('$').collect::<Vec<_>>();
    if p.len() != 4 || p[0] != "pbkdf2_sha256" {
        return false;
    }
    let Ok(n) = p[1].parse::<u32>() else {
        return false;
    };
    if n == 0 || n > 1_000_000 {
        return false;
    }
    let (Ok(salt), Ok(expected)) = (hex::decode(p[2]), hex::decode(p[3])) else {
        return false;
    };
    if salt.len() > 64 || expected.len() != 32 {
        return false;
    }
    let mut digest = [0u8; 32];
    pbkdf2::pbkdf2_hmac::<Sha256>(raw.as_bytes(), &salt, n, &mut digest);
    digest
        .iter()
        .zip(expected)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}
pub fn read(root: &Path, rec: &Instance) -> Result<Value> {
    let dir = Path::new(&rec.dir);
    if rec.kind == Kind::NapCat {
        let file = dir.join("config/webui.json");
        if !file.exists() {
            return Ok(json!([]));
        }
        let c: Value = read_json(&file)?;
        return Ok(if let Some(token) = c["token"].as_str() {
            json!([{"label":"Token","value":token}])
        } else {
            json!([])
        });
    }
    let file = dir.join("data/cmd_config.json");
    if !file.exists() {
        return Ok(json!([]));
    }
    let c: Value = read_json(&file)?;
    let dash = &c["dashboard"];
    let mut items = vec![];
    if let Some(user) = dash["username"].as_str() {
        items.push(json!({"label":"用户名","value":user}));
    }
    let hash = dash["pbkdf2_password"].as_str().unwrap_or("");
    let log = crate::logs::tail(
        &root.join("logs/instances").join(format!("{}.log", rec.id)),
        0,
    )?;
    let re = regex::Regex::new(r"Initial password:\s*([A-Za-z0-9_-]+)").unwrap();
    let mut candidates = re
        .captures_iter(&log)
        .map(|c| c[1].to_string())
        .collect::<Vec<_>>();
    candidates.reverse();
    candidates.truncate(2);
    candidates.push("astrbot".into());
    let password = candidates.into_iter().find(|s| {
        verify(s, hash)
            || (hash.is_empty()
                && dash["password"]
                    .as_str()
                    .is_some_and(|h| h == hex::encode(md5::Md5::digest(s.as_bytes()))))
    });
    if !hash.is_empty() || dash["password"].is_string() {
        items.push(json!({"label":"密码","value":password.unwrap_or_else(||"（看不到，点上面的「重置账密」可以重设）".into())}));
    }
    Ok(json!(items))
}
pub fn token(rec: &Instance) -> Result<Option<String>> {
    if rec.kind != Kind::NapCat {
        return Err(Error::Invalid("仅 NapCat 有 token".into()));
    }
    let file = Path::new(&rec.dir).join("config/webui.json");
    if !file.exists() {
        return Ok(None);
    }
    let value: Value = read_json(&file)?;
    Ok(value["token"].as_str().map(str::to_string))
}
