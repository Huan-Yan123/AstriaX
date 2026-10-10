use crate::{Error, Result};

// Query listeners without connecting to a service, and without parsing netstat or spawning a shell.
#[cfg(windows)]
pub fn owners(port: u16) -> Result<Vec<u32>> {
    use windows_sys::Win32::{
        NetworkManagement::IpHelper::*,
        Networking::WinSock::{AF_INET, AF_INET6},
    };
    let mut owners = vec![];
    for family in [AF_INET, AF_INET6] {
        let mut size = 0u32;
        unsafe {
            GetExtendedTcpTable(
                std::ptr::null_mut(),
                &mut size,
                0,
                family as u32,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            );
        }
        // u64 allocation preserves alignment for all Windows table fields.
        let mut buffer = vec![0u64; (size as usize).div_ceil(8)];
        let status = unsafe {
            GetExtendedTcpTable(
                buffer.as_mut_ptr() as *mut _,
                &mut size,
                0,
                family as u32,
                TCP_TABLE_OWNER_PID_LISTENER,
                0,
            )
        };
        if status != 0 {
            return Err(Error::Process(format!("无法查询 TCP 监听进程：{status}")));
        }
        let count = unsafe { *(buffer.as_ptr() as *const u32) } as usize;
        let bytes = buffer.as_ptr() as *const u8;
        if family == AF_INET {
            let row_size = std::mem::size_of::<MIB_TCPROW_OWNER_PID>();
            if 4 + count * row_size > size as usize {
                return Err(Error::Process("TCP 表长度无效".into()));
            }
            for i in 0..count {
                let row = unsafe {
                    std::ptr::read_unaligned(
                        bytes.add(4 + i * row_size) as *const MIB_TCPROW_OWNER_PID
                    )
                };
                if u16::from_be(row.dwLocalPort as u16) == port {
                    owners.push(row.dwOwningPid);
                }
            }
        } else {
            let row_size = std::mem::size_of::<MIB_TCP6ROW_OWNER_PID>();
            if 4 + count * row_size > size as usize {
                return Err(Error::Process("IPv6 TCP 表长度无效".into()));
            }
            for i in 0..count {
                let row = unsafe {
                    std::ptr::read_unaligned(
                        bytes.add(4 + i * row_size) as *const MIB_TCP6ROW_OWNER_PID
                    )
                };
                if u16::from_be(row.dwLocalPort as u16) == port {
                    owners.push(row.dwOwningPid);
                }
            }
        }
    }
    owners.sort_unstable();
    owners.dedup();
    Ok(owners)
}
#[cfg(not(windows))]
pub fn owners(_: u16) -> Result<Vec<u32>> {
    Err(Error::Unsupported("此平台未实现 TCP 身份查询".into()))
}
