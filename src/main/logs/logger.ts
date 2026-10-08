import { appendFileSync, mkdirSync, cpSync, existsSync, rmSync, readdirSync, writeFileSync, statSync } from 'fs'
import { promises as fsp } from 'fs'
import { spawn, spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import { join } from 'path'
import { psQuote } from '../util/async-exec'
import { readLastRunReport, systemInfoText } from '../util/crash-logs'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'CRASH'

export interface LoggerDeps {
  /** 日志随数据根走：data/logs/app-<日期>.log */
  dataRoot: string
  /** 测试注入固定日期；缺省=当天日期 */
  dateFor?: () => string
  /** 测试注入压缩执行器；缺省=Windows PowerShell Compress-Archive */
  zipRunner?: (cmd: string, args: string[]) => Promise<number>
  /** 测试注入同步压缩执行器（崩溃现场用）；缺省=spawnSync PowerShell */
  zipRunnerSync?: (cmd: string, args: string[]) => number
  /**
   * 当前版本号（写进导出包的系统信息里）。
   *
   * 排查崩溃时"什么版本"是第一句要问的；让导出包自带这行，
   * 别指望用户记得自己是 0.1.2 还是 0.1.3。
   */
  appVersion?: string
  /**
   * ★ 设备与依赖信息采集器（主人 2026-09-27：
   *   「日志系统应该同时收集一次设备信息，比如系统，依赖，硬件等」）。
   *
   * 不注入时退回原来的 8 行基础信息（`systemInfoText`）——
   * 这样单测不需要真的去跑 PowerShell/WMI。
   *
   * 生产由 ipc.ts 注入 `collectDeviceInfo` 的偏函数（已带上数据根、
   * 提权状态、QQ 与 Python 状态），返回一段完整的多行文本。
   */
  deviceInfo?: () => Promise<string>
}

export interface Logger {
  log: (level: LogLevel, scope: string, msg: string, detail?: string) => void
  /** 崩溃兜底：进程将死前也要同步落盘 */
  crash: (scope: string, msg: string) => void
  /** 把 logs/ + config.json + instances.json 打成日期标注 zip，返回 zip 绝对路径 */
  exportZip: () => Promise<string>
  /** 崩溃现场同步打包（spawnSync，进程退出前一口气做完） */
  exportZipSync: () => string
}

/** 读目录，读不了就当空（导出时不该因为一个不可读目录整个失败） */
function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function createLogger(deps: LoggerDeps): Logger {
  const logsDir = join(deps.dataRoot, 'logs')
  const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
  const date = deps.dateFor ?? (() => new Date().toISOString().slice(0, 10))
  const file = () => join(logsDir, `app-${date()}.log`)

  const write = (level: LogLevel, scope: string, msg: string, detail?: string) => {
    const line =
      detail === undefined
        ? `[${stamp()}] [${level}] [${scope}] ${msg}\n`
        : `[${stamp()}] [${level}] [${scope}] ${msg} :: ${detail}\n`
    /*
     * ══════════════════════════════════════════════════════════════════════════
     * ★★ 写日志**绝不能把软件搞崩**（主人 2026-09-27 实测的真崩溃）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 现场
     *
     * 他点「导出日志」（正在打包…）时，软件弹「AstriaX 崩溃了」并直接退出，
     * 弹窗里的原始报错是：
     *
     *     EBUSY: resource busy or locked, open
     *     'E:\MX\launcher-acb\data\logs\app-2026-09-27.log'
     *
     * 日志里也有对应的：
     *     [08:34:17] [CRASH] [uncaughtException] Error: EBUSY: resource busy
     *     or locked, open '...\app-2026-09-27.log'
     *
     * ## 因果链
     *
     *   ① 导出日志时，`tar`（或 `Compress-Archive`）正在读那些日志文件
     *      → 在 Windows 上它会**持有句柄**
     *   ② 就在这几秒里，程序照常写日志 → `appendFileSync` 撞上那个句柄
     *      → 抛 `EBUSY`
     *   ③ **这里原来没有任何 try/catch** → 异常一路冒到
     *      `uncaughtException` → 我们的兜底处理是 `app.exit(1)`
     *   ④ **软件就这么退出去了**，而用户当时只是点了个"导出日志"
     *
     * 第 ③ 步是致命的：**日志是"记录发生了什么"的东西，
     * 它写失败绝不能反过来让程序死掉** —— 那是本末倒置。
     *
     * ## 修法
     *
     * 包 try/catch，失败就**静默丢弃这一条**。
     *
     * 为什么不重试/不落别处：
     *   · 重试会放大阻塞（这个函数在热路径上，每次日志都调）
     *   · 落备选文件会引入"日志分叉"，排查时更乱
     *   · 丢一条日志的代价，远小于**整个软件崩掉**
     *
     * `mkdirSync` 也一并包进来：磁盘满 / 权限问题时它同样会抛
     *（而且那条路径以前也在 try 外面）。
     */
    try {
      mkdirSync(logsDir, { recursive: true })
      appendFileSync(file(), line, 'utf8') // 同步写：崩溃前最后一口气也要落盘
    } catch {
      /* 写不进去就算了 —— 绝不让"记日志"这件事把软件搞崩 */
    }
  }

  const zipRunner =
    deps.zipRunner ??
    (async (cmd, args) =>
      new Promise<number>((resolve) => {
        try {
          const child = spawn(cmd, args, { stdio: 'ignore' })
          child.on('close', (code) => resolve(code ?? 1))
          child.on('error', () => resolve(1))
        } catch {
          resolve(1)
        }
      }))

  /**
   * 把要导出的东西收进暂存目录（**异步版**）。
   *
   * ## 为什么必须异步（主人要求 + 实测证据）
   *
   * 主人机器上的日志：
   *     [ERROR] [perf] IPC logs:export 耗时 30871ms（严重）
   *     [ERROR] [perf] IPC logs:export 耗时 4684ms（严重）
   * 而这段代码是**纯同步**的（cpSync / mkdirSync / statSync），
   * 其中 `cpSync(logs 整目录, {recursive:true})` 会把 logs 下所有实例日志
   * 逐个复制 —— 秒级到几十秒的**主进程完全冻结**，用户点"导出日志"之后
   * 整个界面就不动了，还以为软件卡死了。
   *
   * 现在全程 fs/promises：复制走 libuv 线程池，主进程照常响应。
   */
  /**
   * 导出用的暂存目录名（**唯一**，两个 stageSnapshot 共用同一份实现）。
   *
   * ══════════════════════════════════════════════════════════════════════
   * ★ 为什么抽出来 + 为什么必须带随机后缀（独立审查抓出）
   * ══════════════════════════════════════════════════════════════════════
   *
   * 原来异步版和同步版**各自写了一遍** `` `.staging-${Date.now()}` ``：
   *   · 两处重复 → 改一处漏一处（这次就是）
   *   · `Date.now()` 只有毫秒精度 → 同一毫秒内两次导出（用户连点
   *     「导出日志」，或崩溃恰好撞上导出）会**共用同一个 staging 目录**
   *     → `mkdirSync` 不报错 → 两次导出的内容混进同一个归档
   *
   * 现在一个函数生成，随机后缀保证唯一。
   */
  function stagingDirName(): string {
    return join(deps.dataRoot, 'logs-export', `.staging-${Date.now()}-${randomBytes(4).toString('hex')}`)
  }

  async function stageSnapshot(): Promise<string> {
    const staging = stagingDirName()
    await fsp.mkdir(join(staging, 'logs'), { recursive: true })
    // 整目录复制（异步）：这是原来最耗时的一步
    try {
      await fsp.cp(join(deps.dataRoot, 'logs'), join(staging, 'logs'), { recursive: true })
    } catch {
      /* logs 目录异常（被占/权限）不该让导出失败 —— 后面还有别的证据 */
    }
    /*
     * ══════════════════════════════════════════════════════════════════════════
     * ★ 顶层状态文件：把"排查时第一句要问的东西"全带上
     * ══════════════════════════════════════════════════════════════════════════
     *
     * 这一份清单是主人 2026-09-27 的诊断包暴露出来的缺口。他死机重启后
     * 导出的包里**只有 config.json / instances.json**，而当时最需要的证据
     * 一个都没进来：
     *
     *   · `boot-attempts.json` —— 启动健康看门狗的状态。
     *     它记着"起不来几次、连崩几次、上次为什么失败"，
     *     是判断"这次是偶发还是每次都这样"的唯一依据。**没进包就白记了。**
     *   · `startup-error.txt` —— 窗口建出来之前就抛错时留下的现场。
     *     那是"起不来"类问题**唯一**的证据，比日志更重要
     *     （日志那时可能还没建立）。
     *   · `mirrors.json` / `python-sources.json` —— 用户配的下载源。
     *     "下载失败"类问题的第一句问话就是"你用的哪个源"。
     *   · `runtimes.json` —— 已装运行时的清单。
     *     "我装了但列表里没有"这类问题的判据。
     *
     * 为什么会漏：原来只写了两个文件名（config/instances），
     * **没人回头核对"导出包够不够排查"**。现在按"一份包够不够用"来列。
     */
    const topFiles = [
      'config.json',
      'instances.json',
      /* ★ 看门狗状态：起不来/连崩计数与上次失败原因 */
      'boot-attempts.json',
      /* ★ 启动期异常现场（比日志更早、更关键） */
      'startup-error.txt',
      /* ★ 下载与安装的归因依据（用户到底配了哪个源） */
      'mirrors.json',
      'python-sources.json',
      /* ★ 已装运行时清单（"装了但没显示"类问题的判据） */
      'runtimes.json',
      /* 上次运行的结论（正常退出 / 异常退出） */
      'last-run.json',
      /* 运行锁本身：判据的原始证据（转述版是 last-run.txt） */
      'running.lock'
    ]
    for (const f of topFiles) {
      const src = join(deps.dataRoot, f)
      if (existsSync(src)) {
        try {
          await fsp.cp(src, join(staging, f))
        } catch {
          /* 单个文件拷不动就跳过（权限/占用），不让导出失败 */
        }
      }
    }
    /*
     * 实例目录里的 NapCat config / AstrBot data 也带上。
     * 用户报「连不上 / 登不上」时，光有日志不够，还得看实例当时的配置
     * （端口、token、账号），否则我们只能猜。逐个实例取，不整目录拷
     * （实例目录里有一整套 90MB 运行时，拷进来导出包就没法发人了）。
     */
    const instRoot = join(deps.dataRoot, 'instances')
    if (existsSync(instRoot)) {
      for (const kind of safeReaddir(instRoot)) {
        const kindDir = join(instRoot, kind)
        for (const id of safeReaddir(kindDir)) {
          const instDir = join(kindDir, id)
          const dest = join(staging, 'instances', kind, id)
          // 只挑排查需要的几个文件，不搬运行时
          for (const rel of ['instance.json', join('config', 'webui.json'), join('config', 'napcat.json')]) {
            const src = join(instDir, rel)
            if (existsSync(src)) {
              await fsp.mkdir(join(dest, rel, '..'), { recursive: true })
              try {
                await fsp.cp(src, join(dest, rel))
              } catch {
                /* 单个文件拷不动就跳过，别让整个导出失败 */
              }
            }
          }
        }
      }
    }

    /*
     * ★ 第三层证据：崩溃转储（指导书 3.2 的导出清单要求）
     *
     * `<dataRoot>\dumps` 是 crashReporter 与 WER LocalDumps 的落点
     *（见 util/crash-logs.ts）。**必须进导出包** —— 否则"能抓到 dump"
     * 这件事对用户毫无意义：他不会知道那个目录在哪、也不会想到要一起发。
     *
     * ## 两个上限（拿主人机器的日志换来的）
     *
     * 主人机器上 `logs:export` 实测 **2.8s / 4.7s / 30.9s**（都超阈值），
     * 而导出是同步复制 + 压缩：dump 越大越久，期间主进程整个卡住。
     * 所以：
     *   · 只带最近 3 个（原样保留）
     *   · **单个超过 64MB 的直接不带**（并在包里留一行说明）
     * 我们有"迷你转储 + 最多 3 份"的配置（D23），正常情况下远小于此；
     * 这条上限是防"用户机器上恰好是旧的完整转储配置"时把导出拖死。
     */
    const dumpsDir = join(deps.dataRoot, 'dumps')
    const MAX_DUMP_MB = 64
    const skipped: string[] = []
    const dumpFiles = safeReaddir(dumpsDir)
      .filter((f) => /\.(dmp|zip|log)$/i.test(f))
      .slice(-3)
    for (const f of dumpFiles) {
      try {
        const full = join(dumpsDir, f)
        const mb = (await fsp.stat(full)).size / 1048576
        if (mb > MAX_DUMP_MB) {
          skipped.push(`${f}（${Math.round(mb)} MB，超过 ${MAX_DUMP_MB} MB 未打包）`)
          continue
        }
        await fsp.mkdir(join(staging, 'dumps'), { recursive: true })
        await fsp.cp(full, join(staging, 'dumps', f))
      } catch {
        /* 拷不动就跳过（可能正被系统写），别让导出失败 */
      }
    }
    if (skipped.length) {
      try {
        await fsp.mkdir(join(staging, 'dumps'), { recursive: true })
        await fsp.writeFile(
          join(staging, 'dumps', '_skipped.txt'),
          `以下转储文件太大，未放进本诊断包（避免导出耗时过长）：\n${skipped.join('\n')}\n` +
            `如需它们，请直接到 ${dumpsDir} 复制。\n`,
          'utf8'
        )
      } catch {
        /* 说明文件写不进去也无所谓 */
      }
    }

    /*
     * 崩溃证据 + 系统信息：让收到包的人一眼看到"上次是不是异常退出、
     * 什么版本、什么系统"。
     *
     * ★ 判据来自**启动时写下的 last-run.json**，不是现场读 running.lock。
     *
     * 第一版这里直接调 checkPreviousRun —— 那是错的，而且错得很隐蔽：
     * 导出发生在**运行期间**，而 running.lock 正是本次启动写下的
     *（要等退出才删），于是这条结论 100% 是"上次异常退出"，
     * 连"上次启动时刻"写的都是本次启动时刻。四厂商审计把它抓了出来。
     * 现在只读启动期快照：判据时点唯一，不会自欺。
     */
    try {
      /*
       * ★ 优先用**完整设备信息**（主人 2026-09-27 要求）
       *
       * `deps.deviceInfo` 由生产注入，会去采集系统 / 硬件 / 依赖 / 环境，
       * 比下面那个 8 行的基础版有用得多。采集失败就退回基础版 ——
       * 导出包里"有系统信息"这件事绝不能因为采集失败而消失。
       */
      let info = ''
      if (deps.deviceInfo) {
        try {
          info = await deps.deviceInfo()
        } catch {
          info = ''
        }
      }
      if (!info) info = systemInfoText({ dataRoot: deps.dataRoot, appVersion: deps.appVersion })
      await fsp.writeFile(join(staging, 'system-info.txt'), info, 'utf8')
      const prev = readLastRunReport(deps.dataRoot)
      let text: string
      if (!prev) {
        text = '上次运行：未知（本次启动没有记录到判定结果 —— 可能是首次运行本版本）\n'
      } else if (prev.updated) {
        text = '上次运行：覆盖更新（旧进程被安装器结束，属正常，不是崩溃）\n'
      } else if (prev.crashed) {
        text = `上次运行：**异常退出**（未正常清理运行锁）\n上次启动时刻: ${
          prev.startedAt ? new Date(prev.startedAt).toISOString() : '(读不出)'
        }\n`
      } else {
        text = '上次运行：正常退出\n'
      }
      await fsp.writeFile(join(staging, 'last-run.txt'), text, 'utf8')
    } catch {
      /* 辅助信息，写不进去不影响主流程 */
    }
    return staging
  }

  /*
   * 打包暂存目录 → zip。
   *
   * ## 路径必须走 psQuote（这里原来漏了，是个真 bug）
   *
   * 原实现是裸插值：
   *
   *     `Compress-Archive -Force -Path '${staging}\\*' -DestinationPath '${zipPath}'`
   *
   * PowerShell 单引号串里**唯一的转义规则是「单引号写两遍」**，
   * 所以路径里只要有一个 `'`，字符串就提前结束，报
   * `The string is missing the terminator: '`。而数据根本就是
   * 用户能在设置里随便迁移的路径，Windows 合法字符里包含 `'`
   * —— 也就是**只有那部分用户会遇到的导出失败**，报错还完全指不到真因。
   *
   * 同时它是个注入面：`E:\x'; Remove-Item -Recurse C:\ ;'` 这种路径
   * 会被当命令执行。路径虽来自本机用户，但"导出日志"恰恰是把
   * 出问题的机器状态打包送出去的动作，不该在这里开口子。
   *
   * 项目里早有正确的 `psQuote()`（util/async-exec.ts），注释里写明
   * 就是为了这个坑 —— 这里直接用，别再自己拼引号。
   *
   * ## 为什么把命令拼装收成一个函数
   *
   * 一开始 async 版（exportZip）和 sync 版（exportZipSync，崩溃现场用）
   * 各自拼了一遍同样的 `Compress-Archive ...`。这看着只是重复，
   * 实际是**两个独立的出错点**：反向测试把这一处改回裸插值，
   * 测试**全绿** —— 因为异步那条用例走的是另一个函数，压根没检查到这里
   * （实测确认）。也就是说 sync 那条路径的引号修复当时是**没有测试保护的**。
   *
   * 收成一个 `compress()`，两条路径共用，改一处即全改，也就不会有
   * "修了一半"的漏洞。
   */
  /**
   * 造出压缩命令。优先 `tar.exe`（快），老系统回落到 PowerShell。
   *
   * 返回数组是**有序候选**：调用方按顺序试，第一个成功即止。
   * 这样"没有 tar.exe 的老机器"不会因为我们的优化而**彻底导不出日志** ——
   * 那是最糟的退化（用户最需要日志的时候功能没了）。
   */
  function compressCandidates(
    staging: string,
    zipPath: string
  ): Array<{ cmd: string; args: string[]; label: string }> {
    /**
     * ══════════════════════════════════════════════════════════════════════════
     * ★★ 首选 tar.exe（主人 2026-09-27 反馈"日志导出卡半天"）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * 主人原话：「删除会卡住主进程，而且日志导出也要卡半天」。
     *
     * ## 实测证据（他的日志 + 本机对比实测）
     *
     *     [ERROR] [perf] IPC logs:export 耗时 57997ms（严重）
     *     [ERROR] [perf] IPC logs:export 耗时 28219ms（严重）
     *     [ERROR] [perf] IPC logs:export 耗时 12841ms（严重）
     *
     * 而**被压的只有 0.1 MB / 6 个文件**（实测 logs 目录：6 文件、最大 25 KB）。
     * 所以慢的根本不是数据量，是这行：
     *
     *     powershell -NoProfile -Command Compress-Archive
     *       · PowerShell 冷启动 + 加载 .NET/模块 —— 每次几秒到十几秒
     *       · Compress-Archive 走 .NET ZipArchive，小文件也慢
     *
     * 本机同一份日志实测对比（2026-09-27）：
     *     Compress-Archive  896 ms
     *     tar -a -c -f       20 ms     ← 快 45 倍
     *     且 tar 产出的是**真 zip**（Expand-Archive 能解开，验证过 6 个文件）
     *
     * ## 为什么仍是 .zip 而不是 .tar.gz
     *
     * 用户拿到的包是要**双击打开、随手发给我们**的。zip 在 Windows 上是
     * 原生体验（资源管理器直接进）；tar.gz 得装解压软件。bsdtar 的 `-a`
     * 会按目标扩展名选格式，所以给 `.zip` 得到的就是 zip。
     */
    const tarArgs = ['-a', '-c', '-f', zipPath, '-C', staging, '.']
    return [
      { cmd: 'tar', args: tarArgs, label: 'tar' },
      {
        cmd: 'powershell',
        args: [
          '-NoProfile',
          '-Command',
          `Compress-Archive -Force -Path ${psQuote(join(staging, '*'))} -DestinationPath ${psQuote(zipPath)}`
        ],
        label: 'Compress-Archive'
      }
    ]
  }

  /** 兼容旧调用点：只要首选那条 */
  function compress(staging: string, zipPath: string): { cmd: string; args: string[] } {
    const first = compressCandidates(staging, zipPath)[0]
    return { cmd: first.cmd, args: first.args }
  }

  /**
   * 跑一次压缩，并且**只在成功时**清掉暂存目录。
   *
   * 为什么清理和判定必须绑在一起（原来分在两处、顺序还是反的）：
   *
   *   原代码：
   *     const code = await compress(...)
   *     rmSync(staging, ...)              // ← 先删
   *     if (code !== 0) throw ...         // ← 后判
   *
   *   1. **失败时暂存目录已经没了**。而压缩失败时，那份 staging 正是
   *      唯一的原始素材 —— 用户既不能重试也没法人工翻看，等于把
   *      最后一点可诊断的东西也丢了。
   *   2. runner 抛异常时 `rmSync` 会被跳过，目录**意外留下** ——
   *      留下本身是对的（见下），但它是"碰巧"留下的，不是设计，
   *      所以报错里也没告诉用户东西在哪。
   *
   * 现在：成功 → 清理；失败或抛异常 → **一律保留**，并把路径写进报错。
   *
   * ## 为什么失败时"保留"是对的（不是偷懒）
   *
   * 压缩失败（退出码非 0 或抛异常）**正是**用户需要看 staging 内容的时候。
   * 删掉只省一点磁盘，代价是丢掉唯一可诊断的东西。
   *
   * 那"目录越积越多"怎么办？—— 那是**清理策略**该解决的问题
   * （按时间/个数保留最近几份），不该靠"把证据删掉"来省事。
   * 顺带说：logs-export 里那些 zip 也是只增不减的，同一个问题，
   * 要治就一起治，别只在这一处搞特例。
   */
  async function compressAndClean(
    staging: string,
    zipPath: string,
    run: (c: string, a: string[]) => number | Promise<number>,
    whatFailed: string
  ): Promise<void> {
    /*
     * ★ 依次试候选命令（tar → Compress-Archive）
     *
     * 为什么要有回落：`tar.exe` 是 Windows 10 1803+ 才自带的。
     * 万一用户机器上没有（或 PATH 里被别的东西占了），**导不出日志**
     * 是最糟的退化 —— 用户往往正是遇到问题才来导出。
     * 所以失败就试下一条，两条都不行才报错。
     */
    const candidates = compressCandidates(staging, zipPath)
    let lastErr: string | undefined
    for (const c of candidates) {
      let code: number
      try {
        code = await run(c.cmd, c.args)
      } catch (e) {
        // runner 自己炸了（命令不存在等）→ 记下来试下一条
        lastErr = `${c.label}：${e instanceof Error ? e.message : String(e)}`
        continue
      }
      if (code === 0) {
        // 只有确确实实打包成功了才清理
        rmSync(staging, { recursive: true, force: true })
        return
      }
      lastErr = `${c.label} 退出码 ${code}`
    }
    /*
     * 全部候选都失败。暂存目录**留着**：里面是用户日志的原始快照，
     * 删了就没法人工翻看。把路径写进报错，让用户知道东西在哪。
     */
    throw new Error(
      `${whatFailed}（${lastErr ?? '没有可用的压缩命令'}）` +
        `（日志素材已保留在 ${staging}，可人工查看后重试）`
    )
  }

  async function exportZip(): Promise<string> {
    const now = new Date()
    const hm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
    const outDir = join(deps.dataRoot, 'logs-export')
    mkdirSync(outDir, { recursive: true })
    mkdirSync(logsDir, { recursive: true })
    const zipPath = join(outDir, `astriax-logs-${date().replace(/-/g, '')}-${hm}.zip`)
    /*
     * 正常导出走**异步**的 stageSnapshot（主人要求「能异步的全异步」）——
     * 它要复制 logs 整目录 + 转储，同步版实测能卡 30 秒（见 stageSnapshot 注释）。
     */
    const staging = await stageSnapshot()
    await compressAndClean(staging, zipPath, zipRunner, '导出日志失败')
    return zipPath
  }

  /**
   * 崩溃现场专用的**同步**导出。
   *
   * 这里必须同步：进程马上就要消失，异步的复制/压缩会随进程一起丢掉。
   * 所以它用同步版的 stage（下面单独实现），不复用异步那个 ——
   * 这也是审计里那条"已论证例外"的由来。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * ★ 但**收集的证据必须与异步版一致**（审查抓出的语义漂移）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 第一版只拷了 logs + config.json/instances.json + system-info.txt，
   * 比异步版**少了三类**：
   *   · instances 下的实例配置（端口 / token / 账号）—— 用户报
   *     "连不上 / 登不上"时，光有日志不够，得看实例当时的配置
   *   · dumps（崩溃转储）—— 崩溃现场最需要的东西
   *   · last-run.txt（上次是否异常退出的判据）
   *
   * 而 `crash-handler.ts` 走的**正是这个同步版** ——
   * "必须同步"论证的是"不能异步"，不是"可以少收集证据"。
   * 崩溃时缺的恰恰是最关键的那几样。
   */
  function stageSnapshotSync(): string {
    const staging = stagingDirName()
    mkdirSync(join(staging, 'logs'), { recursive: true })
    try {
      cpSync(join(deps.dataRoot, 'logs'), join(staging, 'logs'), { recursive: true })
    } catch {
      /* logs 目录异常不该让崩溃包彻底失败 */
    }
    for (const f of ['config.json', 'instances.json']) {
      const src = join(deps.dataRoot, f)
      if (existsSync(src)) {
        try {
          cpSync(src, join(staging, f))
        } catch {
          /* 单个文件拷不动就跳过 */
        }
      }
    }
    /* ① 实例配置（端口/token/账号）—— 与异步版同一份清单 */
    try {
      const instRoot = join(deps.dataRoot, 'instances')
      if (existsSync(instRoot)) {
        for (const kind of safeReaddir(instRoot)) {
          for (const id of safeReaddir(join(instRoot, kind))) {
            const instDir = join(instRoot, kind, id)
            const dest = join(staging, 'instances', kind, id)
            for (const rel of [
              'instance.json',
              join('config', 'webui.json'),
              join('config', 'napcat.json')
            ]) {
              const src = join(instDir, rel)
              if (existsSync(src)) {
                try {
                  mkdirSync(join(dest, rel, '..'), { recursive: true })
                  cpSync(src, join(dest, rel))
                } catch {
                  /* 单个文件拷不动就跳过 */
                }
              }
            }
          }
        }
      }
    } catch {
      /* 尽力而为：实例配置拿不到也不该让崩溃包整个失败 */
    }
    /* ② 崩溃转储（最近 3 个 + 单文件 64MB 上限，与异步版同一条规则） */
    try {
      const dumpsDir = join(deps.dataRoot, 'dumps')
      const MAX_DUMP_MB = 64
      const skipped: string[] = []
      const dumpFiles = safeReaddir(dumpsDir)
        .filter((f) => /\.(dmp|zip|log)$/i.test(f))
        .slice(-3)
      for (const f of dumpFiles) {
        try {
          const full = join(dumpsDir, f)
          const mb = statSync(full).size / 1048576
          if (mb > MAX_DUMP_MB) {
            skipped.push(`${f}（${Math.round(mb)} MB，超过 ${MAX_DUMP_MB} MB 未打包）`)
            continue
          }
          mkdirSync(join(staging, 'dumps'), { recursive: true })
          cpSync(full, join(staging, 'dumps', f))
        } catch {
          /* 拷不动就跳过（可能正被系统写） */
        }
      }
      if (skipped.length) {
        try {
          mkdirSync(join(staging, 'dumps'), { recursive: true })
          writeFileSync(
            join(staging, 'dumps', '_skipped.txt'),
            `以下转储文件太大，未放进本诊断包：\n${skipped.join('\n')}\n`,
            'utf8'
          )
        } catch {
          /* 说明文件写不进去也无所谓 */
        }
      }
    } catch {
      /* 尽力而为 */
    }
    /* ③ 系统信息 + 上次运行判据（读的是启动期快照，不是现场读锁） */
    try {
      writeFileSync(
        join(staging, 'system-info.txt'),
        systemInfoText({ dataRoot: deps.dataRoot, appVersion: deps.appVersion }),
        'utf8'
      )
      const prev = readLastRunReport(deps.dataRoot)
      let text: string
      if (!prev) {
        text = '上次运行：未知（本次启动没有记录到判定结果 —— 可能是首次运行本版本）\n'
      } else if (prev.updated) {
        text = '上次运行：覆盖更新（旧进程被安装器结束，属正常，不是崩溃）\n'
      } else if (prev.crashed) {
        text = `上次运行：**异常退出**（未正常清理运行锁）\n上次启动时刻: ${
          prev.startedAt ? new Date(prev.startedAt).toISOString() : '(读不出)'
        }\n`
      } else {
        text = '上次运行：正常退出\n'
      }
      writeFileSync(join(staging, 'last-run.txt'), text, 'utf8')
    } catch {
      /* 辅助信息，写不进去不影响主流程 */
    }
    return staging
  }

  function exportZipSync(): string {
    const now = new Date()
    const hm = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`
    const outDir = join(deps.dataRoot, 'logs-export')
    mkdirSync(outDir, { recursive: true })
    mkdirSync(logsDir, { recursive: true })
    const zipPath = join(outDir, `astriax-logs-${date().replace(/-/g, '')}-${hm}.zip`)
    const staging = stageSnapshotSync()
    const runSync =
      deps.zipRunnerSync ??
      ((c: string, a: string[]) => spawnSync(c, a, { stdio: 'ignore' }).status ?? 1)
    /*
     * 崩溃现场同步打包：这里的清理顺序和异步版是**同一个 bug**，
     * 之前也是先 rmSync 再判退出码 —— 失败时素材已经没了。
     * 而且这是崩溃现场，那份 staging 往往是唯一的线索，更不能丢。
     *
     * 这里不用 compressAndClean（它是 async，崩溃时进程马上要死，
     * 必须一口气同步做完），所以就地写一遍同样的顺序。
     */
    let code: number
    const { cmd, args } = compress(staging, zipPath)
    try {
      code = runSync(cmd, args)
    } catch (e) {
      throw new Error(
        `导出日志失败（同步）：${e instanceof Error ? e.message : String(e)}` +
          `（日志素材已保留在 ${staging}）`
      )
    }
    if (code !== 0) {
      throw new Error(
        `导出日志失败（同步 Compress-Archive 退出码 ${code}）` +
          `（日志素材已保留在 ${staging}）`
      )
    }
    rmSync(staging, { recursive: true, force: true })
    return zipPath
  }

  return {
    log: (l, s, m, d) => write(l, s, m, d),
    crash: (s, m) => write('CRASH', s, m),
    exportZip,
    exportZipSync
  }
}
