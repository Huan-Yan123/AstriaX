/*
 * 「这个占着端口的进程，是不是我们启动的那个实例？」
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么需要它（深度审查报告 C-1，已复验）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 停实例时，`taskkill /T` 之后如果端口还占着，程序会**按端口精确补杀**：
 *
 *     const pid = await findListenerPidAsync(rec.port)
 *     await run('taskkill', ['/PID', String(pid), '/T', '/F'], ...)
 *
 * **唯一判据是"谁在 LISTENING 这个端口"**。而程序**自我提权到管理员**，
 * 所以这是一条"管理员权限的 `taskkill /F /T`"原语（`/T` 连子进程一起杀）。
 *
 * 原来的理由是「端口段（6200-6299）是我们的，不会误伤」——
 * 但端口段只是我们**优先选**的区间，不是保留区；用户完全可能在
 * 6200 上跑别的服务，或者自己手开一个 NapCat。
 *
 * 而 `process-manager.ts` 里明写着承诺：
 *     「绝不按进程名扫描系统；用户另跑的 napcat/astrbot/QQ 一概不碰」
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 判据怎么选（这一版是实测三次之后定下来的）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 试过但**不成立**的判据
 *
 * ① **命令行里找实例目录/id**
 *    实测本机 QQ 主进程：
 *        "E:\QQ\QQ.exe"          ← 命令行里什么都没有！
 *    因为 `NAPCAT_WORKDIR`（实例目录）是**环境变量**，
 *    环境变量**不出现在 CommandLine 里**。→ 判据永远不命中，
 *    等于"永远不杀"，端口永远占着（那不是修 bug，是把功能废掉）。
 *
 * ② **映像路径落在运行时目录下**
 *    NapCat 注入的是**用户自己的 QQ**（`E:\QQ\QQ.exe`），
 *    根本不在我们的 runtimes 目录里。→ 同样不命中。
 *
 * ## 现在用的判据：**监听地址 + 进程启动时间**（两条都要满足）
 *
 *   · **监听地址必须是回环**（127.0.0.1 / ::1）
 *     NapCat 的 WebUI/反向 WS 只绑本机；而"用户在 6200 上跑的服务"
 *     如果是给别人用的，绑的必然是 0.0.0.0。这条能挡掉相当一部分误杀。
 *
 *   · **进程的启动时间必须晚于我们记录的开始时刻**
 *     这是**最硬的一条**：那个实例是我们刚 spawn 的，占端口的进程
 *     必然是在那之后起来的。而"用户几年前就开着的服务"一定早于它。
 *
 * 两条都满足才允许补杀。这样：
 *   · 真实场景（脱链的 QQ，回环监听、刚启动）→ **认得出，能杀** ✔
 *   · 用户自己开的服务（要么绑 0.0.0.0，要么启动更早）→ **不杀** ✔
 *
 * ## 拿不到信息时**不杀**（保守）
 *
 * 漏杀 → 用户看到"没停干净"，再点一次即可（还能手工处理）。
 * 误杀 → 用户别的东西当场没了，**不可逆**。
 * 这个不对称决定了一切判断往保守那边取。
 */
import { run } from '../util/async-exec'

/** 一次进程查询的结果（够判身份即可） */
export interface ProcInfo {
  pid: number
  /** 可执行文件完整路径（可能拿不到 —— 提权进程/权限不足） */
  exePath?: string
  /** 完整命令行（可能拿不到） */
  commandLine?: string
  /** 父进程 pid */
  parentPid?: number
  /** 进程创建时刻（ms epoch）—— **最硬的判据** */
  createdAt?: number
}

/**
 * 批量查进程信息（用 PowerShell 的 CIM 查询）。
 *
 * ## 查询写法：`-in` 过滤，不用 WQL 的 `OR`
 *
 * 第一版写的是 `-Filter "ProcessId=1 OR ProcessId=2"` —— **实测直接报错**：
 *     Get-CimInstance : A positional parameter cannot be found
 *     that accepts argument 'OR'.
 * 因为那句 filter 要经过 **Node → PowerShell -Command → WQL** 三层引号，
 * 中间那层把引号吃掉了。换成"取全部再 `-in` 过滤"就完全不依赖引号内容。
 *
 * pid 是我们自己从 netstat 解析出的整数，不是用户输入，没有注入面；
 * 但仍 `Number.isInteger` 过滤一遍以防上游算错。
 *
 * ## 失败时返回空 Map（调用方据此"保守不杀"）
 */
export async function queryProcInfo(pids: number[]): Promise<Map<number, ProcInfo>> {
  const out = new Map<number, ProcInfo>()
  const wanted = pids.filter((n) => Number.isInteger(n) && n > 0)
  if (!wanted.length) return out

  const script =
    `Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ` +
    `Where-Object { @(${wanted.join(',')}) -contains $_.ProcessId } | ` +
    `Select-Object ProcessId,ExecutablePath,CommandLine,ParentProcessId,CreationDate | ` +
    `ConvertTo-Json -Compress`

  try {
    const r = await run(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeoutMs: 8000 }
    )
    const text = String(r.stdout ?? '').trim()
    if (!text) return out
    const parsed = JSON.parse(text) as unknown
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    for (const row of rows as Array<Record<string, unknown>>) {
      const pid = Number(row.ProcessId)
      if (!Number.isInteger(pid)) continue
      /*
       * `CreationDate` 从 CIM 出来是 `\/Date(1695800000000)\/` 或
       * ISO 字符串（取决于 PowerShell 版本）—— 两种都解析。
       */
      let createdAt: number | undefined
      const rawDate = row.CreationDate
      if (typeof rawDate === 'string') {
        const m = /\/Date\((\d+)\)\//.exec(rawDate)
        if (m) createdAt = Number(m[1])
        else {
          const t = Date.parse(rawDate)
          if (!Number.isNaN(t)) createdAt = t
        }
      } else if (typeof rawDate === 'number') {
        createdAt = rawDate
      }

      out.set(pid, {
        pid,
        exePath: typeof row.ExecutablePath === 'string' ? row.ExecutablePath : undefined,
        commandLine: typeof row.CommandLine === 'string' ? row.CommandLine : undefined,
        parentPid: Number.isInteger(Number(row.ParentProcessId))
          ? Number(row.ParentProcessId)
          : undefined,
        createdAt
      })
    }
  } catch {
    /* 查不到 —— 返回空，调用方会保守地不杀 */
  }
  return out
}

/** 这个端口是不是**只绑回环**（NapCat 的形态） */
export function isLoopbackOnly(netstatText: string, port: number): boolean {
  const lines = String(netstatText ?? '').split(/\r?\n/)
  let found = false
  for (const line of lines) {
    if (!/\bLISTENING\b/i.test(line)) continue
    const m = /^\s*TCP\s+(\S+):(\d+)\s+/i.exec(line)
    if (!m || Number(m[2]) !== port) continue
    found = true
    const addr = m[1]
    /*
     * 只绑回环的形态：`127.0.0.1` / `[::1]` / `[::]`（IPv6 的 any 但
     * Windows 上 NapCat 会同时出现 v4/v6 两条，任一为对外即算对外）。
     * 只要**有一条**是对外地址（0.0.0.0 / 具体网卡 IP），就当"对外"。
     */
    if (addr === '0.0.0.0' || addr === '[::]') return false
    if (/^\d+\.\d+\.\d+\.\d+$/.test(addr) && !addr.startsWith('127.')) return false
  }
  /* 没找到监听记录 → 不能证明是回环 → 保守返回 false（调用方不杀） */
  return found
}

/**
 * 这个占端口的进程**该不该被杀**。
 *
 * 返回 `true` = **可以杀**（有充分证据表明它是这个实例的）。
 *
 * ## 判据（两条都要满足）
 *
 *   ① 端口**只绑回环**（NapCat 的 WebUI 就是本机服务）
 *   ② 进程启动时间 **晚于** `sinceMs`（那个实例开始启动的时刻）
 *
 * ## 为什么这两条够用
 *
 * 真实场景：NapCat 注入用户自己的 QQ（`E:\QQ\QQ.exe`，命令行里
 * **没有**实例痕迹 —— 实测确认），它：
 *   · 绑 127.0.0.1（NapCat 的 WebUI 只服务本机）✔
 *   · 是我们**刚 spawn** 的，启动时间必然晚于实例启动时刻 ✔
 *
 * 用户自己开的服务（在 6200 上）：
 *   · 若要给别人用 → 绑 0.0.0.0 → ① 不满足 → 不杀 ✔
 *   · 若只本机用但开得比实例早 → ② 不满足 → 不杀 ✔
 *
 * 剩下的重叠窗口很小（用户恰好在**实例启动之后**、在**同一个端口**上
 * 起了个**只绑本机**的服务）—— 那种情况本来就几乎不可能发生，
 * 因为端口是我们分配给这个实例的。
 */
export function shouldKillByPort(
  info: ProcInfo | undefined,
  ctx: { sinceMs: number; loopbackOnly: boolean }
): boolean {
  /* ① 端口必须只绑回环 */
  if (!ctx.loopbackOnly) return false

  /* ② 必须有启动时间证据，且晚于实例启动时刻 */
  if (!info || !Number.isFinite(info.createdAt)) return false
  if (!Number.isFinite(ctx.sinceMs)) return false

  /*
   * 留 2 秒余量：进程创建时刻与"我们记录的开始时刻"之间可能有
   * 几毫秒到几百毫秒的误差（记录时刻、spawn、进程真正创建是三步）。
   * 而"用户多年前开的服务"与它差的是几天几个月 —— 2 秒足够区分。
   */
  return info.createdAt >= ctx.sinceMs - 2000
}
