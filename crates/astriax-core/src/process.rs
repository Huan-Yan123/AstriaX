use crate::{platform::job::Job, Error, Result};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone)]
pub struct LaunchSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: HashMap<String, String>,
}
struct Session {
    child: Child,
    job: Job,
    readers: Vec<tokio::task::JoinHandle<()>>,
    cancellation: CancellationToken,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.cancellation.cancel();
        for reader in &self.readers {
            reader.abort();
        }
    }
}
#[derive(Default)]
pub struct ProcessManager {
    sessions: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Session>>>>,
}
pub fn command(spec: &LaunchSpec) -> Command {
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args)
        .current_dir(&spec.cwd)
        .envs(&spec.env)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000 | 0x00000004);
    cmd
}
pub async fn port_free(port: u16) -> bool {
    #[cfg(windows)]
    {
        crate::platform_ports::owners(port)
            .map(|owners| owners.is_empty())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        let ipv4 = tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port)).await;
        let ipv6 = tokio::net::TcpListener::bind((std::net::Ipv6Addr::UNSPECIFIED, port)).await;
        ipv4.is_ok() && ipv6.is_ok()
    }
}
pub async fn listening(port: u16) -> bool {
    tokio::time::timeout(
        Duration::from_millis(400),
        tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)),
    )
    .await
    .map(|r| r.is_ok())
    .unwrap_or(false)
}
async fn capture(mut pipe: impl tokio::io::AsyncRead + Unpin, file: PathBuf) {
    let mut bytes = [0u8; 8192];
    loop {
        match pipe.read(&mut bytes).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let _ = crate::logs::append(&file, &bytes[..n]);
            }
        }
    }
}
impl ProcessManager {
    pub async fn spawn(&self, id: &str, spec: &LaunchSpec, log: PathBuf) -> Result<u32> {
        if self.sessions.lock().unwrap().contains_key(id) {
            return Err(Error::Busy("实例已有受控进程，请先停止".into()));
        }
        let job = Job::new()?;
        let mut child = command(spec)
            .spawn()
            .map_err(|e| Error::Process(format!("无法启动 {}：{e}", spec.program.display())))?;
        if let Err(e) = job.assign(&child) {
            let _ = child.kill().await;
            return Err(e);
        }
        let pid = child
            .id()
            .ok_or_else(|| Error::Process("进程未创建".into()))?;
        if let Err(e) = crate::platform::resume(pid) {
            let _ = child.kill().await;
            return Err(e);
        }
        let mut readers = vec![];
        if let Some(stdout) = child.stdout.take() {
            readers.push(tokio::spawn(capture(stdout, log.clone())));
        }
        if let Some(stderr) = child.stderr.take() {
            readers.push(tokio::spawn(capture(stderr, log)));
        }
        self.sessions.lock().unwrap().insert(
            id.into(),
            Arc::new(tokio::sync::Mutex::new(Session {
                child,
                job,
                readers,
                cancellation: CancellationToken::new(),
            })),
        );
        Ok(pid)
    }
    pub async fn active(&self, id: &str) -> bool {
        let entry = self.sessions.lock().unwrap().get(id).cloned();
        if let Some(entry) = entry {
            let mut s = entry.lock().await;
            let alive = s.child.try_wait().ok().flatten().is_none();
            alive || s.job.active().unwrap_or(1) > 0
        } else {
            false
        }
    }
    pub async fn owns_port(&self, id: &str, port: u16) -> Result<bool> {
        #[cfg(windows)]
        {
            let entry = self.sessions.lock().unwrap().get(id).cloned();
            let Some(entry) = entry else {
                return Ok(false);
            };
            let session = entry.lock().await;
            let owners = crate::platform_ports::owners(port)?;
            if owners.is_empty() {
                return Ok(false);
            }
            for pid in owners {
                if !session.job.contains_pid(pid)? {
                    return Ok(false);
                }
            }
            Ok(true)
        }
        #[cfg(not(windows))]
        {
            Ok(self.active(id).await && listening(port).await)
        }
    }
    pub async fn collect_napcat(
        &self,
        id: &str,
        client: reqwest::Client,
        rec: crate::domain::Instance,
        log: PathBuf,
    ) {
        let entry = self.sessions.lock().unwrap().get(id).cloned();
        if let Some(entry) = entry {
            let mut session = entry.lock().await;
            let reader =
                crate::napcat_logs::collect(client, rec, log, session.cancellation.clone());
            session.readers.push(reader);
        }
    }
    pub async fn stop(&self, id: &str, port: u16) -> Result<()> {
        let entry = self.sessions.lock().unwrap().get(id).cloned();
        if let Some(entry) = entry {
            let mut s = entry.lock().await;
            s.cancellation.cancel();
            s.job.terminate()?;
            if s.child.try_wait()?.is_none() {
                s.child.kill().await?;
            }
            tokio::time::timeout(Duration::from_secs(10), s.child.wait())
                .await
                .map_err(|_| Error::Process("等待子进程停止超时".into()))??;
            for _ in 0..50 {
                if s.job.active()? == 0 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            if s.job.active()? > 0 {
                return Err(Error::Process("Job 中仍有进程，停止未确认".into()));
            }
            for mut reader in s.readers.drain(..) {
                if tokio::time::timeout(Duration::from_secs(2), &mut reader)
                    .await
                    .is_err()
                {
                    reader.abort();
                }
            }
            self.sessions.lock().unwrap().remove(id);
        }
        // A listener can belong to an injected/breakaway QQ or to an unrelated program.
        // Port numbers alone are insufficient ownership evidence. Block mutation instead.
        for _ in 0..30 {
            if port_free(port).await {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err(Error::Process(format!(
            "端口 {port} 仍被占用，无法确认停止。请关闭对应实例后重试"
        )))
    }
}
pub async fn run(
    spec: &LaunchSpec,
    token: &CancellationToken,
    log: &std::path::Path,
) -> Result<()> {
    let job = Job::new()?;
    let mut child = command(spec).spawn()?;
    if let Err(e) = job.assign(&child) {
        let _ = child.kill().await;
        return Err(e);
    }
    if let Err(e) = crate::platform::resume(
        child
            .id()
            .ok_or_else(|| Error::Process("进程未创建".into()))?,
    ) {
        let _ = child.kill().await;
        return Err(e);
    }
    let out = child
        .stdout
        .take()
        .map(|p| tokio::spawn(capture(p, log.to_path_buf())));
    let err = child
        .stderr
        .take()
        .map(|p| tokio::spawn(capture(p, log.to_path_buf())));
    let result = tokio::select! {
        _ = token.cancelled() => { job.terminate()?; let _ = child.kill().await; Err(Error::Cancelled) }
        status = child.wait() => {
            let status = status?;
            if status.success() { Ok(()) } else { Err(Error::Process(format!("外部程序退出码 {status}，请查看 {}", log.display()))) }
        }
    };
    for handle in [out, err].into_iter().flatten() {
        let _ = tokio::time::timeout(Duration::from_secs(2), handle).await;
    }
    result
}
