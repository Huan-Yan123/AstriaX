/*
 * 崩溃日志的第三层 + 异常退出的"证人"（指导书 3.2 的落地）
 *
 * 指导书要求三层：
 *   第一层 常规日志（滚动）    —— 项目已有（src/main/logs/logger.ts）
 *   第二层 崩溃瞬间的捕获      —— 项目已有（index.ts 的 uncaughtException /
 *                                unhandledRejection → onCrash），本轮又补了
 *                                退出前的实例清理
 *   第三层 操作系统级证据      —— 本文件负责：
 *        · Electron crashReporter（V8/进程崩溃时落 .dmp）
 *        · Windows WER LocalDumps（原生崩溃、Node 崩溃这些 crashReporter
 *          可能漏的场景，由系统兜底写 .dmp）
 *        · running.lock —— 上次是否**异常退出**的可靠证据
 *          （进程被杀时来不及写任何日志，只剩这个锁文件）
 *
 * ## 为什么用 HKCU 而不是指导书示例里的 HKLM
 *
 * 指导书自己也说了这一点：写 HKLM 需要管理员，失败就降级 HKCU + 提示。
 * 本项目的原则是"不改用户的系统设置、不额外要权限"，所以：
 *   · 优先 HKCU（当前用户级，无需提权）
 *   · HKCU 也不行就**如实记日志**并继续（绝不静默，也绝不弹管理员框打断用户）
 * 这条与 decisions.log 的"保护数据 > 性能 > 体验"一致：崩溃诊断是好事，
 * 但不值得为它去动系统级注册表。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { release } from 'os'
import { join } from 'path'
// 读 JSON 走统一入口（自带去 BOM；项目自检禁止裸解析文件 JSON）
import { readJsonFile } from './json-file'

/** run 命令的实现（注入以便单测；生产传 util/async-exec 的 run） */
export type RunCmd = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number }
) => Promise<{ status: number | null; stdout: string; stderr: string }>

export interface CrashLogDeps {
  dataRoot: string
  /**
   * 当前应用版本（写进运行锁 + 系统信息）。
   *
   * 用途之一是识别"覆盖更新造成的锁残留"：锁里是旧版本号、
   * 现在跑的是新版本 → 是更新，不是崩溃（否则每次更新完都会误报）。
   * 缺省时退化为"没有版本戳"，此时任何残留锁都按崩溃处理（与老格式一致）。
   */
  appVersion?: string
  log: (level: 'INFO' | 'WARN' | 'ERROR', channel: string, msg: string, detail?: string) => void
  /** 命令执行（生产用 async-exec 的 run）——注入是为了单测能验"到底写了什么注册表" */
  run?: RunCmd
}

/** `<dataRoot>\dumps`：我们自己管的崩溃转储目录（crashReporter 与 WER 都往这儿写） */
export function dumpsDirOf(dataRoot: string): string {
  return join(dataRoot, 'dumps')
}

function lockFileOf(dataRoot: string): string {
  return join(dataRoot, 'running.lock')
}

export interface PreviousRun {
  /** 上次是不是异常退出（锁文件还在 = 上次没走完正常退出流程） */
  crashed: boolean
  /** 上次启动的时间戳（锁文件内容；读不出来就是 undefined） */
  startedAt?: number
  /**
   * 是不是**因为覆盖更新**才留下的锁（不是崩溃）。
   *
   * 判据：锁里记的版本号与当前运行的版本不同。
   *
   * ## 为什么必须有这一条（四厂商审计抓出的真问题）
   *
   * 安装器覆盖更新时的流程是：把整个数据目录（含 running.lock）
   * Rename 到 keep\payload → 装新版本 → 再搬回来。**锁也跟着搬了个来回**，
   * 而且安装器会用 taskkill /F 结束旧进程 —— `will-quit` 根本不跑，
   * `endRun` 没机会删锁。
   *
   * 结果：**每次更新完的第一次启动都会误报"上次异常退出"并弹导出提示**。
   * 这属于把假警报推给用户，比不报还糟（用户会逐渐无视这个提示，
   * 真崩的时候就不看了）。
   *
   * 用版本戳区分：锁里是 0.1.2、现在跑的是 0.1.3 → 显然是更新，不是崩溃。
   */
  updated?: boolean
}

/** 锁文件内容（JSON）。老格式是纯数字时间戳，读取时两者都认。 */
interface LockPayload {
  /** 启动时刻 */
  t: number
  /** 写锁时的应用版本（用于识别"更新导致的残留锁"） */
  v?: string
}

/** 启动时检查"上次是否异常退出"。 */
export function checkPreviousRun(deps: CrashLogDeps): PreviousRun {
  const f = lockFileOf(deps.dataRoot)
  if (!existsSync(f)) return { crashed: false }
  let payload: LockPayload | undefined
  try {
    const raw = readFileSync(f, 'utf8').trim()
    if (raw.startsWith('{')) {
      const j = JSON.parse(raw) as Partial<LockPayload>
      if (typeof j.t === 'number') payload = { t: j.t, v: typeof j.v === 'string' ? j.v : undefined }
    } else {
      // 老格式（纯时间戳）：兼容读取，但没有版本戳
      const n = Number.parseInt(raw, 10)
      if (Number.isFinite(n)) payload = { t: n }
    }
  } catch {
    /* 读不出来也算"上次异常"：文件在就说明没清理掉 */
  }
  if (!payload) return { crashed: true }

  /*
   * 版本戳不一致 → 是覆盖更新留下的锁，**不算崩溃**。
   * 只有"同一个版本留下的锁"才可能是崩溃（进程被杀来不及清）。
   */
  if (payload.v && deps.appVersion && payload.v !== deps.appVersion) {
    return { crashed: false, startedAt: payload.t, updated: true }
  }
  return { crashed: true, startedAt: payload.t }
}

/** 启动时写下锁（内容=启动时刻 + 版本戳） */
export function beginRun(deps: CrashLogDeps): void {
  try {
    mkdirSync(deps.dataRoot, { recursive: true })
    const payload: LockPayload = { t: Date.now(), v: deps.appVersion }
    writeFileSync(lockFileOf(deps.dataRoot), JSON.stringify(payload), 'utf8')
  } catch (e) {
    deps.log('WARN', 'app', `写运行锁失败（下次无法判断是否异常退出）：${String(e)}`)
  }
}

/**
 * 把**本次启动时判定出的"上次运行结论"**落一份到磁盘。
 *
 * ## 为什么不能等导出的时候再判（审计抓出的 bug）
 *
 * 导出诊断包是在**运行期间**发生的，而那时 running.lock **正在**（本次启动
 * 写下的，要到退出才删）。所以我第一版在 logger 里直接调 checkPreviousRun，
 * 结论 100% 是"上次异常退出"——连"上次启动时刻"写的也是**本次**启动时刻。
 * 这条假信息还会和 `app:lastCrash`（启动期快照，结论正确）自相矛盾。
 *
 * 正确做法：**启动时判一次、把结论写进文件**，导出时只读文件。
 * 判据只有一个时点（启动），不会有"在运行期读锁"这种自欺。
 */
export function writeLastRunReport(deps: CrashLogDeps, verdict: PreviousRun): void {
  try {
    mkdirSync(deps.dataRoot, { recursive: true })
    writeFileSync(
      join(deps.dataRoot, 'last-run.json'),
      JSON.stringify({ ...verdict, detectedAt: Date.now(), appVersion: deps.appVersion }, null, 2),
      'utf8'
    )
  } catch (e) {
    deps.log('WARN', 'app', `写上次运行结论失败（导出包里会显示"未知"）：${String(e)}`)
  }
}

/** 读启动时写下的"上次运行结论"（导出诊断包用；没有就返回 undefined） */
export function readLastRunReport(dataRoot: string): (PreviousRun & { detectedAt?: number }) | undefined {
  try {
    const f = join(dataRoot, 'last-run.json')
    if (!existsSync(f)) return undefined
    /*
     * 必须走 readJsonFile（项目约定，自检会拦裸 JSON.parse）。
     * 它顺带处理了 UTF-8 BOM —— 这个文件是我们自己写的、不会有 BOM，
     * 但"统一收口"的价值在于以后没人需要再想一遍这件事。
     */
    const j = readJsonFile<PreviousRun & { detectedAt?: number }>(f)
    return j && typeof j.crashed === 'boolean' ? j : undefined
  } catch {
    return undefined
  }
}

/** 正常退出时删锁。删不掉也只是下次误报一次"疑似崩溃"，不影响使用。 */
export function endRun(deps: CrashLogDeps): void {
  try {
    rmSync(lockFileOf(deps.dataRoot), { force: true })
  } catch {
    /* 忽略：误报的代价远小于崩溃时没有证据 */
  }
}

/**
 * 启动 Electron crashReporter（把 dump 落到我们自己的目录）。
 *
 * 只在 Electron 环境下有效 —— 单测跑在纯 node 里，所以 electron 是
 * **动态 import** 的（顶层 import 会让单测直接崩，项目里已有先例注释）。
 */
export async function startCrashReporter(deps: CrashLogDeps): Promise<void> {
  const dir = dumpsDirOf(deps.dataRoot)
  try {
    mkdirSync(dir, { recursive: true })
    const { app, crashReporter } = await import('electron')
    /*
     * 先把 crashDumps 路径指到我们的目录（在 start 之前设置才生效——
     * crashReporter 启动后再 setPath 不会改变已注册的写入位置）。
     */
    app.setPath('crashDumps', dir)
    crashReporter.start({
      productName: 'AstriaX',
      companyName: 'AstriaX',
      // 不做远程上报：只在本地留证据（指导书也这么建议）
      submitURL: '',
      uploadToServer: false,
      compress: true
    })
    deps.log('INFO', 'app', `崩溃转储已启用（crashReporter → ${dir}）`)
  } catch (e) {
    // 非 Electron 环境（单测）或初始化失败：如实记，不影响启动
    deps.log('WARN', 'app', `crashReporter 未启用（${String(e)}）——崩溃时仍可用 WER 兜底`)
  }
}

/**
 * 写 Windows WER LocalDumps 注册表（**必须在 HKLM**；无管理员权限时如实放弃）。
 *
 * ## ★ 这里踩过一个"探针坏了却宣布成功"的坑（四厂商审计抓出）
 *
 * 我第一版写的是 **HKCU**，理由是"不需要提权、更保守"。写完 `reg query`
 * 回读，值都在 → 日志打印「WER LocalDumps 已配置（<dir>）」。
 *
 * 但微软文档写得很清楚：LocalDumps 的 DumpFolder / DumpCount / DumpType
 * **不支持 HKEY_CURRENT_USER**，WER 只读 HKLM。也就是说：
 *   · 注册表里确实有这些值（HKCU 随便写）
 *   · 我的"回读验证"必然通过（它只证明我写进去了）
 *   · 而**原生崩溃时不会落 dump**
 * ——日志里那句"已配置"是彻头彻尾的假信息，正是本项目最忌讳的
 * "探针坏了会伪装成被测代码正确"。
 *
 * ## 现在怎么做
 *
 *   1. 先试 **HKLM**（键路径与指导书一致）
 *   2. HKLM 写不进去（普通权限一定会被拒）→ **如实记 WARN**，
 *      明确说"第三层只能靠 crashReporter，WER 未配置"，
 *      并且**不再写 HKCU**（写它只会制造"看起来配好了"的假象）
 *   3. 回读验证仍然保留（防注册表语法写错），但它证明的是
 *      "HKLM 里确实有这些值"，这才是 WER 真正会读的地方
 *
 * 键: HKLM\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\AstriaX.exe
 *   DumpType   = 1    （**迷你 dump**；原来是 2 = 完整，见下）
 *   DumpCount  = 3    （只留 3 份；原来 10）
 *   DumpFolder = <dataRoot>\dumps   （REG_EXPAND_SZ）
 *
 * ## ★ 为什么把 2（完整）改成 1（迷你）—— 拿主人的磁盘换来的
 *
 * 第一版按指导书写了 `DumpType = 2`。实测教训：**Electron 的完整转储
 * 单个能到几百 MB 甚至 1GB 以上**，而程序在调试期会崩/被杀好几次 ——
 * 几次下来几十 GB，直接把系统盘撑爆（主人当时就问「C 盘怎么突然涨这么多」）。
 *
 * 迷你转储只有调用栈与少量上下文（几 MB），定位崩溃点已经够用：
 * 我们真正的第一手证据是**滚动日志 + running.lock + op 标记**
 *（能精确到"死在哪个操作"），dump 只是补刀。
 * 用几十 GB 换那点补刀信息，尤其在用户机器上，完全不划算。
 * 份数也从 10 降到 3：反复崩溃时 10 份大文件同样是灾难。
 *
 * 幂等：已存在且值一致就不重复写（每次启动都写会让 reg.exe 白跑）。
 */
export async function installWerLocalDumps(deps: CrashLogDeps): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const run = deps.run
  if (!run) {
    deps.log('WARN', 'app', '未注入命令执行器，跳过 WER LocalDumps 注册（不影响使用）')
    return false
  }
  const dir = dumpsDirOf(deps.dataRoot)
  const key = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\Windows Error Reporting\\LocalDumps\\AstriaX.exe'
  try {
    mkdirSync(dir, { recursive: true })
    /*
     * 先查现值：三个值都在且正确就不动它。
     * （reg query 对不存在的键返回非 0，属正常情况，不当错误。）
     */
    const q = await run('reg', ['query', key], { timeoutMs: 8000 })
    const txt = `${q.stdout}\n${q.stderr}`
    const folderOk = txt.toLowerCase().includes(dir.toLowerCase())
    // 0x1 = 迷你转储（见上面那段"为什么改"）
    const typeOk = /DumpType\s+REG_DWORD\s+0x1\b/i.test(txt)
    if (q.status === 0 && folderOk && typeOk) return true

    const adds: Array<[string, string, string]> = [
      ['DumpType', 'REG_DWORD', '1'],
      ['DumpCount', 'REG_DWORD', '3'],
      ['DumpFolder', 'REG_EXPAND_SZ', dir]
    ]
    for (const [name, type, value] of adds) {
      const r = await run('reg', ['add', key, '/v', name, '/t', type, '/d', value, '/f'], {
        timeoutMs: 8000
      })
      if (r.status !== 0) {
        /*
         * 普通权限下这是**预期结果**（HKLM 需要管理员）。要说清楚
         * "第三层拿不到"，而不是含糊地说一句"注册未成功"——
         * 否则将来排查"为什么没有 dump 文件"又要重新查一遍。
         */
        deps.log(
          'WARN',
          'app',
          `WER LocalDumps 未配置（需要管理员权限，当前以普通权限运行；` +
            `原生崩溃不会有系统级 dump，第二/三层仍由 crashReporter 与日志兜底）：` +
            `${String(r.stderr || r.stdout).slice(0, 160)}`
        )
        return false
      }
    }
    /*
     * 回读验证：确认 HKLM 里真的有这些值。
     * 注意它**只**能证明"写进去了"；HKCU 那次误报恰恰说明
     * "回读通过 ≠ WER 会读它" —— 所以键落在 HKLM 是前提，回读是补充。
     */
    const v = await run('reg', ['query', key], { timeoutMs: 8000 })
    const ok =
      v.status === 0 &&
      `${v.stdout}`.toLowerCase().includes(dir.toLowerCase()) &&
      // 0x1 = 迷你转储，必须和上面写入的值一致（否则每次都判失败、反复重写）
      /DumpType\s+REG_DWORD\s+0x1\b/i.test(v.stdout)
    deps.log(
      ok ? 'INFO' : 'WARN',
      'app',
      ok
        ? `WER LocalDumps 已配置（HKLM，${dir}）`
        : 'WER LocalDumps 写了但回读不一致，原生崩溃可能不会落 dump'
    )
    return ok
  } catch (e) {
    deps.log('WARN', 'app', `WER LocalDumps 配置异常（不影响使用）：${String(e)}`)
    return false
  }
}

/**
 * 系统信息（导出诊断包时一起带上）。
 *
 * 排查崩溃时"版本 + 平台 + 数据目录"是必备上下文：
 * 缺了它，收到日志的人第一句永远是"你什么版本、什么系统"。
 */
export function systemInfoText(deps: { dataRoot: string; appVersion?: string }): string {
  return [
    `AstriaX 版本: ${deps.appVersion ?? '(未知)'}`,
    `平台: ${process.platform} ${process.arch}`,
    `系统: ${process.getSystemVersion?.() ?? ''} ${release()}`,
    `Electron: ${process.versions.electron ?? '(非 Electron)'}`,
    `Node: ${process.versions.node}`,
    `Chrome: ${process.versions.chrome ?? ''}`,
    `数据目录: ${deps.dataRoot}`,
    `生成时间: ${new Date().toISOString()}`
  ].join('\n')
}
