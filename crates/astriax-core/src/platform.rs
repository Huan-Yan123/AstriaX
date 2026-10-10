use crate::{Error, Result};
use std::process::Command;

pub fn hidden(command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(not(windows))]
    let _ = command;
}
// New processes are created suspended, assigned to a Job, then resumed before they
// can fork. ToolHelp retrieves the one primary thread created by CreateProcess.
#[cfg(windows)]
pub fn resume(pid: u32) -> Result<()> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{Diagnostics::ToolHelp::*, Threading::*},
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().into());
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut found = false;
        let mut more = Thread32First(snapshot, &mut entry);
        while more != 0 {
            if entry.th32OwnerProcessID == pid {
                let thread = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                if !thread.is_null() {
                    found = ResumeThread(thread) != u32::MAX;
                    CloseHandle(thread);
                }
                break;
            }
            more = Thread32Next(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        if !found {
            return Err(Error::Process("无法恢复纳入 Job 的子进程主线程".into()));
        }
        Ok(())
    }
}
#[cfg(not(windows))]
pub fn resume(_: u32) -> Result<()> {
    Ok(())
}

#[cfg(windows)]
pub mod job {
    use super::*;
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::JobObjects::*,
    };
    pub struct Job(HANDLE);
    // A Job handle is owned here; operations are thread safe Windows kernel calls.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}
    impl Job {
        pub fn new() -> Result<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return Err(std::io::Error::last_os_error().into());
                }
                let job = Self(handle);
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                if SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of_val(&info) as u32,
                ) == 0
                {
                    return Err(std::io::Error::last_os_error().into());
                }
                Ok(job)
            }
        }
        pub fn assign(&self, child: &tokio::process::Child) -> Result<()> {
            let handle = child
                .raw_handle()
                .ok_or_else(|| Error::Process("无法取得子进程句柄".into()))?;
            unsafe {
                if AssignProcessToJobObject(self.0, handle as HANDLE) == 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
            }
            Ok(())
        }
        pub fn terminate(&self) -> Result<()> {
            unsafe {
                if TerminateJobObject(self.0, 1) == 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
            }
            Ok(())
        }
        pub fn active(&self) -> Result<u32> {
            let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
            unsafe {
                if QueryInformationJobObject(
                    self.0,
                    JobObjectBasicAccountingInformation,
                    &mut info as *mut _ as *mut _,
                    std::mem::size_of_val(&info) as u32,
                    std::ptr::null_mut(),
                ) == 0
                {
                    return Err(std::io::Error::last_os_error().into());
                }
            }
            Ok(info.ActiveProcesses)
        }
        pub fn contains_pid(&self, pid: u32) -> Result<bool> {
            use windows_sys::Win32::System::Threading::{
                OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            };
            unsafe {
                let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
                if process.is_null() {
                    return Err(std::io::Error::last_os_error().into());
                }
                let mut contained = 0;
                let success = IsProcessInJob(process, self.0, &mut contained);
                CloseHandle(process);
                if success == 0 {
                    return Err(std::io::Error::last_os_error().into());
                }
                Ok(contained != 0)
            }
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}
#[cfg(not(windows))]
pub mod job {
    use super::*;
    pub struct Job;
    impl Job {
        pub fn new() -> Result<Self> {
            Ok(Self)
        }
        pub fn assign(&self, _: &tokio::process::Child) -> Result<()> {
            Ok(())
        }
        pub fn terminate(&self) -> Result<()> {
            Ok(())
        }
        pub fn active(&self) -> Result<u32> {
            Ok(0)
        }
    }
}

pub fn qq_status() -> serde_json::Value {
    crate::platform_qq::status()
}
