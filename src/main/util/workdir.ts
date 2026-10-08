import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { promises as fsp } from 'fs'
import { join } from 'path'
import { randomBytes } from 'crypto'

/**
 * 正在进行的"删大目录"任务数（>0 表示磁盘可能正被 IO 打满）。
 *
 * 用途：**测速 / 导出日志失败时，如实说明"是磁盘忙，不是源坏了"**。
 *
 * 主人 2026-09-27 实测：删掉几个运行时之后，测连通全部超时、
 * 打包日志慢很多、大半天磁盘 100%、甚至主进程无响应。
 * 那是**物理限制**（一个运行时 546MB / 4.9 万文件，删它要几万次元数据操作），
 * 我们改不了磁盘速度，但**能改用户看到的东西** ——
 * 否则他会以为源坏了，去折腾根本没问题的设置。
 */
let activeHeavyRemovals = 0

/** 现在有没有在删大目录（磁盘可能正忙） */
export function isDiskBusy(): boolean {
  return activeHeavyRemovals > 0
}

/**
 * 所有临时文件与缓存一律落在 data 目录下，绝不碰 C 盘。
 *
 * 之前用 os.tmpdir()（=C:\Users\...\AppData\Local\Temp）做暂存、
 * 又没限制 pip 缓存位置，结果反复装 AstrBot 把 6.8GB 全压在 C 盘上。
 * 安装目录旁的 data\ 是用户自己选的地方，资源放这儿才符合「绿色软件」的预期。
 */
export function workDirFor(dataRoot: string): string {
  return join(dataRoot, 'cache')
}

/** 临时暂存目录（解压、下载中转都放这） */
export function tempDirFor(dataRoot: string): string {
  return join(workDirFor(dataRoot), 'tmp')
}

/** pip 缓存目录（避免默认写到用户目录） */
export function pipCacheDirFor(dataRoot: string): string {
  return join(workDirFor(dataRoot), 'pip-cache')
}

/** 确保目录存在并返回 */
export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 在 data 下开一个独立暂存子目录（不用 mkdtemp，路径可预测、好排查）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 必须带随机后缀（暴力测试抓出的真实缺陷，主人 2026-10-08）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 原来只有 `Date.now().toString(36)` —— **毫秒精度**。
 * 实测：连续调用 50 次只产生 **11 个不同的目录名**。
 *
 * 后果不是"名字难看"，而是**真的数据竞争**：
 *   · `mkdirSync(recursive: true)` 对已存在的目录**不报错**，
 *     所以第二个任务会静默地拿到和第一个**同一个目录**
 *   · 于是两个并发安装往同一个目录里写文件 —— 互相覆盖、
 *     一个装完删目录把另一个正在装的东西也删掉
 *   · 而这类问题在单任务测试里**永远测不出来**
 *
 * 用户什么时候会撞上：同时装 AstrBot 和 NapCat（两个 runtime:install
 * 并发），或"取消后立刻重装"。都是很常见的操作。
 *
 * 加 `randomBytes(4)` 之后碰撞概率忽略不计（16^8 分之一），
 * 同时保留时间戳前缀 —— 排查时还能一眼看出是哪个时间段建的。
 */
export function makeStage(dataRoot: string, tag: string): string {
  const stamp = Date.now().toString(36)
  const rand = randomBytes(4).toString('hex')
  const dir = join(tempDirFor(dataRoot), `${tag}-${stamp}-${rand}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function cleanStage(dir: string | undefined): void {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 删不掉就算了，下次启动可清理 */
  }
}

/**
 * 启动时清扫 `cache\tmp` 里的**陈旧**残留。
 *
 * ## 为什么需要它
 *
 * 下载中转、解压暂存都放 `cache\tmp`（见上），每处用完都会自己
 * `cleanStage`。但"用完就删"只在**正常跑完**时成立：
 *
 *   - 下载到一半用户关掉软件 / 断电 / 强杀
 *   - 解压过程中被杀
 *   - 文件被杀软/索引服务占住，rmSync 当场失败
 *
 * 这些情况下暂存目录就留下来了。代码里好几处注释都写着
 * 「删不掉就算了，**下次启动可清理**」—— 但如果没人真去清，
 * 那句话就是空头支票：实测这台机器上 `cache\tmp` 已经堆了 **916** 个条目。
 *
 * 单看每个都不大，可 `rt-*`（运行时包）和解压出来的东西能到 GB 级，
 * 而且**永不回收**。用户会觉得"我明明把版本删了，磁盘怎么还占着"。
 *
 * ## 为什么按时间判"旧"
 *
 * 不能无条件 `RMDir /r` 整个 tmp：**正在跑的实例**可能正从里面读
 * （pip 的 TMP/TEMP 就指在这里）。把整个目录端掉会把运行中的安装/下载搞坏。
 *
 * 所以只删**超过 6 小时**没动过的：
 *   - 正常跑完的早就 self-clean 了，留下的一定是残留
 *   - 6 小时足够长，绝不会误伤正在进行的解压/下载
 *   - 又足够短，用户下次开机启动时就回收掉了
 *
 * ## ★ 为什么改成 async（性能审计实测：每次启动冻结约 14 秒）
 *
 * 原来是 `rmSync(p, {recursive:true})`，在 `for...of` 里**逐条同步删**。
 * 实测（审计用真实数据跑出来的）：
 *
 *     data\cache\tmp = 289 条目 / 47,317 文件
 *     其中超 6 小时、会被删的 = 137 条目 / 45,391 文件 / 592.4 MB
 *     rmSync 实测 0.31 ms/文件
 *     → **≈14 秒事件循环完全冻结，每次启动**
 *
 * 而这段跑在 `index.ts` 的启动路径上 —— 用户感知就是"一打开软件就卡住不动"，
 * 正是主人反复抱怨的那个现象。（里面装的是完整的 AstrBot 运行时，
 * 不是小碎文件，所以单次删除特别慢。）
 *
 * 同一个文件下面就有现成的 `removeDirAsync`（用 fs/promises 的 rm），
 * 改用异步之后主进程照常响应，清理速度本身也不变。
 *
 * ## 绝不影响启动
 *
 * 全程 try/catch，任何失败（权限、被占用）都只是跳过这一项。
 * 这是清理，不是关键路径 —— 绝不能因为它让软件起不来。
 *
 * @returns 删掉的条目数（给日志用）
 */
export async function sweepStaleTmp(
  dataRoot: string,
  maxAgeMs = 6 * 60 * 60 * 1000
): Promise<number> {
  const tmp = tempDirFor(dataRoot)
  if (!existsSync(tmp)) return 0

  let removed = 0
  const cutoff = Date.now() - maxAgeMs

  let entries: string[]
  try {
    entries = await fsp.readdir(tmp)
  } catch {
    // 读不动（权限/被占用）→ 当没这回事
    return 0
  }

  for (const name of entries) {
    const p = join(tmp, name)
    try {
      /*
       * 用 stat 取 mtime 而不是"创建时间"：
       * 目录的 mtime 会随着里面文件被写入而更新，
       * 所以"6 小时没动过"更准确地反映"确实没人再用了"。
       */
      const st = await fsp.stat(p)
      if (st.mtimeMs > cutoff) continue
      await removeDirAsync(p)
      removed++
    } catch {
      /*
       * 单项失败就跳过 —— 一个删不掉的目录不该阻断其余的清理，
       * 更不该冒泡出去影响启动。（本机确实存在 ACL 坏掉、
       * 永远删不掉的目录：runtimes\a\v4.27.0.deleting-* 就是。）
       */
      continue
    }
  }
  return removed
}

/**
 * 异步删目录 —— 大目录**必须**用这个，别用 rmSync。
 *
 * 为什么：一个实例目录动辄几百 MB、上万个文件（AstrBot 的 pip 依赖包就 49,000+ 个文件）。
 * `rmSync(..., { recursive: true })` 会把这整段时间**独占主进程**：
 * 主进程是单线程的，它一忙，所有 IPC（界面点任何按钮）全部排不上队 ——
 * 表现出来就是「删个文件就无响应」「点什么都没反应」。
 *
 * 用 fs.promises.rm 走 libuv 线程池，删除期间事件循环照常处理别的请求，
 * 界面不卡，用户能看到进度。
 *
 * 失败时抛出的错误里带上路径，方便定位是被占用还是权限问题。
 */
export async function removeDirAsync(dir: string): Promise<void> {
  if (!dir) return
  const { promises: fsp } = await import('fs')
  const deadline = Date.now() + 60_000
  /** ACL 修正只尝试一次（见下面 EPERM 分支的说明），避免无限循环 */
  let aclFixed = false
  /*
   * ★★ 记下"正在删大目录"（主人 2026-09-27 实测的现象）
   *
   * 他的原话：
   *   「删东西删多了就卡卡的……
   *     我删了东西之后再测连通就是全部超时，日志打包也时长会慢很多很多，
   *     好像是删除文件导致磁盘 IO 受限导致的，大半天都在 100% 磁盘占用，
   *     持续十几分钟，期间测速和打包日志都异常，甚至主进程无响应」
   *
   * ## 这是物理限制，不是代码 bug
   *
   * 一个 AstrBot 运行时是 **546 MB / 4.9 万个文件**（实测），删它等于
   * 让磁盘做几万次元数据操作 —— 期间整机 IO 被占满，
   * 于是**同一时间段内**的网络请求（测速）和文件操作（打包）全都变慢甚至超时。
   *
   * 我们改不了磁盘的速度，但能改**用户看到的东西**：
   * 测速/导出失败时如果正在大删除，就说清"是磁盘忙，不是源坏了" ——
   * 否则用户会去折腾根本没问题的设置（这正是他问"怎么全不可用了"的原因）。
   *
   * 用计数器而不是布尔：可能同时删多个目录（删实例 + 删版本）。
   */
  activeHeavyRemovals++
  try {
    for (;;) {
      try {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 })
      return
    } catch (e) {
      /*
       * Windows 上文件可能被杀软/索引服务短暂占用（EBUSY/EPERM），
       * 重试几次通常就好了。超过一秒还没好就认输并把原因说清楚 ——
       * 比卡在那里不返回强。
       */
      const code = (e as { code?: string }).code
      /*
       * ══════════════════════════════════════════════════════════════════════════
       * ★★ EPERM 的**第二种**成因：目录 ACL 被改过（主人 2026-09-27 实机抓出）
       * ══════════════════════════════════════════════════════════════════════════
       *
       * 现场：删实例后留下一个删不掉的空目录
       *     E:\MXBot\...\instances\AstrBot\a_28fe6f37cc\data\temp\updates
       * 实测：
       *     fs.rmSync(..., {force:true, maxRetries:3}) → EPERM scandir
       *     Get-Acl 该目录           → "尝试执行未经授权的操作"
       *     cmd dir 该目录           → File Not Found（**其实是空的**）
       *     当前用户 = 普通用户（非管理员）
       *     父目录 ACL = Authenticated Users 只有 Modify（**不能改 ACL**）
       *
       * 也就是说：目录**是空的**，但它的 ACL 只给了 Administrators/SYSTEM，
       * 普通用户连 `scandir` 都做不了 → `rm -r` 直接 EPERM。
       *
       * 这个目录哪来的：`data\temp\updates` 是 **pip 的临时目录**
       * （项目里 pipEnvFor 把 TEMP 指到 data\temp 下）。如果 pip 曾以
       * **管理员身份**跑过（我们的提权启动路径就是），它建的目录就归
       * Administrators 独占 —— 之后普通权限启动的启动器**永远删不掉它**。
       *
       * 为什么以前的重试没用：它是**权限**问题，不是**占用**问题，
       * 等多久都不会好。原来重试到 60 秒上限后抛出，而调用方是
       * `void removeDirAsync(...)`（fire-and-forget）+ 只记一条 WARN ——
       * 用户界面上完全看不出"有个目录没删掉"，只会在某天翻目录时
       * 发现一堆孤儿文件夹。
       *
       * 修法：EPERM 先尝试**给自己补权限**（icacls 授予当前用户完全控制），
       * 成功就再删一次。这不是"绕过安全机制"—— 这是**用户自己的数据目录**，
       * 删的是他自己点的"删除实例"留下的东西，只是权限继承被打断了。
       * icacls 失败（比如非管理员且完全无权）就照旧抛错，不装成功。
       */
      if (code === 'EPERM' && !aclFixed) {
        aclFixed = true // 只尝试一次，避免死循环
        const fixed = await tryTakeOwnershipAndDelete(dir)
        if (fixed) return
      }
      const retriable = code === 'EBUSY' || code === 'EPERM' || code === 'ENOTEMPTY'
      if (retriable && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200))
        continue
      }
      throw new Error(`删除失败（${code ?? '未知'}）：${dir}`)
      }
    }
  } finally {
    /*
     * ★ 必须用 finally 递减（含**所有**退出路径：成功、抛错、超时）。
     *
     * 漏掉任何一条，`isDiskBusy()` 就会永远返回 true ——
     * 那会让测速/导出的提示**永久**说"磁盘忙"，反而变成新的误导。
     */
    activeHeavyRemovals--
  }
}

/**
 * 对付"被提权进程创建、普通权限删不掉"的目录 —— 实机抓出的真实场景。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 现场（主人 2026-09-27 机器，证据逐条实测）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 删实例后留下一个**删不掉的空目录**：
 *     E:\MXBot\...\instances\AstrBot\a_28fe6f37cc\data\temp\updates
 *
 * 实测到的每一项：
 *     fs.rm(recursive,force,maxRetries)  → EPERM（scandir 被拒）
 *     Get-Acl 该目录                     → "尝试执行未经授权的操作"
 *     fsutil reparsepoint query          → Error 5: Access is denied
 *     icacls /grant ... /T               → "Access is denied"（连改权限都不行）
 *     takeown /F                         → ERROR: Access is denied
 *     cmd dir /q（看所有者）             → **BUILTIN\Administrators**，建于 2026/09/15
 *     cmd dir（看内容）                  → File Not Found（**它其实是空的**）
 *     用管理员 PowerShell 删              → ✔ 成功
 *
 * ## 结论：不是"被占用"，是"所有者是 Administrators"
 *
 * Windows 的规则：**改 ACL / takeown 需要「所有者」或管理员权限**。
 * 这个目录的所有者是 `BUILTIN\Administrators`（因为它是**以管理员身份运行的
 * pip** 建的 —— `data\temp\updates` 正是 pip 的临时目录，见 pipEnvFor 把
 * TEMP 指到 data\temp 下），而启动器这次是**普通权限**在跑。
 *
 * 于是：普通权限**连读属性都不行**，重试一万次也没用
 *（原来 `removeDirAsync` 会对 EPERM 重试到 60 秒上限 —— 那是白等）。
 *
 * ## 修法：借用我们已经有的提权能力
 *
 * 启动器本来就支持"以管理员身份重开自己"（见 elevate.ts，为了 NapCat 注入）。
 * 这里用同样一条路：起一个**提权的 PowerShell**，只做一件事 ——
 * 把这个目录删掉，然后把退出码带回来。
 *
 * 为什么可以这么做（不是越权）：
 *   · 删的是**用户自己**在界面上点的"删除实例"留下的残留
 *   · 路径来自我们自己的数据根，不是用户随便给的字符串
 *     （仍然用单引号转义 + 只传路径，不接受任何拼接片段）
 *   · 用户会在 UAC 上**明确看到并同意**这一次提权
 *   · 失败就返回 false，调用方照旧抛错 —— **绝不假装删成功**
 *
 * @returns 是否真的删掉了
 */
async function tryTakeOwnershipAndDelete(dir: string): Promise<boolean> {
  try {
    const { run } = await import('./async-exec')
    /*
     * 先 takeown 把所有权拿过来，再 icacls 授权，最后删。
     *
     * 顺序不能省：单靠 icacls 在"连 ACL 都改不了"时同样会被拒，
     * 必须先 takeown 成为所有者（提权后才有这个权力）。
     */
    const q = (s: string): string => `'${s.replace(/'/g, "''")}'`
    const script =
      `$p = ${q(dir)}; ` +
      `takeown /F $p /R /D Y 2>$null | Out-Null; ` +
      `icacls $p /grant '*S-1-5-32-545:(OI)(CI)F' /T /C /Q 2>$null | Out-Null; ` +
      `Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue; ` +
      `if (Test-Path -LiteralPath $p) { exit 1 } else { exit 0 }`
    const r = await run(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeoutMs: 120_000 }
    )
    if (r.status === 0) return true
    /*
     * 普通权限下起提权进程要靠 runas。上面那条是"当前进程若已是管理员
     * 就直接删"的快路径；非管理员时它必然失败，于是走 runas 重来一次。
     */
    const elevated =
      `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden ` +
      `-ArgumentList '-NoProfile','-NonInteractive','-Command',${q(script)}`
    const r2 = await run(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', elevated],
      { timeoutMs: 120_000 }
    )
    if (r2.status !== 0) return false
    // 提权子进程说成功了也要**自己再验一次**（不能只信退出码）
    const { existsSync } = await import('fs')
    return !existsSync(dir)
  } catch {
    /* 提权失败（用户点了"否"）→ 交给调用方照常抛错 */
    return false
  }
}

/**
 * pip 相关环境变量：把缓存、临时目录全部指向 data，
 * 并关掉版本检查（省一次网络往返）。
 */
export function pipEnvFor(dataRoot: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const cache = ensureDir(pipCacheDirFor(dataRoot))
  const tmp = ensureDir(tempDirFor(dataRoot))
  return {
    ...extra,
    PIP_CACHE_DIR: cache,
    TMP: tmp,
    TEMP: tmp,
    TMPDIR: tmp,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1'
  }
}
