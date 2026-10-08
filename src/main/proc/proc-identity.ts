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
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-08 修正：第①条（必须回环）**对 OneBot 端口是错的**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 主人实测的现场（日志实据）
 *
 *     [WARN] 删除实例：端口 6200 被 pid 26324 占用，但**证据不足**
 *            （不是回环监听 ✘, 启动于 20:29:59）—— 为免误杀别人的进程，这次不动它。
 *            它是 E:\QQ\QQ.exe
 *     [WARN] 删除实例：端口 6200 仍被占用（PID 26324），无法确认 n_490819b494 已停止
 *
 * 结果是：实例明明是本启动器启动的，却**删不掉、停不掉、WebUI 也打不开** ——
 * 因为停止那一步被这道"保护"挡死了。
 *
 * ## 为什么①不成立
 *
 * netstat 实测：
 *     TCP  0.0.0.0:6200  LISTENING  26324
 *     TCP  0.0.0.0:6201  LISTENING  4476
 *
 * NapCat 在实例端口上监听的是 **OneBot 端口**，而那个端口**本来就该对外** ——
 * 机器人框架（AstrBot 等）要连它，绑回环反而连不上。
 * 当初写①时假设"NapCat 只绑本机"，那是把 **WebUI 端口**的形态
 * 套到了 **OneBot 端口**上，两者不是一回事。
 *
 * 所以①对最常见的 NapCat 场景**恒为假** → 恒不杀 → 端口永远占着。
 *
 * ## 现在的判据
 *
 *   ① **启动时间是硬条件**（必须晚于实例启动时刻）
 *      这条才是真正区分"我们的"和"用户自己的"的判据：
 *      那个实例是我们刚 spawn 的，占端口的进程必然在那之后起来；
 *      而用户自己开的东西要么早得多，要么根本对不上。
 *   ② 回环从"必要条件"降级为**加分项**
 *      · 回环 → 直接放行（老行为，WebUI 那种形态）
 *      · 对外 → **要求进程确实是 QQ**（`QQ.exe`）
 *        这一条补上①丢失的鉴别力：用户自己的 QQ **也是** QQ.exe，
 *        但它不会"恰好在实例启动之后、恰好在同一个实例端口上开监听"——
 *        那需要他正好在那个时刻、在那个端口上自己起一套 NapCat。
 *        这个窗口极小，而**漏杀的代价（实例删不掉、卡死）是确定会发生的**。
 *
 * ## 取舍为什么反过来
 *
 * 原注释说"漏杀 → 再点一次即可；误杀 → 不可逆"，所以往保守取。
 * 但实测证明**漏杀并不轻**：它不是"再点一次"，而是**这个实例永远删不掉、
 * 停不掉**，用户完全没有自救手段（我们连"手动关掉"的提示都给不出，
 * 因为那个 QQ 就是他自己在用的 QQ）。
 * 而误杀的风险已经被②压到很低。所以这里不再"一切往保守取"。
 */
export function shouldKillByPort(
  info: ProcInfo | undefined,
  ctx: { sinceMs: number; loopbackOnly: boolean }
): boolean {
  /* ② 必须有启动时间证据，且晚于实例启动时刻 —— 硬条件 */
  if (!info || !Number.isFinite(info.createdAt)) return false
  if (!Number.isFinite(ctx.sinceMs)) return false
  /*
   * 留 2 秒余量：进程创建时刻与"我们记录的开始时刻"之间可能有
   * 几毫秒到几百毫秒的误差（记录时刻、spawn、进程真正创建是三步）。
   * 而"用户多年前开的服务"与它差的是几天几个月 —— 2 秒足够区分。
   */
  const startedAfter = info.createdAt >= ctx.sinceMs - 2000
  if (!startedAfter) return false

  /*
   * ① 回环 → 直接放行（WebUI 那种形态，老行为不变）
   */
  if (ctx.loopbackOnly) return true

  /*
   * ①' 对外监听时：**必须确认是 QQ**
   *
   * OneBot 端口就是对外监听的（见上面那段实测），所以"对外"不能作为
   * 拒绝理由。但也确实需要一点鉴别力，否则"用户恰好在 6200 上跑了个
   * 别的对外服务"会被误杀 —— 用**进程名**补这一刀。
   *
   * 为什么不要求 exePath 以 E:\QQ 开头：QQ 的安装位置因人而异
   *（C 盘 / D 盘 / 自定义目录），写死路径等于换个用户就失效。
   * `QQ.exe` 这个文件名是稳定的 —— 而且**只有** QQ 会叫这个名字。
   */
  const exe = (info.exePath ?? '').toLowerCase()
  return /(^|[\\/])qq\.exe$/.test(exe)
}
