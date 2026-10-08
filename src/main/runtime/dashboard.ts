/*
 * AstrBot 的 Dashboard（WebUI 前端）预装。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么必须做这件事（公测反馈里的致命 bug）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 公测用户（D:\公测反馈\astriax-logs-20260926-192659.zip）的实例日志原文：
 *
 *     [out] Dashboard is not installed
 *     [out] Install dashboard? [Y/n]:
 *     [err] click.exceptions.Abort
 *     [err]   File ".../astrbot/cli/utils/basic.py", line 42, in check_dashboard
 *     [err]     if click.confirm(
 *
 * AstrBot 的本体其实**已经完全跑起来了**（日志里平台适配器都注册完了），
 * 卡死发生在最后一步：`astrbot.cli run` 会检查 dashboard 前端在不在，
 * 不在就 `click.confirm("Install dashboard?")` **等用户输入 Y/n**。
 * 而我们是**非交互 spawn**（没有 TTY），`click.confirm` 直接抛 `Abort`
 * → 进程退出 → 端口永远不通 → 界面上就是"启动了但一直起不来"。
 *
 * 这个坑**每个新用户都会踩**（PyPI 的 wheel 不带 dashboard/dist），
 * 而我们之前完全不知道 —— 因为开发机上恰好早先手动装过一次，
 * `data/dist` 一直在，所以从来没复现过。
 *
 * ## 修法：启动前把前端装好，让它走"已是最新"分支（不问任何问题）
 *
 * `check_dashboard` 的分支顺序是：
 *   1. `get_dashboard_version()` 有值且不比本体旧 → `return`（**不提问**）
 *   2. 没有 → `click.confirm(...)` ← 卡死点
 * 所以我们只要在 spawn 之前把 `dist` 铺到 `<实例>\data\dist`，就会命中分支 1。
 *
 * ## 下载源（照抄 AstrBot 自己的顺序，但我们加上本地缓存）
 *
 *   1. `https://astrbot-registry.soulter.top/download/astrbot-dashboard/v<版本>/dist.zip`
 *   2. `https://astrbot-registry.soulter.top/download/astrbot-dashboard/latest/dist.zip`
 *   3. GitHub release：`.../releases/download/v<版本>/AstrBot-v<版本>-dashboard.zip`
 *
 * 失败**不阻塞启动**：拿不到就照旧让它去问 —— 但那种情况下用户至少
 * 能从我们的日志里看到"dashboard 没预装成功"，而不是对着一个静默卡住的实例。
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

/** 下载一个二进制文件到 path（注入以便单测） */
export type FetchFile = (url: string, dest: string) => Promise<void>
/**
 * 解压 zip 到目录（注入以便单测）。
 *
 * ★ **必须在失败时抛错**（审查抓出的一个真实漏洞）。
 *
 * 项目里的 `expandArchive`（util/async-exec.ts）返回的是 `RunResult`，
 * **从不抛错** —— 而 PowerShell 的 `Expand-Archive` 很坑：实测给一个假的
 * / 截断的 zip，它**退出码仍然是 0**（错误只写到 stderr）。
 *
 * 第一版在 ipc.ts 里注入的是 `await expandArchive(zip, dest)` 且**丢掉了返回值**，
 * 于是解压失败时这里以为成功了：继续把空的 tmp 当成解压结果 rename 过去。
 * 恰好当时 dashboardReady 的判据是"目录非空"，才没造成白屏 ——
 * 两个缺陷互相掩盖，而不是设计正确。
 *
 * 现在把契约写进类型注释：**失败必须抛**，让 ensureDashboard 的 try/catch
 * 能真正接住，并清掉临时目录。
 */
export type Unzip = (zip: string, dest: string) => Promise<void>

export interface DashboardDeps {
  /** 实例目录（AstrBot 的 cwd） */
  instanceDir: string
  /** AstrBot 版本，如 "v4.25.2"（不带 v 也行） */
  version: string
  /** 共享缓存目录（默认 <dataRoot>/cache/dashboard），避免每个实例各下一份 */
  cacheDir?: string
  fetchFile: FetchFile
  unzip: Unzip
  log?: (msg: string) => void
}

/**
 * 该实例的 dashboard 是否**已就位且真的会被 AstrBot 认出来**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 判据必须与 AstrBot 完全一致：看 `dist/assets/version` 这个文件
 * ══════════════════════════════════════════════════════════════════════════
 *
 * AstrBot 源码（astrbot/core/utils/io.py:330）：
 *
 *     def _read_dashboard_dist_version(dist_dir):
 *         version_file = Path(dist_dir) / "assets" / "version"
 *         if version_file.exists():
 *             return version_file.read_text(encoding="utf-8").strip()
 *         return None
 *
 * `get_dashboard_version()` 拿它的返回值；为 None 时 `check_dashboard`
 * 走 `case None:` → `click.confirm("Install dashboard?")` → 非交互下 Abort。
 *
 * ## 第一版的错（审查抓出，我已核对 AstrBot 源码确认）
 *
 * 第一版写的是"`data\dist` 存在且目录非空即算装好"。两个后果：
 *   · 解压不完整（有文件但缺 assets/version）→ 我们判"已装好"→
 *     **再也不尝试修复**，而 AstrBot 照样提问 → 原 bug 原样复现；
 *     且因为 ready=true，连"没预装成功"的 WARN 都不会打。
 *   · 典型的「看起来修好了、实际没修」的静默失败。
 *
 * 现在：**version 文件存在且内容非空**才算就位。
 * 目录存在仍作为快速否定（省一次读文件），但正向判据是那个文件。
 */
export function dashboardReady(instanceDir: string): boolean {
  const dist = join(instanceDir, 'data', 'dist')
  try {
    if (!existsSync(dist)) return false
    // 与 AstrBot 同判据：dist/assets/version 存在且非空
    const verFile = join(dist, 'assets', 'version')
    if (!existsSync(verFile)) return false
    return readFileSync(verFile, 'utf8').trim().length > 0
  } catch {
    return false
  }
}

/** 三个候选 URL，按可靠性排序 */
export function dashboardUrls(version: string): string[] {
  const v = version.startsWith('v') ? version : `v${version}`
  return [
    `https://astrbot-registry.soulter.top/download/astrbot-dashboard/${v}/dist.zip`,
    `https://astrbot-registry.soulter.top/download/astrbot-dashboard/latest/dist.zip`,
    `https://github.com/AstrBotDevs/AstrBot/releases/download/${v}/AstrBot-${v}-dashboard.zip`
  ]
}

/**
 * 确保实例里有 dashboard；已经有就什么都不做（幂等、零成本）。
 *
 * 返回 true = 就位（本来就有 / 这次装好了）；false = 没搞定（调用方照旧启动，
 * 但要记日志 —— 别让它悄悄卡住）。
 */
export async function ensureDashboard(deps: DashboardDeps): Promise<boolean> {
  if (dashboardReady(deps.instanceDir)) return true

  const log = deps.log ?? ((): void => undefined)
  const dataDir = join(deps.instanceDir, 'data')
  const distDir = join(dataDir, 'dist')
  const cacheDir = deps.cacheDir ?? join(deps.instanceDir, '..', '..', 'cache', 'dashboard')
  const zipCache = join(cacheDir, `dashboard-${deps.version}.zip`)
  // 建目录也用异步（同上的 P0-4 理由）
  const fsp = await import('fs/promises')
  await fsp.mkdir(dataDir, { recursive: true })

  /*
   * 先试共享缓存：同一台机器上装第二个实例时**不该再下一遍 9.7MB**。
   * （多开是这个软件的核心场景，实例常常有十几个 —— 每个都下一份
   *   就是几十 MB 的纯浪费，而它们的 dashboard 完全一样。）
   */
  let zipPath: string | undefined
  if (existsSync(zipCache)) {
    zipPath = zipCache
    log(`复用已缓存的 dashboard（${zipCache}）`)
  } else {
    for (const url of dashboardUrls(deps.version)) {
      try {
        await fsp.mkdir(cacheDir, { recursive: true })
        await deps.fetchFile(url, zipCache)
        zipPath = zipCache
        log(`dashboard 已下载：${url}`)
        break
      } catch (e) {
        log(`dashboard 源失败（${url}）：${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  if (!zipPath) {
    log('dashboard 三个源都没下成功 —— 实例可能会卡在 "Install dashboard? [Y/n]" 而无法启动')
    return false
  }

  /*
   * 解压到 data\ 下（zip 里顶层就是 dist/，解出来正好是 data\dist）。
   *
   * ★ 先解到临时目录再改名过去：解压中途失败会留下**半个 dist**，
   * 而 dashboardReady 判"目录非空"就认为装好了 —— 那会让 AstrBot 拿到
   * 一个残缺的前端（页面白屏），比"没装"更难查。
   */
  const tmp = `${distDir}.installing`
  try {
    /*
     * ★ 全程用**异步** fs（自检 @P0-4 同步阻塞审计抓出来的）
     *
     * 第一版这里写的是 rmSync / mkdirSync —— 而 dist 目录解压后有几百个文件，
     * 删它和解它都是**几十到几百毫秒**的同步操作，发生在 instance:start 的
     * 路径上，会把主进程事件循环整个卡住（这正是本项目 P0-4 要清零的东西）。
     * 启动实例本来就要等，再叠几百毫秒的同步 IO，用户就是"点了没反应"。
     */
    const fsp = await import('fs/promises')
    await fsp.rm(tmp, { recursive: true, force: true })
    await fsp.mkdir(tmp, { recursive: true })
    await deps.unzip(zipPath, tmp)
    // zip 顶层可能是 dist/ 也可能直接是资源文件，两种情况都要落到 distDir
    const inner = join(tmp, 'dist')
    const from = existsSync(inner) ? inner : tmp

    /*
     * ★ 校验解压结果**再**动旧目录（审查抓出的顺序问题）
     *
     * 第一版是「先 rm(distDir) → 再 rename」。这两步之间若进程被杀/断电，
     * 用户就从"有 dashboard"退化成"完全没有"（虽然窗口很短，
     * 但这正是本文件自己反复强调要避免的形态）。
     *
     * 现在把**校验放在删除之前**：先确认新内容真的就位（assets/version 在），
     * 再动旧目录。校验不过就直接抛错，旧 dashboard 一根毫毛都不动。
     */
    const newVerFile = join(from, 'assets', 'version')
    if (!existsSync(newVerFile)) {
      /*
       * 解压出来的东西里没有 assets/version —— 那 AstrBot 照样会提问，
       * 装上去也没用。直接算失败，并把旧 dist 原地留着
       *（留着旧的至少不会比现在更差，且用户能手动修）。
       */
      throw new Error('解压结果里缺少 assets/version（AstrBot 认不出这个 dashboard）')
    }

    /*
     * 回滚友好顺序：旧目录先改名为 `.old`（不删）→ 新的改名上位 → 删 `.old`。
     * 这样任何一步被打断，最坏情况是留下一个 `.old` 残骸，而 dist 始终
     * 要么是旧的、要么是新的，**不会出现"两个都没有"**。
     */
    const oldDir = `${distDir}.old`
    await fsp.rm(oldDir, { recursive: true, force: true })
    const hadOld = existsSync(distDir)
    if (hadOld) await fsp.rename(distDir, oldDir)
    try {
      await fsp.rename(from, distDir)
    } catch {
      // 跨设备等情况改名会失败，退回复制（同样异步）
      await fsp.cp(from, distDir, { recursive: true, force: true })
    }
    await fsp.rm(oldDir, { recursive: true, force: true })
    await fsp.rm(tmp, { recursive: true, force: true })
    const ok = dashboardReady(deps.instanceDir)
    log(ok ? 'dashboard 已就位' : 'dashboard 解压后仍缺少 assets/version（zip 结构可能变了）')
    return ok
  } catch (e) {
    await (await import('fs/promises')).rm(tmp, { recursive: true, force: true }).catch(() => undefined)
    log(`dashboard 解压失败：${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}
