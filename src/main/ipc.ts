import {
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  statSync,
  /**
 * 换名失败时清理临时文件用（writeInstanceMeta）
 */

  unlinkSync} from 'fs'/**
 * promise 版 unlink —— `instance:remove` 里后台删实例日志用。 必须从 'fs/promises' 取，不能用 'fs' 的：后者是回调式的， 写成 `unlink(p).catch(...)` 会抛 `The "cb" argument must be of type function`（详见调用点的注释）。
 */
/*
 * `readFile` 起个别名（`readFileAsync`）—— 因为这个文件里已经有**同步**的
 * `readFileSync`，直接用 `readFile` 会让人一眼分不清哪个是同步的。
 * 用途见 `runtimes:remove` 里 readTagsForDirs 的说明：
 * 并行读一批实例的 instance.json，别一个个同步读（那是 1.3 秒的主进程阻塞）。
 */
import { readFile as readFileAsync, readdir as readdirAsync, unlink } from 'fs/promises'

import { basename, dirname, join, resolve, sep } from 'path'

import { randomBytes } from 'crypto'

import * as os from 'os'
import {
  createInstanceRepo,
  type InstanceRecord,
  type InstanceRepo} from './store/instance-repo'

import { allocate, createTcpProbe, type OccupancyProbe } from './ports/allocator'

import { TYPE_PORT_RANGE } from './store/instance-repo'/**
 * 记下实例绑定的模板版本。 原先这里自己 join 出 instances.json 做「读-改-写」，绕过了 repo 层： - JSON.parse 没有 try 包裹 → 索引损坏时建实例直接崩； - 用 writeFileSync 直写 → 不是原子替换，写一半断电就毁索引。 现在收敛到 repo.updateTemplateVersion（防御 + 原子写都只有一份实现）。
 */
function refreshTemplateVersion(r: InstanceRepo, id: string, version: number): void {
  r.updateTemplateVersion(id, version)}
import { createProcessManager, type ProcessManager, type StartSpec } from './proc/process-manager'

import type { Logger } from './logs/logger'

import type { AuditLog } from './logs/audit'

import { resetCredentials, scanCredentials } from './creds/creds'
import { isInternalBuild } from './hardware-override'

import { relocateDataRoot } from './store/relocate'

import { createLogger } from './logs/logger'

import { createAuditLog, listAuditDays } from './logs/audit'

import { createCrashHandler } from './logs/crash-handler'

import { getTemplates, instantiateFromTemplate } from './update/templates'/**
 * 这里原来还 import 了 updater 的 checkForUpdate / runUpdate，但生产环境 从来没有调用过它们（只被 updater 自己的单测用）。 原因见 instance:setRuntime 的说明：updater 用的是老的「模板」模型 （把整棵 runtime\ rename 进实例目录），而现架构里运行时是共享的、 实例只持一个 tag 指针。这套模型和现状正交，留在 import 里 只会让人以为「版本更新走的是 updater」。
 */
import { backupRuntime, pruneBackups, restoreBackup } from './update/backup'

import { listBackups, deleteBackup, backupsFolderFor } from './update/backup-list'

import { listUpdateBackupsAsync, pruneUpdateBackupsAsync, updateBackupsRoot } from './update/update-backups'/**
 * template-source 的 MIRROR_PREFIXES / resolveLatest / TEMPLATE_SOURCES 原来 也在这里 import，但生产代码里一次都没用过（镜像源现在走 mirror-store + version-catalog）。留着会让人以为「模板下载那条老链路还在跑」。
 */
import {
  addCustomMirror,
  loadMirrors,
  removeCustomMirror,
  setMirrorPref,
  resolvePythonSource,
  loadPythonSources,
  savePythonSources} from './update/mirror-store'// AstrBot 的 Python 源（pip 索引）—— 与 NapCat 的 GitHub 代理源分开
import {
  findPythonSource,
  pythonSourceToPipArgs,
  type PythonSource} from './update/python-source'

import { testMirrors } from './update/mirror-store-test'

import { downloadTemplate } from './update/template-dl'

import { invalidateVersionCache, listVersions, cmpVersion } from './update/version-catalog'// runPowerShell 也是死导入：所有外部命令都走 run/runSync/expandArchive
import { runPipWithCacheFallback } from './util/pip-run'
/*
 * 「正在进行中的可取消任务」—— 同时提供**互锁**与**取消**句柄。
 *
 * 原来的 `pendingInstalls` 只是个 Set（只有键、没有句柄），
 * 所以它只能防重入、**不能取消**；而且只有 runtime:install 在用它，
 * 导入完全没锁 —— 主人实测「安装和导入没有互锁正在进行的同版本」。
 */
import { beginTask, endTask, findTask, cancelTask, taskKey, listTasks } from './update/running-tasks'
/*
 * 补杀前校验"这个占端口的进程是不是我们的实例"（审查报告 C-1）——
 * 只看端口就 admin 权限强杀，会误伤用户自己开的程序。
 */
import { queryProcInfo, shouldKillByPort, isLoopbackOnly } from './proc/proc-identity'
import {
  clearPythonSourceFailures,
  markPythonSourceFailed
} from './update/mirror-store'
import { expandArchive, run, runSync } from './util/async-exec'

import { readJsonFile } from './util/json-file'

import { importArchive, pickArchiveFile, probeArchive } from './update/import-archive'// cleanStage / ensureDir 同样没人调（暂存目录统一走 makeStage + removeDirAsync）
import { makeStage, pipEnvFor, removeDirAsync } from './util/workdir'

import { downloadRuntime } from './update/runtime-download'

import { createRuntimeStore } from './update/runtime-store'

import { resolveStartupDataRoot, writeRootPointer } from './store/root-pointer'

import { instanceLogFile, readLogTail } from './logs/read-snippet'

import { pruneOldLogs } from './logs/prune'

import { createProgressTracker, humanSize, type ProgressState } from './update/progress'

import { createPipProgress } from './update/pip-progress'

import { ensureTemplate } from './update/templates'

import { isPythonReady, resolveLaunchSpec } from './runtime/layout'

import { patchNapcatWorkerArgv } from './runtime/napcat-patch'

import {
  checkQQ,
  parseUninstallString,
  QQ_FALLBACK_DIRS,
  QQ_INSTALL_REGISTRY_KEYS,
  QQ_REGISTRY_KEYS,
  qqCandidatesFromRegistry,
  qqInstallFromRegistry,
  type QQInfo,
  type QQInstall} from './runtime/qq-check'

import { probePort } from './proc/health'

import { waitForReady, startupFailMessage } from './proc/startup-guard'

import { createNapcatLogCollector } from './proc/napcat-log'

import {
  checkAppUpdate,
  downloadAppUpdate,
  isCheckDue,
  isVersionSkipped,
  versionedInstallerName,
  type AppUpdateCheck} from './update/app-update'

import { manifestUrls } from './update/publish-urls'

import { detectInstanceVersion, versionNumOf } from './runtime/instance-version'

import {
  PYTHON_SOURCES,
  PYTHON_VERSION,
  enableEmbedSite,
  ensureBuildTools,
  ensurePip,
  ensureSiteCustomize,
  pythonDirFor,
  pythonExeFor} from './runtime/python-runtime'

import {
  BACKUP_KEEP_DEFAULT,
  NAPCAT_DEFAULT_TOKEN,
  PORT_RANGE_A,
  type InstanceType} from './constants'/**
 * 下载进度事件：主进程 → 渲染层（无 window 时静默，便于测试与无 GUI 场景）
 */
export interface DownloadProgressEvent extends ProgressState {
  phase: 'start' | 'downloading' | 'verify' | 'finish' | 'unpack' | 'done' | 'error'
  label?: string
  error?: string
  /**
   * 这个任务**开始**的时刻（ms epoch）。
   *
   * 主人 2026-09-27：「正在安装依赖 · 已用 3 秒 —— 切换到其他页面回来，
   * 计时又刷新了」。
   *
   * 「已用 N 秒」原来是**渲染层自己记的**（下载页组件里的一个 Map）——
   * 切走页面组件卸载 → 时间归零 → 切回来又从 0 读。
   *
   * 这与本项目反复出现的**同一类病**：长任务的"进行中"状态只活在
   * 组件生命周期里（logs:exportBusy、download:sessions 都是它）。
   *
   * 现在由主进程在**第一次发出该任务事件时**记下时刻，之后每个事件都带上 ——
   * 界面切多少次都算得准。
   *
   * 主进程没发这个字段时（老的/测试构造的事件），界面回落到
   * "首次见到时自己记"，计时仍然对。
   */
  startedAt?: number
}let progressSender: ((e: DownloadProgressEvent) => void) | undefined/**
 * 由主进程注册真实发送器（BrowserWindow.getAllWindows）
 */
export function setProgressSender(fn: (e: DownloadProgressEvent) => void): void {
  progressSender = fn}/**
 * 「当前有哪些下载/安装任务在跑」—— 给界面**切回页面时恢复进度条**用。
 *
 * ============================================================================
 * 为什么这个状态必须在主进程（主人 2026-09-27 实测的真问题）
 * ============================================================================
 *
 * 他的原话：
 *   「我从下载页切换到其他页面再回来，顶部的下载进度就消失了，
 *     直到更新进度才重新显示更新了进度的那个，没更新进度的就一直不显示」
 *
 * ## 原因
 *
 * 进度原来只存在**下载页组件的 ref**（progressMap）里 ——
 * 切走页面 = 组件卸载 = 进度全丢；切回来时组件是新的、空的，
 * 只有**之后**新发生的事件才会让它显示东西。
 *
 * 于是"装到一半切走再回来"看到的是空白，用户完全不知道那个安装还在不在跑。
 *
 * ## 修法
 *
 * 主进程在每次发进度事件时**顺手维护一份最新快照**，
 * 界面挂载时问一次就能把进度条**原样恢复**（见 download:sessions 通道）。
 *
 * 与 logs:exportBusy 是同一类修法 —— 长任务的"进行中"状态属于主进程，
 * 不该只活在某个组件的生命周期里。
 *
 * 清理：done / error 的事件到达时从快照删掉 ——
 * 已完成的任务不该在切回来时还挂着（那是另一种误导）。
 */
const liveDownloads = new Map<string, DownloadProgressEvent>()

/** 给界面用：当前还在进行中的下载/安装任务快照 */
export function currentDownloads(): DownloadProgressEvent[] {
  return [...liveDownloads.entries()].flatMap(([key, progress]) => {
    // 进程异常退出或收尾事件丢失时，快照不能永久冒充活跃任务。
    const active = findTask(taskKey(progress.type, progress.tag))
    if (!active) {
      liveDownloads.delete(key)
      return []
    }
    return [progress]
  })
}

function sendDownloadProgress(e: DownloadProgressEvent): void {
  /*
   * 先维护快照（**在发送之前**：发送可能因窗口已关而失败，
   * 而快照与"窗口在不在"无关 —— 界面切回来还要靠它）。
   */
  try {
    const key = `${e.type}|${e.tag}`
    if (e.phase === 'done' || e.phase === 'error') {
      liveDownloads.delete(key)
    } else {
      /*
       * 首次见到这个任务 → 记下起始时刻；之后每个事件都**带上它**，
       * 这样界面切页面回来能算出正确的"已用 N 秒"（否则会从 0 重读）。
       */
      const prev = liveDownloads.get(key)
      const startedAt = prev?.startedAt ?? e.startedAt ?? Date.now()
      liveDownloads.set(key, { ...e, startedAt })
    }
  } catch {
    /* 维护快照绝不影响发事件 */
  }
  try {
    progressSender?.(e)
  } catch {
    /**
 * 窗口已关：丢弃进度即可
 */

  }}/**
 * 关键操作的日志记录器（只用到 log 这一个方法）
 */
type OpLogger = { log: (lv: 'INFO' | 'WARN' | 'ERROR', ch: string, msg: string, d?: string) => void } | undefined/**
 * 关键操作的开始/结束标记（指导书 3.2）。 ## 为什么需要它 崩溃时最难回答的问题是"它当时在干什么"。堆栈往往只有一两帧有用， 而日志末尾可能停在任何地方。有了这对标记，判据就非常硬： 有 [op:start] X 而没有 [op:end] X → 它死在 X 里面 ## 为什么必须是"同步写日志" 标记的价值全在"最后一条"上。如果日志是异步刷盘的，进程被杀时 这条标记**根本没落盘* —— 那就等于没打。项目里的 logger 用 `appendFileSync` 同步写（见 logger.ts 的注释），正是为此。 ## 用法约定 包在 try/finally 里：异常也会写上 end（异常本身另有 ERROR 日志， 不该被误认成"卡在这一步"）；**进程被杀**才会出现只有 start 的情况。
 */
function opStart(logger: OpLogger, name: string, detail?: string): void {
  logger?.log('INFO', 'op', `[op:start] ${name}`, detail)}function opEnd(logger: OpLogger, name: string, detail?: string): void {
  logger?.log('INFO', 'op', `[op:end] ${name}`, detail)}const runtimeStores = new Map<string, ReturnType<typeof createRuntimeStore>>()/**
 * 多版本运行时仓库（按数据根缓存，避免每次读盘）
 */
function runtimeStore(dataRoot: string): ReturnType<typeof createRuntimeStore> {
  let s = runtimeStores.get(dataRoot)
  if (!s) {
    s = createRuntimeStore({ dataRoot })
    runtimeStores.set(dataRoot, s)
  }
  return s}/**
 * 启动后等端口就绪的**基础上限**。NapCat 首启要解压/自检，AstrBot 要加载一堆包。 这个数字是被用户日志顶上去的，不是拍的： 2026-09-13 那次失败，AstrBot 内部日志在 19:19:54 之后**静默了 33 秒* （在导入 faiss / numpy 这些重库，没有任何输出），19:20:27 才打印 「AstrBot v4.28.0」，而我们 30 秒就判超时把它杀了（总耗时 43282ms）。 也就是说 30 秒**短于**一次正常的冷启动。给到 90 秒， 让这种「慢但在推进」的启动能跑完。
 */
const START_PORT_WAIT_MS = 90000/**
 * 启动期「静默」多久才算真卡住。 为什么不是 20 秒：上面那次实测里，AstrBot 有一次**连续 33 秒不输出**是完全正常的 （Python 导入重库时不打日志）。20 秒的宽限会把这种正常启动判死。 更要紧的是原来那个续期逻辑根本没生效：`deadline = start + 30s`， 而最后一次输出在第 8 秒，`last + 20s = 第 28 秒 < 第 30 秒`， 于是「有输出就续期」这条规则一次都没触发过 —— 白设。 现在基础预算（90 秒）本身已经够长，静默宽限作为第二道保险。
 */
const START_IDLE_GRACE_MS = 60000/**
 * 有输出时最多给到多久（防止一个疯狂打日志的坏进程把启动永远挂着）
 */
const START_MAX_TOTAL_MS = 300000/**
 * 停止实例后，等端口释放的时长（NapCat 注入的 QQ 属于「脱链」进程，要单独处理）
 */
const STOP_VERIFY_MS = 3000/**
 * 把进程输出裁成能在界面里显示的一小段。 用户报告：「报错内容溢出屏幕」。启动失败时我们本来把进程最后几 KB 输出 整段拼进错误消息，横幅被撑爆、糊住整个界面 — 反而看不到真正的原因。 这里只留最后几行、限总长，并去掉 ANSI 颜色转义（那些 [32m 之类的东西 在界面上就是一坨乱码）。**完整输出照样写进日志文件**， 用户点「看日志」或导出日志包就能拿到。
 */
function shortTail(tail: string, maxLines = 6, maxChars = 400): string {
  const noAnsi = tail.replace(/\u001b\[[0-9;]*m/g, '')
  const lines = noAnsi.split(/\r?\n/).filter((l) => l.trim().length > 0)
  const picked = lines.slice(-maxLines).join('\n')
  const trimmed = picked.length > maxChars ? `${picked.slice(picked.length - maxChars)}` : picked
  return `—— 进程最后几行 ——\n${trimmed}`}/**
 * 等端口彻底没人监听。 返回 true=退了，false=超时还在。用于停止后核实。
 */
async function waitPortGone(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (!(await probePort(port, 600))) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, 300))
  }}/**
 * 从 netstat 输出里解析出监听某端口的 pid（**纯函数**，便于单测）。 形如：TCP 127.0.0.1:6200 0.0.0.0:0 LISTENING 28704 抽成纯函数的理由：解析逻辑是"看一眼 netstat 输出就知道对不对"的东西， 但混在 spawnSync 里就没法测。分离之后同步/异步两个版本共用同一套解析， 也不会出现"改了异步版忘了同步版"的漂移。
 */
export function parseListenerPid(netstatText: string, port: number): number | undefined {
  for (const line of String(netstatText ?? '').split(/\r?\n/)) {
    if (!/\bLISTENING\b/i.test(line)) continue
    const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line)
    if (m && Number(m[1]) === port) return Number(m[2])
  }
  return undefined}/**
 * 找出正在监听某个端口的进程 pid（**同步版**）。 为什么需要它：NapCat 注入进 QQ.exe 之后，QQ 就脱离了我们 spawn 出来的 子进程树，`taskkill /T`（按父子关系递归）根本杀不到它。而端口是 最可靠的线索 —— 端口段是按实例类型分配的，这个端口就是这个实例的身份。 解析 netstat 输出而不是用 Get-NetTCPConnection：后者要起 PowerShell （几百毫秒），而这里在停止流程上，能快就快。 ## ★ 同步版只给**退出路径**用（P0-4 收口） 指导书明确要求"ipc handler 里不得有同步阻塞代码"。这个函数用 `runSync`，最坏要等 netstat 跑满 8 秒超时 —— 放在交互路径（用户点停止） 上会**冻住整个界面 8 秒**。 所以现在的分工是： · 交互路径（stopInstanceHard 等）→ 一律用 findListenerPidAsync · 退出路径（killEverythingForExit）→ 保留同步：那时进程马上就结束， "阻塞"反而是我们想要的（必须在咽气前把清理做完）， 改成异步还要重排 will-quit 的时序，收益为负。
 */
function findListenerPid(port: number): number | undefined {
  try {
    const out = runSync('netstat', ['-ano'], { timeoutMs: 8000 })
    return parseListenerPid(String(out.stdout ?? ''), port)
  } catch {
    /**
 * 查不到就算了，调用方会退化成「只归位状态」
 */

  }
  return undefined}/**
 * findListenerPid 的**异步**版（交互路径专用）。 用异步 spawn：netstat 那几百毫秒~几秒的等待**不占事件循环**， 界面照常响应。停止实例、换版本、搬家这些路径都用它。
 */
async function findListenerPidAsync(port: number): Promise<number | undefined> {
  try {
    const out = await run('netstat', ['-ano'], { timeoutMs: 8000 })
    return parseListenerPid(String(out.stdout ?? ''), port)
  } catch {
    /**
 * 同上：查不到就退化成只归位状态
 */

  }
  return undefined}/**
 * 「把这个实例彻底停掉」—— 停实例的**唯一**正确做法。 ## 为什么要抽成一个函数 这个坑在仓库里踩了三次，每次都是同一句话的注释： NapCat 不是独立服务，它把自己注入进 QQ.exe 运行 （NapCatWinBootMain.exe QQ.exe NapCatWinBootHook.dll）。 QQ 起来之后就脱离了我们的子进程父子链，`taskkill /T` 按父子关系递归， *杀不到这个「孙子辈但已脱链」的 QQ**。 三个调用点里只有一个（instance:stop）做对了全部三步： 1. killTreeSync —— 杀掉我们 spawn 的那棵树 2. waitPortGone —— 等端口真退，**不能只信 taskkill 发出去了* 3. 没退就 findListenerPid + taskkill /PID —— 按端口精确补杀 另两处的后果各不相同但都真实： - `config:moveDataRoot`（迁移数据目录）：以为停了就开始 cpSync runtimes\， 而 QQ 正占着 sqlite .db-wal / .pyd → 复制失败 → 新根里的运行时残缺 → 用户在新根启动实例报「运行时结构不对」。 - `backup:make`（手动备份）：QQ 还在写 data 目录，打包已经开始 → **归档是半写状态**，用户以为有备份，真要用时才发现是坏的。 抽出来共用是为了不再有第四次遗漏。判据里**端口就是实例的身份* （端口段按类型分配：AstrBot 6100-6199 / NapCat 6200-6299）， 按端口补杀不会误伤用户自己开的 QQ。 pm 显式传入而不是用模块级变量：模块级可变状态在测试里会跨用例串味， 而且这里本来就该由调用方明确「用哪个 processManager」。 @param pm processManager（提供 killTreeSync） @param rec 实例记录（要 port 和 id） @param onNote 可选的日志出口（记「按端口补杀」这种值得留痕的动作） @param settleMs 杀完额外静默等待的毫秒数。备份场景要给文件句柄一点时间 真正释放（进程退了不等于句柄全放了），默认 0 = 不等。
 */
async function stopInstanceHard(
  pm: { killTreeSync: (id: string) => void },
  /*
   * ★ 需要 dir 与 type 来**校验进程身份**（C-1）：
   * 命令行/映像路径里要有这个实例的痕迹，才允许按端口补杀。
   * 它们都可选 —— 老的调用方不传时，判身份会"拿不到证据 → 不杀"
   *（保守那一边，见 proc-identity.ts 的说明）。
   */
  rec: { id: string; port: number; dir?: string; type?: 'a' | 'n'; startedAt?: number },
  onNote?: (msg: string) => void,
  settleMs = 0): Promise<boolean> {
  /*
   * 这个实例"开始启动"的时刻 —— 补杀时用它筛掉"比实例还早就在跑的进程"。
   *
   * 优先用调用方传的（那是 spawn 那一刻记的，最准）；
   * 没传就退回"现在往前推一段时间"：停止操作通常发生在实例跑了一会儿
   * 之后，而"刚起来几毫秒"的进程只会是我们要找的那个。
   * 推 10 分钟是保守值 —— 它只会让判据更宽松（更容易认为"是它的"）。
   */
  const startedAt = rec.startedAt ?? Date.now() - 10 * 60 * 1000

  pm.killTreeSync(rec.id)
  let gone = await waitPortGone(rec.port, STOP_VERIFY_MS)
  if (!gone) {
    /**
 * 异步查（用户点「停止」时不能冻界面）。 原来这里是同步版：netstat 最坏要跑满 8 秒超时，期间整个主进程 都不响应 —— 属于指导书 P0(4) 点名的同步阻塞。
 */

    const pid = await findListenerPidAsync(rec.port)
    // 不杀自己：端口理论上不可能是本进程占的，但防御一下更安全

    if (pid !== undefined && pid !== process.pid) {
      /*
       * ══════════════════════════════════════════════════════════════════════════
       * ★★ 补杀之前必须**校验进程身份**（深度审查报告 C-1，已复验）
       * ══════════════════════════════════════════════════════════════════════════
       *
       * ## 原来的问题
       *
       * 唯一判据是"谁在 LISTENING 这个端口"，然后直接
       * `taskkill /PID <pid> /T /F`（`/T` 连子进程一起杀）。
       * 而程序**自我提权到管理员** —— 这是一条"管理员权限的强杀"原语。
       *
       * 原来的理由是「端口段（6200-6299）是我们的，不会误伤」。但端口段
       * 只是我们**优先选**的区间，不是保留区：用户完全可能在 6200 上跑
       * 别的服务，或者自己手开一个 NapCat。
       *
       * 而 `process-manager.ts` 里明写着承诺：
       *     「绝不按进程名扫描系统；用户另跑的 napcat/astrbot/QQ 一概不碰」
       * 按端口盲杀丢掉了这条承诺的精神 —— 只是换成"按端口扫"，误伤后果一样。
       *
       * ## 现在
       *
       * 先查那个 pid 的命令行 / 映像路径，确认它**确实和这个实例有关**
       *（命令行含实例目录或 id，或映像落在我们的运行时目录下）。
       *
       * **查不到、或对不上 → 不杀**，只记一条日志。
       *
       * 为什么"不杀"是对的默认：
       *   · 漏杀 → 用户看到"没停干净"，再点一次就行
       *   · 误杀 → 用户别的东西当场没了，**不可逆**
       * 这个不对称决定了必须往保守那一边取。
       */
      /*
       * ══════════════════════════════════════════════════════════════════════════
       * ★★ 补杀之前必须**校验进程身份**（深度审查报告 C-1，已复验）
       * ══════════════════════════════════════════════════════════════════════════
       *
       * 原来唯一判据是"谁在 LISTENING 这个端口"，然后直接
       * `taskkill /PID <pid> /T /F`（`/T` 连子进程一起杀）。
       * 而程序**自我提权到管理员** —— 这是一条"管理员权限的强杀"原语。
       *
       * 端口段（6200-6299）只是我们**优先选**的区间、不是保留区，
       * 用户完全可能在 6200 上跑别的服务。而 process-manager.ts 明写着
       * 「用户另跑的 napcat/astrbot/QQ 一概不碰」。
       *
       * ## 判据（两条都要满足，详见 proc-identity.ts）
       *
       *   ① 端口**只绑回环** —— NapCat 的 WebUI 就是本机服务；
       *      要给别人用的服务会绑 0.0.0.0
       *   ② 那个进程的**启动时间晚于**本实例开始启动的时刻 ——
       *      它必然是我们刚 spawn 出来的
       *
       * 前两版判据（命令行找实例目录、映像路径在运行时目录下）都
       * **实测不成立**：QQ 主进程命令行实测就是 `"E:\QQ\QQ.exe"`，
       * 实例目录是通过 **环境变量** `NAPCAT_WORKDIR` 传的，
       * 而环境变量不出现在 CommandLine 里。
       *
       * ## 拿不到证据 → **不杀**
       *
       * 漏杀 → 用户看到"没停干净"，再点一次即可；
       * 误杀 → 用户别的东西当场没了，**不可逆**。
       */
      const netOut = await run('netstat', ['-ano'], { timeoutMs: 8000 }).catch(() => undefined)
      const loopbackOnly = isLoopbackOnly(String(netOut?.stdout ?? ''), rec.port)
      const info = (await queryProcInfo([pid])).get(pid)
      const kill = shouldKillByPort(info, { sinceMs: startedAt, loopbackOnly })

      if (!kill) {
        onNote?.(
          `端口 ${rec.port} 被 pid ${pid} 占用，但**证据不足**（` +
            (loopbackOnly ? '回环监听 ✔' : '不是回环监听 ✘') +
            `, ` +
            (info?.createdAt !== undefined
              ? `启动于 ${new Date(info.createdAt).toLocaleTimeString('zh-CN')}`
              : '读不到启动时间') +
            `）—— 为免误杀别人的进程，这次不动它` +
            (info?.exePath ? `。它是 ${info.exePath}` : '')
        )
        // 保留未确认归属的进程；结尾的端口复核会阻止调用方继续做破坏性操作。
        gone = await waitPortGone(rec.port, STOP_VERIFY_MS)
      } else {
        try {
          await run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 15000 })
        } catch {
          // 杀不掉也继续复核端口，最终按实际状态决定是否允许后续操作。
        }
        gone = await waitPortGone(rec.port, STOP_VERIFY_MS)
      }
    }
  }
  if (!gone) {
    /*
     * ★ 返回 false 而不是 throw（回归测试 user-reported-bugs 抓出的语义问题）
     *
     * 原来这里 throw —— 而调用方（instance:stop）在它之后**照样**写
     * `updateStatus(id,'stopped')`（那段没有 try/catch 包住这一步的意义）。
     * 结果就是"没停干净，状态却显示已停止"，正是用户报告的
     * 「点停止没反应，NapCat 还在跑」。
     *
     * 改成显式返回值之后，调用方能**明确地**决定：
     *   · 停干净了 → 写 stopped、关日志轮询
     *   · 没停干净 → 保留原状 + 如实报给用户
     *
     * 为什么要保留 onNote 里的原因：它说明了"为什么没杀"
     *（证据不足 / 找不到 pid），调用方要把它带进给用户的报错里。
     */
    const pid = await findListenerPidAsync(rec.port)
    onNote?.(
      `端口 ${rec.port} 仍被占用${pid ? `（PID ${pid}）` : ''}，无法确认 ${rec.id} 已停止`
    )
    return false
  }
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs))
  return true
}/**
 * WebUI 视图顶部让出的高度：自绘标题栏 44px + 工具条 34px
 */
const WEBUI_TOP_INSET = 74/**
 * versionNumOf 已移到 src/main/runtime/instance-version.ts —— 原来这里有一份私有实现，template-dl.ts 里又抄了一份， 两处算出来的值必须一致（都用来标识「实例绑的是哪个运行时」）， 重复实现迟早漂移。现在统一引用同一份，见那边的说明。
 */
/**
 * 记下实例绑定的运行时版本（换版本/删版本时判断引用）。 ## 必须原子写（先写 tmp，再 rename） 原来这里是直接 `writeFileSync(join(dir, 'instance.json'), ...)`。 非原子 —— 写到一半掉电/被杀/磁盘满，留下的是**截断的半个 JSON**。 而读的那一头 `readInstanceTag()` 对损坏是静默降级的： try { return readJsonFile(f).runtimeTag } catch { return undefined } 于是"文件坏了"和"从没写过"变得无法区分。这本身只是个小瑕疵， 但删除守卫里有一句**兜底**把它放大成了数据事故： (readInstanceTag(inst.dir) ?? store.latest(inst.type)?.tag) === p.tag 读不到就把这个实例的引用**算到 `latest`（该类型最新版本）头上**。后果： - 实例 A 真正绑的是 v4.27.0，instance.json 被写坏 - 用户删 v4.28.0（latest）→ 守卫以为 A 在用 v4.28.0 → A 没在跑（不会被拦）→ v4.28.0 被删掉（误留了本不该留的引用） - 反过来用户删 v4.27.0（A 真正在用的）→ 守卫以为 A 用的是 v4.28.0 → **认为没人用 v4.27.0* → 如果 A 正在跑，正在执行的代码被当场抽走 也就是说那个 `??` 兜底本意是"保守，宁可多留"，实际却把引用**算错了对象**。 ## 为什么 rename 就够了 `renameSync(tmp, target)` 在同一卷上是原子的（Windows MoveFileEx 语义）： 读到的永远是"完整的旧文件"或"完整的新文件"，不存在半个。 instance-repo.ts 的 writeAll 早就用的这个套路，这里跟它保持一致。 临时文件名带随机后缀：并发/重入时不会互相踩（虽然这里都是同步调用， 但代价也就几个字节，不值得为"理论上不会并发"留下隐患）。
 */
function writeInstanceMeta(dir: string, rec: InstanceRecord, tag: string): void {
  const target = join(dir, 'instance.json')
  const tmpPath = `${target}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(
    tmpPath,
    JSON.stringify(
      {
        id: rec.id,
        type: rec.type,
        name: rec.name,
        runtimeTag: tag,
        port: rec.port,
        createdAt: rec.createdAt
      },
      null,
      2
    ),
    'utf8'
  )
  try {
    renameSync(tmpPath, target)
  } catch (e) {
    /**
 * 换名失败（目标被别的进程锁住等）→ 把 tmp 清掉再抛。 不清的话每次失败都在实例目录里漏一个 .tmp 文件。
 */

    try {
      unlinkSync(tmpPath)
    } catch {
      /**
 * 删不掉也只能算了，别把真正的错误盖掉
 */

    }
    throw e
  }}
export interface AppConfig {
  dataRoot: string
  portMin: number
  portMax: number
  backupKeep: number
  /**
 * M4：关闭行为（tray=点 ✕ 最小化到托盘；quit=直接退出；undefined=首次弹一次询问）
 */

  closePolicy?: 'tray' | 'quit'
  /**
 * ---------- 启动器自身更新（用户要求「每次启动检测一次、一天推一次」） ----------
 */

  /**
 * 上次自动检查更新的时间戳（毫秒）；用来算「是否已满一天」
 */

  lastUpdateCheckAt?: number
  /**
 * 用户点过「跳过此版本」的那个版本号；只对该版本生效，下个版本照常提示
 */

  skippedAppVersion?: string}
export interface HandlerOpts {
  probe: OccupancyProbe
  processManager?: ProcessManager
  /**
 * ★ 命令执行器注入点（主人 2026-09-27 要求「严格验证是否点哪个源就从哪个源下载」）。 ## 为什么必须加这个 我第一次"修好"了 pip 源的选择，写了 10 条测试全过 —— 但主人真机一测还是「点哪个都是 python 源」。 原因：那些测试是**源码守卫**（正则查代码形状）， 只能证明"代码长得对"，**证明不了运行时会用对源**。 而 `runtime:install` 里的命令执行器原来是写死的 `await import('./util/async-exec')` —— 没有任何注入点， 想捕获"真正传给 pip 的参数"就必须真起 pip（几分钟 + 联网）。 有了这个注入点，测试可以塞一个**记账的假执行器**： 参数原样记下来、立即返回成功 —— 于是能断言 `-i` 后面那个 URL 就是用户点的那一个源。 这才是"严格验证"。 不注入时走真实实现（生产路径零影响）。
 */

  runCommand?: (
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; env?: NodeJS.ProcessEnv }
  ) => Promise<{ status: number | null; stdout?: string; stderr?: string }>
  /**
 * 测试注入：由实例记录解析启动命令；缺省=启动命令模板尚未接线（M2 接入真实模板布局）
 */

  /**
 * 生成启动命令；dataRoot 由调用方给出，别在函数里猜目录层级
 */

  commandFor?: (rec: InstanceRecord, dataRoot: string) => Omit<StartSpec, 'id' | 'port'>
  /**
 * M3 更新链路注入（未注入时走抛错路径，由设置页下载模板入口代替）
 */

  fetchManifest?: (url: string) => Promise<string>
  fetchAsset?: () => Promise<Buffer>
  /**
 * 这里原有 setLogin / getLogin（开机自启注入点），已随该功能整体移除
 */

  /**
 * 系统信息：内存/磁盘余量。 这里**没有* statsProvider 了 —— 原来它负责给运行实例的 pid 拉 mem/cpu， 但底层 pidusage 在 Windows 上 spawn wmic.exe，而 wmic 在新版 Windows 已被移除，每次调用要等失败超时 2.4~5.1 秒，把主进程拖死（界面全卡）。 AstrBot / NapCat 自己的 WebUI 都有资源监控，不再重复采集。
 */

  systemInfo?: () => Promise<{
    totalMemMB: number
    freeMemMB: number
    totalDiskMB: number
    freeDiskMB: number
    /*
     * 下面三个是**可选**的：早期调用方（和多数测试注入的假实现）
     * 只给内存/磁盘。渲染层用 `sys?.cpuModel` 这样读，缺了就是
     * "未检测到"，不会崩。
     *
     * `gpuModel` 尤其重要 —— 它本来就没在这个类型里，于是内部定制版
     * 无法通过类型检查把它传出去（而渲染层的 cleanGpu 一直在读它）。
     */
    osVersion?: string
    cpuModel?: string
    gpuModel?: string
  }>
  /**
 * M2 日志系统：操作/崩溃日志 + 导出 zip（未注入时 logs:export 报错而非崩）
 */

  logger?: Pick<Logger, 'log' | 'crash' | 'exportZip'>
  /**
 * M2 内嵌 WebUI：注入以提高可测性
 */

  webui?: {
    open: (id: string, url: string) => Promise<void>
    close: (id: string) => void
    list: () => string[]
    /**
 * 当前正在显示的实例 id（同一时刻只有一个）
 */

    visible?: () => string | undefined
  }
  /**
 * QQ 环境检测（NapCat 是把机器人注入 QQ 运行的，没装 QQ / 版本太低必起不来）。 注入以便单测；未注入时 qq:status 返回「未检测」（不让测试环境误报）。
 */

  qqChecker?: () => QQInfo | Promise<QQInfo>
  /**
 * 启动时的提权判定结果（`already` / `relaunched` / `declined`）。 为什么要传进来：这台软件**核心行为依赖管理员权限**（NapCat 要注入 QQ）。 用户报「NapCat 起不来」时，第一句该问的就是"你是管理员跑的吗"—— 而 `index.ts` 早就算出来了，只是一直没写进任何日志。 现在它会被写进导出包的设备信息里。
 */

  elevateVerdict?: string
  /**
 * 打开外部链接（注入以便单测；缺省用 electron shell）
 */

  openExternal?: (url: string) => void | Promise<void>
  /**
 * 在资源管理器里打开本地目录（注入以便单测；缺省用 electron shell）。 返回空串表示成功，非空是错误信息 —— 和 shell.openPath 的约定一致。
 */

  openPath?: (path: string) => Promise<string>
  /**
 * 操作审计：用户和软件的每个动作都留一条痕（logs/audit-<日期>.log）。 缺省不记，测试环境不受影响。
 */

  audit?: AuditLog
  /**
 * 「目前在用的数据根变了」的回调。 由 registerIpcHandlersReal 注入（更新 liveDataRoot，供托盘 getConfig 用）； 测试不注入也不影响任何行为。 触发点：config:set 成功落盘、config:moveDataRoot 迁移完成。
 */

  onDataRootChanged?: (dataRoot: string) => void
  /**
 * 启动器自身更新：拉更新清单（返回 JSON 文本）。 未注入时 app:checkUpdate 会抛错，上层据此显示「已是最新版本」—— 这正是用户要求的失败表现（取版本失败就当最新版，不打扰）。
 */

  fetchUpdateManifest?: (url: string) => Promise<string>
  /**
 * 下载全量包到 outPath，返回字节数；未注入时报错（不静默）
 */

  fetchUpdateToFile?: (
    url: string,
    outPath: string,
    onProgress?: (got: number, total?: number) => void
  ) => Promise<number>
  /**
 * 更新清单地址（缺省用发布地址下的 latest.json）
 */

  updateManifestUrl?: string
  /**
 * 当前启动器版本号（生产传 app.getVersion()）。 允许返回 Promise：生产实现要 `await import('electron')` 懒取 app （顶层不能 import electron，单测跑在纯 node 下）。
 */

  appVersion?: () => string | Promise<string>
  /**
 * 系统默认下载目录（生产传 app.getPath('downloads')），同样允许异步
 */

  downloadsDir?: () => string | Promise<string>
  /**
 * 更新进度推给渲染层
 */

  sendUpdateProgress?: (p: { percent: number; got: number; total?: number }) => void
  /**
 * 当前时间（注入以便测「一天推一次」）
 */

  now?: () => number
  /**
 * 版本目录的 fetchJson 注入点。 为什么需要：`instance:update` 要"找出最新版"，那要问版本目录（走网络）。 单测不能真联网 —— 既慢又不稳定（源不可达时测试会红，而不是被测代码错）。 注入它就能把"有哪些版本"这件事固定下来，专测更新逻辑本身。 生产不注入（走 defaultFetchJson 的真实实现）。
 */

  fetchVersionJson?: (url: string) => Promise<string>
  /**
 * 应用内自更新（electron-updater 封装）。 生产在打包态注入；测试/开发不注入 → 走手写路径。 它的存在只影响"检查"与"下载"的实现，**不改变**主人的硬约束： 只下载，绝不自动安装（见 update/app-updater.ts 的说明）。
 */

  appUpdater?: import('./update/app-updater').AppUpdater
  /**
 * 上次运行是否异常退出（由主进程启动流程判定并注入； 见 util/crash-logs.ts 的 running.lock）。测试不注入 → 恒为"正常"。
 */

  lastCrash?: () => { crashed: boolean; startedAt?: number }}type HandlerFn<TArgs extends unknown[] = unknown[]> = (...args: TArgs) => unknown/**
 * 退出清理入口挂在 handler 表上的键。 为什么用 Symbol 而不是普通字符串键： 它是**给主进程自己调的**，绝不能变成渲染层能 invoke 的通道。 `registerIpcHandlersReal` 用 `Object.entries` 注册通道，而 `Object.entries` **不遍历 Symbol 键* —— 所以放这儿天然不可达， 同时单测又能从 buildHandlers 的返回值上直接取到它来验证行为。
 */
export const EXIT_CLEANUP = Symbol('mxbot.exitCleanup')
export type HandlerMap = {
  'app:ping': HandlerFn<[]>
  'config:get': HandlerFn<[]>
  'config:set': HandlerFn<[Partial<AppConfig>]>
  'instance:list': HandlerFn<[]>
  'instance:create': HandlerFn<
    [{ type: InstanceType; name: string; port?: number; tag?: string; qqAccount?: string }]
  >
  'instance:start': HandlerFn<[string]>
  'instance:stop': HandlerFn<[string]>
  'instance:remove': HandlerFn<[string]>
  'stats:overview': HandlerFn<[]>
  'webui:open': HandlerFn<[string]>
  'webui:close': HandlerFn<[string]>
  'webui:list': HandlerFn<[]>
  /**
 * 当前正在显示的 WebUI 属于哪个实例（同一时刻只有一个）
 */

  'webui:visible': HandlerFn<[]>
  'qq:status': HandlerFn<[]>
  'app:openExternal': HandlerFn<[string]>
  /**
 * app:autostart:status / app:autostart:set 已随「开机自启」功能一起移除
 */

  'instance:creds': HandlerFn<[string]>
  'instance:resetCreds': HandlerFn<[string]>
  'instance:log': HandlerFn<[string]>
  'backup:make': HandlerFn<[string]>
  'backup:list': HandlerFn<[]>
  'backup:openFolder': HandlerFn<[string]>
  /**
 * 读操作审计日志（给界面展示「谁在什么时候干了什么」）
 */

  'audit:read': HandlerFn<[string?]>
  /**
 * 已有哪些天的审计
 */

  'audit:days': HandlerFn<[]>
  'backup:del': HandlerFn<[string]>
  'backup:restore': HandlerFn<[{ instanceId: string; file: string }]>
  /**
 * 覆盖更新时安装器自动打的整库备份（只读列表，供界面展示与取用）
 */

  'backup:updateList': HandlerFn<[]>
  'mirrors:test': HandlerFn<[]>
  'mirrors:state': HandlerFn<[]>
  'mirrors:add': HandlerFn<[{ label: string; base: string; mode?: 'proxy' | 'files' }]>
  'mirrors:remove': HandlerFn<[string]>
  'mirrors:pref': HandlerFn<[{ a?: string; n?: string }]>
  /**
 * AstrBot 的 Python 源（pip 索引）—— 与上面的 GitHub 代理源完全分开
 */

  'pysrc:state': HandlerFn<[]>
  'pysrc:pref': HandlerFn<[string]>
  /**
 * Python 源的测速与可用性（与 mirrors:test 对称）
 */

  'pysrc:test': HandlerFn<[]>
  'pysrc:add': HandlerFn<[{ label?: string; indexUrl: string; jsonApi?: string }]>
  'pysrc:remove': HandlerFn<[string]>
  'versions:list': HandlerFn<[{ type: 'a' | 'n'; base?: string; includePrerelease?: boolean; noCache?: boolean }]>
  /**
 * 启动时静默预热版本缓存（不阻塞界面，失败也不报错）
 */

  'versions:prewarm': HandlerFn<[]>
  'runtime:install': HandlerFn<[{ type: 'a' | 'n'; tag: string; base?: string }]>
  'runtimes:list': HandlerFn<[]>
  'runtimes:remove': HandlerFn<[{ type: 'a' | 'n'; tag: string }]>
  /**
 * 手动导入：弹文件选择框挑压缩包
 */

  'runtimes:pickFile': HandlerFn<[]>
  /**
 * 手动导入：只探不装（识别类型+版本、算哈希），让用户先确认
 */

  'runtimes:probeFile': HandlerFn<[string]>
  /**
 * 手动导入：确认后真正安装
 */

  'runtimes:importFile': HandlerFn<[{ type: 'a' | 'n'; file: string; version?: string }]>
  'templates:download': HandlerFn<['a' | 'n']>
  /**
 * 'instance:update' 的类型条目删掉了 —— 它的实现早已被 instance:setRuntime 取代。 留着一个没有实现的类型条目，等于给下一个调用者准备了一个「编译能过、 运行时才是 undefined」的陷阱（preload 里也确实还挂着这个通道）。
 */

  /**
 * 切换实例的运行时版本（「高版本覆盖低版本」）。 只改 instance.json 里的指针，实例数据/配置天然保留。
 */

  'instance:setRuntime': HandlerFn<[{ id: string; tag: string; type: 'a' | 'n' }]>
  /**
 * 「手动更新」：把实例升级到某类运行时的**最新版**。 返回 `{ updated, from, to, reason }`： updated=false 时 reason 说明为什么没更新（已是最新 / 没有可用版本 / 实例在运行…） 为什么要单独一个通道，而不是让界面"先装再切"： · 判"什么是最新版"要用版本目录（含预发布处理），界面拿不到这个知识 · 装完再切这两步之间不能让实例被启动 —— 必须由主进程一口气做完 · 「实例运行时不许更新」这条约束必须由主进程把关（界面可以被绕过）
 */

  'instance:update': HandlerFn<[{ id: string }]>
  'templates:status': HandlerFn<[]>
  'logs:export': HandlerFn<[]>
  /** 查询"是否正在导出"—— 给界面恢复「正在打包…」状态用（见 handler 上的说明） */
  'logs:exportBusy': HandlerFn<[]>
  /**
   * 当前还在进行中的下载/安装任务 —— 给界面**切回页面时恢复进度条**。
   *
   * 进度原来只活在下载页组件的 ref 里，切走页面就全丢
   *（主人实测：「切到其他页面再回来，顶部的下载进度就消失了」）。
   * 现在主进程维护快照（见 liveDownloads），界面挂载时问一次即可恢复。
   */
  'download:sessions': HandlerFn<[]>
  /**
   * **取消**一个正在进行的安装/导入任务。
   *
   * 主人 2026-09-27：「安装/下载一个加入取消，防止卡住了只能重启软件
   * 来换更快的安装/下载源」。
   *
   * 取消会中断该任务的 HTTP 下载与 pip 子进程（含它派生的编译进程），
   * 并清掉它的暂存目录 —— 用户随后可以换个源重来，**不用重启软件**。
   */
  'runtimes:cancel': HandlerFn<[{ type: 'a' | 'n'; tag: string }]>
  /**
 * 在资源管理器里定位一个已存在的文件（更新包下载完后跳过去）
 */

  'shell:showItem': HandlerFn<[string]>
  'config:moveDataRoot': HandlerFn<[string]>
  /**
 * 数据目录搬家的实时状态（设置页轮询）。 为什么要单独一个通道：关闭设置页**不会**取消主进程里的复制 （半途取消会留下残缺目标，这是刻意的）—— 所以界面必须能重新 看到"还在搬"，而不是卸载组件就把状态丢了。 返回 `{ active, startedAt }`；startedAt 用于显示"已经搬了多久"。
 */

  'config:moving': HandlerFn<[]>
  'dialog:pickDataDir': HandlerFn<[]>
  'window:minimize': HandlerFn<[]>
  'window:toggleMaximize': HandlerFn<[]>
  'window:close': HandlerFn<[]>
  /**
 * ---------- 启动器自身更新（不是 AstrBot/NapCat 的运行时版本） ----------
 */

  /**
 * 当前启动器版本号
 */

  'app:version': HandlerFn<[]>
  /**
 * 上次是否异常退出 → 渲染层据此提示"导出诊断日志"。 返回 `{ crashed, startedAt? }`（startedAt = 上次启动时刻）。
 */

  'app:lastCrash': HandlerFn<[]>
  /**
 * 检查更新（手动点「检查更新」/ 启动时自动都可调）
 */

  'app:checkUpdate': HandlerFn<[{ force?: boolean }?]>
  /**
 * 下载全量包到系统默认下载目录，返回落盘路径
 */

  'app:downloadUpdate': HandlerFn<[{ url: string; version: string; sha256?: string }]>
  /**
 * 跳过某个版本（只对该版本有效）
 */

  'app:skipVersion': HandlerFn<[string]>} & Record<string, HandlerFn>/**
 * 默认配置。 这些数字**必须**引用 constants.ts，不能在这里重写一遍字面量 —— 之前就是硬写的 `portMin: 6100, portMax: 6199, backupKeep: 5`， 与 constants.ts 里的 PORT_RANGE_A / BACKUP_KEEP_DEFAULT 各是一份独立的真相。 那种重复不会报错，但改了一处忘了另一处时， 「端口段」和「备份保留几份」就会静默不一致，而且极难察觉。 （同时 BACKUP_KEEP_DEFAULT 也就成了没人用的死常量。）
 */
const DEFAULTS: Omit<AppConfig, 'dataRoot'> = {
  portMin: PORT_RANGE_A.min,
  portMax: PORT_RANGE_A.max,
  backupKeep: BACKUP_KEEP_DEFAULT
  /**
 * 这里**故意不设 closePolicy**。 需求反复过两次，写清楚免得再绕回去： 1. 最初：undefined → 首次点 ✕ 弹窗问「缩到托盘还是直接退出」 2. 中途一份报告要求「都默认托盘、不要询问」→ 于是这里写死 'tray' 3. 现在用户又明确要求把询问加回来： 「为什么第一次点 X 关闭软件界面的时候不询问用户是托盘还是真的关闭」 关键在于：**只要这里写了 closePolicy，询问就永远不会发生* —— 因为 config:set 会把 DEFAULTS 铺开写进配置，于是任何一次保存 （哪怕是改端口）都会把 closePolicy 填成 'tray'， 关闭流程就再也看不到 undefined，那个「问一次」的分支成了死代码。 这正是第 2 阶段那个"看起来加了、实际从不触发"的坑。 所以：**让 closePolicy 保持 undefined 直到用户真的选过一次**。 DEFAULTS 只放真正有合理默认值的项（端口段、备份份数）。
 */
}
export function buildHandlers(opts: HandlerOpts): HandlerMap {
  const pm = opts.processManager ?? createProcessManager()
  const commandFor = opts.commandFor
  // 必须从 opts 解构出来：直接用裸变量名会 ReferenceError
  // （之前 resetCredentials 就是这么漏的——功能整个不可用还查不出原因）

  const openExternal = opts.openExternal
  // 打开本地文件夹。缺省走 electron 的 shell.openPath（成功返回空串，失败返回错误文案）。
  // 不在模块顶层 import electron：单测环境跑不了它，所以用动态 import。

  const openPath =
    opts.openPath ??
    (async (p: string) => {
      const { shell } = await import('electron')
      return await shell.openPath(p)
    })
  let config: AppConfig | undefined
  let repo: InstanceRepo | undefined
  /**
 * 正在启动中的实例 id（`instance:start` 的重入守卫，见那里的说明）。 为什么放在这个作用域而不是 handler 局部：**跨调用共享* —— 两次并发的 `instance:start` 是两个独立的 async 调用， 只有模块级的集合才能让它们互相看见。 用 Set 而不是计数器：id 是唯一键，重复添加天然幂等； 而"启动中"本来就只是个布尔语义（一个实例不可能同时启动两次）。
 */

  const startingIds = new Set<string>()
  /**
 * 检查更新，**永不抛错**。 用户要求：「如果从服务器获取版本失败则显示最新版」。 所以任何失败（网络不通、服务器挂了、清单是坏 JSON）都收敛成 hasUpdate:false —— 界面上就是「已是最新版本」，不打扰用户。 但会往日志里记一笔：界面上不打扰，排查问题时不能什么都没有。
 */

  const safeCheck = async (current: string): Promise<AppUpdateCheck> => {
    /**
 * ★★ 多加速源**并发测速**后按速度回落（主人 2026-10-08）
 *
 * ## 这一处原来的 bug（主人实测「明明有 1.0.0，却显示已是最新版本啦」）
 *
 * 我换了 GitHub 源、也写好了 `manifestUrls()`（会展开成 gh-proxy /
 * ghfast / ghproxy.net … 加直链），但**这里是拿旧常量拼 url 的**：
 *
 *     MX_OFFICIAL_BASES.map((b) => `${b}latest.json`)
 *
 * 而 `MX_OFFICIAL_BASES` 是兼容旧代码的别名，**只有一个直链** ——
 * 于是六个加速源一个都没用上。
 *
 * 日志实据（用户机器）：
 *     [WARN] 检查更新：源 https://raw.githubusercontent.com/...
 *            main/latest.json 失败，换下一个源试试（fetch failed）
 * 试完就没了 —— 而"检查失败=按最新版处理"意味着**静默失效**：
 * 用户看到「已是最新版本啦」，其实源根本没读到。
 *
 * ## 为什么直链在国内必然失败
 *
 * 我实测过：raw.githubusercontent.com **超时**，
 * 而 gh-proxy 2.8s、ghproxy.net 1.2s 都能通。
 * 只配直链 = 所有国内用户都查不到更新。
 *
 * ## 现在
 *
 * `manifestUrls()` 给出全部候选（加速源 + 直链兜底），逐个尝试。
 * 顺序上把加速源排前面，直链放最后（它最慢但最不依赖第三方）。
 *
 * 测试注入 `updateManifestUrl` 时**只试那一个**（保持既有测试语义）。
 */

    const injected = opts.updateManifestUrl
    const urls = injected ? [injected] : manifestUrls().map((m) => m.url)
    if (!urls.length || !opts.fetchUpdateManifest) {
      return { hasUpdate: false, currentVersion: current }
    }
    let lastErr: unknown
    for (const url of urls) {
      try {
        return await checkAppUpdate({
          currentVersion: current,
          manifestUrl: url,
          fetchJson: opts.fetchUpdateManifest
        })
      } catch (e) {
        lastErr = e
        opts.logger?.log(
          'WARN',
          'app',
          `检查更新：源 ${url} 失败，换下一个源试试（${            e instanceof Error ? e.message : String(e)          }）`
        )
      }
    }
    /**
 * 全部源都失败 → 按用户要求收敛成「已是最新」（不打扰）， 但日志里必须留下"所有源都不通"这个事实。
 */

    opts.logger?.log(
      'WARN',
      'app',
      `检查更新失败（${urls.length} 个源都不可用，按最新版处理）：${        lastErr instanceof Error ? lastErr.message : String(lastErr)      }`
    )
    return { hasUpdate: false, currentVersion: current }
  }
  /**
 * 退出软件时**把跑着的实例全部收干净**。 ## 为什么不能只调 pm.killAllSync() process-manager 只知道我们 spawn 出来的那棵进程树。而 NapCat 是 **注入进 QQ.exe* 跑的：注入器干完活就退出，真正干活的 QQ 早已脱离 我们的父子链，`taskkill /T` 按父子关系递归**杀不到它**。 这正是一类很难自察的泄漏：用户点托盘「退出（停止全部实例）」、 或关闭策略选「直接退出」，软件窗口没了，但 NapCat 还在后台连着 QQ —— 端口占着、机器人还在收发消息，用户以为关掉了。 下次再启动时那个端口还被占着，新实例分到别的端口， 而旧的还在跑，看起来就像"多出来一个我控制不了的实例"。 所以退出时补一道**按端口精确清理**：端口是每个实例的身份 （端口段按类型分配），拿它找 listener 再杀，不会误伤用户自己开的 QQ。 全部同步执行 —— 已经在退出路径上了，没有 await 的机会， 而且必须赶在事件循环被拆掉之前做完。
 */

  function killEverythingForExit(): void {
    // 1) 先按端口把「脱离进程树的」（NapCat 注入的 QQ）找出来杀掉

    if (repo) {
      for (const rec of repo.list()) {
        try {
          const pid = findListenerPid(rec.port)
          if (pid !== undefined && pid !== process.pid) {
            runSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 8000 })
            opts.logger?.log('INFO', 'app', `退出时清理端口 ${rec.port} 上的进程 pid ${pid}`)
          }
        } catch {
          /**
 * 单个清不掉不影响退出
 */

        }
      }
    }
    // 2) 再收我们自己 spawn 的那棵树（顺序无关，但先收孤儿更稳）

    try {
      pm.killAllSync()
    } catch {
      /**
 * 清理绝不卡死退出
 */

    }
  }
  const state = () => {
    if (!config || !repo) throw new Error('数据根目录未设置（config:set）')
    return { config, repo }
  }
  /**
 * 用端口探活校正实例状态。 不能只信 instances.json 里那个 status —— 它只是「最后一次写下的值」： 1. NapCat 进程已经死了，磁盘还留着「运行中」。 2. 反过来更要命：NapCat 是注入 QQ 运行的，我们 spawn 的 cmd.exe 跑完官方 launcher 脚本就退出了（真正干活的是 QQ 进程里的 NapCat）， process-manager 收到 cmd 的 exit 就把状态标成 stopped， 可 NapCat 明明活着、端口也通。 判据是端口（两类实例都以自己的端口对外服务），但要满足两个前提： - **不是我们刚主动停的**：taskkill 之后端口不会立刻释放（FIN/TIME_WAIT）， 这时探活仍是通的，会把「已停止」误判回「运行中」，用户看到点了停止却还在跑。 - starting 例外：它正在启动中，端口没通是正常的，不该被掰成 stopped。 （注意用 probePort「能连上吗」，不是 allocator 的 probe「端口空闲吗」——语义相反。）
 */

  /**
 * 最近被主动停止的实例：id → 时间戳（这段时间内不信端口探活）
 */

  const justStopped = new Map<string, number>()
  /**
 * 端口释放的宽限期：taskkill 之后内核回收监听需要一点时间
 */

  const STOP_GRACE_MS = 5000
  /**
 * 本进程里**真正启动过**的实例。 这是为了解开一个把两个需求顶在一起的矛盾（下面的判据里详细讲）： A. 端口通 ≠ 这个实例在跑。用户自己另开的一套 QQ/NapCat、残留进程、 不相干的软件占了同号端口，探测都会连上。只看端口会把**从没启动成功* 的实例显示成「运行中」，点 WebUI 才发现什么都没有。 B. NapCat 是**注入 QQ* 跑的：我们 spawn 的注入器进程干完活就退出， 真正干活的是 QQ 里的 NapCat。只看进程管理器，会把一个**明明活着、 WebUI 也能开**的 NapCat 判成「已停止」。 这正是用户报告的那条：「NapCat 明明在运行中，点击 WebUI 却显示未启动」。 单独的 A 或 B 都会踩另一边。两者能同时满足的关键是**区分「这个实例」和「别的进程」**： - 从没成功启动过的实例 → 端口通也**不算**它在跑（解决 A） - 本进程启动过、且已经确认就绪的实例 → 进程句柄没了也**认**端口（解决 B） 存的是「启动成功过」的 id，随进程生命周期存在内存里即可： 软件重启后进程管理器本来就是空的，那时实例也不该显示成运行中 （孤儿状态**只在本进程第一次配置落盘时**归位成 stopped —— 见 config:set）。
 */

  const startedInThisRun = new Set<string>()
  /**
 * 孤儿归位是否已经做过（见 config:set 里的说明）。 为什么放在这里而不用局部变量：config:set 是 handler， 局部变量活不过一次调用。这个标志的生命周期 = **进程**， 与 startedInThisRun 同级。
 */

  let orphanRecoveryDone = false
  /**
 * 正在进行的 runtime:install（键 = `<type>:<tag>`）。 ## 为什么必须有这把锁（四厂商审计确认的 MEDIUM/HIGH） 安装 `pip install astrbot` 要**几分钟**，而下载页的按钮并不是 全程禁用的（进度条在走，但再点一下仍会触发）。 两个并发安装同一个 tag 会： · zip 分支：往同一个 dest 并发解压，**混写文件**（谁也不完整） · pypi 分支：两个暂存目录都能装成，最后 rename 互相顶掉， 而且白跑一遍 pip 几分钟又几十秒的下载 锁的粒度是 `type:tag`：装 v4.28.0 的同时**可以**装 NapCat 的版本， 或另一个 AstrBot tag —— 只拦"同一个版本装两次"。 （这才与"狂点按钮不会起几十个线程"的要求对得上：被拦的那次直接 报错回来，不排队 —— 排队会让这个几分钟的隐式队列越积越多。）
 */

  const pendingInstalls = new Set<string>()
  /**
 * 数据目录搬家是否正在进行（进程级真相，不是设置页的组件变量）。 ## 为什么必须放在主进程（主人 0.1.3 实测抓出的缺陷） 原来"正在搬家"这个状态只存在 SettingsPanel 的组件变量里。主人实测： 1. 点了搬家 → 没等完就关掉设置页 2. 再点进设置 → **又显示成"可以搬"**（状态随组件卸载没了） 3. 而主进程里的复制其实**还在跑**（关闭界面不会取消它，这是对的—— 半途取消会留下残缺目标） → 用户完全不知道有活还在跑，甚至可能再触发一次。 于是搬运中再触发第二次 = 两份复制同时往同一目标写： 文件交错，目的地变成"半新半旧"的混合体（粘贴数据这种事最怕这个）。 修法：状态提到这里（生命周期 = 进程）， · 第二次触发直接拒绝并说明原因 · 设置页通过 config:moving 轮询，重进能看到"还在搬" · finally 无条件复位，绝不留下"永远搬家失败"的死状态
 */

  let relocateActive = false
  /**
 * 搬家开始时刻（给界面算"已经搬了多久"，也是"真的在动"的证据）
 */

  let relocateStartedAt = 0
  /**
 * 上一次搬家的**结果**（也是进程级）。 ## 为什么结果也要提到主进程（审计抓出的真问题） 0.1.3 已经把"进行中"这个状态提到主进程了，但**结果**（哪几项没搬过去） 还留在设置页组件的 ref 里。而设置页在搬家成功后会 emit('moved') → 父组件立刻 `settingsOpen = false` → 面板 v-if 卸载 —— 于是"搬完啦，有 N 项失败"这句提示**根本没机会显示**； 用户若照提示关掉设置页再进来，也只会看到"没在搬"。 而失败项恰恰是最需要被看见的东西（那些实例在新根可能起不来）。 所以：结果与进行中一样托管在这里，由 config:moving 一并返回， 设置页重进时还能看到。
 */

  let lastRelocate: { at: number; failed: Array<{ item: string; reason: string }>; to: string } | undefined
  /**
 * 探活结果缓存 —— 这是「整个软件各种互动都卡」的主要根因，别删。 界面每 2 秒调一次 stats:overview 刷新资源占用，而那个 handler 会对**每个实例* 做一次 TCP 探活（probePort 超时 1.2 秒）。实例一多，主进程几乎一直在等网络， 它是单线程的：等的时候其他 IPC（删除、加载列表、开 WebUI）全排队 —— 用户感觉就是「点什么都卡」「删个文件无响应」。 但状态根本不需要 2 秒级别的实时性：端口从通到不通，用户感知的粒度是秒级偏上。 所以这里按 TTL 缓存探活结果，TTL 内重复查询直接用缓存， 把「每 2 秒 × N 个实例 × 最多 1.2 秒」压成「每 TTL 秒 × N 个实例」。 注意：**只在探活路径上用**。用户主动点启动/停止后，对应条目要立刻失效， 否则界面会停在旧状态上（见 invalidateProbeCache 的调用点）。
 */

  const probeCache = new Map<string, { at: number; rec: InstanceRecord }>()
  const PROBE_TTL_MS = 7000
  /**
 * 主动动作（启动/停止/改配置）后让缓存立刻失效，下次查询重新探
 */

  function invalidateProbeCache(id?: string): void {
    if (id === undefined) probeCache.clear()
    else probeCache.delete(id)
  }
  async function liveStatusOf(rec: InstanceRecord): Promise<InstanceRecord> {
    if (rec.status === 'starting') return rec
    // 刚主动停过：这段宽限期内以「已停止」为准，别被还没释放的端口带偏

    const stoppedAt = justStopped.get(rec.id)
    if (stoppedAt !== undefined) {
      /**
 * 用户主动停过 → 这个实例不再算「本进程里启动成功的运行实例」。 放在这里而不是每个 justStopped.set 旁边：所有主动停止路径 （停止/删除/备份前先停/切版本先停…）最后都会经过这里， 收口一处就不会漏。不这么做的话，停了之后万一有别的东西 后来占了同一个端口，会被误判回「运行中」。
 */

      startedInThisRun.delete(rec.id)
      if (Date.now() - stoppedAt < STOP_GRACE_MS) {
        if (rec.status !== 'stopped') {
          repo!.updateStatus(rec.id, 'stopped')
          return { ...rec, status: 'stopped' }
        }
        return rec
      }
      justStopped.delete(rec.id)
    }
    // 缓存命中：TTL 内不重复探（这是把「每 2 秒全量探活」压下去的关键）

    const hit = probeCache.get(rec.id)
    if (hit && Date.now() - hit.at < PROBE_TTL_MS && hit.rec.status === rec.status) return rec
    /**
 * 状态判据：**先问进程管理器，再信端口探测**，但给 NapCat 的注入模式留口子。 两个需求互相顶： A（进程优先）：端口是**共享资源**。任何别的程序（用户自己另开的一套 QQ/NapCat、上一个还没退干净的残留进程、甚至碰巧用同号端口的 无关软件）占着这个端口，探测就连得上，于是**一个从没启动成功的 实例被显示成「运行中」**。 这个 bug 是跑 ipc-handlers 的用例时暴露的：QQ 检查拒绝了启动 （明明抛错了），列表里状态却是 running —— 因为那台机器上真有东西在监听 6200。 B（端口优先）：NapCat 是**注入 QQ* 跑的。我们 spawn 的注入器进程 干完活就退出，真正干活的是 QQ 里的 NapCat，process-manager 收到 exit 就把状态标成 stopped —— 可 NapCat 明明活着、端口也通。 这正是用户报告的那条：「NapCat 明明在运行中，点击 WebUI 却显示未启动」。 两者都要满足，关键是把「这个实例」和「别的进程」区分开： - **从没在本进程里启动成功过* → 端口通也不算它跑着（满足 A） - **本进程启动过并已确认就绪* → 句柄没了也认端口（满足 B） 注意 `startedInThisRun` 只在**启动确实成功**之后才加（见 instance:start 里 updateStatus(id,'running') 旁边），不是 spawn 一出就加 —— 否则启动失败的实例 也会被认成「启动过」，A 又漏了。
 */

    const procStatus = pm.statusOf(rec.id)
    const procAlive = procStatus === 'running'
    const startedHere = startedInThisRun.has(rec.id)
    /**
 * ★ 端口探测超时从 1200ms 降到 300ms（主人 2026-09-27：「删除会卡住主进程」） 日志实测： [ERROR] [perf] IPC runtimes:remove 耗时 3252ms（严重） [WARN] [perf] 主进程事件循环疑似被同步代码阻塞：… 3232ms … `runtimes:remove` 会对**该类型的每个实例**调这个函数（见那里的 `Promise.all(bound.map(liveStatusOf))`），于是 N 个实例 = N 个并发的 1200ms TCP 等待。用户有二十来个实例时，一次删除要等： · 探测窗口本身（1200ms） · 加上删目录的时间 而这一切都压在主进程上，界面就"卡住"。 为什么 300ms 够：这是**本机回环**（127.0.0.1）探测， 一个已经 listen 的端口在本地是**微秒级**就能连上的 —— 需要 1.2 秒才连上的情况，现实中只有"对端很忙/防火墙丢包"， 而那本来就会被判成"没在跑"。真正的远程探测才需要长超时。 保守起见仍留 300ms（不是 50ms）：给繁忙机器上偶发的调度抖动留余量， 避免把"其实在跑"误判成"没跑"—— 那个方向的错误更严重 （会把运行中的实例当成已停止，用户以为可以删它的运行时）。
 */

    const live = await probePort(rec.port, 300)
    /**
 * 三种情况： 1. 进程在跑 + 端口通 → running（正常） 2. 进程在跑 + 端口不通 → stopped（进程活着但服务没起来） 3. 进程不在：本进程启动成功过 → 认端口（NapCat 注入模式）； 否则 → stopped（那是别人的端口）
 */

    const next: typeof rec.status = procAlive
      ? live
        ? 'running'
        : 'stopped'
      : startedHere && live
        ? 'running'
        : 'stopped'
    if (rec.status !== next) {
      // 顺带修正磁盘，下次开软件读到的也是对的      repo!.updateStatus(rec.id, next)

      const fixed = { ...rec, status: next }
      probeCache.set(rec.id, { at: Date.now(), rec: fixed })
      return fixed
    }
    probeCache.set(rec.id, { at: Date.now(), rec })
    return rec
  }
  /**
 * NapCat 实例的日志轮询器：id → collector。 NapCat 被注入 QQ 后日志不走我们的管道，只能从它的 WebUI 拉（见 proc/napcat-log.ts）。 实例停止时要把对应的一起停掉。
 */

  const napcatLoggers = new Map<string, { stop: () => void }>()
  /**
 * 注意这里是**赋值**，不是 return。 踩过的坑：原本写的是 `return { ... } as unknown as HandlerMap`， 于是下面那整段「统一审计」包装代码（约 80 行）**永远执行不到* —— TypeScript 不报错、createAuditLog 的单元测试也全绿， 但功能完全没生效：磁盘上一条审计记录都不会出现。 这个 bug 是靠"走真 handler 链路、断言磁盘上真有审计行"的集成测试抓出来的 （tests/unit/audit-wired.spec.ts）—— 只测模块本身永远发现不了。
 */

  /**
 * 正在进行的日志导出（防重入，见 logs:export 里的说明）。 用 Promise 而不是 boolean：连点的第二次请求直接**复用同一个结果**， 而不是"被告知正在导"（后者用户还是拿不到包，只会更疑惑）。
 */

  let exportInFlight: Promise<string> | undefined
  const handlers = {
    'app:ping': () => 'pong',
    'window:minimize': async () => {
      const { BrowserWindow } = await import('electron')
      BrowserWindow.getAllWindows()[0]?.minimize()
    },
    'window:toggleMaximize': async () => {
      const { BrowserWindow } = await import('electron')
      const w = BrowserWindow.getAllWindows()[0]
      if (!w) return
      if (w.isMaximized()) w.unmaximize()
      else w.maximize()
    },
    'window:close': async () => {
      const { BrowserWindow } = await import('electron')
      BrowserWindow.getAllWindows()[0]?.close()
    },
    'dialog:pickDataDir': async () => {
      const { dialog } = await import('electron')
      const res = await dialog.showOpenDialog({
        title: '选择数据存放文件夹',
        properties: ['openDirectory', 'createDirectory']
      })
      return res.canceled ? null : res.filePaths[0]
    },
    'paths:defaults': async () => {
      // 与 defaultDataRoot 同一规则：打包=安装目录旁 data\；dev=项目根 data\

      const base = await defaultDataRoot()
      return {
        homeDataRoot: join(os.homedir(), 'AstriaX'),
        appDataRoot: base.replace(/\\$/, '')
      }
    },
    /**
 * config:get 永远返回一个**对象**，绝不返回 undefined。 踩过的坑（用户报告「读取配置失败：Cannot read properties of undefined (reading 'dataRoot')」+「镜像源怎么全消失了」+「数据目录（未设置）」）： 这三条是**同一个根因的三种表现**。 全新安装时 data\config.json 不存在 → 启动时的 readAppConfig 返回 undefined → 没有调 config:set → 这里的 config 一直是 undefined。 于是： - 渲染层 cfg.dataRoot 抛 TypeError（「读取配置失败」） - mirrors:state 读 cfg.dataRoot 抛错 → 列表空（「镜像源全消失」） - 设置页拿不到 dataRoot（「数据目录（未设置）」） 返回空对象之后，渲染层能正常判断「还没配过数据目录」并显示首启向导； 依赖 dataRoot 的 handler 仍会各自抛出**说得清楚**的错误（由 state() 负责）， 而不是让调用方在半路撞上 TypeError。
 */

    'config:get': () => (config ?? {}) as unknown,
    'config:set': (patch) => {
      /**
 * 还没有 dataRoot 时，只接受**带着 dataRoot 来的* patch。 踩过的坑（我自己引入的）：原来这里给了一个兜底 `dataRoot: patch.dataRoot ?? join(process.cwd(), 'acb-data')`， 本意是「万不得已别崩」，实际后果很脏： 启动时 `app:checkUpdate` 会调 `config:set({lastUpdateCheckAt})` （见下面的「一天推一次」节流），而首启向导还没跑过 —— 于是这个不带 dataRoot 的 patch 命中了兜底， 在**进程当前目录**下建出一个 `acb-data\`，把假路径写进真正的 config.json，并把仓库指过去。用户下次进设置会看到一个 自己从没选过的数据目录，而真实数据目录被忘掉了。 （`process.cwd()` 对打包后的程序尤其没意义：双击图标启动时 它可能是 C:\Windows\System32 或用户桌面。） 正确行为是**明确拒绝**：调用方（首启向导 / 设置页）必须先给出 数据目录。上层已经各自处理了这个错误（checkUpdate 里 try/catch、 向导本就要用户选目录），不会因此卡住用户。
 */

      if (!config && !patch.dataRoot) {
        throw new Error('数据目录还没设置——先在首启向导里选一个目录')
      }
      const base: AppConfig = config ?? ({ ...DEFAULTS, dataRoot: patch.dataRoot } as AppConfig)
      config = { ...base, ...patch }
      mkdirSync(config.dataRoot, { recursive: true })
      const f = join(config.dataRoot, 'config.json')
      const tmp = `${f}.${randomBytes(4).toString('hex')}.tmp`
      writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
      renameSync(tmp, f)
      /**
 * 数据根变了（或第一次设置）才需要重建仓库 —— 注意这行本身必须 在"孤儿归位"的判定之前先算好，因为旧 config 可能还是 undefined。
 */

      const rootChanged = config?.dataRoot !== base.dataRoot
      repo = createInstanceRepo({ dataRoot: config.dataRoot })
      /**
 * ★ 重启恢复：**每次都跑的问题**（四厂商审计确认的 HIGH） 「PM 只活在内存里，instances.json 里的 running/starting 都是孤儿， 归位 stopped」—— 这段本意是**进程重启后**把上次遗留的假状态清掉。 但它原来写在 config:set 里**无条件执行**，而 config:set 同时是 运行期的通用配置写入口。于是： · app:checkUpdate 的节流到期 → config:set({lastUpdateCheckAt}) · 用户改关窗策略 → config:set({closePolicy}) · 设置页保存任何一项 这些跟实例毫无关系的调用，都会把**正在运行**的实例在盘上改成 stopped。而 instance:setRuntime / resetCreds / backup:make / backup:restore 等一批 handler 用的正是这个盘上 status 判活 —— 结果就是"进程还跑着、账面已停止"，接下来发生什么都很糟 （备份半写数据、重置被旧进程写回、切版本撞上占用的文件……）。 修法（改动最小、语义不变）：这段逻辑**只在两种时机**有意义—— 1. 本进程第一次设置 dataRoot（= 启动恢复，真正清理"上次崩了"的孤儿） 2. 数据根被切换（新根的 instances.json 是另一份磁盘状态） 其余的 config:set 调用一律**不再动**实例状态。
 */

      if (!orphanRecoveryDone || rootChanged) {
        orphanRecoveryDone = true
        for (const r of repo.list()) {
          if (r.status === 'running' || r.status === 'starting') repo.updateStatus(r.id, 'stopped')
        }
      }
      recordDataRootForUninstall(config.dataRoot)
      /**
 * 记下「当前数据目录」的指针文件（安装目录旁的 data-root.txt）。 不做这件事的后果：用户迁移数据目录后重启，启动时读的还是 <安装目录>\data\config.json（那份还写着旧路径），于是「迁移完又回去了」； 若用户听了提示把旧目录删掉，就变成每次启动都弹首启向导。 刻意不 await：这是辅助信息，写不进去也不该拖慢保存配置。
 */

      void rememberDataRoot(config.dataRoot).catch(() => undefined)
      // 通知外层「现在真正在用的根是这个」——托盘读配置、垃圾清理都依赖它

      opts.onDataRootChanged?.(config.dataRoot)
    },
    /**
 * 搬家状态查询（设置页轮询；纯读取，绝无副作用）。 关闭设置页不会取消搬家（刻意）—— 所以状态必须由主进程托管， 界面重进时能立刻看到"还在搬、已经搬了 N 秒"。
 */

    'config:moving': () => ({
      active: relocateActive,
      startedAt: relocateStartedAt,
      /**
 * 上一次的结果也带上：设置页在搬家成功后会被父组件立刻卸载 （emit('moved') → settingsOpen=false），失败清单必须在**重进时* 仍然拿得到，否则那几项失败会永远没人看见。
 */

      last: lastRelocate
    }),
    'config:moveDataRoot': async (target: string) => {
      const cfg = state().config
      const r = state().repo
      /**
 * ★ 防重入（见 relocateActive 的说明） 静默的并行搬家是最糟的一种：两份复制交错写同一目标， 用户看到的却是"两次都成功"。宁可拒绝并说清楚。
 */

      if (relocateActive) {
        throw new Error(
          '上一次数据目录搬家还在进行中哦。设置页会显示它的进度，' +
            '等它搬完再试 —— 中途并行再来一次会把文件交错写坏。'
        )
      }
      relocateActive = true
      relocateStartedAt = Date.now()
      // 关键操作标记：搬家是最重的数据操作，崩溃时必须知道"死在搬家里面"

      opStart(opts.logger, 'moveDataRoot', `→ ${target}`)
      try {
      /**
 * 迁移前停掉所有运行中的实例 —— **并且要真的停干净**。 这里原来是 `pm.killTreeSync(rec.id)` 就算完，和 instance:stop 比少了 两件关键的事（按端口补杀 + 等端口释放）。后果很具体： NapCat 是**注入进 QQ.exe* 跑的，QQ 起来后就脱离了我们 spawn 的 父子链，`taskkill /T` 按父子关系递归，**杀不到它**。 （instance:stop 里为此写了整整 30 行注释和一段按端口补杀。） 于是：这里以为停了，紧接着 relocate 开始 cpSync runtimes\， 而 QQ/NapCat 正占着里面的 sqlite .db-wal、.pyd 等文件 → 复制失败。 原来那种失败被 relocate 的 `catch {}` 静默吞掉，结果就是 **「迁移显示成功，新根里的运行时却是残缺的」**， 用户在新根启动实例报「运行时结构不对」，怎么也想不到是迁移没搬全。 按端口补杀是安全的：端口段按实例类型分配，这个端口就是该实例的身份， 不会误伤用户自己开的 QQ（用户自己的 QQ 不监听 6100-6299）。
 */

      for (const rec of r.list()) {
        /**
 * ★ 判活用**活体探测**，不再读磁盘上的 status 字段 主人的实测（0.1.2 日志）：两个实例 08:00/08:01 明明启动着， 08:36 点搬家却直接开搬 —— 一条"停止实例"的记录都没有， 于是 QQ/NapCat 一边往旧根写 .db-wal，一边被复制走， 目标根里那份是**半新半旧**的。 病因是审计早就点过的那批"读盘上 status 判活"的调用点之一： 磁盘字段可能被 config:set 的重启恢复归位、或与真实进程脱节。 instance:update 已经统一改成 liveStatusOf + pm.statusOf， 这里（以及所有迁移守卫）必须同款 —— 判活只有一个口径。
 */

        const liveRec = await liveStatusOf(rec)
        const rawProc = pm.statusOf(rec.id)
        const busy = ['running', 'starting']
        if (busy.includes(liveRec.status) || busy.includes(rawProc ?? '')) {
          opts.logger?.log(
            'WARN',
            'proc',
            `迁移数据目录：实例「${rec.name}」还在运行，先停掉它再搬（避免复制出半新半旧的数据）`
          )
          napcatLoggers.get(rec.id)?.stop()
          napcatLoggers.delete(rec.id)
          /**
 * 用统一的「彻底停掉」——按端口补杀 + 等端口释放。 只 killTreeSync 的话，NapCat 注入的 QQ 杀不到， 它会占着 runtimes\ 里的文件让下面的复制失败（静默残缺）。
 */

          /*
           * ★ 必须检查返回值 —— 这处**最不能**在没停干净时继续
           *
           * 下面紧接着就是 `relocateDataRoot`（把整个数据目录搬走）。
           * 如果 QQ 还占着 runtimes\ 里的 sqlite .db-wal / .pyd，
           * 复制会失败 → 新根里的运行时是**残缺**的 →
           * 用户在新根启动实例报「运行时结构不对」，而且完全想不到是迁移没搬全。
           * （这正是抽出 stopInstanceHard 的那个历史事故。）
           */
          const stopped = await stopInstanceHard(pm, rec, (m) =>
            opts.logger?.log('WARN', 'proc', `迁移数据目录：${m}`)
          )
          if (!stopped) {
            throw new Error(
              `实例「${rec.name}」没能停下来，所以**没有**开始搬数据。\n` +
                `它还占着运行时目录里的文件，此时复制会得到一份不完整的副本。\n` +
                `请先手动关掉它（或占着端口 ${rec.port} 的程序），再重试迁移。`
            )
          }
          r.updateStatus(rec.id, 'stopped')
          // 和 instance:stop 一样登记宽限期：端口还没回收完，别被探测判回 running

          justStopped.set(rec.id, Date.now())
        }
      }
      /**
 * ★ 迁移现在是**异步**的（改用 fs.promises.cp，主进程不再冻结）—— 这里必须 await：relocated 的清单要在下面的返回里交给用户。 （dataRoot 相关的切配置/写指针都必须等复制真正完成， 不能抢跑。）
 */

      const relocated = await relocateDataRoot(r, { target })
      // 切换 config 与仓库

      const cfgPath = join(target, 'config.json')
      const newCfg = { ...cfg, dataRoot: target } as AppConfig
      const tmp = `${cfgPath}.${randomBytes(4).toString('hex')}.tmp`
      writeFileSync(tmp, JSON.stringify(newCfg, null, 2), 'utf8')
      renameSync(tmp, cfgPath)
      config = newCfg
      repo = createInstanceRepo({ dataRoot: target })
      recordDataRootForUninstall(target)
      opts.onDataRootChanged?.(target)
      /**
 * 更新指针文件 —— **迁移这条路上这个最关键**。 这里是「读哪份 config」的转折点：不写指针的话，迁移后关掉软件再打开， 启动逻辑还会去读 <安装目录>\data\config.json（旧的那份）， 用户就会看到「迁移完重启，实例全没了 / 又让我选数据目录」。 所以这一步要用 await（迁移本来就是个慢操作，多几毫秒无所谓）， 并且写失败要把原因说出来 —— 否则用户下次重启才发现指针没生效， 那时已经没法归因了。
 */

      const pointed = await rememberDataRoot(target)
      if (!pointed) {
        opts.logger?.log(
          'WARN',
          'store',
          `数据目录已迁到 ${target}，但"上次用的目录"指针没写成功——下次启动可能要重新选一次数据目录`
        )
      }
      /**
 * 有东西没搬过去就**如实告诉用户**。 不说的后果：用户在新根启动实例失败，报「运行时结构不对」或 「需要先装好 Python」，而他会以为新根的数据本来就是坏的 —— 完全想不到是刚才那次迁移漏了。这类「静默半成品」最难排查。
 */

      if (relocated.failed.length) {
        const list = relocated.failed.map((f) => `${f.item}（${f.reason}）`).join('；')
        opts.logger?.log('WARN', 'store', `数据目录迁移有 ${relocated.failed.length} 项没搬过去：${list}`)
      }
      /**
 * 结果存进进程级状态：设置页在搬家成功后会立刻被卸载， 失败清单只有在"重进设置页时还能读到"才有机会被用户看见。
 */

      lastRelocate = {
        at: Date.now(),
        to: target,
        // 结构化保留（不要提前拼成字符串）：界面要按 item/reason 分行显示

        failed: relocated.failed.map((f) => ({ item: f.item, reason: f.reason }))
      }
      return {
        movedCount: relocated.moved.length,
        // 界面据此提示；空数组 = 全部搬好

        failed: relocated.failed
      }
      } finally {
        /**
 * 无条件复位（成功/失败/异常都走这里）—— 少了它，一次异常的搬家会让这个软件**永远**拒绝再搬。 同时把"进行中"标记归零，设置页的横幅随之消失。
 */

        relocateActive = false
        relocateStartedAt = 0
        // 结束标记：异常也写（异常另有 ERROR 日志，不该被误判成"卡在搬家"）

        opEnd(opts.logger, 'moveDataRoot')
      }
    },
    // 状态以端口探活为准（见 liveStatusOf 的说明）

    'instance:list': async () => {
      if (!repo) return []
      /**
 * 补上 runtimeTag 再返回。 踩过的坑（子代理审计时挖出来的既存 bug）： 下载页删版本时要点出「有 N 个实例正在用这个版本」， 它的判断是 `i.runtimeTag === tag`（DownloadPage.vue 的 delUsedBy）。 但 InstanceRecord 里**根本没有 runtimeTag 字段* —— 真实的绑定关系存在 <实例目录>\instance.json 里（见 writeInstanceMeta）。 于是那个 filter 恒为空，确认框永远显示「没有实例在使用这个版本」， 用户就会放心删掉一个**正在被实例使用**的运行时。 后端其实算对了（runtimes:remove 用 readInstanceTag 得到 usedBy）， 但它只在**删除之后**才把 usedBy 返回给界面 —— 那时已经晚了。 这里把 tag 一并列出去，让确认框在**删之前**就能说清楚。
 */

      /**
 * store 只建一次（它是按 dataRoot 缓存的，但在这里提出来更直白）。 注意别照抄别的 handler 里 `const store = runtimeStore(...)` —— 那是它们各自内部的局部变量，这个作用域里没有。
 */

      const store = runtimeStore(config!.dataRoot)
      /**
 * 逐条兜错：**一条坏记录不许把整份列表带崩**。 `Promise.all` 是「任一 rejected 则整体 rejected」。而这里每条都要 探端口、读 instance.json、量目录大小 —— 其中任何一步都可能因为 一条被手改坏的记录而抛（最典型：port 被改成 99999， net.connect 抛 RangeError）。 那会是什么后果：整个 `instance:list` 失败 → App.vue 的 `.catch(() => [])` 静默降级成空数组 → **界面一个实例都不显示**， 用户以为实例全丢了（数据其实完好）。 所以每条自己 catch：出错就退回「记录里写的状态 + 版本未知」， 让这个实例照样出现在列表里。用户看到一张灰色的卡片， 比看到一片空白好得多 —— 至少他知道东西还在。 （probePort 自己也加了端口范围守卫，这是第二道防线： 将来有别的什么原因让 liveStatusOf 抛，也不会连坐。）
 */

      /**
 * ★ `store.latest(type)` 必须在循环**外面**算一次（性能修复） 审计抓出的问题：原来它在 `.map()` 里， const tag = readInstanceTag(rec.dir) ?? store.latest(rec.type)?.tag 而 `latest(type)` = `buildList(type)[0]`，`buildList` 会对每个版本 调 `dirSizeMB(dir)` —— 那是**逐文件 statSync* 的递归统计，且无缓存。 于是 `instance:list` 的复杂度是 实例数 × 版本数 × 运行时目录里的文件数 全是同步 IO，跑在主进程上。审计实测：2 万个小文件跑一次约 950ms； 而 AstrBot 真实规模是 **49133 个文件* → 单次 buildList 就是秒级。 5 个实例 × 3 个版本 = 15 次全量遍历，界面直接卡住。 而 `instance:list` 是 `refresh()` 的必经路径（每次增删改都会走）。 修法：按 type 各算一次，循环里查表。语义完全不变 —— 同一次 list 调用里，同一个 type 的 "latest" 本来就该是同一个值。
 */

      const latestByType = new Map<'a' | 'n', string | undefined>()
      for (const t of ['a', 'n'] as const) {
        try {
          latestByType.set(t, store.latest(t)?.tag)
        } catch {
          /**
 * 版本目录损坏不该让整个列表挂掉
 */

          latestByType.set(t, undefined)
        }
      }
      return Promise.all(
        repo.list().map(async (rec) => {
          try {
            const live = await liveStatusOf(rec)
            const tag = readInstanceTag(rec.dir) ?? latestByType.get(rec.type)
            return { ...live, runtimeTag: tag }
          } catch (e) {
            opts.logger?.log(
              'WARN',
              'proc',
              `实例 ${rec.id}（${rec.name}）状态探测失败，已按「已停止」列出：${e instanceof Error ? e.message : String(e)}`
            )
            return { ...rec, status: 'stopped' as const, runtimeTag: undefined }
          }
        })
      )
    },
    'instance:create': async (p) => {
      const { config: cfg, repo: r } = state()
      // 分段端口：AstrBot 6100-6199，NapCat 6200-6299；默认=同类末端口+1，探测占用顺延

      const range = TYPE_PORT_RANGE[p.type]
      const sameTypePorts = r.list().filter((x) => x.type === p.type).map((x) => x.port)
      const lastOfAny = r.list().length ? Math.max(...r.list().map((x) => x.port)) + 1 : undefined
      const lastOfType = sameTypePorts.length ? Math.max(...sameTypePorts) + 1 : undefined
      const port = await allocate(
        opts.probe,
        [range.min, range.max],
        r.list().map((x) => x.port),
        p.port ?? lastOfType ?? lastOfAny,
        p.type === 'a' ? 'AstrBot' : 'NapCat'
      )
      const store = runtimeStore(cfg.dataRoot)
      // 没有可用运行时就不许创建：否则建出来是个跑不起来的空壳

      const avail = store.list(p.type)
      if (!avail.length) {
        throw new Error(`还没下载 ${p.type === 'a' ? 'AstrBot' : 'NapCat'} 的任何版本——先去「下载」页装一个，再创建实例`)
      }
      // AstrBot 靠内置 Python 跑，没装 Python 就是创建了也起不来，这里一并拦住

      if (p.type === 'a' && !isPythonReady(cfg.dataRoot)) {
        throw new Error('AstrBot 需要先装好 Python 才能运行——去「下载」页装一下，再创建实例')
      }
      // NapCat 注入 QQ 运行，没装 QQ / 版本太低同样起不来

      if (p.type === 'n' && opts.qqChecker) {
        const qq = await opts.qqChecker()
        if (!qq.ok) throw new Error(qq.reason ?? 'QQ 环境不满足 NapCat 的要求')
      }
      const chosenTag = p.tag && store.isInstalled(p.type, p.tag) ? p.tag : avail[0].tag
      const src = store.dirFor(p.type, chosenTag)
      if (!existsSync(src)) {
        throw new Error(`运行时文件不完整（${chosenTag}）——去「下载」页把它删掉重新装一次`)
      }
      const rec = r.create({
        type: p.type,
        name: p.name,
        qqAccount: p.qqAccount,
        allocatePort: () => port
      })
      /**
 * 只建实例骨架，**不复制运行时**。 运行时留在共享的 runtimes\<type>\<tag>\（启动时读的就是它）， 实例目录只放这个实例自己的数据。原来这里复制整树，实测白占了 AstrBot 565.4 MB / 49133 个文件（见 templates.ts 的详细说明）。 数据目录不预建：AstrBot 会自己建 data\，NapCat 会自己建 config\， 我们提前建空目录只会让用户以为里面该有东西。
 */

      instantiateFromTemplate({ src, dest: rec.dir })
      refreshTemplateVersion(r, rec.id, versionNumOf(chosenTag))
      // 记下实例用的是哪个版本（换版本/删除时判断引用）

      writeInstanceMeta(rec.dir, rec, chosenTag)
      /**
 * 创建时就读一次真实版本写进记录：卡片立刻能显示， 不用等第一次启动。读的是运行时包自己的标识（不是我们起的目录名）。
 */

      const ver = detectInstanceVersion({
        type: rec.type,
        instanceDir: rec.dir,
        runtimeDir: src
      })
      r.updateRuntimeVersion(rec.id, ver)
      opts.logger?.log('INFO', 'proc', `创建实例 ${rec.name}(${rec.id}) 端口${rec.port}，用 ${p.type === 'a' ? 'AstrBot' : 'NapCat'} ${chosenTag}`)
      return { ...r.get(rec.id)!, tag: chosenTag }
    },
    'instance:start': async (id) => {
      /**
 * ★ 搬家中禁止启动实例（四厂商审计三家一致指认的数据安全问题） 搬家会把整个数据目录**复制**到新根，而 `state()` 里的 config/repo 要等复制全部结束才切到新根。所以在这个（可能是分钟级的）窗口里 启动实例，它会： · 往**旧根**的实例目录写数据 —— 而那份目录正在被复制 → 复制出来的副本"半新半旧"，甚至复制中途失败进 failed 列表 · 实例的日志还会写进 `logs\instances`，而 logs 也是被复制的成员 这正是 move-guard 契约一防的"边写边复制"，但那条只防了 **搬家开始时在跑的**实例，没防"搬家期间新起来的"。 拦在这里而不是靠渲染层置灰：前端可被绕过（快捷键/并发窗口）， 数据安全的事必须由**唯一真相源**（主进程）把门。
 */

      if (relocateActive) {
        throw new Error('正在搬家（复制数据）中，等搬完再启动实例哦 —— 现在启动会写到正在复制的旧目录里')
      }
      /**
 * ══════════════════════════════════════════════════════════════════════════ ★★ 同一个实例**不许并发启动**（子代理审计抓出，我复核确认） ══════════════════════════════════════════════════════════════════════════ ## 原来的缺口 渲染层有 `busyIds` 禁用按钮，但**那只是界面**： · 快捷键 / 连点 / 两个窗口 / 脚本调用都能绕过它 · 而 process-manager 自己虽有 DuplicateInstance 守卫， ipc 层却从不依赖它 —— 等于把它绕开了 后果（两次并发 invoke 同一 id）： ① 都通过前置检查 → 双双 `updateStatus('starting')` → **spawn 两个进程* 抢同一个端口（第二个必然失败，但它已经把状态写成 error 了） ② 后到者的失败路径 `updateStatus(id,'error')` 把**活着那个**的账面打成 error → 用户看到一个"报错但实际在跑"的实例，点停止还可能停不掉 ## 修法：与 relocateActive 同一个思路 —— 主进程把门 加一个"正在启动中"的集合，进不来就明确拒绝（而不是静默排队）。 用 Set 而不是计数器：`id` 是唯一键，重复添加天然幂等。 注意**必须放在 try/finally 或成对清理**：启动失败也要移除， 否则那个实例会永远"正在启动中"，用户再也点不动。
 */

      if (startingIds.has(id)) {
        throw new Error('这个实例正在启动中，稍等一下哦 —— 不要重复点。')
      }
      /**
 * 标记 + 清理： cleanup 挂在下面那个**已有的* try 的 finally 上 （见函数末尾的 `} finally { startingIds.delete(id) }`）—— **不新加一层 try/finally**：这个 handler 内部本来就有大 try/catch （覆盖 spawn 与等待），再套一层会让括号层次变复杂 （我第一版就是这么写的，直接编译不过）。 但"add 之后、那个 try 之前"还有几行前置检查会抛错 —— 那些 throw 走不到 finally，所以它们各自先 `delete` 再抛。 漏一个的后果：那个实例永远"正在启动中"，用户再也点不动它。
 */

      startingIds.add(id)
      const { repo: r, config: cfg } = state()
      const rec = r.get(id)
      if (!rec) {
        startingIds.delete(id)
        throw new Error(`实例不存在: ${id}`)
      }
      if (!commandFor) {
        startingIds.delete(id)
        throw new Error('启动命令模板未接线（commandFor 未注入）')
      }
      // NapCat 注入 QQ 才能跑：QQ 没装或版本太低时先说清楚，别让用户对着一个
      // 永远不通的端口干等（NapCat 自身会去找 QQ，我们只负责提前告知）

      if (rec.type === 'n' && opts.qqChecker) {
        const qq = await opts.qqChecker()
        if (!qq.ok) {
          opts.logger?.log('ERROR', 'proc', `启动 NapCat 实例被 QQ 环境拦截 ${id}`, qq.reason ?? '')
          startingIds.delete(id)
          throw new Error(qq.reason ?? 'QQ 环境不满足 NapCat 的要求')
        }
      }
      /**
 * ★ 端口是坏的（被归零 / 越界）就**重新分配**一个 —— 这是 instance-repo 里那句注释承诺过的行为，但原来根本没实现。 ## 原 bug（审计抓出的） `store/instance-repo.ts:204` 的注释明确写着： 「保留下来 + 端口归零，界面上会显示成「已停止」， 用户点启动时 start 会走 allocate 重新分配一个合法端口」 但全文件 grep：`allocate()` **只在 instance:create 里调过一次**。 instance:start 直接用 `rec.port` 去 spawn、去探端口。 于是端口被写成 0 的实例（readAll 会把越界端口"修"成 0， 而那次修会连同 writeAll 一起落盘 —— 也就是**我们自己写的 0**） 就永远修不好了： · probePort(0) 恒为 false（health.ts 有范围守卫） · 每次启动都要**白等满 START_PORT_WAIT_MS（90 秒）**才失败 · AstrBot 还会被传一个 `--port 0` 用户看到的是一句含糊的「端口 0 也没起来」，而且没有自助修复入口。 ## 修法 在启动的最前面判断端口是否合法；不合法就现分配一个、 **写回记录**（否则下次启动又是 0，等于没修），再用新端口继续。 用与 create 相同的 allocate 逻辑 + 相同的占用表，保证不会撞号。
 */

      let effectivePort = rec.port
      if (!Number.isInteger(effectivePort) || effectivePort < 1 || effectivePort > 65535) {
        /**
 * 调用形态必须和 instance:create 里那处**逐字一致* （allocate 的签名是 (probe, range, alreadyAllocated, hintPort, what)）。 我第一版凭印象写成了对象参数 `allocate({lo, hi, taken, hintPort}, probe)` —— 编译期没报错（Vite 构建会剥掉类型），运行起来必然是 "cannot read properties of undefined"。所以这里照抄 create 的写法， 不自己发明。
 */

        const range = TYPE_PORT_RANGE[rec.type]
        const allRecs = r.list()
        const sameTypePorts = allRecs.filter((x) => x.type === rec.type).map((x) => x.port)
        const lastOfAny = allRecs.length ? Math.max(...allRecs.map((x) => x.port)) + 1 : undefined
        const lastOfType = sameTypePorts.length ? Math.max(...sameTypePorts) + 1 : undefined
        const nextPort = await allocate(
          opts.probe,
          [range.min, range.max],
          allRecs.map((x) => x.port),
          lastOfType ?? lastOfAny,
          rec.type === 'a' ? 'AstrBot' : 'NapCat'
        )
        r.updatePort(id, nextPort)
        const bad = rec.port
        effectivePort = nextPort
        /**
 * 顺手把本地这份 rec 也改掉 —— 下面几十行都在用 rec.port （spawn、探端口、失败提示、WebUI 地址…）。 只改盘上的记录而不改这份内存副本，会出现"盘里是新的、 这次启动还在用 0"的错位。
 */

        rec.port = nextPort
        opts.logger?.log(
          'WARN',
          'proc',
          `实例 ${id} 的端口记录无效（原值 ${bad}），已自动重新分配为 ${nextPort}`
        )
      }
      if (rec.type === 'n') napcatTokenCache.set(rec.id, await existingNapcatTokenAsync(rec.dir))
      const spec = commandFor(rec, state().config.dataRoot)
      // 端口已被占用时不能再拉起第二个 NapCat；仅凭该端口可连接也不能证明
      // 响应服务属于这个实例。明确拒绝并提示改端口/确认旧服务，避免错认实例。
      if (await probePort(effectivePort, 300)) {
        startingIds.delete(id)
        throw new Error(`端口 ${effectivePort} 已有服务在监听。为避免启动重复的 NapCat 或连接到其他实例，请先关闭占用该端口的程序，或为此实例更换端口。`)
      }
      /**
 * 每次启动都重读一次真实版本并写回记录。 为什么启动时还要读（创建时已经读过）：用户可能在中途手动换过运行时包、 回滚过备份、或者更新过版本 —— 只有启动这一刻读到的才是"现在要跑的"。 卡片显示的版本因此始终跟得上，不会停留在创建时的旧值。
 */

      try {
        /*
         * ★★ `runtimeDir` 必须是**运行时目录**，不是 `spec.cwd`（实例目录）
         *   （主人 2026-09-27 实测：「只要启动过就变成版本未知」）
         *
         * ## 原来的错
         *
         * 这里传的是 `spec.cwd` —— 而 AstrBot 的 `spec.cwd` 是**实例目录**
         *（它必须是，因为 AstrBot 的 `get_astrbot_root()` 取 cwd，
         *  而 `.astrbot` 标记落在实例目录里）。
         *
         * `detectInstanceVersion` 拿实例目录去读：
         *   ① `readBuiltinVersion(实例目录)` → 那里没有 AstrBot 包 → undefined
         *   ② 退回 `instance.json` 的 runtimeTag → 应该能读到…
         *      **但读不到** —— 实测确认（见下面的证据）
         *
         * ## 实测证据
         *
         * 对真实实例跑同一个函数：
         *     传运行时目录 → "4.28.1"   ✔
         *     传实例目录   → undefined  ✘
         *
         * 于是每次启动都把这个 `undefined` 写回记录 →
         * 卡片上显示「版本未知呢」——**启动一次就丢一次版本号**。
         * 用户看到的正是："只要启动过就会变成版本未知"。
         *
         * ## 为什么第 ② 步也没救回来
         *
         * `detectInstanceVersion` 的实现是：
         *     const tag = j.runtimeTag?.trim()
         *     if (tag) return tag.replace(/^v/i, '')
         * 从 `instanceDir` 读 `instance.json` —— 传实例目录时**这一步是对的**，
         * 所以理论上能读到 v4.28.1。
         *
         * 但它前面先跑了 `readBuiltinVersion`，而那个函数对实例目录
         * 会走到"读 pyproject.toml"那一步 —— 实例目录里**没有** pyproject.toml，
         * 于是返回 undefined，正确落到第 ② 步。
         *
         * 所以真正的问题在**调用方**：`spec.cwd` 传错了。
         * 修法：用 `spec.env.MXBOT_SITE`（layout.ts 里明确写着
         * `MXBOT_SITE: deps.dir`，也就是运行时目录），
         * 拿不到才退回 `rec.dir` 让函数自己走 instance.json 那条路。
         */
        const runtimeDir = String(spec.env?.MXBOT_SITE ?? '') || rec.dir
        r.updateRuntimeVersion(
          id,
          detectInstanceVersion({ type: rec.type, instanceDir: rec.dir, runtimeDir })
        )
      } catch {
        /**
 * 读版本失败不该拦住启动
 */

      }
      /**
 * AstrBot 靠内嵌 Python 跑，而内嵌版的 `._pth` 会让解释器进隔离模式、 **完全忽略 PYTHONPATH**。所以每次启动都确保 sitecustomize.py 在位 —— 不能只在「装 Python」那一刻写一次：用户从旧版本升上来、搬过数据目录、 或者手动清过 site-packages，它都可能不在。 缺了它的表现是 ModuleNotFoundError: No module named 'astrbot'， 报错完全指不到真正原因，极难自查。这里自愈，成本是一次 existsSync。
 */

      if (rec.type === 'a') {
        try {
          const pyDir = pythonDirFor(cfg.dataRoot)
          if (existsSync(join(pyDir, 'python.exe'))) ensureSiteCustomize(pyDir)
        } catch (e) {
          opts.logger?.log('WARN', 'proc', `注入 sitecustomize 失败（AstrBot 可能加载不到包）`, String(e))
        }
        /**
 * AstrBot 的 `check_astrbot_root()` 要求运行目录里存在 `.astrbot` 标记， 没有就直接拒绝启动（报 "is not a valid AstrBot root directory"）。 而 `get_astrbot_root()` 取的是 **cwd**，也就是实例目录 —— 所以这个标记必须落在实例目录里，且**每次启动都要确保存在* （用户可能手动清理过、或从旧版本升上来时没有）。
 */

        try {
          mkdirSync(rec.dir, { recursive: true })
          const marker = join(rec.dir, '.astrbot')
          if (!existsSync(marker)) writeFileSync(marker, '', 'utf8')
        } catch (e) {
          opts.logger?.log('WARN', 'proc', `创建 .astrbot 标记失败（AstrBot 会拒绝启动）`, String(e))
        }
        /**
 * ★ data\config 目录也必须自愈（主人实测的插件加载失败） 实测事故：装插件 `astrbot_plugin_reneban` 报 FileNotFoundError: `...\a_xxx\data\config` 不存在 —— 插件保存配置时用 `tempfile.mkstemp` 往 `data/config/` 里写， 而 AstrBot 在"全新实例"的启动路径上**自己不会先建这个目录* （它建的是 data/config/astrbot_config.json 之类，且时机取决于 加载顺序：插件先加载就先炸）。 我们在 create.ts:64 只建了 `data/`，也没建 `data/config/`。 修法和上面 `.astrbot` 标记一个道理（启动时自愈、幂等、零成本）： 目录存在不会有任何副作用，不存在就会让插件安装当场报错。 NapCat 不需要（它的配置走 config\，由 NapCat 自己建）。
 */

        try {
          mkdirSync(join(rec.dir, 'data', 'config'), { recursive: true })
        } catch (e) {
          opts.logger?.log('WARN', 'proc', `建 data\\config 失败（AstrBot 插件安装可能报 FileNotFoundError）`, String(e))
        }
        /**
 * ══════════════════════════════════════════════════════════════════ ★ Dashboard 前端预装（公测反馈抓出的致命 bug） ══════════════════════════════════════════════════════════════════ 公测用户实例日志原文： Dashboard is not installed Install dashboard? [Y/n]: click.exceptions.Abort AstrBot 本体已经跑起来了，却卡在这句**等键盘输入**的提问上 —— 我们是非交互 spawn，没人回答 → Abort → 进程退出 → 端口永远不通 → 用户看到"启动了但一直起不来"。 把前端提前铺到 `<实例>\data\dist`，`check_dashboard` 就会走 "already up to date / 不提问"那条分支。详见 runtime/dashboard.ts。 ────────────────────────────────────────────────────────────────── ★ 但**绝不能 await 它**（第一版就是这么写的，被测试当场抓住） ────────────────────────────────────────────────────────────────── 第一版写成 `const ready = await ensureDashboard(...)`，跑全量测试时 ipc-handlers 里 3 条用例**全部 5 秒超时**（stats:overview / webui:open / 重置账密 —— 它们都要经过 instance:start）： 那是我在启动路径上塞了一次**真实网络下载**（9.7MB）， 下载没完成，启动流程就永远走不到 spawn。 用 git stash 对照确认过：改动收起来 25 条全过、带改动 3 条超时 —— 100% 是我引入的。 对真实用户同样是 bug：网络一慢，"启动实例"按钮就卡着不动。 所以改成**后台预装 + 启动后复查**： · 不 await，启动流程立刻继续（该 spawn 就 spawn） · 预装完成后如果"这次没装成"，补一条 WARN 日志 · 已经装好的（绝大多数情况）走同步快路径：只是 stat 一下目录，零成本
 */

        /**
 * 版本号从**实际使用的运行时目录名**取（`spec.cwd`），而不是 `store.latest(type)` —— 后者是"这类里最新的一个"，而实例可能 固定用某个旧版本（多版本共存是本软件的核心场景）。 ── 这里踩过两个坑，都记下来（改动时务必看清）────────────── ① 第一版写的是 `store.latest(rec.type)`，而 `store` 在这个作用域里 *根本不存在* —— ReferenceError，被 tests/unit/instance-status.spec.ts 当场抓住（`store is not defined`）。 ② 第二版改成 `basename(spec.cwd)`，**又错了**：`spec.cwd` 是 *实例目录**（layout.ts:147 `cwd: workDir`，而 workDir 是 `deps.instanceDir ?? deps.dir`），basename 拿到的是**实例 ID* （如 `a_1a2b3c4d5e`），不是版本号 `v4.28.0`。 更糟的是 `cwd` 类型上是 `string | undefined`，为 undefined 时 `basename` 直接抛 TypeError —— 而这一行在 spawn **之前**， 于是 `instance:start` 整个失败（实测 ipc-handlers 3 条用例全挂）。 正确来源是 **`spec.env.MXBOT_SITE`**（layout.ts:148 明确写着 `MXBOT_SITE: deps.dir`，即运行时目录），或退回实例的 meta 记录。 这里按"可靠性"排优先级： 1. 实例 meta 里记的 tag（writeInstanceMeta 写的，最贴近"这个实例用哪个版本"） 2. env.MXBOT_SITE 的目录名（运行时目录就叫 <tag>） 都拿不到就不预装 —— 没版本号算不出 dashboard 的下载地址。
 */

        const runtimeDir = String(spec.env?.MXBOT_SITE ?? '')
        const tag = readInstanceTag(rec.dir) ?? (runtimeDir ? basename(runtimeDir) : '') ?? ''
        if (tag) {
          // 同步快路径：dist 已在就直接跳过（不发起任何异步/网络动作）

          let needInstall = true
          try {
            const { dashboardReady } = await import('./runtime/dashboard')
            needInstall = !dashboardReady(rec.dir)
          } catch {
            needInstall = false // 判不出来就别乱下载

          }
          if (needInstall) {
            void (async () => {
              try {
                const { ensureDashboard } = await import('./runtime/dashboard')
                const ready = await ensureDashboard({
                  instanceDir: rec.dir,
                  version: tag,
                  cacheDir: join(cfg.dataRoot, 'cache', 'dashboard'),
                  log: (m) => opts.logger?.log('INFO', 'proc', `AstrBot dashboard：${m}`),
                  fetchFile: async (url, dest) => {
                    // 复用项目既有的流式下载（边下边写盘、内存恒定）

                    const { defaultFetchToFile } = await import('./update/runtime-download')
                    await defaultFetchToFile(url, dest)
                  },
                  unzip: async (zip, dest) => {
                    /**
 * 用 async-exec 的 expandArchive：它内部用 psQuote 正确转义， 避免实例路径里的中文/空格/单引号把 PowerShell 命令拼坏 （这个坑项目里踩过，见 async-exec 的注释）。
 */

                    /**
 * ★ 必须自己判 status + 校验结果（审查抓出的漏洞） `expandArchive` 返回 RunResult、**从不抛错**；而 PowerShell 的 Expand-Archive 在 zip 损坏/截断时 **退出码仍然是 0**（错误只写 stderr）—— 审查实测： 假 zip / 截断 zip / 中部清零的 zip，三种都 ExitCode 0。 第一版丢掉返回值，于是解压失败被当成成功。 项目里其它四处调用点都判 status，只有这里漏了。 另外再加一道**结果校验**：退出码 0 也不等于真解出来了 （上面那三种损坏 zip 都是 0）。看结果比信返回码可靠。
 */

                    const r = await expandArchive(zip, dest)
                    if (r.status !== 0) {
                      throw new Error(
                        `解压 dashboard 失败（退出码 ${r.status}）：` +
                          `${String(r.stderr ?? '').trim().slice(0, 300) || '(无 stderr)'}`
                      )
                    }
                    if (!existsSync(join(dest, 'dist'))) {
                      throw new Error('解压 dashboard 后没有 dist 目录（压缩包损坏或结构变了）')
                    }
                  }
                })
                if (!ready) {
                  opts.logger?.log(
                    'WARN',
                    'proc',
                    'AstrBot dashboard 没预装成功 —— 本次实例可能会卡在 "Install dashboard? [Y/n]" 无法启动'
                  )
                }
              } catch (e) {
                opts.logger?.log('WARN', 'proc', 'dashboard 预装异常（不影响本次启动）', String(e))
              }
            })()
          }
        }
      }
      r.updateStatus(id, 'starting')
      // 实例日志路径：<dataRoot>\logs\instances\<id>.log（start 前建目录）

      mkdirSync(join(cfg.dataRoot, 'logs', 'instances'), { recursive: true })
      const logFile = join(cfg.dataRoot, 'logs', 'instances', `${id}.log`)
      /*
       * ══════════════════════════════════════════════════════════════════════════
       * ★★ 「本次运行」的起点必须在**启动之前**记
       *   （主人 2026-09-27：「为什么是实例完全启动后再刷新起始点，
       *     我都看不到实例开始启动到完成启动的日志」）
       * ══════════════════════════════════════════════════════════════════════════
       *
       * ## 我第一版放错了位置
       *
       * 我把它放在 `updateStatus(id, 'running')` **之后** ——
       * 那是"确认启动成功"的地方，于是记下的偏移是
       * **启动过程全部结束之后**的文件长度。
       *
       * 结果：用户点「翻翻日志」，看到的是"启动完之后"的日志，
       * **启动过程本身**（加载依赖、起 WebUI、报错现场）全被跳过 ——
       * 而那恰恰是排查时最想看的一段。
       *
       * ## 正确位置：就在**要往这个文件写东西之前**
       *
       * 这里（mkdir 之后、spawn 之前）正是那个点：
       *   · 此刻文件里是**上一次运行**的全部内容
       *   · 接下来 spawn 产生的一切输出都属于**本次**
       *
       * 所以记下当前长度，"从这之后"就是完整的本次运行 —— 含启动过程。
       *
       * 文件不存在（首次启动）时 size 视为 0，等价于"从头上看"。
       */
      try {
        let off = 0
        try {
          off = statSync(logFile).size
        } catch {
          /* 首次启动还没有日志文件 → 0 */
        }
        r.markStarted(id, new Date().toISOString(), off)
      } catch (e) {
        /* 记不上不该拦住启动（下次启动会重记） */
        opts.logger?.log('WARN', 'proc', `记录启动起点失败 ${id}`, String(e))
      }
      try {
        const handle = await pm.start({ id, port: rec.port, ...spec, logFile })
        /**
 * 先等进程真的落地（拿到 pid）。 注意这一步**不能当作启动成功* —— spawn 事件在"程序还没跑起来"时就发了， AstrBot 那种秒退（缺依赖）也会先触发它。真正的判据在下面。
 */

        await handle.eventually('running', 15000)
        /**
 * 再判「是否真的进入启动流程」：**进程活着 且 端口通**，两个都要。 为什么不能只 waitPort： - 残留的旧进程、或别的软件占了同一个端口，端口照样通 —— 用户看到「运行中」，连上去却是别人的服务。 - 进程中途崩了（缺依赖/配置错/被安全软件拦）， 只探端口会白等满 30 秒才失败，而那时用户只拿到一句笼统的"没起来"。 waitForReady 把这两种情况分开报，并且进程一死就立刻收手。
 */

        const ready = await waitForReady({
          port: rec.port,
          timeoutMs: START_PORT_WAIT_MS,
          intervalMs: 500,
          probePort: () => probePort(rec.port, 1500),
          isAlive: () => pm.statusOf(id) === 'running' || pm.statusOf(id) === 'starting',
          exitCode: () => handle.exitCode?.() ?? undefined,
          /**
 * 只要进程还在输出，就说明它在推进，别按固定 30 秒把它杀掉。 用户日志里踩到的：AstrBot 冷启动 33 秒（Python 解释器 + 依赖 + 数据库迁移 + 插件加载），期间一直正常打印日志， 而原来 30 秒到点就判超时、把进程 kill 了 —— 用户看到的就是「重置完账密直接卡在启动中」。 静默 20 秒才算真卡住；最多给到 3 分钟（防止刷屏进程永不超时）。
 */

          lastOutputAt: () => handle.lastOutputAt?.() ?? 0,
          idleGraceMs: START_IDLE_GRACE_MS,
          maxTotalMs: START_MAX_TOTAL_MS
        })
        if (!ready.ok) {
          const tail = pm.tailOf(id)
          // 服务没起来就别留着这个半死进程占着实例

          pm.killTreeSync(id)
          r.updateStatus(id, 'error')
          const reason = startupFailMessage(ready, rec.port)
          // 日志里留**完整**输出，方便事后排查

          opts.logger?.log(
            'ERROR',
            'proc',
            `启动实例失败 ${id}（${ready.reason}，耗时 ${ready.elapsedMs}ms）`,
            tail ? `${reason}\n${tail}` : reason
          )
          /**
 * 但抛给界面的要**截断**。 用户报告：「报错内容溢出屏幕……报错内容超出部分省略， 而且不能影响上面的正常 UI 和界面」。 tail 是进程最后几 KB 的输出（含 ANSI 转义和多行日志）， 整段塞进错误横幅会把界面糊住。这里只取最后几行、限长， 完整内容用户可以去「看日志」或导出日志包。
 */

          throw new Error(tail ? `${reason}\n${shortTail(tail)}` : reason)
        }
        r.updateStatus(id, 'running')
        /**
 * 标记「这个实例在本进程里真的启动成功过」。 之后即使注入器进程退出（NapCat 注入 QQ 的正常现象）， liveStatusOf 也会认端口，不会把活着的实例显示成「已停止」。 必须放在这里（确认就绪之后），不能放在 pm.start 成功处 —— 否则启动失败的实例也算「启动过」，端口被占时又会误报运行中。
 */

        startedInThisRun.add(id)
        // 起来了就清掉「刚停过」的标记，否则宽限期内会被误判成已停止

        justStopped.delete(id)
        /**
 * NapCat 的日志要另外收 —— 它被注入进 QQ 进程跑， 真正的运行日志（版本、Token、二维码、登录结果）不经过我们的管道， 只靠 stdout 只能拿到 "Administrator mode detected." 那一行。 所以起一个轮询器，从它自己的 WebUI 日志接口拉增量写进同一个日志文件。 （细节和实机证据见 proc/napcat-log.ts 的注释。）
 */

        if (rec.type === 'n') {
          try {
            /**
 * 先停掉这个实例**上一次**留下的收集器。 踩过的坑：`napcatLoggers.set(id, ...)` 会直接覆盖 Map 里旧的 collector，而覆盖**不会**清掉旧 collector 内部那个 setInterval —— 它还活着，每 3 秒继续往同一个日志文件拉一次。 触发场景很日常：用户在卡片上点「重启」（或切版本自动重启） 几次，同一个实例就会挂着好几个轮询器同时写同一个日志文件 —— 日志行重复、乱序，而且这些定时器永远不会被回收 （Map 里只剩最后一个，前面那些谁也够不着了，等于泄漏）。 所以覆盖前必须先 stop 再 delete，跟 instance:stop 里同一套。
 */

            napcatLoggers.get(id)?.stop()
            napcatLoggers.delete(id)
            const collector = createNapcatLogCollector({
              port: rec.port,
              token: NAPCAT_DEFAULT_TOKEN,
              logFile
            })
            napcatLoggers.set(id, collector)
          } catch {
            /**
 * 收不到日志不该影响实例运行
 */

          }
        }
      } catch (e) {
        r.updateStatus(id, 'error')
        // 把子进程最后的输出带出来：光说「超时」用户根本不知道哪儿错了

        const tail = pm.tailOf(id)
        const why = tail ? `${String(e)}\n—— 进程输出 ——\n${tail}` : String(e)
        opts.logger?.log('ERROR', 'proc', `启动实例失败 ${id}`, why)
        throw new Error(tail ? `${String(e instanceof Error ? e.message : e)}\n${tail}` : String(e))
      } finally {
        /**
 * ★ 一定要移除"正在启动中"标记（含失败路径）。 不移除的话：那次启动失败后，这个实例会**永远**处于 "正在启动中"——用户再点启动就被自己的守卫拦住， 只能重启软件。守卫绝不能自己变成故障源。
 */

        startingIds.delete(id)
      }
    },
    'instance:stop': async (id) => {
      const { repo: r } = state()
      const rec = r.get(id)
      /**
 * 杀完必须**核实**端口真的退了，不能只信 taskkill 发出去就算完。 用户日志里的实据：停止实例记的是 11:10:37，而该实例的日志一直写到 11:25:17 —— 停了之后还跑了 15 分钟。用户的感受就是 「NapCat 明明在运行中」（点停止没反应、点 WebUI 又说没启动）。 为什么：NapCat 注入进 QQ.exe 之后 QQ 脱离了父子链，`taskkill /T` 杀不到。 完整解释和「为什么按端口补杀是安全的」都写在 stopInstanceHard 的注释里 —— 这里是它的第一个调用点，另外两处（迁移数据目录、手动备份）原来各漏了一步， 现在统一走同一个函数（树杀 + 等端口 + 按端口补杀）。
 */

      /*
       * ══════════════════════════════════════════════════════════════════
       * ★ 停不干净时**不许**写 stopped（回归测试 user-reported-bugs 抓出）
       * ══════════════════════════════════════════════════════════════════
       *
       * 原来的写法是：
       *     await stopInstanceHard(...)      ← 内部可能没能停干净（只是 onNote 提示）
       *     napcatLoggers.get(id)?.stop()    ← 注释写着「只有确认停止后才关轮询」
       *     r.updateStatus(id, 'stopped')    ← 但这一行照样执行了
       *
       * 于是：**端口上还有服务在跑，状态却被写成 stopped**。
       * 那正是用户报告的现象：「点停止没反应，NapCat 其实还在收发消息」——
       * 界面说停了、实际没停，比直接报错更糟（用户不会再去管它）。
       *
       * 现在：用 `stopInstanceHard` 的显式返回值判断"是否真的停干净"。
       * 没停干净 → 保留原状态、保留日志轮询（还要靠它排障）、把原因抛给用户。
       */
      let stoppedCleanly = false
      let stopReason = ''
      if (rec) {
        stoppedCleanly = await stopInstanceHard(pm, rec, (m) => {
          stopReason = m
          opts.logger?.log('WARN', 'proc', `停止实例 ${id}：${m}`)
        })
      } else {
        // 记录已经不在了（比如刚被删），至少把进程树收掉
        pm.killTreeSync(id)
        stoppedCleanly = true
      }

      if (!stoppedCleanly) {
        /*
         * 没停干净：**什么都不改**，如实告诉用户。
         *
         * 为什么连 `startedInThisRun` 也不清：那个集合的语义是
         * "本进程里启动成功过"，用于按端口判活（NapCat 脱链场景）。
         * 既然它可能还在跑，就不该把它降级成"从没启动过"。
         */
        throw new Error(
          `没能确认实例「${rec?.name ?? id}」已经停止：${stopReason || '端口仍被占用'}\n` +
            `为避免误杀别的程序（比如你自己开着的 QQ），这次没有强行动它。\n` +
            `它的状态和文件都保持原样 —— 请手动关掉占着该端口的程序后重试。`
        )
      }

      // 只有确认停止后才关闭日志轮询；如果停不干净，保留诊断能力。
      napcatLoggers.get(id)?.stop()
      napcatLoggers.delete(id)
      r.updateStatus(id, 'stopped')
      startedInThisRun.delete(id)
      // 记一笔：端口不会立刻释放，探活宽限期内以「已停止」为准

      justStopped.set(id, Date.now())
      opts.logger?.log('INFO', 'proc', `停止实例 ${id}`)
    },
    /**
 * 删实例：异步的，而且**先把记录摘掉再删文件**。 踩过的坑（用户反馈「删各种东西也是半天删不掉，或者根本删除不了」 「删个文件就无响应了」）： 1. 原来 `repo.remove()` 内部是 `rmSync(dir, {recursive:true})` —— 一个 AstrBot 实例目录几万个文件、几百 MB，同步删会**独占主进程**， 界面在此期间完全没响应（所有 IPC 都排队）。 2. 记录和文件一起删，文件删失败就整体失败，用户看到「删不掉」； 而且失败后记录还在，下次列表里又冒出来。 现在：先摘记录（立即返回，界面马上少一张卡），文件交给异步删除慢慢删。 文件删失败也不影响「实例已删除」这个事实 —— 残留目录下次启动会被清理， 记一条日志让用户能查。
 */

    'instance:remove': async (id) => {
      const { repo: r, config: cfg } = state()
      const rec = r.get(id)
      /**
 * 删之前先把 NapCat 的日志轮询停掉。 instance:stop 里一直有这两行（napcatLoggers.get(id)?.stop() + delete）， 但 remove **漏了**。后果：用户在 NapCat 实例运行中直接删实例， 那个 setInterval 会继续按已删除实例的 id 去拉 WebUI 日志、 往已经没人管的文件里写 —— 而且**再也没人回收它**（实例都没了， 不会再有人调 stop）。每删一个运行中的 NapCat 实例就漏一个轮询器， 越删越慢，直到重启软件。
 */

      /**
 * 用 stopInstanceHard 而不是裸 killTreeSync。 删实例**紧接着就要 removeDirAsync(rec.dir)* 删目录。如果 NapCat 注入的 QQ 还活着（它脱链了，taskkill /T 杀不到）， 那个后台删除会撞上被占用的文件 —— 删不干净，留下一个残缺的 实例目录永远赖在磁盘上（用户看得见、又删不掉）。 按端口补杀之后再去删文件，成功率完全不是一回事。 rec 可能已经不在仓库里（用户重复点删除），那种情况没有端口信息， 退回原来的 killTreeSync 即可。
 */

      if (rec) {
        /*
         * ★ 删实例也要检查返回值（下面紧接着 removeDirAsync 删目录）
         *
         * 没停干净就删目录 → 文件被占用删不动 → 留下一个残缺的实例目录
         * 永远赖在磁盘上（用户看得见、又删不掉）。
         * 这正是这段注释原本就写明的场景，只是以前靠 throw 断住流程，
         * 现在改成显式判断，语义要跟着补上。
         */
        const stopped = await stopInstanceHard(pm, rec, (m) =>
          opts.logger?.log('WARN', 'proc', `删除实例 ${rec.name}：${m}`)
        )
        if (!stopped) {
          throw new Error(
            `实例「${rec.name}」没能停下来，所以**没有**删除它。\n` +
              `它还占着自己的文件，此时删目录会删不干净、留下残缺目录。\n` +
              `请先手动关掉它（或占着端口 ${rec.port} 的程序），再重试删除。`
          )
        }
      } else {
        pm.killTreeSync(id)
      }
      napcatLoggers.get(id)?.stop()
      napcatLoggers.delete(id)
      invalidateProbeCache(id)
      startedInThisRun.delete(id)
      // 只摘记录，不碰文件（repo.remove 里已改成不删目录）

      r.remove(id)
      opts.logger?.log('INFO', 'proc', `已删除实例 ${rec?.name ?? id}`)
      if (rec?.dir) {
        // 后台删文件，失败只记日志——不能因为删不掉就让「删除实例」整个失败

        void removeDirAsync(rec.dir).catch((e: unknown) => {
          opts.logger?.log(
            'WARN',
            'proc',
            `实例 ${rec.name} 的目录残留未清掉：${e instanceof Error ? e.message : String(e)}`
          )
        })
      }
      /**
 * 连它的实例日志一起清掉。 日志在 <dataRoot>\logs\instances\<id>.log，**不在实例目录里**， 所以上面那个 removeDirAsync(rec.dir) 清不到它。实机验证： 实例 a_3326e137e2 在 10:01:44 被删掉之后， logs\instances\a_3326e137e2.log（5684 字节）**依然躺在那里**。 后果：删得越多、日志目录越臃肿（每个实例一份，AstrBot 的能到几 MB）； 而且 instance:log 是按 id 读文件的，残留文件意味着 万一将来 id 被复用会读到上一个实例的日志（现在是随机 id 不会复用， 所以这条只是卫生问题，不是错误——但迟早得清）。 ## 这行代码原来有两处错，都是写用例时被带出来的 写 detached-process-kill 的用例（走"实例在运行中直接被删"这条路径） 时才暴露： 1. `unlink` **压根没被导入* → `ReferenceError: unlink is not defined` 2. 就算导入了，`fs.unlink` 是**回调式**的，没有 `.catch()` —— 会抛 `The "cb" argument must be of type function` 两个错叠在一起，而这行长得像一句平平无奇的清理语句，静态看很难发现。 更要命的是它的**位置**：`instance:remove` 走到这里时， 实例记录已经从 instances.json 摘掉了（在那之前），所以用户看到的是 "实例消失了，但界面弹一个 unlink is not defined 的报错"， 而且后面的 logger.log 不执行 —— 日志里连痕迹都没有。 现在用 fs/promises 的 unlink（项目里 import-archive.ts 也是这个约定）， 真异步、真能被 catch 接住。
 */

      if (cfg?.dataRoot) {
        const logFile = join(cfg.dataRoot, 'logs', 'instances', `${id}.log`)
        void unlink(logFile).catch(() => undefined)
      }
    },
    /**
 * 系统概况：**只回系统级信息**，不再采集每个实例的 CPU/内存。 去掉了 per-instance 资源采集，原因见 docs 里那条记录，简述： 采集靠 pidusage，它在 Windows 上 spawn wmic.exe，而 wmic 在新版 Windows 已被移除 —— 每次调用要等命令失败超时（实测 2.4~5.1 秒）。 界面原来是 2 秒一轮询，比单次耗时还短，于是主进程永远在等它， 所有交互（点按钮、删文件、加载列表）全部排队卡死。 现在这个 handler 只做两件轻活： 1. liveStatusOf 校正状态（有 TTL 缓存，不会每次都探端口） 2. 读内存/磁盘余量（os + statfs，不 spawn 进程） 而且前端不再轮询它，只在需要时按需拉一次。
 */

    'stats:overview': async () => {
      const { repo: r } = state()
      // 状态同样要探活校正：NapCat 的 cmd 早退出了，但服务和端口都还在

      const recs = await Promise.all(r.list().map((rec) => liveStatusOf(rec)))
      return {
        system: opts.systemInfo ? await opts.systemInfo() : undefined,
        perInstance: recs.map((rec) => ({
          id: rec.id,
          name: rec.name,
          type: rec.type,
          status: rec.status,
          port: rec.port
        }))
      }
    },
    'logs:export': async () => {
      if (!opts.logger) throw new Error('日志系统未注入')
      /**
 * ★ 防重入（主人 2026-09-27 的日志抓出的真问题） 他的日志里三条导出**紧挨着**： [ERROR] [perf] IPC logs:export 耗时 57997ms（严重） [ERROR] [perf] IPC logs:export 耗时 28219ms（严重） [ERROR] [perf] IPC logs:export 耗时 12841ms（严重） 说明用户连点了（因为界面没反应，他以为没点着）—— 而每次导出都会重新复制一遍日志、起一个压缩进程。 三次并发 → 互相抢磁盘 + 抢 CPU → **每一条都更慢**， 用户看到的是"点了没反应，越点越卡"。 现在：正在导出时直接复用同一个 Promise，第二个请求拿到的 是**同一份结果**（用户连点也不会多产出几个包）。
 */

      if (exportInFlight) return exportInFlight
      exportInFlight = (async () => {
        try {
          return await opts.logger!.exportZip()
        } finally {
          exportInFlight = undefined
        }
      })()
      return exportInFlight
    },
    /**
     * 「现在有导出任务在跑吗」—— 给界面**恢复状态**用。
     *
     * ══════════════════════════════════════════════════════════════════════════
     * ★ 为什么需要它（主人 2026-09-27 实测的真问题）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * 原话：
     *   「导出日志没导出完的时候关闭设置弹窗，再点进去就又可以导出日志了，
     *     明明上次的就没导出完整，这次点进去应该依旧显示正在打包直到
     *     打包任务完成」
     *
     * ## 为什么会这样
     *
     * 「正在打包…」那个状态是**渲染层组件里的一个 ref**
     *（`SettingsPanel.vue` 的 `exporting`）—— 设置弹窗一关，组件卸载、
     * ref 归零；重开时又是 `false`，于是按钮显示"导出日志"、可以点。
     *
     * **界面在骗人**：主进程其实还在打包（它有防重入，第二次会拿到
     * 同一个 Promise），但用户看到的是"没在干活"。
     *
     * ## 修法
     *
     * 状态归**主进程**：
     *   · `logs:export` 时置位（就是上面那个 exportInFlight）
     *   · 界面**挂载时**问一次 `logs:exportBusy`，据此恢复按钮文字
     *   · 打包结束由界面自己再问一次（或重新挂载时自然刷新）
     *
     * 同类问题在这个项目里不止一处（下载进度条也是渲染层状态 → 切页就丢），
     * 所以这条注释写详细些：**长任务的"进行中"状态属于主进程，
     * 不该只活在某个组件的生命周期里**。
     */
    'logs:exportBusy': async () => exportInFlight !== undefined,
    /**
     * 当前还在进行中的下载/安装任务快照。
     *
     * 下载页**挂载时**问一次，把进度条恢复出来 ——
     * 否则"装到一半切走再回来"看到的是空白（主人实测报过）。
     */
    'download:sessions': async () => currentDownloads(),
    /**
     * 取消一个正在进行的安装/导入。
     *
     * ## 为什么按 `<type>:<tag>` 而不是 pid / 任务 id
     *
     * 界面上的「取消」按钮是**跟着那个版本**走的（用户看到
     * "AstrBot v4.28.1 正在装…"，他要取消的就是**那个**）——
     * 用同一个键定位最直白，而且和互锁共用键空间，
     * 不会出现"取消了 A 却把 B 停了"。
     *
     * ## 返回值的语义
     *
     * `ok: true` = **已经发出了取消信号**（不是"已停止"）。
     * 真正的停止要等 pip/fetch 响应（通常很快，但 pip 被杀后
     * 它的子进程回收可能要一两秒）。所以界面应当显示"取消中…"，
     * 然后靠进度事件里的 error（"已取消"）来确认结束。
     */
    'runtimes:cancel': async (p) => {
      const key = taskKey(p.type, p.tag)
      const r = cancelTask(key)
      if (!r.ok) {
        return { ok: false, reason: '这个任务已经结束了（或者本来就没在跑）' }
      }
      opts.logger?.log(
        'INFO',
        'proc',
        `用户取消了 ${r.task?.kind === 'import' ? '导入' : '安装'}：${r.task?.label ?? key}` +
          `（已跑 ${Math.round((Date.now() - (r.task?.startedAt ?? Date.now())) / 1000)} 秒）`
      )
      /*
       * 发一条进度事件让界面**立刻**有反馈（不用等 pip 真的退出来）——
       * 否则用户点完取消还要盯着一个不动的进度条，以为没生效。
       *
       * phase 用 error 而不是新造一个 'cancelled'：渲染层对 error 的
       * 处理是"显示失败原因 + 几秒后清掉"，正是取消后想要的行为；
       * 而造新 phase 要动渲染层、还得管它的显示与清理，收益不划算。
       */
      sendDownloadProgress({
        type: p.type,
        tag: p.tag,
        got: 0,
        total: undefined,
        percent: null,
        bytesPerSec: 0,
        gotText: '',
        speedText: '',
        done: false,
        phase: 'error',
        error: '已取消 —— 你可以换个更快的源重新下载',
        label: r.task?.label ?? p.tag
      })
      return { ok: true }
    },
    /**
 * 在资源管理器里定位一个文件（打开所在文件夹并选中它）。 用途：更新包下载完之后，用户点「打开所在文件夹」直接跳过去。 原来界面只把路径当纯文本显示，用户得自己一层层翻目录找 —— 便携版装在深层目录时尤其烦。 和 backup:openFolder 的区别：那个只允许打开数据根下的备份目录 （因为入参来自界面、要防路径穿越）；这里入参是**我们自己刚下载完 返回给界面的路径**，而且必须确认它真的存在才打开 —— 不然就是「打开了一个不存在的路径」，shell 会静默失败或弹系统错误框。
 */

    'shell:showItem': async (p) => {
      const { shell } = await import('electron')
      if (!p || !existsSync(p)) throw new Error('文件不存在（可能已经被移动或删除）')
      shell.showItemInFolder(p)
      return true
    },
    /**
 * ==================== 启动器自身更新 ====================
 */

    'app:version': async () => (await opts.appVersion?.()) ?? '0.0.0',
    /**
 * 上次是否异常退出（指导书 3.2：「下次启动检测异常退出 → 提示导出诊断」）。 判据是 running.lock 还在不在（见 util/crash-logs.ts）—— 用日志判断不可靠：进程被杀时根本来不及写日志。 纯读、无副作用；渲染层启动时问一次，据此决定要不要弹"导出诊断日志"。 未注入时返回 {crashed:false}（测试环境不受影响）。
 */

    'app:lastCrash': () => opts.lastCrash?.() ?? { crashed: false },
    /**
 * 检查更新。 用户要求： - 每次启动检测一次 - 一天最多推一次 - 从服务器取版本**失败就显示「最新版」* 所以这里**从不抛错**：拿不到清单就返回 hasUpdate:false（外加 checked:false 让界面知道"其实没检查成功"，但对外表现就是最新版）。 把「失败」和「没更新」都收敛成 hasUpdate:false，是用户明确要的表现。 force=true（手动点「检查更新」）会忽略"一天一次"的限制，并更新计时。
 */

    'app:checkUpdate': async (p) => {
      const force = Boolean((p as { force?: boolean } | undefined)?.force)
      const now = opts.now?.() ?? Date.now()
      const current = (await opts.appVersion?.()) ?? '0.0.0'
      /**
 * ★ 优先用 electron-updater 检查（指导书第六章 P3） 它读打包时生成的 app-update.yml（地址就是我们发布配置里的 MX_OFFICIAL_BASE），比自己拼 latest.json 更"标准"。 但检查失败必须**安静回落到手写检查* —— 用户点"检查更新"时 不能因为一个库的问题就什么都查不到。
 */

      /**
 * ★ `viaLibrary` 已删除（主人 2026-09-27） 它原来在这里：用 electron-updater 判"有没有新版"。 删掉的原因是**它和 latest.json 会互相打架**，实测造成两个用户可见的 bug（同版本报更新 + 点下载没反应，详见下面那段说明）。 electron-updater 仍然在用，但只在它该在的地方： `app:downloadUpdate` 里的**增量下载**，以及 `app-updater.ts` 自己。 「有没有新版」这件事从此只有 `latest.json` 一个来源。
 */

      // 没到期且不是强制 → 直接说没有更新（不问服务器）

      if (!force) {
        const last = config?.lastUpdateCheckAt
        const skipped = config?.skippedAppVersion
        if (!isCheckDue(last, now)) {
          return { hasUpdate: false, currentVersion: current, throttled: true }
        }
        // 到点了，先记时间再查（查失败也算查过，不然失败会每启动都重试、很吵）

        try {
          handlers['config:set']({ lastUpdateCheckAt: now })
        } catch {
          /**
 * 记不上不影响这次检查
 */

        }
        const r = await safeCheck(current)
        // 用户跳过过的版本不再提示（但下一个版本照常提示）

        if (r.hasUpdate && isVersionSkipped(r.latestVersion, skipped)) {
          return { ...r, hasUpdate: false, skipped: true }
        }
        return r
      }
      // 强制检查：同样记时间

      try {
        handlers['config:set']({ lastUpdateCheckAt: now })
      } catch {
        /**
 * ignore
 */

      }
      /**
 * ══════════════════════════════════════════════════════════════════════ ★★ 手动检查：**以我们自己的 latest.json 为准* （主人 2026-09-27 反馈：「同版本也能检测到更新」+ 「点下载怎么没反应」—— 两个现象同一处根因） ══════════════════════════════════════════════════════════════════════ ## 原来的写法为什么错 const via = await viaLibrary() // electron-updater if (via?.hasUpdate) { const detail = await safeCheck(current) const merged = detail.hasUpdate ? detail : ({ ...via, url: undefined }) ... return merged } 两处致命问题： ① **`via` 这条路径不带 url**（`viaLibrary` 只回 version）。 一旦 `detail.hasUpdate` 为假，就返回 `{ hasUpdate: true, url: undefined }` —— 界面显示"发现新版本"， 而点「下载更新」时渲染层第一行就是 `if (!info?.url || !info.version) return` ← **静默返回* 于是"点了没反应"，连个报错都没有。 ② **electron-updater 的 hasUpdate 与我们的语义不一致**。 它读的是打包时生成的 `app-update.yml`，比较逻辑/缓存时机 都与 `latest.json` 无关 —— 于是出现**同版本号也报更新* （实测：当前 0.1.6、清单 0.1.6，却显示"发现新版本 0.1.6 呀"）。 ## 现在怎么做 **只有一个真相来源：`latest.json`**（`safeCheck`）。 它同时给出 hasUpdate / url / sha256 / sizeMB / notes —— 恰好是渲染层"下载"需要的全部字段。 electron-updater 退回它本来的定位：**增量下载**（`app:downloadUpdate` 里那条路径），不再参与"有没有新版"的判定。 这符合它文档里的定位，也消除了"两个来源互相打架"这一整类 bug。
 */

      const r = await safeCheck(current)
      if (r.hasUpdate && isVersionSkipped(r.latestVersion, config?.skippedAppVersion)) {
        // 手动检查时，用户显然想知道有没有新版 —— 跳过的版本也如实告诉他

        return { ...r, userSkipped: true }
      }
      return r
    },
    /**
 * 下载全量包到**系统默认下载目录**。 只下载，**不运行、不安装**（用户硬约束： 「更新只能是用户运行更新版本的安装包走安装流程来更新」）。
 */

    'app:downloadUpdate': async (p) => {
      const { url, version, sha256 } = p
      /**
 * ★ 优先用 electron-updater 的**增量下载**（指导书第六章 P3） 为什么值得：它按 blockmap 算差分，更新时通常只下几 MB， 而不是每次重下 80MB 全量包。 为什么不是"直接换掉"：它要求打包态、依赖 app-update.yml、 还可能因为服务器/配置问题失败。而"更新下载"是用户点下去就 必须成功的事 —— 所以**任何异常都回落到原来那条手写路径* （那条有完整的 sha256 校验与进度，且已被测试覆盖）。 遵循主人的硬约束：只下载，**绝不运行、绝不安装**。 electron-updater 的 quitAndInstall 一次都不调， autoInstallOnAppQuit 也在 createAppUpdater 里被按成 false。
 */

      if (opts.appUpdater) {
        try {
          const r = await opts.appUpdater.download()
          opts.logger?.log('INFO', 'app', `已下载启动器更新包（增量）：${r.file}`)
          opts.audit?.record({ actor: 'user', action: 'app.downloadUpdate', target: String(version), result: 'ok', detail: '增量下载' })
          return r.file
        } catch (e) {
          opts.logger?.log(
            'WARN',
            'app',
            `增量下载失败，改用整包下载：${e instanceof Error ? e.message : String(e)}`
          )
        }
      }
      if (!url) throw new Error('下载地址为空')
      if (!opts.fetchUpdateToFile) throw new Error('下载通道未就绪')
      const dir = await opts.downloadsDir?.()
      if (!dir) throw new Error('取不到系统下载目录')
      const saved = await downloadAppUpdate({
        dir,
        url,
        // 文件名带版本号：新旧安装包不互相覆盖，用户还能留着旧的

        fileName: versionedInstallerName(version),
        expectSha256: sha256,
        fetchToFile: opts.fetchUpdateToFile,
        onProgress: (prog) => opts.sendUpdateProgress?.(prog)
      })
      opts.logger?.log('INFO', 'app', `已下载启动器更新包：${saved}`)
      opts.audit?.record({ actor: 'user', action: 'app.downloadUpdate', target: String(version), result: 'ok' })
      return saved
    },
    /**
 * 跳过此版本：只记版本号，下个版本照样提示
 */

    'app:skipVersion': (v) => {
      handlers['config:set']({ skippedAppVersion: String(v ?? '') })
      return true
    },
    'webui:open': async (id) => {
      if (!opts.webui) throw new Error('窗口尚未就绪，无法打开 WebUI')
      const { repo: r } = state()
      const rec = r.get(id)
      if (!rec) throw new Error(`实例不存在：${id}`)
      /**
 * 判据是「端口上真的有服务」，而不是「记录里写的是 running」。 踩过的坑（用户报告「NapCat 明明在运行中，点击 WebUI 却显示未启动」）： 原来第一句就是 `if (rec.status !== 'running') throw`， 而 rec.status 是**磁盘上的旧记录* —— 它可能因为各种原因落后于现实： - NapCat 是注入进 QQ 跑的，QQ 进程比我们的子进程活得久， 停止实例时子进程被杀了、QQ 还在跑，记录写 stopped 但服务其实还在 - 软件重启后记录里的 running 会被归位成 stopped（见 config:set） 于是服务明明活着，用户一点就被告知「实例没在运行」。 端口探测才是真相。记录里的状态只用来生成更贴切的错误措辞。
 */

      if (!startedInThisRun.has(rec.id) && pm.statusOf(rec.id) !== 'running') {
        throw new Error(`实例「${rec.name}」没有在本次启动器会话中成功启动；端口 ${rec.port} 上的服务可能属于残留进程或其他程序。请先停止旧进程，再启动此实例。`)
      }
      if (await probePort(rec.port, 1500)) {
        const base = `http://127.0.0.1:${rec.port}`
        const token = rec.type === 'n' ? await existingNapcatTokenAsync(rec.dir) : undefined
        const url = rec.type === 'n'
          ? `${base}/webui/${token ? `?token=${encodeURIComponent(token)}` : ''}`
          : base
        await opts.webui.open(id, url)
        return
      }
      // 端口不通：这时候才告诉用户为什么打不开

      const why =
        rec.status === 'running'
          ? `服务没在 ${rec.port} 端口上响应——实例可能要重开一次`
          : rec.status === 'error'
            ? `实例出错了，没有可访问的服务（端口 ${rec.port} 无响应）`
            : `实例没在运行（当前「已停止」），先把它启动起来`
      throw new Error(why)
    },
    'webui:close': async (id) => {
      if (!opts.webui) throw new Error('窗口尚未就绪，无法关闭 WebUI')
      opts.webui.close(id)
    },
    'webui:list': async () => {
      if (!opts.webui) return []
      return opts.webui.list()
    },
    /**
 * ★ 当前**正在显示**的是谁的 WebUI（修"点 AstrBot 却看到 NapCat"） 主进程现在保证"同一时刻只有一个 WebUI 视图可见"（见 webui-manager 里 那段长注释：多个视图 bounds 相同会互相堆叠，用户点 A 却看到 B）。 界面靠这个通道如实显示"现在看的是谁" —— 否则工具条会写着 A、屏幕上是 B。
 */

    'webui:visible': async () => {
      if (!opts.webui) return undefined
      return opts.webui.visible?.()
    },
    // 状态优先问真实注册表（重启软件后也能正确回显），拿不到才用内存值    /**     * QQ 环境检测。     * NapCat 不是独立服务，它注入已安装的 QQ 客户端运行（看 NapCat 的 launcher.bat：     * NapCatWinBootMain.exe QQ.exe NapCatWinBootHook.dll）。没装 QQ 或版本太老，     * 实例必定起不来——所以在创建/启动前先问一次，好让界面弹窗引导去官网装。     */

    'qq:status': async () => {
      if (!opts.qqChecker) {
        // 测试/未接线环境：不误报，直接放行

        return { ok: true, installed: true, minBuild: 0 } satisfies QQInfo
      }
      return await opts.qqChecker()
    },
    /**
 * 用系统默认浏览器打开外部链接。 只放行 http/https：渲染层来的东西不能直接喂给 shell.openExternal， 否则一个 file:// 或自定义协议就可能被用来在本机执行东西。
 */

    'app:openExternal': async (url: string) => {
      let parsed: URL
      try {
        parsed = new URL(String(url))
      } catch {
        throw new Error(`链接格式不对：${url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`不允许打开这种链接：${parsed.protocol}`)
      }
      if (openExternal) {
        await openExternal(parsed.toString())
        return
      }
      const { shell } = await import('electron')
      await shell.openExternal(parsed.toString())
    },
    /**
 * 「开机自启」功能已整体移除（用户要求：算了去掉开机自启）。 原来的 app:autostart:status / app:autostart:set 两个 handler 一并删掉了， 不是只藏起界面按钮 —— 留着没人调的 handler、 以及 HandlerOpts 上的 setLogin/getLogin 注入点，只会让下一个人 以为这个功能还在，改起来互相牵连。 如果哪天要加回来：写 HKCU\...\CurrentVersion\Run 必须走 reg.exe **子进程**， 不能用 app.setLoginItemSettings（那个同步写注册表，实测卡 3 秒、界面僵住）。
 */

    'instance:creds': async (id) => {
      const { config: cfg, repo: r } = state()
      const rec = r.get(id)
      if (!rec) throw new Error(`实例不存在：${id}`)
      /**
 * 把 dataRoot 和 id 一起传进去。 AstrBot 首次运行会自动生成一个强密码，把哈希写进 cmd_config.json、 把**明文**在启动日志里打印一次。实例日志在 `<dataRoot>\logs\instances\<id>.log`，所以扫描凭据时必须能拿到这两样， 否则只能干巴巴地说「加密存储，无法查看」（用户明确抱怨过这句）。
 */

      return await scanCredentials({ dir: rec.dir, type: rec.type, id: rec.id, dataRoot: cfg.dataRoot })
    },
    'templates:status': async () => {
      const { config: cfg } = state()
      return getTemplates({ templatesRoot: join(cfg.dataRoot, 'templates') })
    },
    /**
 * 把一个实例切到另一个运行时版本（用户要的「高版本覆盖低版本、保留数据和配置」）。 ## 为什么是「改指针」而不是「覆盖文件」 这个架构里，实例**不复制**运行时：创建时只往 <实例目录>\instance.json 写一个 runtimeTag 指针（见 writeInstanceMeta / instantiateFromTemplate）， 运行时文件始终在 <dataRoot>\runtimes\<type>\<tag>\ 并被同类实例共享。 而实例自己的数据（AstrBot 的 data\、NapCat 的 config\、备份）全在实例目录里， 和运行时目录完全分离（见 runtime/layout.ts 的 workDir/cwd 处理）。 所以「换版本」= 改一个 tag + 刷新缓存字段， **数据和配置天然原样保留* —— 不需要复制、也不需要先备份再还原。 这正是用户要的效果，而且是这个架构白送的。 ## 为什么新写而不是改造 instance:update instance:update 用的是老的「模板」模型：把新版本的 runtime\ 目录 rename 进**实例目录**（见 updater.ts）。但实例目录里根本没有 runtime\ 这一层 （代码在 runtimes\ 下共享），而且它的 fetchManifest/fetchAsset 生产环境 从来没注入过、UI 也没有入口 —— 是彻底的死代码。 它的模型和现架构是正交的，硬改只会留下一堆必须靠注释解释的历史包袱。
 */

    'instance:setRuntime': async (p) => {
      const { repo: r } = state()
      const { config: cfg } = state()
      const rec = r.get(p.id)
      if (!rec) throw new Error(`实例不存在：${p.id}`)
      /**
 * ---- 1. 目标版本必须真实存在，且类型要对得上 ----
 */

      const store = runtimeStore(cfg.dataRoot)
      const target = store.list(p.type).find((x) => x.tag === p.tag)
      if (!target) {
        /**
 * ★ 提示要可执行，不能只说"还没下载"（用户 2026-09-26 的新交互带来的） 现在「换个版本」的列表是**从源上列**的（AstrBot 走 PyPI）， 所以用户完全可能选到一个**源上有、但本机还没装**的版本。 这时他需要知道"去哪装"，而不是一句技术性的拒绝。 实例的数据与配置此刻一根毫毛都没动 —— 也要说清楚，免得他慌。
 */

        throw new Error(
          `${p.tag} 还没有下载到本机，所以暂时切不过去。\n` +
            `请先到「下载」页安装这个版本，装好后回来再切（实例的数据和配置不会受影响）。`
        )
      }
      if (rec.type !== p.type) {
        throw new Error(`实例类型不匹配：它是 ${rec.type === 'a' ? 'AstrBot' : 'NapCat'}`)
      }
      /**
 * ---- 2. 当前版本：从 instance.json 读（不是 rec.templateVersion） ----
 */

      const currentTag = readInstanceTag(rec.dir) ?? store.latest(rec.type)?.tag
      /**
 * 比大小用的是 cmpVersion（正确处理 v4.10.0 > v4.9.9）， **绝不能**用 versionNumOf —— 它是有损指纹（v4.2.10 和 v4.21.0 都变 4210）， 拿来判方向会把降级当成升级。
 */

      if (currentTag && cmpVersion(p.tag, currentTag) === 0) {
        return { changed: false, from: currentTag, to: p.tag, dataPreserved: true }
      }
      /**
 * ---- 3. 运行中先停掉 ---- 必须先停：运行的进程可能还把配置握在手里、或退出时把旧值写回去； NapCat 更是注入 QQ 运行的，进程树跨了 QQ.exe，不停就直接换 会让"新版本"和"旧进程"同时存在。 停完登记宽限期，否则端口还没释放，列表会立刻把它探回「运行中」， 用户以为没停成功。这个三件套和 instance:stop 完全一致。 用 stopInstanceHard 而不是裸 killTreeSync：换版本这一步之后 会把实例指向另一个 runtimeTag，而 NapCat 注入的 QQ 如果没真停， 它仍占着旧版本的代码文件 —— 用户随后去「下载」页删旧版本时， 删除会半途失败、留下 `.deleting-*` 垃圾目录（正是用户报告过的 `runtimes\a\v4.27.0.deleting-mu0knsw0` 那个删不掉的目录）。 ★ 判活同样是**三者取或**（与 resetCreds / backup:make / backup:restore 同一套，见 resetCreds 那段长注释）： 盘上说在跑 OR liveStatusOf 说在跑 OR 端口通 只看 `rec.status` 会漏掉"盘上 stopped、实际在跑"； 只看 `liveStatusOf` 会漏掉"端口通但不是本进程启动的"（脱链 NapCat）—— 而后者正是"换完版本旧进程还在占文件"的场景。
 */

      const liveR = await liveStatusOf(rec)
      const portAliveR = await probePort(rec.port, 300)
      const wasRunning =
        rec.status === 'running' ||
        rec.status === 'starting' ||
        liveR.status === 'running' ||
        liveR.status === 'starting' ||
        portAliveR
      if (wasRunning) {
        /* 换版本紧接着要改实例的运行时指针 —— 旧进程还在会把旧版本的文件占住 */
        const stopped = await stopInstanceHard(pm, rec, (m) =>
          opts.logger?.log('WARN', 'proc', `换版本前停止实例 ${rec.name}：${m}`)
        )
        if (!stopped) {
          throw new Error(
            `实例「${rec.name}」没能停下来，所以**没有**换版本。\n` +
              `它还占着旧版本的文件，此时切换会让新旧进程同时存在。\n` +
              `请先手动关掉它（或占着端口 ${rec.port} 的程序），再重试。`
          )
        }
        r.updateStatus(rec.id, 'stopped')
        justStopped.set(rec.id, Date.now())
        // 等端口真的释放（按端口判活时才不会误判成 running）

        /*
         * ★ 这里原来写的是裸赋值 `gone = await ...` —— **没有声明**（TS2304）。
         *
         * 它靠"隐式全局变量"侥幸能跑，但在 ESM/严格模式下会直接抛
         * ReferenceError；而且一旦抛了，就被下面那个 catch 吞掉，
         * 表现为"等端口释放"这一步**静默没执行** ——
         * 于是换版本时可能在旧实例还没退干净时就开始动文件。
         *
         * 加 `let` 声明即可（外面 382/470/477 三处都是这么写的）。
         */
        let gone = false
        try {
          gone = await waitPortGone(rec.port, STOP_VERIFY_MS)
        } catch {
          /**
 * 端口没退干净也让流程继续，启动时会再校验一次
 */

        }
      }
      /**
 * ---- 4. 换指针 ----
 */

      writeInstanceMeta(rec.dir, rec, p.tag)
      /**
 * 这两个字段只是给界面显示的缓存，不参与启动判定（启动时以 instance.json 为准）。 **必须剥掉 tag 前面的 `v`**：`RuntimeVersion` 里根本没有 `version` 字段 （见 runtime-store.ts 的接口定义），所以 `target.version` 永远是 undefined，`?? p.tag` 每次都取到带 `v` 的 tag（如 `v4.28.0`）。 而 create（ipc.ts 的 instance:create）和 start 写进去的都是 detectInstanceVersion 出来的**裸版本号**（如 `4.18.19`）， 界面那边又会自己补一个 `v`（InstanceCard.vue： `inst.runtimeVersion ? \`v${inst.runtimeVersion}\` : '版本未知'`）。 两边一叠加就显示成 **`vv4.28.0`* —— 切换过版本的实例卡片上是双 v， 没切换过的正常。TypeScript 抓不到，因为 App.vue 里手写的类型 自称有 `version?: string`（跨进程契约漂移）。 这里统一成裸版本号，和 create/start 一致。
 */

      r.updateRuntimeVersion(rec.id, p.tag.replace(/^v/i, ''))
      refreshTemplateVersion(r, rec.id, versionNumOf(p.tag))
      opts.logger?.log(
        'INFO',
        'proc',
        `实例 ${rec.name} 版本 ${currentTag ?? '(未记录)'} → ${p.tag}（数据与配置保留）`
      )
      opts.audit?.record({ actor: 'user', action: 'instance.setRuntime', target: rec.name, result: 'ok', detail: `→ ${p.tag}` })
      /**
 * ---- 5. 停机过就顺手拉起来 ---- 用户点「更新到此版本」的意图显然是"换完继续用"， 停在那儿不动会让他以为更新把实例弄坏了。 起不来**不算更新失败**（版本已经切好了），把原因原样带回去让界面提示。
 */

      let restartError: string | undefined
      if (wasRunning) {
        try {
          await handlers['instance:start'](rec.id)
        } catch (e) {
          restartError = e instanceof Error ? e.message : String(e)
        }
      }
      return {
        changed: true,
        from: currentTag,
        to: p.tag,
        dataPreserved: true,
        restarted: wasRunning && !restartError,
        restartError
      }
    },
    /**
 * ══════════════════════════════════════════════════════════════════════ 「手动更新」：把实例升到该类运行时的最新版 ══════════════════════════════════════════════════════════════════════ ## 为什么需要它（用户的实测报错） 用户在 AstrBot 的 WebUI 里点「一键更新」，报： Exception: Error: You are running AstrBot via CLI, please use `pip` or `uv tool upgrade` to update AstrBot. 这不是故障，是 AstrBot 的**主动设计**：它检测到自己是被 `pip install --target` 装出来的（我们的运行时就长这样）， 于是禁用 WebUI 自更新，避免版本管理混乱 （见 src/main/update/template-source.ts:24 那条注释， 以及 astrbot/core/updater.py:407 的判据）。 所以"怎么更新"这个问题**必须由启动器回答**，不能指望 AstrBot 自己。 ## 为什么不在启动器里重新适配 GitHub 源码.zip 用户提到「GitHub 上的 AstrBot 得下源码.zip 才是本体」， 也给了 E:\AstrBot-4.28.0.zip。但实测现有链路后发现**不需要**： 1. 现在的 `runtime:install` 走 `pip install --target <运行时目录> astrbot==<ver>`， *pip 会自动解析并装好全部依赖**（那正是用户担心的"它需要很多依赖"）。 改用源码.zip 反而要我们自己去装几十个依赖 —— 更难，不是更好改。 2. WebUI 自更新被禁的真正原因不是"包不对"，而是"部署形态是 CLI"。 换成源码.zip 装上之后，AstrBot 依然会认为自己不是它管的那种安装。 3. uv 是管**全局 CLI 安装**的（`uv tool upgrade`）， 而我们的架构是"共享运行时目录 + 多实例各留数据"， 两者不兼容；用 uv 还要额外内置 uv 二进制并重建整套目录约定。 结论：**复用现有的、已被 e2e 验证过的安装链路**， 把"更新"实现为「装最新版 → 切指针」，一步到位。 ## 为什么必须"实例没在运行" 用户明确要求：「手动更新必须在 astrbot 没有运行的时候才能更新」。 技术上也是对的： · 更新会往 `runtimes/a/<新tag>/` 写文件，而正在跑的进程持有的是 *旧 tag* 的代码目录 —— 但换完指针后，旧目录可能还要被清理， 而 Windows 会锁住正在使用的文件（项目里已经踩过这个坑： `runtimes\a\v4.27.0.deleting-*` 删不掉的残骸）。 · 实例正在写自己的数据/配置时换版本，容易出现"新版本 + 旧写入"的混合态。 所以这里**显式拒绝**运行中的实例，让用户先停 —— 而不是像 instance:setRuntime 那样自动停了再换。 为什么与 setRuntime 的处理不同：setRuntime 是"切到我已经下载好的版本" （本地已有、瞬间完成），自动停一下再拉起是合理的便利； 而更新要先 `pip install` **几分钟**，中途把用户的实例停掉再让他等， 体验很差且不符合他"不运行时才更新"的明确要求。
 */

    'instance:update': async (p) => {
      const { repo: r, config: cfg } = state()
      const rec = r.get(p.id)
      if (!rec) throw new Error(`实例不存在：${p.id}`)
      /**
 * ---- 1. 运行中一律拒绝（用户明确要求 + 技术上也必须） ----
 */

      /**
 * ★ 必须问**实际**运行状态，不能只看 instances.json 里那个字段。 这一条是写测试时被逼出来的（测试里"运行中的实例"居然通过了检查）： `config:set` 里有一段**重启恢复**逻辑 —— 「PM 只活在内存里，instances.json 里的 running/starting 都是孤儿， 归位 stopped」（见上面 config:set 的注释）。 那段逻辑本意是好的（软件重启后清理孤儿状态），但它是**无条件**跑的： 任何一次配置保存（包括 `config:set({lastUpdateCheckAt})` 这种 跟实例毫无关系的单字段 patch）都会把盘上的 running 改成 stopped。 于是"读盘上的 status 判实例在不在跑"这个做法**不可靠* —— 恰好在更新操作之前发生过一次配置保存，就会把运行中的实例 误判成已停止，然后对着正在跑的实例去装/换版本。 正确判据是 `liveStatusOf`：它**先问进程管理器**（这个进程亲手起的 它是知道的），再回落端口探测，正是"现在到底在不在跑"的权威答案。 `instance:list` 用的也是它。
 */

      const live = await liveStatusOf(rec)
      /**
 * 判据要**同时**看 liveStatusOf 和进程管理器的原始状态。 为什么不能只看 liveStatusOf：它对 `starting` 的处理是"直接返回盘上 那个 status"（`if (rec.status === 'starting') return rec`）， 而进程管理器那边报 starting 时它会把实例归到"没在跑"那一类 （`procAlive = procStatus === 'running'`，starting 不算活的）。 而 starting 的实例**确实**在往旧版本目录里写东西（Python 正在 加载模块、NapCat 正在注入），换掉它等于对着一个正在启动的进程 动文件 —— 正是要避免的事。 所以这里把两个来源都算上： · liveStatusOf 的结果（盘上状态 + 端口/进程的综合判断） · pm.statusOf 的原始值（能区分 starting）
 */

      const procRaw = pm.statusOf(rec.id)
      const busyStatuses = ['running', 'starting']
      if (busyStatuses.includes(live.status) || busyStatuses.includes(procRaw ?? '')) {
        throw new Error(
          `${rec.type === 'a' ? 'AstrBot' : 'NapCat'} 正在运行，没法更新哦。`
            + '请先点「停止」，等它完全停下来之后再更新呀。'
        )
      }
      const store = runtimeStore(cfg.dataRoot)
      const currentTag = readInstanceTag(rec.dir) ?? store.latest(rec.type)?.tag
      /**
 * ---- 2. 找出最新版 ----
 */

      /**
 * 用 listVersions 而不是只看 store（已安装的）—— "更新"要的是**网上最新的**，本地装没装过都得先知道有没有新的。 includePrerelease: false：更新是常规动作，不该把 beta/rc 推给用户 （安装页那边让用户自己挑，那是显式选择，性质不同）。
 */

      let candidates: Array<{ tag: string; kind?: string }> = []
      try {
        candidates = (await listVersions({
          dataRoot: cfg.dataRoot,
          type: rec.type,
          // 测试注入时走假数据；生产不注入 → 走真实网络

          fetchJson: opts.fetchVersionJson,
          /**
 * 测试注入了 fetchJson 就**必须**同时禁掉缓存： version-catalog.ts:128 的契约是"注入 fetchJson 说明调用方要验解析， 不能被缓存短路"。少了这个参数，第二次调用会直接吃缓存、 我注入的假数据根本用不上（测试会莫名其妙地"通过"）。
 */

          noCache: opts.fetchVersionJson ? true : undefined
        })) as Array<{ tag: string; kind?: string }>
      } catch (e) {
        throw new Error(
          `取版本列表失败了（网络不通或源不可用）：${e instanceof Error ? e.message : String(e)}`
        )
      }
      if (!candidates.length) {
        throw new Error('没取到任何可用版本，检查一下网络或到「下载」页看看源是不是通的')
      }
      /**
 * ★ 必须自己把预发布版滤掉（这是写测试时抓出来的真 bug） `listVersions` **故意**不过滤测试版 —— 版本目录那边的注释写着「版本列表不过滤测试版：全都列出来， 由用户自己决定装不装」（version-catalog.ts:346）。 对「下载」页这是对的：用户显式挑一个版本，那是他的选择。 但"更新"是**自动**动作 —— 不该把 beta 推给用户。 不滤的话会出事：`4.30.0b1` 用 cmpVersion 比 `4.29.0` 大， 于是点一下「更新」，用户的稳定版就被换成一个 beta。 而 PyPI 那个读取器只在 `includePrerelease === false` **严格等于 false* 时才过滤（version-catalog.ts:263）， 传 undefined 是**不过滤**的 —— 我一开始就踩了这里。 判定方法沿用 catalog 自己的口径（:262）：版本号里带字母就是预发布。 注意 tag 有 `v` 前缀，得先剥掉再判，否则 `v4.29.0` 也会被当成带字母。
 */

      /**
 * 例外：PEP 440 的 post-release（`.postN`）不算预发布 （四厂商审计都点了这一点：`4.28.0.post1` 是修复发布， 按 PEP 440 比 4.28.0 还新，见字母就滤会误杀。AstrBot 现在没用 这种编号，属于"现在不疼、将来必坑"的 —— 修在判定里不留 TODO。 `post` 之后又挂 `dev` 的极端形态不照顾：那本来就是预发布。）
 */

      const isPrerelease = (tag: string): boolean => {
        const bare = tag.replace(/^v/i, '')
        if (/\.post\d+$/.test(bare)) return false
        return /[a-zA-Z]/.test(bare)
      }
      const stable = candidates.filter((c) => !isPrerelease(c.tag))
      if (!stable.length) {
        throw new Error('没找到可用的正式版本（只看到了测试版），稍后再试试吧')
      }
      /**
 * 找"最大的那个 tag"。 必须用 cmpVersion 逐个比，**不能**用 versionNumOf —— 它是有损指纹（v4.2.10 和 v4.21.0 都会变成 4210）， 拿它排序会把降级当升级。setRuntime 那边也踩过这个坑。
 */

      let newest = stable[0].tag
      for (const c of stable) {
        if (cmpVersion(c.tag, newest) > 0) newest = c.tag
      }
      /**
 * ---- 3. 已经是最新就不用动 ----
 */

      /*
       * ---- 3. 两种"看起来不用更新"的情况（主人 2026-09-27：
       *    「如果已经是最新版和版本未知，一键更新怎么处理」）----
       *
       * ## ① currentTag 有值且不比最新版旧 → 什么都不做
       *
       * 返回 updated:false + 一句人话。界面弹「没有更新」并说明原因 ——
       * **不能静默**（用户点了按钮，必须有个答复）。
       *
       * ## ② currentTag 为空（"版本未知"）→ **照常装最新版**
       *
       * 这是有意的选择，理由：
       *   · 版本读不出来的成因是"instance.json 没有 runtimeTag" ——
       *     那通常是**实例从没成功启动过**，而不是"它已经是最新"
       *   · 这种情况下用户点「一键更新」的真实意图就是"让它能跑起来"
       *   · 装最新版**正好解决这个问题**（顺带把版本指针写上）
       *
       * 反过来，如果这里也拦下（"不知道你什么版本，不更新"），
       * 用户会**卡在死循环**里：版本未知 → 不给更新 → 永远修不好。
       * 那比"多装一次"糟得多。
       */
      if (currentTag && cmpVersion(newest, currentTag) <= 0) {
        return {
          updated: false,
          from: currentTag,
          to: currentTag,
          reason: currentTag === newest ? '已经是最新版啦' : `当前 ${currentTag} 不比最新版 ${newest} 旧`
        }
      }
      if (!currentTag) {
        /*
         * 版本未知：**继续往下走**（装最新版），但记一条日志 ——
         * 这样用户问"为什么它又装了一遍"时，日志能回答。
         */
        opts.logger?.log(
          'WARN',
          'proc',
          `实例 ${rec.name} 的版本读不出来（instance.json 没有 runtimeTag）——` +
            '按"装最新版"处理（那通常能让它恢复可用）'
        )
      }
      opts.logger?.log(
        'INFO',
        'proc',
        `实例 ${rec.name} 手动更新：${currentTag ?? '(未记录)'} → ${newest}`
      )
      /**
 * ---- 4. 先确保目标版本已装好（没装过就装） ----
 */

      /**
 * 这里直接复用 runtime:install —— 它已经具备： · pip 依赖自动解析（用户担心的"很多依赖"由 pip 负责） · 装完核实本体在不在（astrbot/__init__.py） · 失败时清掉半个目录（不留假的"已安装"） · 进度事件（界面能看到"正在装"） 自己再写一遍只会把那些已验证的细节漏掉。
 */

      const already = store.list(rec.type).some((v) => v.tag === newest)
      if (!already) {
        await handlers['runtime:install']({ type: rec.type, tag: newest })
      }
      /**
 * ---- 5. 装好之后**再确认一次**实例没被启动 ----
 */

      /**
 * 安装要几分钟，这期间用户完全可能去点了「启动」。 装完直接切指针就会在运行中换版本 —— 正是要避免的事。 所以这里复查一次（第 1 步那次是"开始前"，这次是"落地前"）。 ★ 复查也用**活体判定**（四厂商审计指出不能只读盘上 status）： 原来这里 `r.get(rec.id).status` 读的是 instances.json —— 而那个值 可能被 config:set 触发前的"归位"污染过（就是第 1 步拦过的那个坑， 只是反过来：真正的 running 也可能被账面写成 stopped）。 现在 config:set 已改为只在首次/换根时归位，但**判活这件事 始终以 liveStatusOf + pm.statusOf 为准* —— 与第 1 步同一判据， 前后一致才不会"进来拦一次、出去换一套标准"。 （用户在安装期间真的点了启动 → instance:start 会把盘上 status 写成 running，liveStatusOf 也能探到活跃进程/端口。）
 */

      const afterRec = r.get(rec.id)
      if (afterRec) {
        const live2 = await liveStatusOf(afterRec)
        const raw2 = pm.statusOf(rec.id)
        const busy = ['running', 'starting']
        if (busy.includes(live2.status) || busy.includes(raw2 ?? '')) {
          return {
            updated: false,
            from: currentTag,
            to: newest,
            reason:
              `${newest} 已经装好啦，但实例在安装过程中被启动了，所以没有切换版本。`
              + '停掉之后再点一次「更新」就会切过去哦。'
          }
        }
      }
      /**
 * ---- 6. 切指针（复用 setRuntime：保数据、原子写、刷新显示字段） ----
 */

      const res = (await handlers['instance:setRuntime']({
        id: rec.id,
        tag: newest,
        type: rec.type
      })) as { changed: boolean; from?: string; to?: string }
      opts.audit?.record({
        actor: 'user',
        action: 'instance.update',
        target: rec.name,
        result: 'ok',
        detail: `${currentTag ?? '(未记录)'} → ${newest}`
      })
      return {
        updated: res.changed !== false,
        from: res.from ?? currentTag,
        to: res.to ?? newest,
        reason: res.changed === false ? '版本指针没有变化（可能已经是这个版本）' : undefined
      }
    },
    /**
 * 重置账密 / Token。 AstrBot：账号密码自己管，忘了要重置（写 data/cmd_config.json 的 dashboard.*）。 NapCat：重置 webui.json / onebot11_*.json 里的 token 为内置默认值。 这里原来**只允许 AstrBot**，理由是「NapCat 的 token 由启动器固定注入， 每次启动都写成 114514，没有重置这回事」—— 那个前提已经不成立了：启动器现在**不再覆盖**用户改过的 token （见 runtime/layout.ts 的 webuiToken 参数），所以 token 真的是用户在管， 他改乱了、忘了，就需要能重置回去。 重置前必须先停实例：实例在跑时配置可能被进程握在手里、或启动时又把旧值写回去， 结果就是「重置了还是登不上」。渲染层会先弹窗告知并让用户确认。
 */

    'instance:resetCreds': async (id) => {
      const { repo: r } = state()
      const rec = r.get(id)
      if (!rec) throw new Error(`实例不存在：${id}`)
      /**
 * ══════════════════════════════════════════════════════════════════════════ ★★ 判活：破坏性操作要**更保守**（子代理审计 + 真机测试共同逼出来的） ══════════════════════════════════════════════════════════════════════════ ## 为什么不能只看盘上的 `rec.status` `config:set` 的"重启恢复"会**无条件**把盘上残留的 running/starting 归位成 stopped（它自己的注释也承认）。于是「盘上=stopped、**实际在跑**」 真实可达（NapCat 注入的 QQ 脱链后尤其如此）。 这时不走进停止流程 → 直接抹凭据 → 那个活着的进程退出时把**旧 token 写回去* → 用户看到"重置了还是登不上"。 ## 但也不能只看 `liveStatusOf` `liveStatusOf` 的设计取舍是**给状态显示用的**：它刻意不让"端口通" 就认 running（否则别人占同号端口会把一个从没启动的实例显示成运行中 —— 那是踩过的真 bug，见它的长注释 A/B）。 于是它会把"**端口上真有进程、但那个进程不是我们启动的**" （脱链的 NapCat / 用户自己开的 QQ）判成 `stopped` —— 而这恰恰是"重置了还是登不上"最容易发生的场景！ `detached-process-kill.spec.ts` 那条用例就是为此存在的， 改成只看 `liveStatusOf` 之后它立刻红了（真机测试的价值）。 ## 所以：**两者取或* 在跑（对破坏性操作而言） = 盘上说在跑 OR liveStatusOf 说在跑 OR *端口通* 多停一次的代价是几秒；少停一次的代价是**用户数据被写坏**、 或者"重置了还是登不上"这种查半天的问题。方向必须选保守那边。 注意 `stopInstanceHard` 本身对"其实没在跑"是安全的： 它 kill 不到东西就直接返回（内部有等待与容错）。
 */

      const live = await liveStatusOf(rec)
      const portAlive = await probePort(rec.port, 300)
      const diskSaysRunning = rec.status === 'running' || rec.status === 'starting'
      const liveSaysRunning = live.status === 'running' || live.status === 'starting'
      const wasRunning = diskSaysRunning || liveSaysRunning || portAlive
      if (wasRunning) {
        /**
 * 用 stopInstanceHard：NapCat 注入的 QQ 脱链后 killTreeSync 杀不到， 它会一直占着 data 目录里的配置/凭据文件。那个进程退出时还可能 把**旧的 token 写回去* —— 于是"重置了还是登不上"。 settleMs=600 保留原来的静默等待（进程退了句柄未必立刻释放）。
 */

        const stopped = await stopInstanceHard(pm, rec, (m) =>
          opts.logger?.log('WARN', 'proc', `重置账密前停止实例 ${rec.name}：${m}`), 600
        )
        if (!stopped) {
          throw new Error(
            `实例「${rec.name}」没能停下来，所以**没有**重置账密。\n` +
              `它还占着配置文件，此时写入会被那个进程的退出覆盖回旧值（重置了也登不上）。\n` +
              `请先手动关掉它（或占着端口 ${rec.port} 的程序），再重试。`
          )
        }
        r.updateStatus(id, 'stopped')
        /**
 * 必须登记进 justStopped —— 和 instance:stop 同样的理由： taskkill 之后内核还要一点时间回收监听端口（FIN/TIME_WAIT）， 这期间 instance:list 的端口探测会误判成「还在跑」并把状态写回 running。 表现就是「重置了账密、界面却显示还在运行」，用户以为重置没生效。 （之前只给 instance:stop 加了宽限，漏了这一条路径。）
 */

        justStopped.set(id, Date.now())
      }
      const out = resetCredentials({ dir: rec.dir, type: rec.type })
      opts.logger?.log(
        'INFO',
        'proc',
        `实例 ${rec.name}(${rec.id}) 重置账密${wasRunning ? '，重置前已停止实例' : ''}`
      )
      return { list: out, stoppedFirst: wasRunning }
    },
    'instance:log': async (id) => {
      const { config: cfg, repo: r } = state()
      const rec = r.get(id)
      if (!rec) throw new Error(`实例不存在：${id}`)
      /**
       * ★★ 只显示**本次运行**的日志（主人 2026-09-27 的两点要求）
       *
       *   「翻翻日志功能改成只显示实例这次运行的日志」
       *   「为啥不是通过实例启动来判定」
       *
       * ## 判据：启动时记下的**字节偏移**（`rec.lastLogOffset`）
       *
       * 实例启动成功那一刻（`instance:start` 里 updateStatus('running') 之后），
       * 我们会把当时日志文件的长度记进实例记录。这里就**从那之后读** ——
       * 之前的都是历史运行，本次不会再混进来。
       *
       * ## 为什么不用"在日志里找标记"
       *
       * 我先试过两条弯路（都在真机日志上翻车了）：
       *   ① 自己写分隔线 `========== 启动于 … ==========`
       *      → 主人否掉了：「不需要分割线」——那行混在正文里对读日志的人是噪音
       *   ② 找 AstrBot 自己打的 `Welcome to AstrBot CLI!`
       *      → 仍在**猜文本**：换程序、改文案、用户手改日志就失效
       *
       * 主人的思路（"通过实例启动来判定"）才是对的：**启动是我们发起的**，
       * 那一刻文件多长我们完全知道，不需要任何猜测。
       *
       * ## 失效保护
       *
       * 用户可能删掉/清空过日志 —— 那时偏移会大于当前文件大小，
       * `readLogTail` 内部会退回"从头读"（宁可多给，不能给空）。
       *
       * 丢弃返回值里那两个字段（truncated / bootMarked）保持接口不变 ——
       * 渲染层只用到 text。
       */
      return readLogTail(instanceLogFile(cfg.dataRoot, id), 500, {
        fromOffset: rec.lastLogOffset
      }).text
    },
    // 备份前会先把实例停下来（跑着的时候数据在写，备份出来是坏的）。
    // 渲染层会先弹窗告知并让用户确认，确认后才走到这里。

    'backup:make': async (id) => {
      const { repo: r } = state()
      const rec = r.get(id)
      if (!rec) throw new Error(`实例不存在：${id}`)
      /**
 * ★ 判活：**盘上 / liveStatusOf / 端口通，三者取或* —— 与 resetCreds 同一套。 盘上写 stopped 而实际在跑时，这里会**不停机就备份* —— 归档里是半写状态的数据：用户以为有备份，真要用时才发现是坏的。 而只看 liveStatusOf 又不够（它刻意不认"端口通但不是我们启动的"， 那是给状态显示用的取舍）—— 脱链的 NapCat 正属于这种， 而它此刻正在往 data 目录里写。
 */

      const live0 = await liveStatusOf(rec)
      const portAlive0 = await probePort(rec.port, 300)
      const wasRunning =
        rec.status === 'running' ||
        rec.status === 'starting' ||
        live0.status === 'running' ||
        live0.status === 'starting' ||
        portAlive0
      if (wasRunning) {
        /**
 * 停实例（**彻底停**），并把状态落成 stopped。 这里原来只做 `pm.killTreeSync(id)` + 固定 sleep 600ms。 但 NapCat 是**注入进 QQ.exe* 跑的，QQ 起来后就脱离了我们 spawn 的父子链 —— `taskkill /T` 按父子关系递归，**杀不到它**。 那个 QQ 可能还在写 data 目录，而打包已经开始， 结果就是**归档里是半写状态的数据**：用户以为有备份， 等真要用的时候才发现备份是坏的。 现在统一走 stopInstanceHard（和 instance:stop / 迁移数据目录同一套）， 它会等端口真正释放、必要时按端口精确补杀。
 */

        const stopped = await stopInstanceHard(pm, rec, (m) => opts.logger?.log('WARN', 'proc', `备份前停止实例 ${id}：${m}`), 600)
        if (!stopped) {
          throw new Error(
            `实例「${rec.name}」没能停下来，所以**没有**备份。\n` +
              `它还在写数据目录，此时打包会得到一份半写状态的归档 ——\n` +
              `你以为有备份，真要用时才发现是坏的。\n` +
              `请先手动关掉它（或占着端口 ${rec.port} 的程序），再重试备份。`
          )
        }
        r.updateStatus(id, 'stopped')
        /*
         * ★ 必须登记 justStopped（独立审查抓出的不一致，主人 2026-10-08）
         *
         * 同族的三处调用点（setRuntime `:2416`、resetCreds `:2709`、
         * backup:restore `:2930`）都登记了，**只有这里漏了**。
         *
         * 后果很具体：备份是**长活**（几十秒到几分钟），期间界面每 2 秒
         * 轮询 `instance:list` → `liveStatusOf` 靠 `justStopped` 的宽限期
         * 判"刚停过的算已停止"。没登记 → taskkill 后端口还在 FIN/TIME_WAIT
         * → 探到端口通 → 把刚写下的 `stopped` 又探回 `running`。
         *
         * 用户看到的是：「备份前已停止实例」（日志说了）但卡片显示运行中，
         * 于是怀疑备份到底有没有正确停实例。
         */
        justStopped.set(id, Date.now())
      }
      /**
 * backupRuntime 现在是 **async**（主人要求：「能异步的全异步」）—— 它内部会递归读实例数据 + gzip 压缩，同步版会把主进程冻住几百毫秒。 这里 await 它；handler 本身已经是 async，不影响任何调用方。
 */

      const result = await backupRuntime({ dir: rec.dir, templateVersion: rec.templateVersion })
      const removed = pruneBackups({ dir: rec.dir, keep: state().config.backupKeep })
      opts.logger?.log(
        'INFO',
        'proc',
        `实例 ${rec.name} 手动备份 v${rec.templateVersion}（顺带清理 ${removed.length} 份旧备份）${wasRunning ? '，备份前已停止实例' : ''}`
      )
      return { ...result, stoppedFirst: wasRunning }
    },
    'backup:list': async () => {
      const { config: cfg } = state()
      const all = listBackups({ dataRoot: cfg.dataRoot })
      const items = all.map((x) => {
        const rec = repo!.get(x.instanceId)
        return { ...x, instanceName: rec?.name ?? x.instanceId }
      })
      /**
 * 连带返回备份的根目录，让界面能告诉用户「东西在这台机器的哪儿」。 用户要的是**文件夹位置**（一个），而不是每条备份各自的完整路径 —— 每实例一个 backups 子目录，逐条列路径既啰嗦又没多给信息。 所以这里给根，界面显示一次；每条只显示自己的子目录名。
 */

      return { items, folder: backupsFolderFor({ dataRoot: cfg.dataRoot }) }
    },
    /**
 * 覆盖更新时安装器自动打的整库数据备份列表。 用户要求「覆盖更新的时候会自动打包数据备份压缩包放在备份文件夹」—— 那些包是**安装器**打的（放在 `<dataRoot>\backups\update\<时间戳>\`）， 程序这边只负责**展示**，让用户在界面上看得到、找得着、能打开文件夹。 顺带做一次清理（保留 config.backupKeep 份）：启动时也清， 但用户可能一直不重启程序就反复更新，打开这一页时再清一次更保险。 清理失败不影响列表返回。
 */

    'backup:updateList': async () => {
      const { config: cfg } = state()
      try {
        await pruneUpdateBackupsAsync(cfg.dataRoot, cfg.backupKeep)
      } catch {
        /**
 * 清理是尽力而为，绝不因为它失败就不给用户看列表
 */

      }
      const items = await listUpdateBackupsAsync(cfg.dataRoot)
      return { items, folder: updateBackupsRoot(cfg.dataRoot) }
    },
    /**
 * 在资源管理器里打开备份文件夹。 走 shell.openPath 而不是 openExternal：这是本地目录，不是 URL。 目录不存在时先建出来 —— 用户点「打开文件夹」时还没有任何备份是很正常的， 弹一句「路径不存在」纯属添堵。
 */

    'backup:openFolder': async (folder) => {
      const { config: cfg } = state()
      const base = backupsFolderFor({ dataRoot: cfg.dataRoot })
      /**
 * 只允许打开数据根下的备份目录：这个入参最终会进 shell.openPath。 为什么不能只写 folder.startsWith(base)： 1) 前缀匹配不认目录边界 —— `...\backups-evil` 也 startsWith `...\backups`， 于是能打开同级的兄弟目录； 2) 不规范化就比不出来 —— `...\backups..\..\Windows` 字面上带前缀， 真正解析出来的却跑到数据根外面去了。 正确做法：两边都 resolve 成绝对规范路径，再要求 「相等 或 以 base + 分隔符 开头」——这样目录边界和 .. 都被算清楚了。
 */

      const norm = (p: string): string => resolve(p)
      const nBase = norm(base)
      const nFolder = norm(folder)
      const inside = nFolder === nBase || nFolder.startsWith(nBase + sep)
      if (!inside) throw new Error('不允许打开这个路径')
      mkdirSync(nFolder, { recursive: true })
      const err = await opts.openPath(nFolder)
      if (err) throw new Error(`打不开文件夹：${err}`)
      opts.logger?.log('INFO', 'backup', `打开备份文件夹 ${nFolder}`)
    },
    /**
 * 读审计日志：默认今天，也可指定某天。 返回原文（一行一条），界面自己排版——审计的约定就是「一条一行」， 在这层解析成结构化反而容易和写入口径不一致。
 */

    'audit:read': async (date?: string) => {
      const { config: cfg } = state()
      /**
 * ★ 必须和 audit:days 用**同一个**数据根（审计抓出的真问题） 原来这里是 `opts.audit ?? createAuditLog({ dataRoot: cfg.dataRoot })`。 生产环境注入了 opts.audit，而它是在 registerIpcHandlersReal 里 用 **启动时* 的 defaultDataRoot() 建出来的、之后**永不重建* （createAuditLog 的目录在构造时就定死了，见 logs/audit.ts）。 于是用户**迁移过数据目录**之后： · audit:days 用 cfg.dataRoot（新目录）→ 列出新目录的日期 · audit:read 读 opts.audit（老目录）→ 新目录的日期当然读不到 两处指向不同目录，审计页**必然永远是空的**，而数据其实还在旧目录里。 同一个文件里刚有注释强调过「用 liveRoot()」，作者知道这条规则 但漏了 audit —— 典型的"修一处忘一处"。 修法：不再信任启动时那个实例，**每次都按当前 cfg.dataRoot 现建**。 createAuditLog 只是拼个路径（见其实现在构造时不读盘）， 所以每次现建不贵；这样 audit:read 与 audit:days 永远指向同一处。
 */

      const a = createAuditLog({ dataRoot: cfg.dataRoot })
      return a.read(date)
    },
    'audit:days': async () => {
      const { config: cfg } = state()
      return listAuditDays({ dataRoot: cfg.dataRoot })
    },
    /**
 * 删除/回滚一个备份。 ## 为什么必须校验路径 这两个 handler 的入参是**渲染层给的字符串路径**，而底层分别是 `unlinkSync(file)` 和 `readFileSync(file)`。原来直接透传，等于 「界面说什么就删什么」。 风险不是理论上的： - 这个启动器**自我提权到管理员**（NapCat 注入 QQ 需要）， 所以「任意删文件」= 「以管理员身份任意删文件」； - 页面里将来任何一处 IPC 转发/注入都会把这条路放大； - 普通用户也能踩到：备份记录是扫盘来的，用户在资源管理器里 把归档挪走或改名、界面没刷新，再点「删除」就可能删错东西。 注意同一个文件里的 `backup:openFolder` **本来就是校验的* （resolve 之后要求落在备份根目录内）—— 同一类入参，一个做了、 另两个漏了，正是「修一处忘两处」的典型。 允许的范围：`<dataRoot>\instances\` 底下的 `*.tar.gz` 和配套 `*.json`。那才是备份真正住的地方（每实例一个 `backups\` 子目录）。
 */

    /**
 * ══════════════════════════════════════════════════════════════════════ ★ 备份路径校验：不能靠"后缀白名单"（审计抓出的严重问题） ══════════════════════════════════════════════════════════════════════ 原来的写法是： assertInsideInstances(cfg.dataRoot, file, { allowExt: ['.tar.gz', '.json'] }) 然后 `deleteBackup` 会 `unlinkSync(file)`（还会顺带删同名的 .json）。 问题在于实例目录里的关键文件**全都是 `.json`**： · `<inst>\instance.json` ← 版本绑定的**唯一真相* · `<inst>\data\cmd_config.json` ← AstrBot 账密 + 模型 API key + 插件开关 + 人格 · `<inst>\config\webui.json` ← NapCat 的 token / 端口 · `<inst>\config\onebot11_*.json` 而校验只要求"在 instances\ 下面 + 以 .json 结尾"—— 上面这些**全部通过**。渲染层只要调一次 backup.del(那路径) （preload/api-map.ts 是开放通道），就能删掉它们。 而这个进程会**自我提权到管理员**（NapCat 注入 QQ 需要）， 于是这等于"管理员权限下的任意 .json 删除原语"。 删 instance.json 会让实例与运行时的绑定丢失，之后可能被切到错误版本； 删 cmd_config.json 则是用户配置与 API key 永久消失。 ## 修法：不用后缀，改用**备份命名规则 + 目录位置**双约束 备份的真实形态（backup.ts:82-84 写入、backup-list.ts:39-44 扫描）： <dataRoot>\instances\<类型>\<实例>\backups\<时间戳>-v<版本>.tar.gz 配套的清单是**同名**的 `.json`（deleteBackup 会一起删）。 所以校验变成三条： 1. 在 instances\ 之下（原样保留，防目录穿越） 2. **父目录必须叫 backups* —— 关键文件都不在 backups\ 里 3. 文件名必须匹配备份形状（`\d{14}-v\d+` 开头，或以它 + .json 结尾） 第 2 条是关键：它把"删任意 .json"收紧成"删备份目录里的文件"， 而备份目录里除了备份本身不该有别的东西。 另外 `deleteBackup` 也只是 unlink 一个文件（不递归、不删目录）， 所以这些约束足够，不需要更复杂的机制。
 */

    'backup:del': async (file) => {
      const { config: cfg } = state()
      const safe = assertBackupFile(cfg.dataRoot, file, { exts: ['.tar.gz', '.json'] })
      deleteBackup({ file: safe })
    },
    'backup:restore': async (args) => {
      const { repo: r, config: cfg } = state()
      const rec = r.get(args.instanceId)
      if (!rec) throw new Error(`实例不存在：${args.instanceId}`)
      /**
 * 用同一个严格校验（理由见上面 backup:del 那段长长的说明）。 回滚的入参也来自渲染层，而且它会把归档**解压覆盖**到实例目录 —— 比删除更需要确认"这真的是一个备份归档"， 而不是某个恰好以 .tar.gz 结尾的奇怪文件。
 */

      const safe = assertBackupFile(cfg.dataRoot, args.file, { exts: ['.tar.gz'] })
      // 关键操作标记：回滚会覆盖实例数据，崩溃时必须知道"死在回滚里"

      opStart(opts.logger, 'backup:restore', `${rec.name} ← ${safe}`)
      try {
      /**
 * ★ 判活：**三者取或* —— 与 resetCreds / backup:make 同一套。 回滚会把归档**解压覆盖**到实例目录 —— 若那个"盘上说 stopped、 实际还在跑"的进程活着，它会一边被覆盖一边往文件里写， 结果是**回滚后数据仍然不一致**（用户以为回滚成功了）。
 */

      const live1 = await liveStatusOf(rec)
      const portAlive1 = await probePort(rec.port, 300)
      if (
        rec.status === 'running' ||
        rec.status === 'starting' ||
        live1.status === 'running' ||
        live1.status === 'starting' ||
        portAlive1
      ) {
        /**
 * 用 stopInstanceHard：紧接着 restoreBackup 会覆盖实例目录里的文件。 NapCat 注入的 QQ 如果还活着（脱链，killTreeSync 杀不到）， 它会在解压的同时继续写 data 目录 —— 归档解出来的内容被覆盖成 新旧混合的坏状态，用户以为回滚成功了，实际拿到一份半新半旧的数据。 备份/回滚这类"对着实例目录动文件"的操作，最不能容忍还有进程在写， 所以这里也必须等端口真的退干净（stopInstanceHard 内部会等）。
 */

        const stopped = await stopInstanceHard(pm, rec, (m) =>
          opts.logger?.log('WARN', 'proc', `回滚前停止实例 ${rec.name}：${m}`)
        )
        if (!stopped) {
          throw new Error(
            `实例「${rec.name}」没能停下来，所以**没有**回滚。\n` +
              `它还在写数据目录，此时解压归档会被它盖成新旧混合的坏状态。\n` +
              `请先手动关掉它（或占着端口 ${rec.port} 的程序），再重试回滚。`
          )
        }
        r.updateStatus(args.instanceId, 'stopped')
        // 登记宽限期：回滚完状态必须稳稳显示「已停止」（用户刚点完，最容易盯着看）

        justStopped.set(args.instanceId, Date.now())
      }
      /**
 * await：restoreBackup 现在是 async（尾部的残骸清理走异步删， 见 backup.ts 的注释）。这里 await 它，既让"回滚完成"这句 含义真实（残骸也清完了），又不阻塞事件循环。
 */

      await restoreBackup({
        dir: rec.dir,
        file: safe,
        // 把它接进项目统一日志：清理残骸失败时能归因（见 backup.ts 尾部的异步删除）

        log: (msg, detail) => opts.logger?.log('WARN', 'store', msg, detail)
      })
      r.updateStatus(args.instanceId, 'stopped')
      opts.logger?.log('INFO', 'proc', `实例 ${rec.name} 回滚到备份 ${safe}`)
      } finally {
        /**
 * 结束标记放 finally：**异常也算结束**。 只有"进程被杀/断电"才会出现"有 start 没有 end" —— 那才是我们要定位的情况；把普通异常也报成"卡在这一步" 只会让这个标记失去意义。
 */

        opEnd(opts.logger, 'backup:restore')
      }
    },
    'mirrors:test': async () => {
      const { config: cfg } = state()
      return testMirrors({ dataRoot: cfg.dataRoot })
    },
    'mirrors:state': () => {
      const { config: cfg } = state()
      return loadMirrors(cfg.dataRoot)
    },
    'mirrors:add': (m) => {
      const { config: cfg } = state()
      opts.logger?.log('INFO', 'app', `新增镜像源 ${m.label}（${m.base}）`)
      return addCustomMirror(cfg.dataRoot, m)
    },
    'mirrors:remove': (base) => {
      const { config: cfg } = state()
      return removeCustomMirror(cfg.dataRoot, base)
    },
    'mirrors:pref': (patch) => {
      const { config: cfg } = state()
      const st = setMirrorPref(cfg.dataRoot, patch)
      /**
 * 注意这里**只记 NapCat**（GitHub 代理源）。 AstrBot 的那一份已经搬到 `pysrc:*`（Python 源，pip 用）—— 两类源的语义完全不同，日志里也不再混着说， 否则排查时会把"给 NapCat 换的源"当成 AstrBot 的。
 */

      opts.logger?.log('INFO', 'app', `首选镜像源（NapCat/GitHub）：${st.pref.n || '自动'}`)
      return st
    },
    /**
 * ══════════════════════════════════════════════════════════════════════ AstrBot 的 **Python 源**（pip 索引）—— 独立于上面的 GitHub 代理源 ══════════════════════════════════════════════════════════════════════ 主人 2026-09-26：「把 astrbot 从 GitHub 源剥离，单独做一个 python 源 来安装 astrbot」+「github 源只有 napcat」。 为什么用新前缀 `pysrc:` 而不是复用 `mirrors:`： 两类源的字段与语义都不同（pip 索引 vs GitHub 代理前缀）， 复用会让界面和日志里两套东西继续混在一起 —— 那正是这次要拆开的原因。
 */

    'pysrc:state': () => {
      const { config: cfg } = state()
      const st = loadPythonSources(cfg.dataRoot)
      const active = resolvePythonSource(cfg.dataRoot)
      return { ...st, active }
    },
    /**
 * ★ Python 源的测速与可用性（主人 2026-09-27：「加入和 github 一样的测通断」） 与 `mirrors:test` 完全对称：界面每张源卡片都要有"可用 xxx ms"徽章。 之前 Python 源那栏什么都没有，因为延迟是**写死在 note 里的* （"实测唯一可列版本·下载稳定"之类）—— 我们的实测环境 ≠ 用户的网络， 那种文案既不准也不该占版面。现在当场测。
 */

    'pysrc:test': async () => {
      const { config: cfg } = state()
      const { testPythonSources } = await import('./update/python-source-test')
      const st = loadPythonSources(cfg.dataRoot)
      return testPythonSources({ sources: st.sources })
    },
    'pysrc:pref': (label) => {
      const { config: cfg } = state()
      const st = loadPythonSources(cfg.dataRoot)
      const custom = st.sources.filter((s) => !s.builtin)
      savePythonSources(cfg.dataRoot, { custom, pref: String(label ?? '') })
      const active = resolvePythonSource(cfg.dataRoot)
      opts.logger?.log('INFO', 'app', `AstrBot 的 Python 源切换为：${active.label}（${active.indexUrl}）`)
      return { ...loadPythonSources(cfg.dataRoot), active }
    },
    'pysrc:add': (s) => {
      const { config: cfg } = state()
      const st = loadPythonSources(cfg.dataRoot)
      const custom = st.sources.filter((x) => !x.builtin)
      const label = String(s.label ?? '').trim() || String(s.indexUrl ?? '').trim()
      const indexUrl = String(s.indexUrl ?? '').trim()
      if (!indexUrl) throw new Error('索引地址不能为空（形如 https://example.com/simple/）')
      if (!/^https?:\/\//i.test(indexUrl)) throw new Error('索引地址必须以 http:// 或 https:// 开头')
      if (st.sources.some((x) => x.indexUrl === indexUrl)) throw new Error('这个源已经加过了')
      custom.push({ label, indexUrl, jsonApi: s.jsonApi, note: '自定义' })
      savePythonSources(cfg.dataRoot, { custom, pref: st.pref })
      opts.logger?.log('INFO', 'app', `新增 Python 源 ${label}（${indexUrl}）`)
      return { ...loadPythonSources(cfg.dataRoot), active: resolvePythonSource(cfg.dataRoot) }
    },
    'pysrc:remove': (indexUrl) => {
      const { config: cfg } = state()
      const st = loadPythonSources(cfg.dataRoot)
      const target = st.sources.find((x) => x.indexUrl === indexUrl || x.label === indexUrl)
      if (!target) throw new Error('找不到这个源')
      if (target.builtin) throw new Error('内置源不能删除')
      const custom = st.sources.filter((x) => !x.builtin && x.indexUrl !== target.indexUrl)
      // 删掉的正好是当前首选 → 清空 pref（回落到默认源）

      const pref = st.pref === target.label || st.pref === target.indexUrl ? '' : st.pref
      savePythonSources(cfg.dataRoot, { custom, pref })
      return { ...loadPythonSources(cfg.dataRoot), active: resolvePythonSource(cfg.dataRoot) }
    },
    'templates:download': async (type) => {
      const { config: cfg } = state()
      const dest = join(cfg.dataRoot, 'templates', type === 'a' ? 'astrbot' : 'napcat')
      const r = await downloadTemplate({
        type,
        dataRoot: cfg.dataRoot,
        destDir: dest,
        /**
 * ★ 接线 onSourceTried（复审抓出的"定义了但没人传"） 这个回调在 `runtime-download` 里早就实现了（每个源成功/失败都会调）， 但唯一的生产调用方**没有传它* —— 于是"下载失败"时日志里 只有耗时，**看不出是哪个源、什么错误、试了几个**。 用户报「下载失败」时我们只能猜，而真实原因就在这个回调里。 失败记 WARN（要能一眼看到是哪个源不行），成功记 INFO（便于对账顺序）。
 */

        onSourceTried: (base, ok, err) => {
          if (ok) {
            opts.logger?.log('INFO', 'dl', `${type === 'a' ? 'AstrBot' : 'NapCat'} 运行时：源 ${base} 下载成功`)
          } else {
            opts.logger?.log(
              'WARN',
              'dl',
              `${type === 'a' ? 'AstrBot' : 'NapCat'} 运行时：源 ${base} 失败，换下一个`,
              err
            )
          }
        }
      })
      opts.logger?.log(
        'INFO',
        'proc',
        `${type === 'a' ? 'AstrBot' : 'NapCat'} 运行时已下载 v${r.version}（来源 ${r.from}）→ ${dest}`
      )
      return r
    },
    'versions:list': async (p) => {
      const { config: cfg } = state()
      /**
 * 默认走缓存（用户要求：别每次打开都重新获取）。 用户显式点「刷新」时传 noCache=true 强制走网络。
 */

      return listVersions({
        dataRoot: cfg.dataRoot,
        type: p.type,
        onlyBase: p.base,
        includePrerelease: p.includePrerelease,
        noCache: p.noCache === true
      })
    },
    /**
 * 启动时静默预热版本列表缓存。 用户要求：「改成启动时静默检测并缓存，出现更新操作（下载/删除）再更新」。 这里在后台把两类都拉一遍，不阻塞界面；用户第一次进下载页时 缓存已经就绪，直接就出来了。 失败**完全静默* —— 预热只是让界面更快，网络不通时不该弹任何东西， 用户真的需要列表时会在下载页看到正常的错误提示。
 */

    'versions:prewarm': async () => {
      const { config: cfg } = state()
      /**
 * 两类预热 **并行**（四厂商审计的低危项）： 它们是两个独立的网络请求，串行只是让第二类多等一轮 RTT， 对启动预热这种"越快越好"的场景毫无好处。
 */

      const jobs = (['a', 'n'] as const).map(async (type) => {
        try {
          await listVersions({ dataRoot: cfg.dataRoot, type })
        } catch {
          /**
 * 预热失败无所谓：不影响任何功能，用户要用时会自己重试
 */

        }
      })
      await Promise.all(jobs)
      return { ok: true }
    },
    /**
 * 按用户选的版本 + 源下载，落进 runtimes/<type>/<tag>（多版本并存）
 */

    'runtime:install': async (p) => {
      /**
 * ★ 安装互斥（见 pendingInstalls 的说明） 锁覆盖**整个**安装过程（找版本 + 装包 + 替换 + 收尾）， 以 `<type>:<tag>` 为键：同一个版本装两次直接报错回来， 不排队 —— 几分钟的隐式队列只会越积越多。 不同版本之间不互斥（装 v4.28.0 的同时可以装 NapCat）。
 */

      const lockKey = taskKey(p.type, p.tag)
      /*
       * 互锁：**同一个版本**只允许一个任务在跑（安装 / 导入共用这个键）。
       *
       * ## 粒度为什么是"同版本"而不是"全局串行"
       *
       * 装 AstrBot 的同时装 NapCat 是**无害的** —— 它们写不同目录、
       * 各自用各自的源，串行只会让用户白等（装 AstrBot 要几分钟）。
       * 主人选的也是这个粒度。
       *
       * 而"同一个版本一边装一边导入"**必须挡**：两个流程会同时写
       * 同一个目录（解压、pip、原子替换互相踩），那是真会互相破坏的。
       * 主人实测遇到过（日志里 `runtimes:importFile` 跑了 201 秒的
       * 同时 `runtime:install` 又开了同一个版本）。
       */
      if (findTask(lockKey)) {
        throw new Error(
          `这个版本正在安装中（${p.type === 'a' ? 'AstrBot' : 'NapCat'} ${p.tag}），` +
            `不要重复点哦。进度条走完（或报错）会让界面恢复的。`
        )
      }
      const task = beginTask({
        key: lockKey,
        kind: 'install',
        controller: new AbortController(),
        label: `${p.type === 'a' ? 'AstrBot' : 'NapCat'} ${p.tag}`
      })
      /*
       * 理论上不会为 null（上面刚 findTask 过），但并发下仍可能竞争 ——
       * 真出现就当"已经有任务在跑"处理，别往下走。
       */
      if (!task) {
        throw new Error(`${p.tag} 已经在装了，等它完成或先取消它。`)
      }
      /* 取消信号：下载的 fetch 与 pip 子进程共用它 */
      const signal = task.controller.signal
      /*
       */
      // 关键操作标记：装机要几分钟，崩溃时"只有 start"就能定位到具体版本

      opStart(opts.logger, 'runtime:install', `${lockKey}`)
      try {
        const { config: cfg } = state()
        const st = loadMirrors(cfg.dataRoot)
        /**
 * ══════════════════════════════════════════════════════════════════════════ ★★ `p.base` 现在的语义是"**用户点的那个 pip 源**"，不能当 onlyBase 用 （主人 2026-09-27 的改动引入的回归，靠测试抓出来） ══════════════════════════════════════════════════════════════════════════ ## 背景 界面上「Python源 / 腾讯源 / 清华源」的下载按钮，现在传的是 `pip 索引地址`（如 `https://mirrors.cloud.tencent.com/pypi/simple/`）—— 因为要求"点哪个源就用哪个源装"（见下面选 pySrc 的那段）。 而**列版本**是另一回事：AstrBot 的版本来自 **PyPI 元数据** （`https://pypi.org/pypi/astrbot/json`）。pip 索引源上**根本没有 `versions.json`** —— 拿它当 onlyBase 去过滤，结果必然是空列表： `找不到 v4.28.0 这个版本，刷新一下版本列表` （这正是 `pick-source-real.spec.ts` 5 条全红的原因） ## 修法：只有"真镜像源"才当 onlyBase `st.mirrors` 里的是 GitHub/官方文件源（它们**有** versions.json）， pip 索引源不在其中。所以： · `p.base` 能在 st.mirrors 里找到 → 它是镜像源，当 onlyBase（原行为） · 找不到（是 pip 索引地址）→ **不传 onlyBase**， 让 version-catalog 走"AstrBot 不指定源 → 列 PyPI 全量"那条正路
 */
        const isMirrorBase = st.mirrors.some((m) => m.base === p.base)
        const prefBase = isMirrorBase ? p.base! : (st.pref[p.type] ?? '')
        /*
         * 这里原来还有一个 `const mirror = st.mirrors.find(...)`，只用来
         * 给下载传 `onlyBase: mirror?.base ?? prefBase` —— 那是"锚死首选源、
         * 不回退"的根源（见下面下载处那段说明）。现在改成按
         * **用户有没有显式点源**（`isMirrorBase`）决定，那个变量就没用了，
         * 清掉以免误导后来者以为"首选源要锁死"。
         */
      const list = await listVersions({
        dataRoot: cfg.dataRoot,
        type: p.type,
        /**
 * ★ 关键：pip 索引源不能当 onlyBase（它没有 versions.json）。 用 `undefined` 让 version-catalog 走"AstrBot 列 PyPI"的正路。
 */
        onlyBase: isMirrorBase ? prefBase : undefined,
        includePrerelease: true
      })
      const pick = list.find((v) => v.tag === p.tag)
        // 首选源上没这个版本时，从全量结果里找（多为 PyPI 那条）        ?? (await listVersions({ dataRoot: cfg.dataRoot, type: p.type, includePrerelease: true })).find((v) => v.tag === p.tag)

      if (!pick) throw new Error(`找不到 ${p.tag} 这个版本，刷新一下版本列表`)
      const store = runtimeStore(cfg.dataRoot)
      const dest = store.dirFor(p.type, pick.tag)
      const pyExe = pythonExeFor(cfg.dataRoot)
      /**
 * AstrBot：PyPI 包 → 用内置 Python 的 pip 装进这个版本目录 ══════════════════════════════════════════════════════════════════════ ★ 装进**暂存目录**，成功后才原子替换（修「重装毁掉可用运行时」） ══════════════════════════════════════════════════════════════════════ ## 原来的两个错（来自真实的崩溃日志） `acb-logs-20260914-230529.zip` 的审计日志里： 23:01:13 runtime:install AstrBot v4.28.0 成功 ← 装好了，实例能跑 23:04:11 runtime:install AstrBot v4.28.0 失败 :: ... shutil.py line 863 in move / os.py line 225 in makedirs FileExistsError: [WinError 183] 当文件已存在时，无法创建该文件: '...\runtimes\a\v4.28.0\bs4' 23:05:15 instance:start 1 失败 :: AstrBot 运行时结构不对（...\runtimes\a\v4.28.0），重新下载这个版本 用户只是**又点了一次同一个版本**，那个好好的运行时就被毁了。两个原因叠加： 1. `pip install --target dest` 装进一个**已存在且已有包**的目录。 pip 内部用 `shutil.move` 搬运包，目标子目录（`bs4`）已存在时 Windows 的 `makedirs` 抛 WinError 183（POSIX 会覆盖，Windows 不会）。 2. 失败分支里 `removeDirAsync(dest)` **把整个目标目录删掉* —— 连那份原本可用、正在被实例使用的安装一起删了。 所以用户不是"没更新成"，而是"环境没了"。 ## 修法（指导书里说的"可逆性最强的方案"） 1. pip 装进 `<dest>.stage-<rand>`（全新空目录，不会再撞 WinError 183） 2. 校验本体真的在（原有校验，保留） 3. 旧的 dest 改名成 `<dest>.old-<rand>` → 暂存目录改名成 dest → 删掉旧的 三个好处： · **失败不伤旧版**：pip 失败时 `dest` 从头到尾没被碰过 · **可重装**：每次都是干净目录，不会再有 WinError 183 · **失败清理简单**：只删暂存目录，不涉及用户数据 注意暂存/备份目录名都带随机后缀：两次并发安装不会互踩 （用户狂点按钮是真会发生的）。
 */

      if (pick.kind === 'pypi') {
        if (!existsSync(pyExe)) throw new Error('还没装内置 Python——先去「下载」页装好 Python 再下载 AstrBot')
        const ver = pick.tag.replace(/^v/, '')
        // 暂存目录：与 dest 同级（同一卷，rename 才是原子的）

        const stageDir = `${dest}.stage-${randomBytes(4).toString('hex')}`
        mkdirSync(dirname(stageDir), { recursive: true })
        // 保险：万一随机名撞了（极不可能），先清掉

        await removeDirAsync(stageDir).catch(() => {
          /**
 * 不存在就是最好的情况
 */

        })
        /**
 * ★ 进度映射（指导书 7.3(3)：分阶段 + 包计数 → 进度条） 原来这里只把包名塞进 speedText、percent 恒为 null —— 于是界面上进度条**一直静止**（主人原话：「看起来在装但不走， 以为卡死」）。现在用 pip-progress 把输出映射成 阶段（依赖收集 → 安装 → 配置）+ 单调推进的百分比。 映射逻辑抽在 src/main/update/pip-progress.ts 里， 有独立的单测（拿真实 pip 输出样本验）—— 写在 onData 里没法验。
 */

        const pip = createPipProgress()
        // pip 的 raw 下载进度每约 250ms 输出「Progress 当前字节 of 总字节」。
        // 子进程 stdout 可能把一行拆成多个 chunk，因此保留未完成行再解析。
        let pipRawBuffer = ''
        let pipCurrentBytes = 0
        let pipTotalBytes = 0
        let pipBytesPerSec = 0
        let pipLastSampleAt = 0
        let pipLastSampleBytes = 0
        let pipSourceMode: 'network' | 'cache' | 'unknown' = 'unknown'
        const readPipDownloadProgress = (chunk: string, stream: 'out' | 'err'): void => {
          if (/using cached/i.test(chunk)) pipSourceMode = 'cache'
          if (/downloading\s+/i.test(chunk)) pipSourceMode = 'network'
          if (stream !== 'out') return
          pipRawBuffer += chunk
          const lines = pipRawBuffer.split(/\r?\n/)
          pipRawBuffer = lines.pop() ?? ''
          for (const line of lines) {
            const m = /^\s*Progress\s+(\d+)\s+of\s+(\d+)\s*$/i.exec(line)
            if (!m) continue
            const current = Number(m[1])
            const total = Number(m[2])
            const now = Date.now()
            if (total !== pipTotalBytes || current < pipCurrentBytes || !pipLastSampleAt) {
              // 新文件开始下载：每个 wheel 的计数都会从 0 重新开始。
              pipBytesPerSec = 0
              pipLastSampleAt = now
              pipLastSampleBytes = current
            } else if (now > pipLastSampleAt && current > pipLastSampleBytes) {
              const sample = ((current - pipLastSampleBytes) * 1000) / (now - pipLastSampleAt)
              pipBytesPerSec = pipBytesPerSec ? pipBytesPerSec * 0.65 + sample * 0.35 : sample
              pipLastSampleAt = now
              pipLastSampleBytes = current
            }
            pipCurrentBytes = current
            pipTotalBytes = total
          }
        }
        /**
 * ★ 进度事件节流（审计：pypi 分支没和 zip 分支对齐） pip 输出密集时（依赖冲突 WARNING 多、单行被管道切成小块）， 原来每个 chunk 都发一次 IPC —— 渲染层跟着重渲染，还会反复 重置"5 秒无动静"的 stall 时钟。zip 分支早就有 120ms 合并队列， 这里对齐它：**同阶段内最多 120ms 一次**， 阶段变化时立刻发（阶段跃迁是用户最该看见的信号，不能等）。
 */

        let lastEmitAt = 0
        let lastStage = ''
        const emitPip = (force = false): void => {
          const t = pip.now()
          const now = Date.now()
          if (!force && t.stage === lastStage && now - lastEmitAt < 120) return
          lastStage = t.stage
          lastEmitAt = now
          sendDownloadProgress({
            type: p.type,
            tag: pick.tag,
            got: pipCurrentBytes,
            total: pipTotalBytes || undefined,
            percent: t.percent,
            bytesPerSec: pipBytesPerSec,
            gotText: (t.stage === 'deps'
              ? `解析/下载依赖 · 已发现 ${t.packages} 个`
              : t.stage === 'install' ? `写入依赖文件 · 已发现 ${t.packages} 个` : '配置运行时')
              + (pipTotalBytes ? ` · 当前包 ${humanSize(pipCurrentBytes)} / ${humanSize(pipTotalBytes)}` : ''),
            // speedText 保留"当前包名"：这是用户唯一能看到的"在动"的证据

            speedText: (t.package ? t.package.slice(0, 28) : (t.stage === 'deps' ? '正在解析依赖' : '正在安装'))
              + (pipBytesPerSec > 0
                ? pipSourceMode === 'cache'
                  ? ` · 缓存读取 ${humanSize(pipBytesPerSec)}/秒`
                  : ` · ${((pipBytesPerSec * 8) / 1_000_000).toFixed(1)} Mbps`
                : ''),
            done: false,
            phase: 'downloading',
            label: `AstrBot ${pick.tag}`
          })
        }
        /**
 * 统一发"失败"事件。 ## 为什么要一个统一出口（审计抓出的"进度条僵尸"） 渲染层清进度条**只认 done / error* 两档。所以任何一条 "发过 downloading 之后抛错、却没发 error"的路径，都会在界面上 留下一条**永远亮着的"安装中"**（5 秒后还会变成"正在处理中…"）， 看上去就是软件卡死了。 原来只有 4 个**手写**的失败点发了 error；盘点后发现收尾段 （写 mxbot-runtime.json / ensureSiteCustomize / store.register） 一旦抛错就没人收尾 —— 磁盘满、杀毒软件锁文件都可能触发。 现在：收尾段统一走 emitError，用 pipErrored 去重。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 修正一处**过度承诺**的注释（独立复核抓出，主人 2026-10-08）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 这里原来写的是"**所有失败**都走 emitError…保证**恰好发一次**"。
 * 那句话不成立，而且会误导后人：
 *
 *   · 本 handler 里 `phase:'error'` 的发送点有**好几处是手写的**
 *     （pip 失败、本体缺失、替换失败…），它们**不经过 emitError、
 *     也不碰 pipErrored**
 *   · "恰好发一次"实际是靠**控制流互斥**偶然成立的，不是靠这个标志位
 *
 * 那个"偶然"曾经真的破过（复核实测）：替换失败那两处手写发送
 * 位于收尾段 try 之内，抛出后被 catch 再次收尾 → 用户看到**两条**
 * error，其中第二条"装好了文件"还是事实错误（文件根本没就位）。
 * 现在那两处已改为走 emitError，去重才真正生效。
 *
 * 所以准确的说法是：**收尾段的失败走 emitError（去重生效）；
 * 收尾段之前的失败各自手写发送，靠控制流保证不重复。**
 * 改这里时请注意别把两类混起来。
 */

        let pipErrored = false
        const emitError = (msg: string): void => {
          if (pipErrored) return
          pipErrored = true
          sendDownloadProgress({
            type: p.type, tag: pick.tag, got: 0, total: undefined, percent: null,
            bytesPerSec: 0, gotText: '', speedText: '', done: false,
            phase: 'error', error: msg, label: `AstrBot ${pick.tag}`
          })
        }
        emitPip(true)
        /**
 * ══════════════════════════════════════════════════════════════════════ ★★ pip 用哪个源：**界面上点的那一个**（主人 2026-09-27 的严格质疑） ══════════════════════════════════════════════════════════════════════ 主人原话： 「为啥要有用这个的选项，我用哪个我直接点下载不就好了」 「真的是用对应的源来下载的吗，这么混乱」 他的怀疑**完全正确，而且问题比"混乱"更严重**： 原来这里只有一句 const pySrc = resolvePythonSource(cfg.dataRoot) 读的是**配置里记着的那一个首选源**，而界面传下来的 `p.base` （用户在卡片上点的是哪个源）**从头到尾没被看过* —— 也就是说"点哪个源就用哪个源"**从来没有实现过**： 无论点腾讯源还是清华源，pip 用的都是同一个（配置里的那个）。 界面为此还专门做了一个「用这个」按钮来改那个配置 —— 用户当然要问"我直接点下载不就好了"。 ## 现在 `p.base`（界面上点的源的 indexUrl）**优先**： ① 能按 indexUrl / label 在 Python 源表里找到 → 用它 ② 找不到（比如官方文件源那种非 pip 源）→ 回落到配置里的首选源 于是「用这个」按钮可以彻底去掉，语义变成最直白的一句： **点哪个源的下载，就用哪个源装这一次**。
 */

        const pickedSrc = p.base ? findPythonSource(loadPythonSources(cfg.dataRoot).sources, p.base) : undefined
        const pySrc = pickedSrc ?? resolvePythonSource(cfg.dataRoot)
        opts.logger?.log(
          'INFO',
          'proc',
          `AstrBot 使用 Python 源：${pySrc.label}（${pySrc.indexUrl}）` +
            (pickedSrc ? '（来自界面点击的那个源）' : '（界面没指定，用配置里的首选源）')
        )
        // pip 装依赖要几分钟。用异步 spawn，主进程照常响应——
        // 之前用 spawnSync 时它会堵住整个事件循环，界面就点不动了。        /*         * ★ 走可注入的执行器（`opts.runCommand` 优先，缺省是真实实现）。         *         * 加这个注入点是为了让"点哪个源就用哪个源"能被**严格验证**：         * 测试塞一个记账的假执行器，就能读到**真正传给 pip 的参数**         *（见 HandlerOpts.runCommand 的说明）。         */

        const execCmd = opts.runCommand ?? run
        let r: Awaited<ReturnType<typeof run>>
        try {
        const pipRun = await runPipWithCacheFallback(execCmd, pyExe, ['-m', 'pip', 'install', '--progress-bar', 'raw', '--no-warn-script-location', '--disable-pip-version-check', '--target', stageDir, `astrbot==${ver}`, ...pythonSourceToPipArgs(pySrc)], {
              timeoutMs: 900000,
              /*
               * 取消信号：按「取消」时 taskkill 掉 pip **整棵进程树**
               *（含它派生的编译子进程）—— 见 async-exec 的 onAbort。
               *
               * 只杀 pip 本身不够：pip 装源码包时会派生编译器，
               * 留个孤儿在后面写文件比不取消还糟。
               */
              signal,
              // pipEnvFor 把缓存指向 data\cache\pip-cache，否则默认写 C 盘用户目录（实测能堆到 6.8GB）

              env: pipEnvFor(cfg.dataRoot, { ...process.env, PYTHONHOME: pythonDirFor(cfg.dataRoot) }),
              onData: (chunk, stream) => {
                readPipDownloadProgress(chunk, stream)
                pip.feed(chunk)
                emitPip()
              }
            }
          )
          r = pipRun.result
          if (pipRun.retriedNoCache) {
            opts.logger?.log('WARN', 'proc', 'AstrBot 首次装包失败（像是 pip 缓存坏了），已绕过缓存重试：' + (r.status === 0 ? '成功' : '仍失败（退出码 ' + r.status + '）'))
          }
        } catch (e) {
          /**
 * ★ run 本身 reject（超时 / spawn 失败 / 被中断）也必须收尾 （审计：这条路径原来**完全没有* error 事件，进度条永久僵尸）
 */

          const why = e instanceof Error ? e.message : String(e)
          emitError(`装 AstrBot 失败（pip 没能正常启动或超时）：${why}`)
          await removeDirAsync(stageDir).catch(() => {
            /**
 * 清不掉也别把真实错误盖住
 */

          })
          throw e instanceof Error ? e : new Error(why)
        }
        /**
 * pip 退出 0 → 推进到「收尾/配置」阶段（90%）。 后面还有几件真实的事：校验本体在不在 → 原子替换 → 写 sitecustomize → 登记清单。它们通常一两秒就完，但**不能让进度条 停在 60 多**（用户会以为卡住了）。100% 由收尾处的 done 事件发。
 */

        if (r.status === 0) {
          pip.finishInstall()
          emitPip()
        }
        /**
 * ★ 这两个失败点必须先把进度推到 error 再抛（四厂商审计抓出的） 渲染层的进度条**只在收到 phase === 'done' 或 'error' 时才会清* （DownloadPage 的 setProgress → scheduleClear 只认这两档）。 这里发过 `phase:'downloading'（安装中…）` 之后直接 throw 的话， 那条进度就**永远没人收尾* —— 用户界面上会留着一个亮着的 "安装中"条，看着像软件卡死了；而异常的文案只是顶部一行小字。 对照 zip 下载路径（本文件 runtime:install 的非 pypi 分支）： 它有外层 try/catch 且捕获时发 `phase:'error'` —— 那才是完整的。 pypi 分支当时漏了，这里补齐同一行为。
 */

        if (r.status !== 0) {
          const msg = `装 AstrBot 失败：${String(r.stderr ?? '').slice(-300) || String(r.stdout ?? '').slice(-300)}`
          sendDownloadProgress({
            type: p.type, tag: pick.tag, got: 0, total: undefined, percent: null,
            bytesPerSec: 0, gotText: '', speedText: '', done: false,
            phase: 'error', error: msg, label: `AstrBot ${pick.tag}`
          })
          await removeDirAsync(stageDir).catch(() => {
            /**
 * 清不掉也别把真实错误盖住
 */

          })
          throw new Error(msg)
        }
        /*
         * ══════════════════════════════════════════════════════════════════
         * ★★ 取消检查（独立审查抓出的**严重**缺口，主人 2026-10-08）
         * ══════════════════════════════════════════════════════════════════
         *
         * ## 缺口是什么
         *
         * `runtimes:importFile`（手动导入）早就有了 `throwIfCancelled()`
         * —— 它在解压后、依赖装完、register 前各查一次，保证"取消" =
         * "不登记 + 不留残留"。而 **`runtime:install` 的 pypi 分支
         * 从头到尾没有任何 `signal.aborted` 检查**。
         *
         * ## 后果（与 importFile 修过的那个 bug 完全同类）
         *
         * 用户取消装 AstrBot → pip 被 taskkill（`status: -1`）→
         * **但下面那条 `existsSync` 校验仍可能通过**（pip 被杀之前
         * 已经落了 `astrbot/__init__.py` 和一部分依赖）→
         * 流程继续走到原子替换 + `store.register` + 发 `phase:'done'`。
         *
         * 于是用户**以为取消了**，列表里却多出一个装了一半、
         * 启动必崩的版本，还占着"已装版本"的位置和几十到几百 MB 磁盘。
         * 这正是「所有安装都不能取消」那份报告里最后没修干净的一块。
         *
         * ## 为什么必须在**校验之前**查
         *
         * `existsSync(astrbot/__init__.py)` 只能证明"这个文件在"，
         * 不能证明"装完了" —— 半成品恰好有它，校验就形同虚设。
         * 所以取消检查要挡在它前面，而不是指望校验去发现。
         */
        if (signal.aborted) {
          await removeDirAsync(stageDir).catch(() => undefined)
          /*
           * ★ 必须**自己发一条 error 进度事件**（独立复核抓出的新缺口）
           *
           * 这一处 `throw` 位于收尾段的 `try` **之外**（那个 try 从下面
           * "记下入口：AstrBot 装完的可执行模块"那句之前开始），
           * 所以它不会被那个 catch 收尾；而渲染层的进度条**只认
           * done / error** 两档才会清掉（见 setProgress → scheduleClear）。
           *
           * 于是：用户点取消 → 走到这里抛错 → 却没有任何收尾事件 →
           * 界面上**永久留着一条"安装中…"**。那正是这个文件里
           * 反复强调要避免的"进度条僵尸"，而且看起来比不取消更糟
           *（用户以为取消没生效、软件卡住了）。
           *
           * 对比：收尾段 `try` 之内的两处取消检查不需要手写发送 ——
           * 它们抛出后会被那个 catch 接住并调 emitError（已带去重）。
           */
          sendDownloadProgress({
            type: p.type,
            tag: pick.tag,
            got: 0,
            total: undefined,
            percent: null,
            bytesPerSec: 0,
            gotText: '',
            speedText: '',
            done: false,
            phase: 'error',
            error: '已取消 —— 你可以重新点「下载」再试',
            label: `AstrBot ${pick.tag}`
          })
          throw new Error('已取消 —— 这个版本不会被登记，也不会留下残留文件')
        }

        if (!existsSync(join(stageDir, 'astrbot', '__init__.py'))) {
          const msg =
            'pip 报告成功，但没找到 AstrBot 本体（astrbot/__init__.py）——'
              + '多半是镜像上缺包或下载被中断，已清掉这个不完整的安装，请重试'
          sendDownloadProgress({
            type: p.type, tag: pick.tag, got: 0, total: undefined, percent: null,
            bytesPerSec: 0, gotText: '', speedText: '', done: false,
            phase: 'error', error: msg, label: `AstrBot ${pick.tag}`
          })
          await removeDirAsync(stageDir).catch(() => {
            /**
 * 同上
 */

          })
          throw new Error(msg)
        }
        /**
 * ★ 收尾段整体兜底（审计确认的"进度条僵尸"缺口） 从写 mxbot-runtime.json 到 store.register 这几步**都在暂存目录 已经替换成正式目录之后**，所以它们抛错时"文件其实已经装好了" —— 但渲染层不知道：它只认 done / error，而这条路径原来既不发 done 也不发 error，于是界面上永远留着一条"安装中"。 现在：任何异常都发一次 error（emitError 自带去重）， 让用户至少看到"出错了"而不是"卡住了"。
 */

        try {
          // 记下入口：AstrBot 装完的可执行模块（写在暂存目录里，随替换一起就位）

          writeFileSync(
            join(stageDir, 'mxbot-runtime.json'),
            JSON.stringify({ tag: pick.tag, kind: 'pypi', entry: 'astrbot' }, null, 2),
            'utf8'
          )
        /**
 * ── 原子替换 ────────────────────────────────────────────────────── 顺序有意为之，每一步失败都能回到"用户原来能用"的状态： 旧 dest → .old （挪开） stage → dest （就位） 删 .old （收尾，失败也无所谓） 如果"就位"失败，把旧的挪回去 —— 绝不让用户两头落空。
 */

        /*
         * ★ 取消检查（原子替换之前，最后一道）
         *
         * 走到这里说明 pip 退出码是 0、本体校验也过了 —— 但用户可能
         * **恰恰在这几秒里点了取消**。再往下就是不可逆的 rename：
         * 一旦把 stage 换成 dest，用户就真的"多了一个版本"。
         *
         * 放在这里而不是更早：前面那次检查是在 pip 结束后，
         * 而"校验本体 + 写 mxbot-runtime.json"这几步也要花时间，
         * 期间用户完全可能点取消。
         */
        if (signal.aborted) {
          await removeDirAsync(stageDir).catch(() => undefined)
          throw new Error('已取消 —— 这个版本不会被登记，也不会留下残留文件')
        }
        const oldDir = `${dest}.old-${randomBytes(4).toString('hex')}`
        const hadOld = existsSync(dest)
        if (hadOld) {
          try {
            renameSync(dest, oldDir)
          } catch (e) {
            await removeDirAsync(stageDir).catch(() => {
              /**
 * 尽力而为
 */

            })
            const msg = e instanceof Error ? e.message : String(e)
            const full = `替换运行时失败（旧的挪不开，可能有进程正在使用这个版本）：${msg}`
            /*
             * ★ 走 emitError 而不是手写 sendDownloadProgress（独立复核抓出）
             *
             * 这一处 throw 在**收尾段的 try 之内**，所以它抛出去之后
             * 会被那个 catch 接住、再调一次 emitError。手写的话就是
             * **重复发两条 error 事件**：
             *   ① 本条："替换运行时失败（旧的挪不开…）"
             *   ② catch 里那条："装好了文件，但收尾（写标记/登记清单）失败…"
             *
             * 而第②条是**事实错误** —— 此时 rename 还没成功，
             * 文件根本没就位。用户看到两条，第二条说"装好了文件"，
             * 可能就跑去启动一个其实不存在的版本。
             *
             * 走 emitError 后 `pipErrored` 去重生效：本条先发，
             * catch 里那条被自动吞掉，用户只看到**准确的那一条**。
             */
            emitError(full)
            throw new Error(full)
          }
        }
        try {
          renameSync(stageDir, dest)
        } catch (e) {
          // 回滚：把旧的挪回原位，绝不能把用户搞成"两个都没有"

          if (hadOld) {
            try {
              renameSync(oldDir, dest)
            } catch {
              /**
 * 回滚也失败了 —— 下面的报错会带上旧目录位置，用户还能手救
 */

            }
          }
          await removeDirAsync(stageDir).catch(() => {
            /**
 * 尽力而为
 */

          })
          const msg = e instanceof Error ? e.message : String(e)
          const full =
            `替换运行时失败：${msg}` + (hadOld ? `（原来的版本已保留在 ${oldDir}）` : '')
          /*
           * ★ 同样走 emitError（理由与上面那处一致）：
           *   这条也在收尾段的 try 里，手写会与 catch 的 emitError
           *   重复发两条，且第二条"装好了文件"与事实不符。
           */
          emitError(full)
          throw new Error(full)
        }
        // 收尾：旧的已经没用了。删不掉也要继续（只是占点空间，不影响功能）

        if (hadOld) {
          await removeDirAsync(oldDir).catch((e) => {
            /**
 * ★ 删不掉要**报出来**，不能只有一行注释（四厂商审计确认的隐患） .old-<rand> 里是一份完整的旧运行时（几百 MB~几 GB）。 原来这里 `catch(() => {})` 完全静默 —— 万一被占用删不掉， 它就永久留在 runtimes\<type>\ 下：scanDisk 现在已经把 .old- 排除了（不会当版本列出来），但磁盘占用**没人看得见、没人管**， 用户也不会明白"怎么空间越用越少"。 现在：不影响安装结果（照旧成功），但失败原因进日志，能归因。
 */

            const why = e instanceof Error ? e.message : String(e)
            opts.logger?.log(
              'WARN',
              'proc',
              `旧版本目录清理失败（不影响本次安装）：${oldDir} —— ${why}`
            )
          })
        }
        // 确保内置 Python 认识这个包目录（embed 版忽略 PYTHONPATH，靠 sitecustomize 认）

        const pyDirNow = pythonDirFor(cfg.dataRoot)
        if (existsSync(join(pyDirNow, 'python.exe'))) ensureSiteCustomize(pyDirNow)
        /*
         * ★ 最后一道取消检查（register 的**紧邻上一句**）
         *
         * `store.register` 是"这个版本从此存在"的那一刻 —— 一旦登记，
         * 界面「已装版本」里就会多出它，用户得手动删。
         *
         * 在此之前检查成本极低（读一个 boolean），但能挡住
         * "文件已经就位、还没登记"这个窗口期里的取消。
         *
         * 注意此刻 **dest 已经是新装的版本**了（rename 已完成），
         * 所以这里不能删 dest —— 删了等于把刚装好的东西毁掉。
         * 正确做法：只**不登记**，目录本身留着（下次装同版本会走
         * 原子替换覆盖它，不会累积）。
         *
         * ★ 修正一处早先写错的注释（独立复核指出）
         *
         * 我原来写"让用户从界面上看不到它"—— **不成立**。
         * `runtime-store` 的 `buildList` 会把「清单记录」与「磁盘扫描」
         * 合并展示，而 `hasSubstance` 的判据之一是
         * `existsSync(<dir>/mxbot-runtime.json)`，那个标记文件
         * 早在 stage 里写好、随 rename 一起就位了 ——
         * 所以这个未登记的目录**仍会被扫出来列在「已装版本」里**。
         *
         * 功能上无害（能正常删除、下次装会被覆盖），但注释不能
         * 承诺一个做不到的事 —— 下一个人会据此以为"取消后界面上不会有它"。
         * 这与 importFile 的语义一致：**取消 = 不登记**（而不是"消失"）。
         */
        if (signal.aborted) {
          opts.logger?.log(
            'WARN',
            'proc',
            `AstrBot ${pick.tag} 在收尾阶段被取消：文件已就位但不登记`
          )
          throw new Error('已取消 —— 这个版本不会被登记（文件已就位，重新下载会覆盖它）')
        }
        const rec = store.register({ type: p.type, tag: pick.tag, from: pick.from })
        // 装完作废版本列表缓存：让「已安装」状态立刻反映到界面上

        invalidateVersionCache(cfg.dataRoot)
        opts.logger?.log('INFO', 'proc', `已安装 AstrBot ${pick.tag}（PyPI，用内置 Python，暂存目录安装后原子替换）`)
        sendDownloadProgress({ type: p.type, tag: pick.tag, got: 0, total: undefined, percent: 100, bytesPerSec: 0, gotText: '', speedText: '完成', done: true, phase: 'done', label: `AstrBot ${pick.tag}` })
        return { version: versionNumOf(pick.tag), tag: pick.tag, from: pick.from, sha256: '', dir: rec.dir }
        } catch (e) {
          /**
 * 收尾段失败：文件其实已经就位，但**不能让进度条悬着**。 如实报错，并说清"可能已经装上了，去列表看一眼" —— 这比 让用户对着一条不动的进度条猜要诚实得多。
 */

          const why = e instanceof Error ? e.message : String(e)
          /*
           * ★ 必须区分"用户取消"和"真的失败"（独立复核抓出）
           *
           * 这个 catch 会接住**取消检查**抛出的错（上面那两处
           * `if (signal.aborted) throw` 都在这个 try 内）。不区分的话，
           * 用户主动点了取消，看到的却是：
           *
           *   「装好了文件，但收尾（写标记/登记清单）失败：已取消…」
           *
           * 这句话有三个毛病：
           *   ① 归因错了 —— 取消是**用户主动操作**，不是故障
           *   ② 自相矛盾 —— 前半句像成功、后半句说取消了
           *   ③ 「装好了文件」在原子替换那条取消分支上甚至是**事实错误**
           *      （那时 rename 还没执行，文件根本没就位）
           *
           * 对齐 `python:install` 的做法（那里早就用 `cancelled` 区分了）。
           */
          /*
           * ★ 日志级别不能只由 `signal.aborted` 决定（独立复核抓出）
           *
           * `signal.aborted` 一旦置 true 就**永不复位**。于是这个场景会出错：
           *   用户点了取消 → 但流程在"取消生效"之前**因为别的原因**失败
           *   （磁盘满 → writeFileSync 抛；杀毒锁文件 → renameSync 抛）
           *   → 此时 aborted 仍为 true → 真实故障被**记成 INFO**。
           *
           * INFO 在排查时基本等于"不存在"—— 用户报"装不上"，
           * 我们翻日志却找不到那条磁盘满的记录，只能看到一句"已取消"。
           *
           * 判据改成：**只有确实由取消分支抛出的错**才算取消。
           * 取消分支抛的错文案是固定的（下面那两处 `已取消 —— …`），
           * 用文案前缀识别比再用一个布尔标志可靠 —— 因为它是
           * "这个异常的真实来源"，而不是"用户点过取消没有"。
           */
          const fromCancel = why.startsWith('已取消')
          emitError(
            fromCancel
              ? '已取消 —— 这个版本不会被登记，你可以重新点「下载」再试'
              : `装好了文件，但收尾（写标记/登记清单）失败：${why} —— 去版本列表看看是否已可用`
          )
          opts.logger?.log(
            fromCancel ? 'INFO' : 'ERROR',
            'proc',
            `AstrBot ${pick.tag} ${fromCancel ? '已取消' : '收尾失败'}：${why}`
          )
          throw e instanceof Error ? e : new Error(why)
        }
      }
      /**
 * 非 PyPI 路径（zip 下载解压）：这个目录现在才建。 原来 mkdir 是无条件在最前面做的，于是**即使走 pypi 分支* 也会先把 dest 建出来 —— 那正是 pip 撞 WinError 183 的前提条件之一。 现在只在这条路径上建。
 */

      mkdirSync(dest, { recursive: true })
      const release = {
        tag: pick.tag,
        assetName: pick.assetName,
        assetUrl: pick.assetUrl,
        sha256: pick.sha256
      }
      // 暂存放 data\cache\tmp：绝不落 C 盘的系统临时目录

      const stage = makeStage(cfg.dataRoot, 'rt')
      const zip = join(stage, pick.assetName.replace(/[\\/]/g, '_'))
      const tracker = createProgressTracker()
      const queue: Array<{ got: number; total?: number }> = []
      let flushing = false
      const flush = (): void => {
        if (flushing) return
        flushing = true
        setTimeout(() => {
          flushing = false
          const lastEvt = queue.pop()
          queue.length = 0
          if (lastEvt) {
            const s = tracker.update(p.type, pick.tag, lastEvt.got, lastEvt.total)
            sendDownloadProgress({ ...s, phase: 'downloading', label: pick.tag })
          }
        }, 120)
      }
      try {
        sendDownloadProgress({ type: p.type, tag: pick.tag, got: 0, total: undefined, percent: 0, bytesPerSec: 0, gotText: '0 B', speedText: '0 B/s', done: false, phase: 'start', label: pick.tag })
        /*
         * ══════════════════════════════════════════════════════════════════════════
         * ★★ 首选源下不到时要能**回退**（主人 2026-09-27：「NapCat 一键更新失败」）
         * ══════════════════════════════════════════════════════════════════════════
         *
         * ## 现象与日志
         *
         *     instance:update  n_2d9a960119  失败
         *     :: 下载失败：试过 1 个镜像源都没成。最后错误：Error: HTTP 404
         *
         * **"试过 1 个"** 是关键 —— 而 NapCat 配了一堆源
         *（官方源 + GitHub 直连 + gh-proxy + cors），本该全都试一遍。
         *
         * ## 根因
         *
         * 这里原来传 `onlyBase: mirror?.base ?? prefBase`，而 `prefBase`
         * 是**配置里的首选源**（他设了官方源）。到了 `downloadRuntime`：
         *
         *     const order = deps.onlyBase !== undefined
         *       ? mirrorOrderFor(...).filter((m) => m.base === deps.onlyBase)  // ← 只剩 1 个
         *       : mirrorOrderFor(...)
         *
         * 候选只剩官方源 —— 而那时服务器上**还没有 v4.18.28 的文件**
         *（只有 v4.18.19），404 之后**没有任何回退**，直接失败。
         *
         * ## 修法：按"用户有没有**显式点**这个源"来分
         *
         * `p.base` 才是"用户点的那个源"（界面按钮传上来的）。
         * 而 `mirror`/`prefBase` 是**从配置里解析出来的首选源** ——
         * 那只是"优先试它"，不是"只许用它"。
         *
         *   · **`isMirrorBase`（用户点了某个镜像源）**
         *     → `onlyBase` 锁死它 —— 尊重显式选择
         *       （"点哪个源就用哪个源"这条有测试盯着：
         *        tests/unit/pick-source-real.spec.ts，不能动）
         *
         *   · **否则（没点，用配置首选）**
         *     → **不传 onlyBase** —— 让 `mirrorOrderFor` 把首选源排最前、
         *       其余源做回退。首选源暂时缺文件或挂了，就自动落到下一个。
         *
         * 这既保住"用户显式选择"的语义，又让多源回退真正生效 ——
         * 那正是"配了好几个源"的意义。
         */
        const dl = await downloadRuntime({
          dataRoot: cfg.dataRoot,
          type: p.type,
          release,
          destFile: zip,
          onlyBase: isMirrorBase ? p.base : undefined,
          /*
           * ★ 取消：**两个都要传**（主人 2026-10-08：「napcat 和 astrbot
           *   依旧取消不了」）
           *
           * 原来只传了 `isCancelled`（轮询式，只在"换下一个源"的间隙
           * 检查一次）。而一个正在传输的 28MB 包，在那之间**没有任何
           * 检查点** —— 用户点了取消，下载会一直跑到自然结束。
           *
           * `signal` 是**事件式**的：abort 时立刻断开正在进行的 fetch。
           * 两者一起传，才能做到"换源间隙不重试 + 正在传的立刻停"。
           *
           * `isCancelled` 保留是给旧路径的兼容，不是冗余。
           */
          signal,
          isCancelled: () => signal.aborted,
          onProgress: (got, total) => {
            queue.push({ got, total })
            flush()
          },
          // 100% 之后还有校验与落盘，必须让用户看到，否则像卡死

          onPhase: (e) => {
            sendDownloadProgress({
              type: p.type,
              tag: pick.tag,
              got: e.got,
              total: e.total,
              percent: 100,
              bytesPerSec: 0,
              gotText: humanSize(e.got),
              speedText: e.phase === 'verify' ? '校验中…' : '落盘中…',
              done: false,
              phase: e.phase,
              label: pick.tag
            })
          }
        })
        sendDownloadProgress({ type: p.type, tag: pick.tag, got: dl.bytes, total: dl.bytes, percent: 100, bytesPerSec: 0, gotText: humanSize(dl.bytes), speedText: '解压中', done: false, phase: 'unpack', label: pick.tag })
        // 异步解压：117MB 的 NapCat 包用 spawnSync 会卡住界面十几秒
        // 用 expandArchive：路径里的单引号会被正确转义（自己拼脚本会踩引号坑）

        const expand = await expandArchive(zip, dest, { timeoutMs: 900000 })
        if (expand.status !== 0) throw new Error(`解压失败：${String(expand.stderr).slice(0, 200)}`)
        // NapCat 的 worker 启动参数里写死了 Electron 才有的 --no-sandbox，
        // 纯 node.exe 不认 → worker 退出码 9 → 实例永远起不来。解压后精确修掉。

        if (p.type === 'n') {
          const fix = patchNapcatWorkerArgv(dest)
          opts.logger?.log(
            fix.patched ? 'INFO' : 'WARN',
            'proc',
            `NapCat ${pick.tag} 启动参数修补：${fix.reason}`
          )
        }
        const rec = store.register({ type: p.type, tag: pick.tag, from: dl.usedLabel })
        // 装完作废版本列表缓存，界面上的「已安装」立刻是对的

        invalidateVersionCache(cfg.dataRoot)
        opts.logger?.log('INFO', 'proc', `已安装 ${p.type === 'a' ? 'AstrBot' : 'NapCat'} ${pick.tag}（来源 ${dl.usedLabel}）`)
        sendDownloadProgress({ type: p.type, tag: pick.tag, got: dl.bytes, total: dl.bytes, percent: 100, bytesPerSec: 0, gotText: humanSize(dl.bytes), speedText: '完成', done: true, phase: 'done', label: pick.tag })
        return { version: versionNumOf(pick.tag), tag: pick.tag, from: dl.usedLabel, sha256: dl.sha256, dir: rec.dir }
      } catch (e) {
        sendDownloadProgress({ type: p.type, tag: pick.tag, got: 0, total: undefined, percent: null, bytesPerSec: 0, gotText: '0 B', speedText: '', done: false, phase: 'error', error: String(e instanceof Error ? e.message : e), label: pick.tag })
        throw e
      } finally {
        /**
 * 暂存目录必须**异步**删。 踩过的坑（用户原话「下载的时候为什么会让主程序无响应」）： 这里原来是 `rmSync(stage, {recursive:true, force:true})`。 而 stage 里装着**下载下来的整个压缩包 + 解压出来的整棵树* —— NapCat 那个包 29 MB 压缩、解开后上百 MB、几万个文件 （大部分是 node_modules 里的小文件）。 rmSync 是同步的，主进程只有一个事件循环，于是这几万个文件的 unlink 会**整段独占主进程**：窗口标题变「无响应」、进度条卡住、 点什么都排队。用户看到的正是「下完了反而卡死一下」。 removeDirAsync 走异步递归删除（fsp.rm），期间事件循环照常转， 界面不会假死。删不掉也不该让整个下载流程算失败 —— 那只是留了点垃圾， 下次同 tag 的下载会复用同名 stage 覆盖掉；所以吞掉异常只记日志。
 */

        void removeDirAsync(stage).catch((e: unknown) => {
          opts.logger?.log(
            'WARN',
            'proc',
            `下载暂存目录没清干净（不影响使用，下次会覆盖）：${e instanceof Error ? e.message : String(e)}`
          )
        })
      }
      } finally {
        /**
 * 锁必须无条件释放（成功、失败、中途抛错都一样）—— 没有这个 finally，一次失败的安装会让这个版本永远"正在安装中"。
 */

        /*
         * 释放登记（**必须传 controller**：只释放自己那一个，
         * 见 running-tasks.ts 里 endTask 的说明）。
         *
         * 放在 finally 里 —— 成功、失败、取消三条路径都要释放，
         * 否则那个版本会永远"正在安装中"、永远开不了新的。
         *
         * ★ 传的是 `task.controller`，**不是 `signal`** ——
         * `endTask` 内部靠 `cur.controller === controller` 判断
         * "这是不是我那一个"，而 `signal` 只是 controller 的一个属性，
         * 两者不是同一个对象。传错的话那次比较永远为 false →
         * **永远不释放**（我第一次就是这么写的，测试当场抓到：
         * 同一个 tag 的第二次安装被"正在安装中"挡住）。
         */
        endTask(lockKey, task.controller)
        // 结束标记（异常也写）：只有进程被杀才会留下"有 start 没 end"

        opEnd(opts.logger, 'runtime:install', lockKey)
      }
    },
    'runtimes:list': () => {
      const { config: cfg } = state()
      const store = runtimeStore(cfg.dataRoot)
      /**
 * ★ 顺手触发"缺大小"的**后台**回填（主进程零阻塞的收尾） buildList 已不再同步扫文件（那曾是整机卡顿的头号元凶）， 于是老用户第一次打开会看到版本大小空白 —— 这里 fire-and-forget 让后台 bright 把缺失的大小算好 patch 进清单，几秒后下一次 刷新就补齐了。列表本身照旧毫秒级返回。
 */

      const filled = store.recomputeSizes()
      if (filled.length) {
        opts.logger?.log('INFO', 'proc', `后台补算运行时体积：${filled.join('、')}`)
      }
      return store.all()
    },
    /**
 * 删运行时版本。 ## 什么情况允许删 有实例**只是引用**着这个版本（但没在跑）→ **允许删**。 这时实例下次启动会找不到运行时、启动失败并给出明确提示 （见 resolveLaunchSpec / instance:start 的报错），**不会静默跑坏**， 用户重新下载同一个版本或换个版本即可。 下载页的确认弹窗也是这么写的（「已用它创建的实例不受影响」）， 两边说法一致。 ## 什么情况**必须拦* 有实例**正在这个版本上运行* → 拒绝，并告诉用户先停掉它。 这是实机踩出来的坑（问题报告v2 第 9、4、7 条都是它的连锁后果）： 用户在 AstrBot 实例运行中的时候删了 v4.27.0，结果那个版本目录被 **删了一半**—— runtimes\a\v4.27.0.deleting-xxx\ aiohttp/ anthropic/ numpy/ ... ← 依赖还在（没被锁） astrbot/ ← **整个空掉了**（模块文件被删） 因为正在运行的 python 进程把 `astrbot\*.pyc`、`.pyd` 这类文件锁住了， 异步删除删不动它们、又已经把能删的都删了，最后留下一个残缺目录。 连锁反应： - 实例当场半死（代码被抽走） - 那个实例卡片显示「版本未知」——读不到包内版本标识了 - `.deleting-*` 目录永远删不掉（文件被锁），成了永久垃圾 - 用户想重装同版本，还得先手工清掉它 所以判据必须是**进程真正在跑**（status === 'running'）， 而不是「有没有实例引用它」。前者是在动活人的代码，后者只是留个坑。 顺带：这也解释了用户问的「为什么删了就不能启动，不是复制一份吗」—— 运行时是**同类实例共享**的一份（省磁盘），不是每个实例各拷一份。
 */

    'runtimes:remove': async (p) => {
      const { config: cfg, repo: r } = state()
      const store = runtimeStore(cfg.dataRoot)
      /**
 * 绑到这个版本上的实例。 ## 这里原来有个会把引用算错对象的兜底（已去掉） 原写法： (readInstanceTag(inst.dir) ?? store.latest(inst.type)?.tag) === p.tag `??` 那半句的意图是"读不到 version 就保守地当成最新版"。 但"保守"的方向搞反了 —— 它把**一个未知的引用**算到了 `latest` 这个**具体版本**头上，于是： - 实例 A 真正绑 v4.27.0，它的 instance.json 读不出来 - 用户删 v4.28.0（latest）→ 守卫以为 A 在用 v4.28.0 → A 没在跑（不会被拦）→ v4.28.0 被删（多算了一个引用） - 用户删 v4.27.0（A 真正在用的）→ 守卫以为 A 用的是 v4.28.0 → **认为没人用 v4.27.0* → A 若正在跑，代码被当场抽走 两种情况一个误留、一个误删，而误删那侧正是最致命的 （正在执行的代码被抽走 → 实例半死 + 删不掉的 `.deleting-*` 垃圾）。 ## 现在怎么处理"读不到" 分两种来源，区别对待： 1. **instance.json 不存在* → 这是很老的实例（或者刚建一半）， 确实没有版本信息，退回 `latest` 是合理的近似 （老版本建实例时绑的就是当时的最新版）。 2. **文件存在但读不出来（损坏）* → **绝不能猜**。 猜错的代价是删掉活人的代码。这时把它当成"可能用到任意版本"， 即：**只有在它没在跑时才允许删**，且要在返回值里点명它 （`unknownBinding`）。界面上会提示用户这个实例的版本记录坏了。 换句话说：不确定的时候，宁可多留一个引用（用户顶多多点一次）， 绝不把一个未知引用错算成某个具体版本来"放行删除"。
 */

      const tagOf = (inst: { dir: string; type: 'a' | 'n' }): { tag?: string; unknown: boolean } => {
        const f = join(inst.dir, 'instance.json')
        const hasFile = existsSync(f)
        const tag = readInstanceTag(inst.dir)
        if (tag) return { tag, unknown: false }
        if (!hasFile) {
          // 情形 1：从来没有版本记录（老实例）→ 退回 latest

          return { tag: store.latest(inst.type)?.tag, unknown: false }
        }
        // 情形 2：有文件但读不出来 → 不猜，交给调用方保守处理

        return { tag: undefined, unknown: true }
      }
      /**
       * 并行读一批实例目录的 `runtimeTag`。
       *
       * 返回 Map：`dir → tag`
       *   · `string`  读到了
       *   · `null`    文件在、但**读不出来**（损坏）→ 调用方走 unknown
       *   · `undefined` 根本没有那个文件 → 调用方走"回落 latest"
       *
       * ## 为什么单独抽出来
       *
       * `readInstanceTag` 是**同步**的（`existsSync` + `readJsonFile`）——
       * 在 31 个实例的循环里调它，就是 31 次串行的同步读盘，
       * 实测累计 **1.3 秒的主进程阻塞**（见上面那段日志证据）。
       *
       * 这里改用 `fs/promises`：真正并行、跑在 libuv 线程池上，
       * 事件循环全程不被占住。
       *
       * 语义与 `readInstanceTag` + `existsSync` 完全一致 ——
       * 只是"一个一个读"变成"一起读"。
       */
      const readTagsForDirs = async (
        dirs: string[]
      ): Promise<Map<string, string | null | undefined>> => {
        const { readFile } = await import('fs/promises')
        const out = new Map<string, string | null | undefined>()
        await Promise.all(
          dirs.map(async (dir) => {
            if (!dir || typeof dir !== 'string') {
              out.set(dir, undefined)
              return
            }
            const f = join(dir, 'instance.json')
            let text: string
            try {
              text = await readFileAsync(f, 'utf8')
            } catch {
              /* 读不到（不存在 / 权限）→ 与"没有文件"同义 */
              out.set(dir, undefined)
              return
            }
            try {
              const j = JSON.parse(text) as { runtimeTag?: string }
              const tag = typeof j.runtimeTag === 'string' ? j.runtimeTag : undefined
              /*
               * 文件读到了、也是合法 JSON，但没有 runtimeTag ——
               * 这**不算损坏**，而是"老实例没记版本"，与
               * `readInstanceTag` 返回 undefined 的情形一致 → 走回落。
               */
              out.set(dir, tag ?? undefined)
            } catch {
              /* JSON 坏了 → 标记为"读不出来"（null），调用方会进 unknown */
              out.set(dir, null)
            }
          })
        )
        return out
      }
      const all = r.list()
      const unknownBound: string[] = []
      /*
       * ══════════════════════════════════════════════════════════════════════════
       * ★★ 读实例的 tag 要**并行**，别一个个同步读
       *   （主人 2026-09-27 实测：「我是连续删除两三个文件包」→ 卡）
       * ══════════════════════════════════════════════════════════════════════════
       *
       * ## 日志证据
       *
       *     [07:02:17] 已删除 NapCat v4.18.27 运行时
       *     [07:02:17] [ERROR] [perf] IPC runtimes:remove 耗时 1396ms（严重）
       *     [07:02:17] [WARN] 主进程事件循环疑似被同步代码阻塞：1363ms
       *
       * 删除本身只是 `renameSync`（微秒级），**1.3 秒全花在"读每个实例的
       * instance.json"上**。他有 31 个实例，而"连续删两三个包"
       * 就是把这段跑两三遍 —— 累加就是那个"卡"。
       *
       * ## 为什么不能只按类型筛掉
       *
       * 我第一版想"清单里已经有 tag 了，直接读记录不碰盘" ——
       * 查了真实数据发现**行不通**：`InstanceRecord` 根本没有 `runtimeTag`
       * 字段（31 个实例一个都没有），tag 只存在各自的 `instance.json` 里。
       * 所以要判断"某个实例绑没绑这个版本"，**必须**读那个文件。
       *
       * ## 所以：改成并行读
       *
       * `readJsonFile` 是同步的，Promise.all 包不住它 —— 但我们可以
       * **批量走异步读**（`fsp.readFile`，跑在 libuv 线程池上，
       * 且多个文件真正并行），这样 31 次读盘不再串行占用事件循环。
       *
       * 读失败/文件不在 → 走原来的"unknown / 回落"语义，不变。
       */
      const instDirs = all.filter((i) => i.type === p.type)
      const tagByDir = await readTagsForDirs(instDirs.map((i) => i.dir))
      const bound = instDirs.filter((inst) => {
        const known = tagByDir.get(inst.dir)
        /*
         * known === null 表示"文件在、但读不出来" → 版本记录损坏。
         * undefined 表示"根本没有这个文件"（老实例）→ 退回 latest。
         */
        if (known === null) {
          unknownBound.push(inst.name)
          return true
        }
        if (known === undefined) {
          const { tag, unknown } = tagOf(inst)
          if (unknown) {
            unknownBound.push(inst.name)
            return true
          }
          return tag === p.tag
        }
        return known === p.tag
      })
      /**
 * 正在跑（或正在启动）的那几个：必须拦住。 ## 为什么不能只判 `status === 'running'`（这里原来是个洞） 判据原来只有一个 `liveBound.filter(inst => inst.status === 'running')`， 而 liveStatusOf 的**第一行**是： if (rec.status === 'starting') return rec // 原样返回，不探端口 于是实例处于 `starting` 期间，liveStatusOf 直接原样返回， status 保持 `'starting'` —— 既不等于 `'running'`，也不会去探端口。 守卫的 `=== 'running'` 过滤**看不见它**，直接放行删除。 这个窗口真实存在且致命。instance:start 是： updateStatus(id,'starting') → spawn → waitForReady → updateStatus(id,'running') 而 AstrBot 冷启动要几十秒（解压、装依赖、起 web 服务）。 用户在这几十秒里去「下载」页把这个版本删掉 → 守卫说"没有 running 的实例" → `store.remove()` 同步 rename 成 `.deleting-*` → 后台开始抽走 **正在被 import 的代码**。 结果就是用户报告过的那一幕：`runtimes\a\v4.27.0.deleting-*` 里 `astrbot\` 整个空掉、实例「版本未知」、当场半死 —— 只是触发时机从「运行中」变成了「启动瞬间」，一样致命， 而且用户更难意识到（他刚点完启动，转头就去点删除）。 ## 判据取并集，宁严勿松 1. status === 'running' —— 已就绪，明确在跑 2. status === 'starting' —— 正在加载代码，进程可能已经在读这些文件 3. pm.statusOf(id) === 'running' —— 兜底：即使记录状态脏了 （崩溃后来不及更新、被别的路径写成别的值）， 只要进程管理器说这个 id 在跑，就不许删它的代码 误拦的代价是用户多点一次（等启动完再删，那时会被明确拦住）； 漏拦的代价是实例半死 + 一个永远删不掉的垃圾目录。 这个不对称决定了必须往严的方向取。
 */

      /**
 * ★ 只探"绑定到这个版本"的实例（主人 2026-09-27：「删除会卡住主进程」） 原来是对 `bound`（该类型**所有**实例）逐个探活。用户有二十来个 实例时，就是二十来次端口探测 —— 即使并行，也要等最慢那个， 而且每个都要过 `pm.statusOf` + 端口连接。日志实测 3252ms。 但实际上：**只有"可能正在用这个版本"的实例才需要拦**。 绑定到别的版本的实例，删这个版本跟它一点关系都没有， 完全不必探活（它们的状态不影响本次删除的判定）。 注意这里仍用 `bound` 做过滤基础（它已经按 tag 筛过）， 只是把"要不要探"收紧到"确实相关的那几个"。 语义没有放松：真正在用这个版本的实例，仍然会被逐个探活并拦住。
 */

      const liveBound = await Promise.all(bound.map((inst) => liveStatusOf(inst)))
      const busy = liveBound.filter(
        (inst) =>
          inst.status === 'running' ||
          inst.status === 'starting' ||
          pm.statusOf(inst.id) === 'running'
      )
      if (busy.length) {
        const names = busy.map((i) => i.name).join('、')
        const anyStarting = busy.some((i) => i.status === 'starting')
        throw new Error(
          `还有 ${busy.length} 个实例正在用这个版本运行（${names}）——`
            + `先把它们停掉再删。`
            + (anyStarting
              ? `（其中有的还在启动中：启动过程会持续读取这个版本的代码，`
                + `这时删掉会让它启动失败甚至半死）`
              : '')
            + `运行中删掉会把它正在执行的代码抽走：那个实例会当场半死，`
            + `而且文件被占用删不干净，会留下一个残缺目录反而更麻烦。`
        )
      }
      /**
 * 只是被引用（没在跑）：允许删 —— 返回值里带上名字，界面可以提示。 注意 `used` 要**排除**未知绑定的实例：两者语义不同，混在一起 界面就没法区分"确定在用"和"可能在用"了（也就没法给出不同的提示）。 usedBy —— 确定在用这个版本，删了它下次启动会失败（用户自己选） unknownBinding —— 版本记录坏了，**可能**在用，必须提示去修
 */

      const used = bound.filter((i) => !unknownBound.includes(i.name))
      const dir = store.remove(p.type, p.tag)
      // 版本列表缓存作废：下次进下载页要能反映「这个版本已经删了」

      invalidateVersionCache(cfg.dataRoot)
      opts.logger?.log('INFO', 'proc', `已删除 ${p.type === 'a' ? 'AstrBot' : 'NapCat'} ${p.tag} 运行时`)
      if (used.length) {
        opts.logger?.log(
          'WARN',
          'proc',
          `${used.length} 个实例仍指向已删除的 ${p.tag}：${used.map((i) => i.name).join('、')}`
        )
      }
      /**
 * 版本记录损坏的实例要单独报出来。 这些实例的 instance.json 读不出来，所以我们**无法确定**它们是否 真的没用这个版本（见上面 tagOf 的注释）。现在是把它们当成 "可能用到"从而参与"在跑就拦"的判断，但删除仍然放行了 —— 因为不这样的话用户会彻底删不掉东西。 所以必须让用户知道："你有个实例的版本记录坏了，它下次启动 可能会失败"。否则他会在某次启动时突然遇到「运行时结构不对」， 完全联想不到是这里删掉的。修法是重新给它选一次版本（换版本会重写记录）。
 */

      if (unknownBound.length) {
        opts.logger?.log(
          'WARN',
          'proc',
          `${unknownBound.length} 个实例的版本记录已损坏、无法确认是否在用 ${p.tag}：` +
            `${unknownBound.join('、')}（建议在实例卡片上重新选一次版本以修复记录）`
        )
      }
      // 文件后台删，删不掉只记日志——不能因为删不干净就让「删除」整个失败

      /*
       * ══════════════════════════════════════════════════════════════════════════
       * ★★ 为什么这里**不**做"限速删除"（我实测过，然后撤掉了）
       * ══════════════════════════════════════════════════════════════════════════
       *
       * 主人报告：「删了东西之后再测连通就是全部超时，磁盘 100% 持续十几分钟」。
       * 我第一版凭直觉加了 `slowRemoveDir`（每子目录让 8ms），
       * 以为"少抢点 IO"就能解决。
       *
       * **实测把我打脸了**（真实规模 4.9 万文件 / 120 目录，同一块盘）：
       *
       *     策略                删完       别人 IO 的 P95
       *     A 无限速            13.50s     0.075 ms   ← 最好
       *     B 每目录让 8ms      15.31s     0.081 ms   ← 我加的，只更慢
       *     C 每 200 文件让 2ms 14.45s     0.083 ms
       *
       * 也就是说：**删 4.9 万文件只需要 13.5 秒，而且期间别人的 IO
       * 完全没有被拖慢**（P95 才 0.075 毫秒）。限速纯属让删除更慢。
       *
       * ## 那用户的"十几分钟"到底是什么
       *
       * 日志给出的真实时间线：
       *     07:02:10  已删除 AstrBot v4.28.1      ← 后台删除开始
       *     07:02:17  runtimes:remove 耗时 1396ms（严重）
       *     07:02:17  主进程事件循环被同步阻塞 1363ms   ← **真凶**
       *     07:02:32  versions:list 耗时 10793ms
       *     07:02:38  mirrors:test / pysrc:test 8381ms
       *
       * 那 1.3 秒的同步阻塞**不是删文件**造成的 —— 删除本身只是
       * `renameSync`（微秒级）。它是**"为删一个版本去同步读所有实例的
       * instance.json"** 造成的（上面已改成并行读）。
       *
       * 而"连续删两三个包"会把这个 1.3 秒跑两三遍 —— 累加起来，
       * 用户看到的就是"删几下之后什么操作都慢"。
       *
       * 教训：**先量再改**。凭直觉加限速，方向和收益都是错的。
       * 所以这里用回普通的 `removeDirAsync`。
       */
      void removeDirAsync(dir).catch((e: unknown) => {
        opts.logger?.log(
          'WARN',
          'proc',
          `${p.tag} 的文件残留未清掉：${e instanceof Error ? e.message : String(e)}`
        )
      })
      return {
        usedBy: used.map((i) => i.name),
        // 版本记录损坏、无法确认是否引用这个版本的实例（界面应提示用户去修）

        unknownBinding: unknownBound
      }
    },
    /**
 * 手动导入运行时压缩包。 为什么需要：镜像源可能都慢或者都不通，而用户手上未必没有现成的包。 让他直接把 zip/whl 选进来，跳过网络。 设计上刻意拆成「探测 → 确认 → 安装」三步： 用户拖进来的可能是任何一个 zip，如果直接解开却发现不是我们要的东西， 既浪费时间磁盘，又会留下一个装了一半的坏目录，报错还会跑偏到很远的地方。 所以先读压缩包**条目清单**判断类型（不解压），把结论给用户看，确认了再装。
 */

    'runtimes:pickFile': async () => {
      return await pickArchiveFile()
    },
    'runtimes:probeFile': async (file) => {
      // 只读条目清单 + 算哈希，不动磁盘上的运行时目录

      const probe = await probeArchive(String(file))
      return {
        kind: probe.kind,
        version: probe.version,
        reason: probe.reason,
        sizeMB: Math.round((probe.sizeBytes / (1024 * 1024)) * 10) / 10,
        sha256: probe.sha256,
        // 顶层条目给用户看一眼，出问题时好对照

        sample: probe.entries.filter((e) => !e.endsWith('/')).slice(0, 8)
      }
    },
    'runtimes:importFile': async (p) => {
      const { config: cfg } = state()
      const store = runtimeStore(cfg.dataRoot)
      const file = String(p.file)
      /**
 * 导入归档是**读外部文件**（用户自己挑的 .zip/.tar.gz）， 所以这里不能像备份那样要求"必须在 instances 里" —— 用户 就是从下载目录或 U 盘挑的。但也不能完全不设防： - 空路径会让后面的 statSync/解压给出莫名其妙的报错； - 路径过长（>4096）在 Windows 上必然失败，早报错比晚报错清楚； - 必须是**文件**：传个目录进来会让 probeArchive 抛内部错误， 用户看到的是英文堆栈而不是"你选的是文件夹"。 这是"输入形状校验"而不是"权限边界"：读用户明确挑选的文件 本身就是这个功能的目的（和 assertInsideInstances 那种 "渲染层不该有权力指哪删哪"是两码事，不要混淆）。
 */

      if (!file.trim()) throw new Error('没有选择要导入的文件')
      if (file.length > 4096) throw new Error('文件路径过长，请把包移到更浅的目录再试')
      if (!existsSync(file)) throw new Error('文件不存在（可能已被移动或删除）')
      if (!statSync(file).isFile()) throw new Error('请选择一个压缩包文件，而不是文件夹')
      // 先探一次拿到类型和版本（importArchive 内部也会探，但这里要先算 tag）

      const probe = await probeArchive(file)
      if (probe.kind === null) throw new Error(probe.reason)
      if (probe.kind !== p.type) {
        throw new Error(
          `包类型对不上：这个包是 ${probe.kind === 'a' ? 'AstrBot' : 'NapCat'} 的，`
            + `但你要装的是 ${p.type === 'a' ? 'AstrBot' : 'NapCat'}`
        )
      }
      /**
 * 版本号决定装到哪个目录（也是实例引用它的标识）。 优先用用户填的，其次用包里读出来的，最后退化成时间戳 —— 绝不能编一个假版本号，那会让「实例在用哪个版本」这类判断全错。
 */

      const version = (p.version ?? '').trim() || probe.version
      const tag = version ? (version.startsWith('v') ? version : `v${version}`) : `imported-${Date.now().toString(36)}`
      const dest = store.dirFor(p.type, tag)

      /*
       * ══════════════════════════════════════════════════════════════════════════
       * ★★ 导入也要**进同一把锁**（主人 2026-09-27：
       *    「安装和导入没有互锁正在进行的同版本」）
       * ══════════════════════════════════════════════════════════════════════════
       *
       * ## 原来为什么没锁
       *
       * 锁（`pendingInstalls`）只有 `runtime:install` 在用，
       * 导入**完全没参与**。于是"同一个版本一边在装、一边又能导入"——
       * 两个流程同时解压/pip/替换同一个目录，互相踩。
       *
       * 日志证据（主人给的诊断包）：
       *     [11:42:13] runtimes:importFile 耗时 201619ms    ← 导入跑了 201 秒
       *     [11:43:31] runtime:install :: n:v4.18.28         ← 导入没完，安装又开了
       *     阻塞现场：正在执行：instance:update、runtimes:importFile
       *
       * ## 现在
       *
       * 与安装**共用同一个键空间**（`<type>:<tag>`）——
       * 同版本互斥，不同版本 / 不同运行时仍可并行。
       *
       * 注意登记放在**算出 tag 之后**（键要用它）。
       */
      const importKey = taskKey(p.type, tag)
      if (findTask(importKey)) {
        const busyTask = findTask(importKey)
        throw new Error(
          `${tag} 已经有一个${busyTask?.kind === 'install' ? '安装' : '导入'}在进行了 ——` +
            `等它完成，或者先取消它再来。\n` +
            `（两个流程同时写同一个目录会互相破坏，所以这里拦住了）`
        )
      }
      const importTask = beginTask({
        key: importKey,
        kind: 'import',
        controller: new AbortController(),
        label: `${p.type === 'a' ? 'AstrBot' : 'NapCat'} ${tag}`
      })
      if (!importTask) throw new Error(`${tag} 已经有一个任务在进行了，等它完成或先取消它。`)
      const importSignal = importTask.controller.signal
      /**
       * 检查是否已被取消，是就**抛错中断**。
       *
       * ══════════════════════════════════════════════════════════════════════════
       * ★ 为什么要在各个节点都查一遍（主人 2026-09-27 实测：
       *   「取消但是判定安装成功了」，多出一个 25.9 MB 的坏版本）
       * ══════════════════════════════════════════════════════════════════════════
       *
       * ## 原来的问题
       *
       * 取消的 signal 只传给了 pip —— 于是"取消"的效果是
       * **依赖装失败**，而流程照旧走完 `register` + 返回成功：
       *
       *     [22:02:27] 用户取消了 导入：AstrBot v4.28.1（已跑 3 秒）
       *     [22:02:31] 依赖安装失败：pip 退出码 -1：已取消
       *     [22:02:31] runtimes:importFile ... 成功      ← 还是"成功"
       *     runtimes.json: { "tag": "v4.28.1", "sizeMB": 25.9 }  ← 正常应 ~547
       *
       * 用户以为取消了，实际多了个跑不起来的版本，还占着「已装版本」。
       *
       * ## 现在：在每个"耗时操作之后"都查一次
       *
       * 因为用户可能在**任何阶段**点取消：
       *   · 解压大包（NapCat 那个 29 MB 压缩 / 上百 MB 解开）
       *   · pip 装依赖（几分钟）
       *   · 收尾登记
       *
       * 每个节点之后查一次，保证"取消"能在最近的检查点生效，
       * 而不是等整个流程跑完。
       *
       * 抛出的错会被下面的 catch 接住 → 清理目录 + 发 error 事件 +
       * **不登记** —— 那才是"取消"该有的语义。
       */
      const throwIfCancelled = (): void => {
        if (importSignal.aborted) {
          throw new Error('已取消 —— 这个版本不会被登记，也不会留下残留文件')
        }
      }
      /**
 * ══════════════════════════════════════════════════════════════════════ ★ 同名版本已存在时：**不能一律拦死**（审查抓出的死锁） ══════════════════════════════════════════════════════════════════════ 原判据是裸的 `existsSync(dest)` → 抛「已经有一个 vX 了」。 但真实场景是这样的（主人实测）： 导入 astrbot-4.28.0.whl → 解压成功 → **pip 装依赖失败* → 目录留下了、清单也登记了（register 在 pip 之前调用） → 用户按提示"再导一次" → **必然撞这句拦死* → 他去看列表能删，但 UI 在劝他"重来一次"，方向是反的 于是用户陷在「导入成功但起不来 → 重试被拦 → 找不到重装入口」的闭环里。 现在按**"这个版本能不能用"**判，而不是"目录在不在"： · AstrBot：缺依赖（click/quart 都没有）→ **放行重装* （pip 的 --upgrade 会覆盖式重装，安全） · 其他情况（看起来是好的）→ 维持原样拦死，避免误覆盖用户的东西
 */

      if (existsSync(dest)) {
        /*
         * ══════════════════════════════════════════════════════════════════════
         * ★★ 「已存在」的判据对 **NapCat 也要生效**
         *   （主人 2026-09-27 实测：
         *     「Error: 已经有一个 v4.18.19 了，换个版本号或先把它删掉」——
         *      而那个 v4.18.19 是他自己刚装好、清单里登记着的版本，
         *      他只想用同一个包再导一次）
         * ══════════════════════════════════════════════════════════════════════
         *
         * ## 原来的错
         *
         *     const broken = p.type === 'a' && !astrbotDepsLookInstalled(dest)
         *                     ^^^^^^^^^^^^^^^^ 只算 AstrBot
         *
         * 于是 NapCat（`p.type === 'n'`）**永远** `broken = false` →
         * **永远拦死**，哪怕那个 NapCat 目录里空空如也、或者只解压了一半。
         *
         * 后果与当初给 AstrBot 修这个 bug 时一模一样：用户陷在
         * 「装不成功 → 想重装 → 被拦 → 没有别的入口」的闭环里。
         * 只是当时只修了 AstrBot 那半边。
         *
         * ## 现在：两类各有各的"能不能用"判据
         *
         *   · AstrBot：依赖装没装齐（click/quart）
         *   · NapCat ：本体在不在（`napcat.mjs`）——
         *     那是它的入口文件，layout.ts 里也用它判"运行时结构对不对"
         *
         * 判成"坏的"就放行重装（解压是覆盖式写入，安全）。
         *
         * ## 为什么这里用「本体在不在」而不是「是不是坏了一半」
         *
         * 因为"坏"的定义只能是**可验证的缺失**。
         * 目录在、入口文件在 = 看起来是好的 → 拦死，避免误覆盖用户的东西
         *（这条保守原则保留）。入口文件都不在 = 明显残缺 → 放行。
         */
        const broken =
          p.type === 'a'
            ? !astrbotDepsLookInstalled(dest)
            : /* NapCat：入口文件不在 = 残缺，放行重装 */
              !existsSync(join(dest, 'napcat.mjs'))
        if (!broken) {
          /*
           * ══════════════════════════════════════════════════════════════════════
           * ★ 报错要给出**真能走的路**（主人 2026-09-27 实测的困惑）
           * ══════════════════════════════════════════════════════════════════════
           *
           * 原话：「已经有一个 v4.18.19 了，换个版本号或先把它删掉」
           *
           * ## 那句话里"换个版本号"是**做不到的建议**
           *
           * 版本号是从**包本身**读出来的（`probe.version`），不是用户填的
           *（界面里那个输入框只是可选的覆盖项）。所以对用户来说，
           * "换个版本号"＝"去弄一个别的包"，等于没说。
           *
           * 真正可走的路只有两条：
           *   · 到「下载」页把它删掉，再回来导入
           *   · 或者**直接把它当重装**（用户大概率就是这个意思）
           *
           * ## 所以文案改成指路，并点明"它已经装好了"
           *
           * 关键信息是**"这个版本已经装好了"** —— 用户常常不知道
           *（他从"已装版本"看到 0 之类，以为没装上），
           * 告诉他"已经有了"，他就不必再导。
           */
          throw new Error(
            `本机已经有 ${tag} 了，不用再导一次。\n` +
              `· 想用它：直接在「新建实例」里选这个版本就行\n` +
              `· 想重装覆盖：先到「下载」页把 ${tag} 删掉，再回来导入`
          )
        }
        opts.logger?.log(
          'WARN',
          'proc',
          p.type === 'a'
            ? `导入的 ${tag} 已存在但**缺依赖**（上次 pip 没装完）—— 放行重装，用 --upgrade 覆盖`
            : `导入的 ${tag} 已存在但**目录不完整**（缺 napcat.mjs）—— 放行重装，覆盖解压`
        )
      }
      sendDownloadProgress({
        type: p.type,
        tag,
        got: 0,
        total: probe.sizeBytes,
        percent: 0,
        bytesPerSec: 0,
        gotText: '',
        speedText: '解压中…',
        done: false,
        phase: 'unpack',
        label: tag
      })
      /**
 * 解压/落盘这一段必须包起来发 error 事件。 不发的话进度条会**永久停在「解压中…」**：渲染层的 clearProgress 只在收到 done 或 error 时才清（见 DownloadPage 的 onDownloadProgress）， 中途抛异常就再也没人来收尾了。用户看到的是一个永远转不完的条， 既不知道失败了、也不知道为什么 —— 而错误信息其实就在异常里。 走网络的安装路径（runtime:install）本来就有这个 catch， 手动导入这条新链路当时漏了，这里补齐，格式保持一致。
 */

      try {
        await importArchive({ dataRoot: cfg.dataRoot, file, type: p.type, destDir: dest, probe })
        /*
         * 解压完先查一次取消：NapCat 那个包 29 MB 压缩、解开上百 MB，
         * 用户完全可能在解压途中就点了取消 —— 那时不该继续往下装依赖。
         */
        throwIfCancelled()
        // NapCat 的 worker 参数补丁：解压后的包同样要修（跟下载安装走同一条逻辑）

        if (p.type === 'n') {
          const fix = patchNapcatWorkerArgv(dest)
          opts.logger?.log('INFO', 'proc', `手动导入的 NapCat ${tag} 启动参数修补：${fix.reason}`)
        }
        /**
 * ══════════════════════════════════════════════════════════════════ ★ AstrBot 的 wheel 必须**补装依赖**（主人实测的报错换来的） ══════════════════════════════════════════════════════════════════ 主人的日志（astriax-logs-20260926-213629）： instance:importFile AstrBot astrbot-4.28.0-py3-none-any.whl 成功 instance:start 失败 :: File "...\v4.28.0\astrbot\cli\__main__.py", line 5, in <module> import click ModuleNotFoundError: No module named 'click' 原因：**wheel 只含 AstrBot 本身，不含它的依赖**。 （astrbot-4.28.0-py3-none-any.whl 只有 1.2MB —— click / quart / aiohttp / anthropic 这些全在 dependencies 里，得由 pip 去装。） 原来整条导入链只做「解压 + 摆位置」，于是**导入成功但永远起不来**， 而且报错发生在实例启动时，用户根本联想不到"是导入缺了一步"。 我们自己的下载安装路径（runtime:install）是有 pip 安装这步的， 这条人工兜底路径漏了 —— 所以这里补齐，与那条路保持一致。 失败处理：**不删已导入的内容**，只把它标成"缺依赖"， 让用户能看到"装了一半"并重试（重装会走同一条 pip 逻辑）。 直接删掉的话，用户下载的 1.2MB 白费，还得重新选文件。
 */

        let depsOk = true
        if (p.type === 'a') {
          try {
            const py = pythonExeFor(cfg.dataRoot)
            if (!existsSync(py)) {
              depsOk = false
              opts.logger?.log(
                'WARN',
                'proc',
                '导入的 AstrBot 还没装依赖：**内置 Python 尚未安装**。' +
                  '先去「下载」页把 Python 装好，再来**重新导入一次**（同一个文件即可，会被放行覆盖重装）。'
              )
            } else {
              // 进度上如实显示"正在装依赖"（用户要知道为什么这一步要等）

              sendDownloadProgress({
                type: p.type,
                tag,
                got: probe.sizeBytes,
                total: probe.sizeBytes,
                percent: null,
                bytesPerSec: 0,
                gotText: '',
                speedText: '正在安装依赖（pip，可能几分钟）…',
                done: false,
                phase: 'unpack',
                label: tag
              })
              const r = await installAstrbotDeps({
                pythonExe: py,
                runtimeDir: dest,
                dataRoot: cfg.dataRoot,
                /**
 * 把用户选的原始文件传进去：如果它本身是 .whl， pip 直接装这个文件 —— 保证装到的正是用户手里那个版本 （按 PyPI 装可能拿到同版本号的不同构建，甚至因网络失败）。
 */

                wheelFile: /\.whl$/i.test(file) ? file : undefined,
                /* 取消信号一路传进 pip —— 导入的依赖安装也要能取消 */
                signal: importSignal,
                /*
                 * ★★ 把 pip 的每个阶段转发成进度事件
                 *   （主人 2026-09-27：「导入 astrbot 的时候一直"正在处理，
                 *     请稍候…"，而不是根据阶段显示进度，会让人以为卡住了」）
                 *
                 * ## 为什么这个回调是必须的（不只是一个"锦上添花"）
                 *
                 * 渲染层有个**"看起来卡死"的保护**（`isStalled`）：
                 * 某个任务**超过 5 秒**没收到新事件 → 把标签改成
                 * 「正在处理，请稍候…」。
                 *
                 * 而装 AstrBot 依赖要**几分钟**，期间 pip 的输出原来全被丢弃 ——
                 * 界面只在开始/结束各收到一条事件。于是那几分钟里
                 * **一直显示"正在处理，请稍候…"**，用户完全不知道在干什么。
                 *
                 * 接上这个回调之后，pip 每输出一行就发一次事件
                 *（界面上滚动显示 aiohttp-3.10.5、quart-0.19.6 …），
                 * 既满足 stall 保护的时间要求，又让用户看到"确实在动"。
                 *
                 * `speedText` 放阶段名（"正在安装依赖"），`gotText` 放具体包名 ——
                 * 界面渲染成「正在安装依赖 · aiohttp-3.10.5」的样子。
                 */
                onStage: (stage) => {
                  sendDownloadProgress({
                    type: p.type,
                    tag,
                    got: probe.sizeBytes,
                    total: probe.sizeBytes,
                    percent: null,
                    bytesPerSec: 0,
                    gotText: stage,
                    speedText: '正在安装依赖',
                    done: false,
                    phase: 'unpack',
                    label: tag
                  })
                }
              })
              depsOk = r.ok
              opts.logger?.log(
                r.ok ? 'INFO' : 'WARN',
                'proc',
                r.ok
                  ? `导入的 AstrBot ${tag} 依赖已装好`
                  : `导入的 AstrBot ${tag} 依赖安装失败：${r.reason}`
              )

              /*
               * ══════════════════════════════════════════════════════════════════
               * ★★ 用户**取消**了 → 必须中断整个导入，不能继续登记
               *   （主人 2026-09-27 实测的真问题）
               * ══════════════════════════════════════════════════════════════════
               *
               * ## 现场（他给的日志）
               *
               *     [22:02:27] 用户取消了 导入：AstrBot v4.28.1（已跑 3 秒）
               *     [22:02:31] 导入的 AstrBot v4.28.1 依赖安装失败：pip 退出码 -1：已取消
               *     [22:02:31] runtimes:importFile  AstrBot ...whl  成功   ← 还是"成功"！
               *
               * 而 `runtimes.json` 里那条记录是：
               *     { "tag": "v4.28.1", "from": "手动导入", "sizeMB": 25.9 }
               *                    ↑ 正常应当 ~547 MB，25.9 MB 说明只解压了 whl 本体
               *
               * ## 为什么会这样
               *
               * 依赖安装失败原来**只降级成 `depsOk = false`**，
               * 然后流程照旧走完 `register` + 返回成功 ——
               * 于是"取消"变成了"装了一个跑不起来的版本，而且界面显示已安装"。
               *
               * 那比"取消失败"更糟：用户以为取消了，实际多了个坏版本，
               * 还占着「已装版本」的位置，点它创建实例必崩。
               *
               * ## 现在：取消 → 抛错中断
               *
               * 抛出去会被上面的 catch 接住 → 清理暂存/目标目录、
               * 发一条 error 事件、**不登记**。用户看到"已取消"，
               * 而且没有任何残留。
               *
               * 注意判据是 `importSignal.aborted`（**用户取消**），
               * 不是 `!r.ok` —— 依赖装失败（源坏了/网络断）是另一回事：
               * 那种情况下目录里**有完整的 AstrBot 本体**，
               * 登记它让用户可以换源重装，比删掉更友好。
               * 两者的区别就在这里，不能混。
               */
              /* 换成统一的中断检查（见 throwIfCancelled 的说明） */
              throwIfCancelled()
            }
          } catch (e) {
            depsOk = false
            opts.logger?.log('WARN', 'proc', '导入后装依赖异常', String(e))
          }
        }
        /*
         * ★ 登记之前**最后一道取消检查** —— 这是最关键的一处。
         *
         * 用户从点「取消」到主进程真正收到，中间有 IPC 往返；
         * 而登记是"从此这台机器上这个版本就算装好了"的那一刻。
         * 不加这道检查，就会出现主人实测的：
         *
         *     取消了 → 但 runtimes.json 里多出一条
         *     { "tag": "v4.28.1", "sizeMB": 25.9 }     ← 半成品
         *
         * 取消之后再登记 = 用户以为取消了、实际多了个跑不起来的版本。
         */
        throwIfCancelled()
        store.register({ type: p.type, tag, from: '手动导入' })
        // 导入也是「更新操作」，同样要作废版本列表缓存

        invalidateVersionCache(cfg.dataRoot)
        opts.logger?.log('INFO', 'proc', `已手动导入 ${p.type === 'a' ? 'AstrBot' : 'NapCat'} ${tag}`)
        sendDownloadProgress({
          type: p.type,
          tag,
          got: probe.sizeBytes,
          total: probe.sizeBytes,
          percent: 100,
          bytesPerSec: 0,
          gotText: '',
          // 依赖没装成就要在完成提示里说出来，别让用户以为一切正常

          speedText: depsOk ? '完成' : '完成（但依赖没装上，启动会失败）',
          done: true,
          phase: 'done',
          label: tag
        })
        return { tag, kind: probe.kind, sha256: probe.sha256, depsOk }
      } catch (e) {
        /**
 * 解压到一半失败会留下半个目录（importArchive 自己会清暂存， 但已落进 dest 的内容它不管）。这里顺手清掉， 否则下次导入同一个版本会被 existsSync(dest) 拦下， 用户看到「已经有一个 vX 了」却找不到能用的版本 —— 一个残缺目录把人卡死。
 */

        try {
          if (existsSync(dest)) await removeDirAsync(dest)
        } catch {
          /**
 * 清不掉就算了，别盖掉真正的失败原因
 */

        }
        const msg = e instanceof Error ? e.message : String(e)
        sendDownloadProgress({
          type: p.type,
          tag,
          got: 0,
          total: undefined,
          percent: null,
          bytesPerSec: 0,
          gotText: '0 B',
          speedText: '',
          done: false,
          phase: 'error',
          error: msg,
          label: tag
        })
        throw e
      } finally {
        /*
         * 释放登记（成功 / 失败 / 取消三条路径都要走这里）。
         *
         * 不释放的话那个版本会**永远显示"正在进行中"**、永远开不了新任务 ——
         * 这正是我在 `markInstalling` 上踩过的坑（true/false 没配对），
         * 所以这次严格用 finally，并且 `endTask` 只释放"自己那一个"。
         */
        endTask(importKey, importTask.controller)
      }
    },
    'python:status': () => {
      const { config: cfg } = state()
      const exe = pythonExeFor(cfg.dataRoot)
      return { ready: existsSync(exe), version: PYTHON_VERSION, exe }
    },
    /**
 * 安装内置 Python 3.12（AstrBot 运行必需；NapCat 用自带 node.exe 不需要）
 */

    'python:install': async () => {
      const { config: cfg } = state()
      const dir = pythonDirFor(cfg.dataRoot)
      const exe = pythonExeFor(cfg.dataRoot)
      if (existsSync(exe)) return { ready: true, version: PYTHON_VERSION, exe }
      /*
       * ══════════════════════════════════════════════════════════════════
       * ★★ 登记任务，让「取消」按钮真的能取消（主人 2026-10-08 实测）
       * ══════════════════════════════════════════════════════════════════
       *
       * 主人：「不只是 python 安装点击取消没反应，是全部东西的安装都不能取消」
       *
       * ## 根因
       *
       * 界面上的取消走 `runtimes:cancel`，它按 `<type>:<tag>` 去
       * `running-tasks` 注册表里查任务、abort 它的 controller。
       * 而这条路径**从来没登记过**，于是：
       * 注册表里查不到 → cancelTask 返回 ok:false → 界面什么都不做。
       *
       * 更糟的是它还发了 `downloaded` 类进度事件，而
       * `currentDownloads()`（切页恢复进度用）会拿 findTask 判断存活 ——
       * 没登记的任务会被**误判成僵尸清掉**，表现是"进度条自己消失了"。
       *
       * 键用 `a:Python <版本>`：与进度事件里的 tag 完全一致
       *（见下面 sendDownloadProgress 的 tag），这样界面按
       * `${p.type}|${p.tag}` 就能对上号。
       */
      const pyKey = taskKey('a', `Python ${PYTHON_VERSION}`)
      if (findTask(pyKey)) {
        throw new Error(`Python ${PYTHON_VERSION} 正在安装中，不要重复点。`)
      }
      const pyTask = beginTask({
        key: pyKey,
        kind: 'install',
        controller: new AbortController(),
        label: `Python ${PYTHON_VERSION}`
      })
      if (!pyTask) {
        throw new Error(`Python ${PYTHON_VERSION} 已经在装了，等它完成或先取消它。`)
      }
      /* 取消信号：下载的 fetch 与 pip 子进程共用它 */
      const pySignal = pyTask.controller.signal
      const { mkdirSync: mk } = await import('fs')
      // 同上：暂存与 pip 缓存全部走 data 下的固定目录

      const stage = makeStage(cfg.dataRoot, 'py')
      const zip = join(stage, 'python.zip')
      try {
        sendDownloadProgress({ type: 'a', tag: `Python ${PYTHON_VERSION}`, got: 0, total: undefined, percent: null, bytesPerSec: 0, gotText: '', speedText: '下载中…', done: false, phase: 'downloading', label: `Python ${PYTHON_VERSION}` })
        const tracker = createProgressTracker()
        const dl = await downloadRuntime({
          dataRoot: cfg.dataRoot,
          type: 'a',
          release: {
            tag: `Python ${PYTHON_VERSION}`,
            assetName: `python-${PYTHON_VERSION}-embed-amd64.zip`,
            assetUrl: PYTHON_SOURCES[0]
          },
          destFile: zip,
          onlyBase: undefined,
          sources: PYTHON_SOURCES,
          /* 取消信号传下去：点取消时中断正在进行的 HTTP 下载 */
          signal: pySignal,
          onProgress: (got, total) => {
            sendDownloadProgress({ ...tracker.update('a', `Python ${PYTHON_VERSION}`, got, total), phase: 'downloading', label: `Python ${PYTHON_VERSION}` })
          }
        })
        mk(dir, { recursive: true })
        sendDownloadProgress({ type: 'a', tag: `Python ${PYTHON_VERSION}`, got: dl.bytes, total: dl.bytes, percent: 100, bytesPerSec: 0, gotText: humanSize(dl.bytes), speedText: '解压中', done: false, phase: 'unpack', label: `Python ${PYTHON_VERSION}` })
        /* 解压同样接受取消：Expand-Archive 起的是独立进程，abort 会 taskkill 掉它 */
        const ex = await expandArchive(zip, dir, { timeoutMs: 300000, signal: pySignal })
        if (ex.status !== 0) throw new Error(`解压失败：${String(ex.stderr).slice(0, 200)}`)
        enableEmbedSite(dir)
        // 注入 sitecustomize：embed 版会忽略 PYTHONPATH，实例的包目录只能靠它认出来

        ensureSiteCustomize(dir)
        // 全程异步：pip 引导与构建工具安装都要几十秒，同步会卡住整个界面
        // 环境里带 pipEnvFor：缓存与临时目录都指向 data，不写 C 盘

        const runPy = (args: string[], o?: { signal?: AbortSignal }) =>
          run(exe, args, {
            timeoutMs: 600000,
            env: pipEnvFor(cfg.dataRoot, { ...process.env, PYTHONHOME: dir }),
            /* 取调用方传进来的（更精确），缺省用本任务的总信号 */
            signal: o?.signal ?? pySignal
          })
        await ensurePip({
          dir,
          runPython: runPy,
          /* 取消信号：pip 引导是几十秒的长活，不接它就等于按钮是死的 */
          signal: pySignal,
          onNote: (m) => opts.logger?.log('INFO', 'proc', `内置 Python：${m}`)
        })
        // 兜底：某些机器上构建工具没装上，这里再确认一次（AstrBot 有源码依赖，必须能编译）

        await ensureBuildTools({
          runPython: runPy,
          signal: pySignal,
          // 跟随用户选的 Python 源（不传会用默认源）

          pipArgs: pythonSourceToPipArgs(resolvePythonSource(cfg.dataRoot)),
          onNote: (m) => opts.logger?.log('INFO', 'proc', `内置 Python：${m}`)
        })
        opts.logger?.log('INFO', 'proc', `内置 Python ${PYTHON_VERSION} 就绪 → ${dir}`)
        sendDownloadProgress({ type: 'a', tag: `Python ${PYTHON_VERSION}`, got: dl.bytes, total: dl.bytes, percent: 100, bytesPerSec: 0, gotText: humanSize(dl.bytes), speedText: '完成', done: true, phase: 'done', label: `Python ${PYTHON_VERSION}` })
        return { ready: true, version: PYTHON_VERSION, exe }
      } catch (e) {
        /*
         * ★ 失败/取消必须发一条 error 进度（否则进度条永远挂着）
         *
         * 与 runtime:install 的约定一致：渲染层的进度条只在收到
         * done / error 时才收尾（见 setProgress → scheduleClear）。
         * 漏发的话用户点完取消，那个条会一直亮着"下载中…"。
         */
        const msg = e instanceof Error ? e.message : String(e)
        const cancelled = pySignal.aborted
        sendDownloadProgress({
          type: 'a',
          tag: `Python ${PYTHON_VERSION}`,
          got: 0,
          total: undefined,
          percent: null,
          bytesPerSec: 0,
          gotText: '',
          speedText: '',
          done: false,
          phase: 'error',
          error: cancelled ? '已取消 —— 你可以重新点「安装」再试' : `安装 Python 失败：${msg}`,
          label: `Python ${PYTHON_VERSION}`
        })
        throw e
      } finally {
        /**
 * 释放任务登记 —— **必须放在 finally**。 漏了的话这个键会永远留在注册表里，下次装 Python 会被 互锁当成"已经在装了"直接拒绝（而且用户没有任何办法解开，只能重启软件）。
 */

        endTask(pyKey, pyTask.controller)
        /**
 * 同样要异步删（见 runtimes:install 里那段说明）。 内置 Python 解压后上万个文件，rmSync 会把主进程锁住好几秒， 表现为「装完 Python 界面卡一下」。
 */

        /*
         * ★ 删失败要**记日志**，不能静默（独立审查抓出的"静默黑洞"）
         *
         * 原来是 `catch(() => undefined)` —— 完全无声。
         * 而这里删失败的概率并不低：pip 的 `TMP`/`TEMP` 被 `pipEnvFor`
         * 指向 `cache/tmp`（正是 stage 的父目录），子进程刚被杀时
         * 句柄可能还没释放。
         *
         * 后果：取消一次安装就在 `cache/tmp` 里留几十 MB~几百 MB 的残骸，
         * 而**日志里一个字都没有** —— 用户报"磁盘越来越小"时我们无从查起。
         * （`workdir.ts` 里那段抱怨"cache\tmp 堆了 916 个条目"的注释，
         *   成因之一就是这类静默失败。）
         *
         * 与 `runtime:install` 的收尾保持一致：失败写 WARN，但**不影响**
         * 安装结果本身（该抛的照抛）。
         */
        void removeDirAsync(stage).catch((e: unknown) => {
          const why = e instanceof Error ? e.message : String(e)
          opts.logger?.log(
            'WARN',
            'proc',
            `内置 Python 暂存目录清理失败（下次启动会重试）：${stage} —— ${why}`
          )
        })
      }
    }
  } as unknown as HandlerMap
  /**
 * 统一审计：把所有 handler 包一层，自动记录「谁调了哪个操作、成功还是失败」。 为什么放在这一层而不是每个 handler 里手写： 手写必然漏 —— 我们有几十个 handler，将来还会加，靠自觉就是等着漏。 在这里包一层，**新加的操作自动被记录**。 过滤掉噪声（不记的）： - 纯读类（list/get/status/read/log/test 这类）：翻日志要查的是"谁改了什么"， 把每次刷新列表都记进去会把审计轨淹掉。用户想看的操作是"动作"，不是"看见"。 记的：启动/停止/创建/删除/改名/改端口/重置/备份/回滚/更新/装运行时/改配置…
 */

  const audited = {} as HandlerMap
  /**
 * 退出清理：**不参与审计包装**，直接挂在返回对象上（Symbol 键， 不会被 registerIpcHandlersReal 的 Object.entries 注册成 IPC 通道）。
 */

  ;(audited as unknown as Record<symbol, unknown>)[EXIT_CLEANUP] = killEverythingForExit
  const SKIP_AUDIT = /(^|:)(list|get|read|status|ping|state|log|versions|overview|test|probe|days)(:|$)/
  /**
 * 给审计挑一个「人能认出的对象名」。 handler 的第一个参数常常是实例 id（`a_1c9c6d958f`）或参数对象， 这些对人类读者毫无意义。审计要的是「NapCat 实例」这种能直接看懂的称呼， 所以把 id 解析成实例名；解析不出就退回原样。
 */

  const describeTarget = (args: unknown[]): string => {
    const first = args[0]
    if (first === undefined) return '-'
    if (typeof first === 'string') {
      // 实例 id 形态：a_/n_ + hex —— 换成实例名，日志才读得懂

      if (/^[an]_[0-9a-f]{6,}$/.test(first)) {
        const rec = repo?.get(first)
        if (rec) return rec.name
      }
      return first.length > 60 ? first.slice(0, 57) + '…' : first
    }
    if (first && typeof first === 'object') {
      const o = first as Record<string, unknown>
      const parts: string[] = []
      for (const k of ['name', 'tag', 'file', 'id']) {
        const v = o[k]
        if (typeof v === 'string' && v) parts.push(v)
      }
      const t = o.type
      if (typeof t === 'string') parts.unshift(t === 'a' ? 'AstrBot' : 'NapCat')
      if (parts.length) return parts.join(' ')
    }
    return '-'
  }
  for (const [channel, fn] of Object.entries(handlers as Record<string, HandlerFn>)) {
    if (typeof fn !== 'function') {
      ;(audited as Record<string, unknown>)[channel] = fn
      continue
    }
    if (SKIP_AUDIT.test(channel)) {
      ;(audited as Record<string, unknown>)[channel] = fn
      continue
    }
    /**
 * 包装要**保留原有的同步/异步性质**。 踩过的坑：一开始无脑写成 `async (...args) => {...}`，结果把同步 handler 的「同步抛异常」变成了「返回一个 rejected promise」——调用方拿到的 是 promise，同步 try/catch 和 `expect(() => ...).toThrow()` 全都失效， **校验静默失效了**。当时触发这个坑的是 `runtimes:remove`（它的引用 检查靠同步 throw 拦住删除），那个 handler 后来改成了 async， 但这条规矩对**其他同步 handler* 依然成立，所以保留这个分支。 所以按原函数的类型分两条路：原本同步的保持同步，原本异步的才用 async。
 */

    const isAsync = fn.constructor.name === 'AsyncFunction'
    const recordOk = (target: string): void => {
      opts.audit?.record({ actor: 'user', action: channel, target, result: 'ok' })
    }
    const recordFail = (target: string, e: unknown): void => {
      // 失败也要记，而且要把原因带上——出问题时最该查的就是这些

      opts.audit?.record({
        actor: 'user',
        action: channel,
        target,
        result: 'fail',
        detail: e instanceof Error ? e.message : String(e)
      })
    }
    if (isAsync) {
      ;(audited as Record<string, unknown>)[channel] = async (...args: unknown[]) => {
        const target = describeTarget(args)
        try {
          const out = await fn(...args)
          recordOk(target)
          return out
        } catch (e) {
          recordFail(target, e)
          throw e
        }
      }
    } else {
      ;(audited as Record<string, unknown>)[channel] = (...args: unknown[]) => {
        const target = describeTarget(args)
        try {
          const out = fn(...args)
          recordOk(target)
          return out
        } catch (e) {
          recordFail(target, e)
          throw e // 保持同步抛，调用方的 try/catch 与断言才能正常工作

        }
      }
    }
  }
  return audited}/**
 * 把 handlers 注册进真 Electron ipcMain（生产入口；测试不走这条）。返回 logger/pm 供主进程挂崩溃与退出钩子
 */
/**
 * 阻塞现场探针（给 index.ts 的阻塞看门狗用）。 ★ 为什么走模块级变量而不是 return 出去 `registerIpcHandlersReal()` 的返回值已经被 index.ts 解构成一堆命名成员 （logger / getConfig / killEverythingForExit …）。再塞一个进去要改 两边的解构与类型，而这条信息**只被看门狗用一次**，不值得动那个契约。 用模块级变量 + 一个 getter，语义清楚（"问一问当前在跑什么"）， 也不会让 index.ts 与 ipc.ts 的返回结构继续膨胀。
 */
let ipcSceneProbe: (() => string) | undefined/**
 * 读"阻塞时主进程在跑什么" —— 未注册（如单测直接调 handler）时返回 undefined
 */
export function currentIpcScene(): string | undefined {
  try {
    return ipcSceneProbe?.()
  } catch {
    return undefined
  }}
export async function registerIpcHandlersReal(extra: {
  /**
 * 启动时的提权判定结果。会写进导出包的设备信息（见 HandlerOpts.elevateVerdict）。 用可选参数而不是必填：单测直接调这个函数时不关心它。
 */

  elevateVerdict?: string} = {}) {
  const { ipcMain, app } = await import('electron')
  const pm = createProcessManager()
  const dataRoot0 = await defaultDataRoot()
  /**
 * 探测 QQ 环境（安装位置 + 版本）。 ★ 为什么提取成局部函数：原来这段逻辑**内联在 buildHandlers 的 `qqChecker` 参数里**，而导出诊断包也要用同一份结论（"用户是哪个 QQ 版本" 是排查 NapCat 起不来的第一句问话）。复制一份必然漂移，所以提取共用。
 */

  const detectQQInfo = async () => {
    // QQ 安装位置有两条注册表来源 + 常见位置兜底：
    //   1. HKLM\...\Tencent\QQNT 的 Install 值（直接就是安装目录，最可靠）
    //   2. 卸载项 UninstallString（NapCat 官方 launcher.bat 读的就是这个）
    //   3. C:\Program Files\Tencent\QQNT 等常见位置（绿色版/便携版）
    // 走异步 reg.exe，不阻塞主进程（版本检测可能会被连点好几次）。

    const keys = [...QQ_INSTALL_REGISTRY_KEYS, ...QQ_REGISTRY_KEYS]
    const found = new Map<string, string>()
    for (const key of keys) {
      const isInstallKey = QQ_INSTALL_REGISTRY_KEYS.includes(key)
      const value = isInstallKey ? 'Install' : 'UninstallString'
      const r = await run('reg.exe', ['query', key, '/v', value], { timeoutMs: 8000 })
      if (r.status !== 0) continue
      const line = r.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l.toLowerCase().startsWith(value.toLowerCase()))
      if (!line) continue
      const m = line.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)$/i)
      if (m) found.set(key, m[1].trim())
    }
    const candidates = [
      // Install 值给的就是目录本身

      ...QQ_INSTALL_REGISTRY_KEYS.map((k) => (found.get(k) ?? '').replace(/^"|"$/g, '')).filter(
        Boolean
      ),
      // 卸载项要推一层目录（去掉 \QQ.exe 和引号）

      ...qqCandidatesFromRegistry((key) => found.get(key)),
      // 兜底：没写进注册表的绿色版/常见位置

      ...QQ_FALLBACK_DIRS
    ]
    /**
 * ★ 顺手把"解析出来的 QQ 安装位置"回填缓存（指导书 P0-4） 这个异步检测在 instance:start 里**先于**取启动命令执行： await detectQQInfo() ← 这里（注册表已异步查完） commandFor(...) ← 之后才轮到同步的 qqInstallDir() 命中缓存后，那条同步路径一次 syscall 都不做 —— 启动实例不再 因为"查 QQ 在哪"冻结主进程（原来最坏 2×5 秒）。
 */

    rememberQqInstall(qqInstallFromRegistry((key) => found.get(key)))
    return checkQQ({ candidates })
  }
  /**
 * ★ 必须把版本号传给 logger（主人 2026-09-27 的诊断包暴露的缺口） 他导出的包里写着： AstriaX 版本: (未知) 而"你用的是哪个版本"是排查任何问题的**第一句话**。 版本号本来是可选参数（`appVersion?: string`），生产这里没传 → 导出包永远显示"(未知)"。 `app.getVersion()` 在打包态读的是 package.json 的 version （dev 态读 Electron 的版本，所以下面再兜一层 —— dev 时优先用 项目里那份，避免把 Electron 版本误当成软件版本）。 ★ 必须走 `electronApp()`（不是裸的 `app`） ipc-app-import-guard 那条守卫会拦下裸用法，理由很实在： 本文件**顶层不 import electron**（单测跑纯 node）， 而 `const { app } = await import('electron')` 在纯 node 下**不会抛错* —— 它拿到的是一个只有路径字符串的模块，解构出来的 `app` 是 undefined， 下一行访问属性就抛 `Cannot read properties of undefined`。 `electronApp()` 内部 try/catch 并返回 `app | undefined`，用它才安全。
 */

  const appVersion = await electronApp()
    .then((a) => {
      try {
        return a?.getVersion?.()
      } catch {
        return undefined
      }
    })
    .catch(() => undefined)
  const logger = createLogger({
    dataRoot: dataRoot0,
    appVersion,
    /**
 * ★ 注入设备信息采集器（主人 2026-09-27： 「日志系统应该同时收集一次设备信息，比如系统，依赖，硬件等」） 每次导出时**现采**（而不是启动时采一次存着）—— 因为磁盘余量、可用内存、实例数这些都是**动态**的， 用户往往是"出了问题立刻导出"，那一刻的数值才有意义。 采集全程异步子进程 + 各项超时，绝不阻塞主进程； 任何一项失败都写"(取不到)"，绝不让导出失败。
 */

    deviceInfo: async () => {
      const { collectDeviceInfo } = await import('./logs/device-info')
      const { run } = await import('./util/async-exec')
      /**
 * QQ 与 Python 状态用**现成的探测函数**（不重复实现）： 探测各自有缓存/超时，拿不到就传 undefined（会写成"未检测"）。
 */

      let qq: { ok?: boolean; version?: string; path?: string; reason?: string } | undefined
      try {
        /**
 * 直接探测（**不能写 `opts.qqChecker`* —— 那是 buildHandlers 的参数， 这个作用域里根本没有它，会 ReferenceError）。 这里用与 `qq:status` handler 同一套探测函数，保证两边结论一致。
 */

        const info = await detectQQInfo()
        if (info) {
          qq = {
            ok: info.ok,
            version: info.version,
            path: (info as { path?: string }).path,
            reason: (info as { reason?: string }).reason
          }
        }
      } catch {
        qq = undefined
      }
      let py: { ready?: boolean; version?: string; exe?: string } | undefined
      try {
        /*
         * ★★ `state()` 在这里**不可达**（第二版排查报告抓出的真 bug）
         *
         * `state` 是 `buildHandlers()` 的**局部函数**，而这段代码在
         * `registerIpcHandlersReal()` 的作用域里 —— 两个函数互不相通。
         *
         * 于是 `state().config` 抛 ReferenceError → 下面那个 `catch` 吞掉
         * → `py = undefined` → **导出的诊断包里 Python 状态永远是"未检测"**。
         *
         * 诊断工具自己坏了：用户导出日志求助，而"Python 装没装"这个
         * 最关键的信息恰好缺失。
         *
         * ## 讽刺的是，作者自己 17 行前刚提醒过同类错误
         *
         * 上面 qq 那段注释写着：
         *     「直接探测（**不能写 `opts.qqChecker`** —— 那是 buildHandlers
         *       的参数，这个作用域里根本没有它，会 ReferenceError）」
         * 刚说完"这个作用域拿不到那个东西"，紧接着对 `state()` 犯了**完全相同的错**。
         *
         * 说明这条约束**没有被任何工具兜住** —— 类型检查本可以，
         * 但项目没在跑它（见报告的 H-6）。
         *
         * ## 修法：用这个作用域里**真实可用**的变量
         *
         * `liveDataRoot` 就是这个作用域里的"当前数据根"（它跟着配置迁移更新），
         * 正是要拿去算 Python 路径的东西。
         */
        const dr = liveDataRoot
        if (dr) {
          const { pythonExeFor, PYTHON_VERSION } = await import('./runtime/python-runtime')
          const exe = pythonExeFor(dr)
          const ready = existsSync(exe)
          py = { ready, version: ready ? PYTHON_VERSION : undefined, exe: ready ? exe : undefined }
        }
      } catch (e) {
        py = undefined
        logger.log('WARN', 'app', '采集 Python 状态失败（诊断包里会是"未检测"）', String(e))
      }
      return collectDeviceInfo({
        dataRoot: dataRoot0,
        appVersion,
        run,
        elevateVerdict: extra?.elevateVerdict,
        qq,
        python: py
      })
    }
  })
  /**
 * ══════════════════════════════════════════════════════════════════════════ IPC 现场记账（给阻塞看门狗抓"谁卡的"用） ══════════════════════════════════════════════════════════════════════════ ★ 这段代码的位置踩过一次坑，写下来免得再犯： 第一版我把它插到了 **`buildHandlers()`* 里（那个函数在第 765 行， 是"纯函数式的 handler 构造器"，不接触 ipcMain），而 `ipcSceneProbe` 是模块级变量、在**这里**才被赋值。两个作用域对不上，于是： Error invoking remote method 'config:get': ReferenceError: inflightIpc is not defined —— 界面一进来就弹"读取配置失败"。 **是互动测试（真把软件打开看一眼）抓到的，不是单测**： 单测直接调 handler、根本不走 `ipcMain.handle` 那层包装， 所以这段代码在单测里从来没被执行过。 又是一次"接线层的 bug 单测看不见"。 inflight —— 此刻正在执行的 channel 名集合（await 交错时会有多个） recent —— 最近完成的慢调用（环形，最多 8 条）
 */

  const inflightIpc = new Set<string>()
  const recentIpc: Array<{ ch: string; ms: number; at: number }> = []
  ipcSceneProbe = () => {
    const now = Date.now()
    const running = [...inflightIpc]
    const done = recentIpc
      .slice(-4)
      .map((r) => `${r.ch}(${r.ms}ms, ${Math.round((now - r.at) / 1000)}秒前)`)
    const bits: string[] = []
    if (running.length) bits.push(`正在执行：${running.join('、')}`)
    if (done.length) bits.push(`最近完成：${done.join('、')}`)
    return bits.length ? bits.join('；') : '（没有正在执行也没有近期慢调用）'
  }
  /**
 * ★ 审计日志必须**跟着当前数据根走**，不能让它在启动时就定死。 ## 原来的 bug（审计抓出来的） 这里原来是 `const audit = createAuditLog({ dataRoot: dataRoot0 })` —— createAuditLog 在**构造时**就把 logsDir 定死了（见 logs/audit.ts:60）， 所以这个实例永远指向**启动那一刻**的数据根。 而 `onDataRootChanged` 只更新 liveDataRoot，从不重建 logger/audit。 于是用户**迁移过数据目录**之后： · `audit:days` 用 cfg.dataRoot（新目录）列日期 · `audit:read` 和所有 `record()` 走这个老实例（旧目录） 两处指向不同目录 → 审计页**永远是空的**，而记录其实都写在旧目录里。 同一个文件里刚有注释强调过「用 liveRoot()」，说明这条规则是知道的， 只是漏掉了 audit —— 典型的"修一处忘一处"。 ## 修法：惰性解析 用一个**转发代理**：每次调用时才按当前 liveDataRoot 现建一个真实的 AuditLog，再把调用转过去。这样 record/read/list 天然都落在 "现在真正在用的那个目录"上。 为什么可以每次现建：createAuditLog 只是拼一个路径字符串 （logs/audit.ts:57-60 只算 logsDir，不读盘、不建目录 —— 目录是在真正写的时候才 mkdir），所以构造成本可以忽略。 注意 `liveDataRoot` 在下面才声明 —— 用函数声明式取值而不是把值 提前捕获，才能拿到"调用那一刻"的值（这正是这个修复的要点）。
 */

  let liveDataRoot = await startupDataRoot()
  const liveRoot = (): string => liveDataRoot
  /**
 * ★ 审计日志必须**跟着当前数据根走**，不能让它在启动时就定死。 ## 原来的 bug（审计抓出来的） 这里原来是 `const audit = createAuditLog({ dataRoot: dataRoot0 })` —— createAuditLog 在**构造时**就把 logsDir 定死了（见 logs/audit.ts:60）， 所以那个实例永远指向**启动那一刻**的数据根。 而 `onDataRootChanged` 只更新 liveDataRoot，从不重建 logger/audit。 于是用户**迁移过数据目录**之后： · `audit:days` 用 cfg.dataRoot（新目录）列日期 · `audit:read` 和所有 `record()` 走那个老实例（旧目录） 两处指向不同目录 → 审计页**永远是空的**，而记录其实都写在旧目录里。 同一个文件里刚有注释强调过「用 liveRoot()」，说明这条规则是知道的， 只是漏掉了 audit —— 典型的"修一处忘一处"。 ## 修法：惰性解析 用一个**转发代理**：每次调用时才按当前 liveDataRoot 现建一个真实的 AuditLog，再把调用转过去。这样 record/read/fileFor 天然都落在 "现在真正在用的那个目录"上。 为什么可以每次现建：createAuditLog 只是拼一个路径字符串 （logs/audit.ts:57-60 只算 logsDir，不读盘、不建目录 —— 目录是在真正写的时候才 mkdir），所以构造成本可以忽略。 注意：代理体里的 `liveRoot()` 是**延迟求值**的（只在被调用时执行）， 所以它拿到的永远是"调用那一刻"的值 —— 这正是这个修复的要点。 声明顺序上放在 liveRoot 之后，避免读代码时的 TDZ 疑惑。
 */

  const audit: AuditLog = {
    record: (e) => createAuditLog({ dataRoot: liveRoot() }).record(e),
    fileFor: (date) => createAuditLog({ dataRoot: liveRoot() }).fileFor(date),
    read: (date) => createAuditLog({ dataRoot: liveRoot() }).read(date)
  }
  /**
 * 「目前真正在用的数据根」——启动时按指针解析一次，之后跟着配置变。 为什么需要单独记一个，而不是每次现算： - 启动那一刻要读指针才知道上次用的是哪个目录（startupDataRoot） - 但用户在**这一次运行中**迁移了目录之后，指针虽然也写了， 可"现在到底在用哪个"这件事只有主进程自己清楚，重算一遍指针 在极端情况下（写指针失败）会退回到旧值 - 托盘菜单随时可能来读配置，它不该依赖一次异步的指针读取 所以：初值 = startupDataRoot()，被 config:set（首启向导/改配置落盘） 和 config:moveDataRoot（迁移）更新。getConfig 用它。
 */

  /**
 * 「上次是否异常退出」的持有者。 为什么由这里持有、而不是 index.ts 直接算： buildHandlers 在**这个函数内部**被调用，而判定的时机在**它之后* （要先知道 dataRoot 才能读 running.lock）。所以用闭包变量 + 返回一个 setter：index.ts 判定完调 setLastCrash(prev)， handler 读的时候拿到的就是最新值 —— 顺序天然正确。
 */

  let lastCrashInfo: { crashed: boolean; startedAt?: number } = { crashed: false }
  /**
 * 更新进度发送（统一一处）。 ## 为什么要带 isDestroyed 判断 升级/下载过程中用户可能已经把窗口关掉了。`webContents.send` 到已销毁的 webContents 会抛 `Object has been destroyed` —— 而这个调用点在 下载进度回调里（每秒好几次），抛出去会把下载流程本身打断。 项目在 0.1.2 的审计里就点过这类"往已销毁窗口发消息"，这里一并守住。
 */

  const sendUpdateProgress = (p: { percent: number; got: number; total?: number }): void => {
    void import('electron')
      .then(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (w.isDestroyed() || w.webContents.isDestroyed()) continue
          w.webContents.send('update:progress', p)
        }
      })
      .catch(() => {
        /**
 * 窗口都没了就丢弃进度，绝不让它影响下载
 */

      })
  }
  /**
 * electron-updater 封装（指导书第六章 P3）。 只在**打包态**构造：开发态没有 app-update.yml，检查必然失败， 构造出来只会制造噪音。任何异常（依赖缺失、electron 不可用） 都只记一行日志 —— 更新功能本身有手写路径兜底，不该因此起不来。
 */

  let appUpdater: import('./update/app-updater').AppUpdater | undefined
  try {
    const el = await electronApp()
    if (el?.isPackaged) {
      const mod = (await import('electron-updater')) as {
        autoUpdater?: unknown
        default?: { autoUpdater?: unknown }
      }
      const real = mod.autoUpdater ?? mod.default?.autoUpdater
      if (real) {
        const { createAppUpdater } = await import('./update/app-updater')
        appUpdater = createAppUpdater({
          log: (lv, ch, msg, d) => logger.log(lv, ch, msg, d),
          isPackaged: true,
          onProgress: (p) => sendUpdateProgress(p),
          downloadDir: async () =>
            el.getPath ? el.getPath('downloads') : join(process.cwd(), 'downloads'),
          updater: real as import('./update/app-updater').UpdaterLike
        })
        logger.log('INFO', 'app', 'electron-updater 已接入（增量下载；不会自动安装）')
      } else {
        logger.log('WARN', 'app', 'electron-updater 模块里没有 autoUpdater 导出，更新走手写路径')
      }
    }
  } catch (e) {
    logger.log(
      'WARN',
      'app',
      `electron-updater 接入失败（更新仍可用，走手写路径）：${e instanceof Error ? e.message : String(e)}`
    )
  }
  const handlers = buildHandlers({
    probe: createTcpProbe(),
    processManager: pm,
    commandFor: defaultCommandFor,
    lastCrash: () => lastCrashInfo,
    /**
 * 提权判定结果：会被写进导出包的设备信息（见 HandlerOpts.elevateVerdict）
 */

    elevateVerdict: extra?.elevateVerdict,
    // 数据根一变就更新 liveDataRoot，托盘 getConfig 立刻跟上（迁移后无需重启）

    onDataRootChanged: (r) => {
      liveDataRoot = r
    },
    /**
 * 注意：**不注入 statsProvider**。 pidusage 在 Windows 上 spawn wmic.exe 取资源占用，而 wmic 在新版 Windows 已被移除 —— 每次调用要等失败超时 2.4~5.1 秒，把主进程拖死（界面全卡）。 AstrBot / NapCat 自己的 WebUI 都有资源监控，我们不再重复采集。
 */

    systemInfo: realSystemInfo,
    logger,
    audit,
    webui: await ensureElectronWebUi(),
    /**
 * setLogin / getLogin 已随「开机自启」功能整体移除（用户要求去掉）
 */

    qqChecker: detectQQInfo,
    /**
 * ---------------- 启动器自身更新 ----------------
 */

    /**
 * `app` **不能**在这里直接引用。 踩过的坑（用户报告里的崩溃原文）： Error invoking remote method 'app:checkUpdate': ReferenceError: app is not defined 原因：这个文件顶部从来不 import electron 的 app（因为单测在纯 node 下跑， 顶层 import electron 会直接炸）。文件里所有用到 `app` 的地方都是 **函数内部* `const { app } = await import('electron')` 懒取的 （见下面的 defaultDataRoot）。而这两行是**对象字面量里直接写的表达式**， 位置在模块顶层装配阶段，`app` 这个名字根本不在作用域里 —— 于是模块一加载、或者第一次调 app:checkUpdate 就 ReferenceError。 这也是「当前版本 MXBot 未知」的原因：app:version 走的是 opts.appVersion?.()， 而这个箭头函数一被调用就抛，渲染层拿不到版本号只能显示未知。 所以这里统一改成异步懒取，和文件里其它地方保持一致。
 */

    appVersion: async () => {
      try {
        const { app } = await import('electron')
        return app.getVersion()
      } catch {
        // 非 electron 环境（单测）拿不到版本：给个明确占位，别抛

        return '0.0.0'
      }
    },
    // 系统默认下载目录：用户要求下到这里，他要能自己看到并双击那个安装包

    downloadsDir: async () => {
      const app = await electronApp()
      // 纯 node（单测）里没有 app：退回当前目录下的 downloads，
      // 别让"取下载目录"这种辅助信息把整个流程打挂

      return app?.getPath ? app.getPath('downloads') : join(process.cwd(), 'downloads')
    },
    /**
 * ★ 刻意**不注入* updateManifestUrl（四厂商审计抓出的真问题） `updateManifestUrl` 是给单测准备的注入口：一旦被注入， safeCheck 里的双源回落就会被绕过（只试那一个 url）。 我第一版在这里写了 `updateManifestUrl: MX_UPDATE_MANIFEST_URL`， 后果是**生产环境永远只试主源**： 主源不可达 → 检查更新失败 → 按用户要求收敛成"已是最新版" → 界面显示"最新" → 备用源上明明有新版本，用户**永远看不到**。 也就是说我加的双源保险在真机上是**死代码**。 现在把注入留给测试：生产不传这个键，safeCheck 就会按 `MX_OFFICIAL_BASES` 的顺序（主源 → 备用源）依次尝试。
 */

    fetchUpdateManifest: async (url) => {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      return await r.text()
    },
    fetchUpdateToFile: async (url, outPath, onProgress) => {
      const res = await fetch(url, { signal: AbortSignal.timeout(30 * 60 * 1000) })
      if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`)
      const total = Number(res.headers.get('content-length') ?? 0) || undefined
      const { createWriteStream } = await import('fs')
      const { pipeline } = await import('stream/promises')
      const { Readable } = await import('stream')
      if (!res.body) throw new Error('下载失败：响应没有内容')
      let got = 0
      // 手动数一遍字节，边写边报进度（Readable.fromWeb 的 chunk 是 Uint8Array）

      const counter = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctrl) {
          got += chunk.byteLength
          onProgress?.(got, total)
          ctrl.enqueue(chunk)
        }
      })
      const nodeStream = Readable.fromWeb(
        res.body.pipeThrough(counter) as unknown as import('stream/web').ReadableStream
      )
      await pipeline(nodeStream, createWriteStream(outPath))
      return got
    },
    sendUpdateProgress: (p) => {
      sendUpdateProgress(p)
    },
    /**
 * electron-updater 封装（指导书第六章 P3）。 打包态可用就注入；不可用（开发态、缺 app-update.yml、依赖缺失） 就不注入 → ipc 的检查/下载自动走手写路径，行为与之前完全一致。
 */

    appUpdater
  })
  // 启动即恢复上次保存的 config / 实例索引（数据根固定=安装目录旁 data\，无需 config 也可定位）  /*   * 这句**必须包 try/catch**。   *   * 踩过的坑（用户报告「为什么第一次提示数据目录在哪变成了每次启动软件都弹」）：   * `handlers['config:set'](saved)` 里面会 `mkdirSync(config.dataRoot)`。   * 如果磁盘上那份 config 里的 dataRoot 已经不可写了（用户删了目录、   * 换了盘符、U 盘拔了、被安全软件锁了），这句就抛。   *   * 它一抛，**本函数就在这里中断** —— 后面那个   * `for (...) ipcMain.handle(ch, ...)` 注册循环一行都不会跑。   * 于是 ipcMain 上什么通道都没有，渲染层调 config:get 拿到   * "No handler registered for 'config:get'"，App.vue 进 catch 分支   * 把 firstRun 置 false 并显示 bootErr —— 用户看到的是一个半死不活的界面，   * 而真实原因（旧数据目录不可写）一个字都没露出来。   *   * 恢复失败的正确表现：**当作没配置过**，让首启向导正常出来请用户重选。   * 那正是用户能自己解决的情况，比整个 IPC 面瘫强得多。   */

  try {
    /**
 * 用 startupDataRoot() 而不是 defaultDataRoot()： 用户迁移过数据目录时，config.json 只在**新**目录里是最新的。 读默认位置会拿到旧那份（dataRoot 还写着旧路径）， 于是「迁移完重启又回到旧目录」；若旧目录已被删则每次启动都弹向导。
 */

    const root = await startupDataRoot()
    const saved = readAppConfig(root)
    if (saved) {
      // 记下实际用的根：托盘读配置、后面的 sweepTrash 都跟着它走

      liveDataRoot = root
      handlers['config:set'](saved)
    }
  } catch (e) {
    createLogger({ dataRoot: dataRoot0 }).log(
      'WARN',
      'app',
      '恢复上次的数据目录配置失败（当作未配置，稍后会请用户重新选择）',
      String(e)
    )
  }
  /**
 * 顺手清掉遗留的 `.deleting-*` 垃圾目录。 这些是「删版本时有实例正在用它」留下的残缺目录（实机抓到过一个 v4.27.0.deleting-xxx 占着几百 MB，永远不消失）。删版本那条路已经加了 「运行中不许删」的守卫，新的不会再产生；但**已经留下的得有个归宿**， 否则用户想重装同版本还得手工去清。 刻意放在配置恢复之后、不 await：这是打扫卫生， 不该拖慢启动，也不该因为它失败而影响任何功能（sweepTrash 自己吞异常）。
 */

  {
    // 用 liveRoot()：用户迁移过目录时，真正在用的数据在这里

    const dr = readAppConfig(liveRoot())
    if (dr?.dataRoot) {
      createRuntimeStore({ dataRoot: dr.dataRoot }).sweepTrash((msg) =>
        logger.log('INFO', 'proc', msg)
      )
      /**
 * 顺手清掉过期日志。 日志是**永不轮转**的追加文件（见 prune.ts 的说明）：app-*.log 按天 攒、instances\*.log 单个能到几百 MB。多开挂机跑一个月能攒出几个 GB， 而用户自己不容易发现该删哪些（app/audit 是按天分文件的）。 保留 30 天 —— 日志是这个软件唯一的排查依据，要能翻到"上周那次"。 删失败如实记日志（被占用很常见），不静默。
 */

      const pruned = pruneOldLogs(dr.dataRoot)
      if (pruned.removed.length) {
        logger.log('INFO', 'proc', `清理了 ${pruned.removed.length} 个过期日志文件`)
      }
      if (pruned.failed.length) {
        logger.log(
          'WARN',
          'proc',
          `有 ${pruned.failed.length} 个过期日志没删掉（多半被占用）：${pruned.failed            .map((f) => f.file)            .join('、')}`
        )
      }
    }
  }
  for (const [ch, fn] of Object.entries(handlers) as Array<[string, (...args: unknown[]) => unknown]>) {
    /**
 * ★ IPC 延迟埋点（指导书 0.1.3 自检 2 的产品化） 主人的实测：点任何东西都卡一下、下载页要等全部加载完。 有了这个埋点，"卡在哪个 channel" 从猜测变成**日志里的一行数字**： · >200ms → WARN（用户能感知，值得看） · >1000ms → ERROR（明确的病灶） 异步 handler 的耗时差异（例如等网络 10s）也会如实记录 —— 那不阻塞主进程，但它是"下载页要等半天"的另一半答案。
 */

    ipcMain.handle(ch, async (_e, ...args: unknown[]) => {
      const t0 = Date.now()
      /**
 * ★ 记账：谁在跑、刚跑完什么（主人 2026-09-27 死机日志逼出来的） 他的日志里有这么一段： [ERROR] [perf] IPC window:minimize 耗时 5970ms（严重） [WARN] [perf] 主进程事件循环疑似被同步代码阻塞：… 5941ms … 然后**电脑死机**。问题是：我们知道"卡了 6 秒"， 却**完全不知道那 6 秒主进程在干什么* —— 原始看门狗自己都承认 "阻塞发生瞬间的栈拿不到"。 所以这里维护一份极廉价的记账： · inflight —— 此刻正在执行的 IPC 名（可能不止一个：await 会交错） · recent —— 最近完成的若干个（带耗时），环形保留 阻塞看门狗在检测到卡顿时读它，就能把日志从 "卡了 6 秒" 升级成 "卡了 6 秒，当时在跑 X，刚跑完 Y(1200ms)"。 开销：两个 Map/数组的增删，纳秒级，绝不能因此引入新的阻塞。
 */

      inflightIpc.add(ch)
      try {
        return await fn(...args)
      } finally {
        inflightIpc.delete(ch)
        const ms = Date.now() - t0
        /**
 * 环形保留最近 8 条**慢**记录（>50ms 才值得记）。 不记全部是因为高频短 IPC（stats:overview 每 2 秒一次） 会把真正有用的那条挤掉。
 */

        if (ms > 50) {
          recentIpc.push({ ch, ms, at: t0 })
          if (recentIpc.length > 8) recentIpc.shift()
        }
        if (ms > 1000) {
          logger.log('ERROR', 'perf', `IPC ${ch} 耗时 ${ms}ms（严重）`)
        } else if (ms > 200) {
          logger.log('WARN', 'perf', `IPC ${ch} 耗时 ${ms}ms`)
        }
      }
    })
  }
  // 下载进度推给所有窗口（渲染层订阅 download:progress）

  setProgressSender((e) => {
    void import('electron')
      .then(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('download:progress', e)
        }
      })
      .catch(() => undefined)
  })
  return {
    logger,
    pm,
    /**
 * 供主进程（托盘菜单等）读取当前配置。 这里原来传的是 `dataRoot0`（= defaultDataRoot()，永远指安装目录旁的 data）， 而上面启动恢复和 sweepTrash 用的都是 `startupDataRoot()`（指针优先）—— 同一份 config 有两套读法，于是出现了自相矛盾的行为： 用户把数据目录迁到 D:\MXBotData → 重启 → 关窗缩托盘 → 从托盘菜单读配置 → 读到的是**安装目录旁那份旧 config.json**（dataRoot 还是旧路径）。 现在统一走 `liveRoot()`：它记住「目前真正在用的根」—— 启动时是 startupDataRoot()，`config:set` / `config:moveDataRoot` 处理过程中会被更新成实际生效的那个目录。这样迁移之后不用重启， 托盘读到的就已经是新配置了。
 */

    getConfig: () => readAppConfig(liveRoot()),
    setClosePolicy: (p: 'tray' | 'quit') => handlers['config:set']({ closePolicy: p }),
    /**
 * 退出清理。 不能只把 pm 交出去让调用方调 pm.killAllSync() —— 那个只收我们 spawn 的进程树，收不到 NapCat 注入出去、已经脱离父子链的 QQ。 见 killEverythingForExit 的说明。 从 handler 表上取（Symbol 键），不从作用域里直接抓 —— 那两处不是同一个函数作用域。
 */

    killEverythingForExit: (handlers as unknown as Record<symbol, () => void>)[EXIT_CLEANUP],
    /**
 * 把"上次异常退出"的判定结果交给 IPC 层（见上面 lastCrashInfo 的说明）。 主进程启动流程在拿到 dataRoot 之后才能读 running.lock， 那时 buildHandlers 早就跑完了 —— 所以用 setter 回填， handler 读的是这个闭包变量的最新值。
 */

    setLastCrash: (v: { crashed: boolean; startedAt?: number }) => {
      lastCrashInfo = v
    }
  }}
export { createLogger } from './logs/logger'

export { createCrashHandler } from './logs/crash-handler'/**
 * 「全新安装时会用哪个数据目录」—— 固定 = 安装目录旁 data\（dev 时为项目根\data）。 打包/dev 双形态统一。 注意这**不是**「现在该读哪个目录」。用户迁移过数据目录之后， 真正该读的是 `startupDataRoot()` 返回的那个（指针优先）。 保留这个函数是因为还有几处语义确实是「默认位置」： - 系统余量统计（statfs）想知道安装盘还剩多少 - 首启向导要在默认位置建初始目录 - 指针文件本身也放在这个位置的**上一级**（安装目录）里
 */
export async function defaultDataRoot(): Promise<string> {
  const app = await electronApp()
  if (!app || !app.isPackaged) {
    // 纯 node（单测）时 getAppPath 也不在，退回 cwd —— 与 testStage 的约定一致

    return app?.getAppPath ? join(app.getAppPath(), 'data') : join(process.cwd(), 'data')
  }
  return join(process.execPath, '..', 'data')}/**
 * 启动时**真正**该读 config.json 的目录。 为什么不是直接用 defaultDataRoot()：用户可以在设置里把数据目录迁到别处， 迁移是**复制**（旧目录留着），所以旧目录那份 config.json 还在、且 dataRoot 还写着旧路径。直接读默认位置就会「迁移完重启又回到旧目录」； 如果用户把旧目录删了，还会变成每次启动都弹首启向导 —— 那正是用户报告过的现象。 指针文件（`<安装目录>\data-root.txt`）由 config:set / config:moveDataRoot 在每次落盘时更新，这里只管读。读不到就退回默认位置。
 */
export async function startupDataRoot(): Promise<string> {
  const app = await electronApp()
  if (!app || !app.isPackaged) {
    /**
 * 两种情况都走这里： 1. dev 模式 —— 没有"安装目录"这个概念（execPath 指向 electron.exe）， 项目根\data 就是默认位置，不参与指针逻辑。否则开发机上跑一次 迁移就会在 node_modules\electron\dist\ 下留个指针文件。 2. **纯 node 环境（单测）* —— `import('electron')` 拿到的是 electron 包的入口 js（里面只有一段 path 字符串），**没有 app**。 原来这里直接 `app.isPackaged` 会抛 `TypeError: Cannot read properties of undefined (reading 'isPackaged')`， 把 config:moveDataRoot 这个 handler 整个打挂 （tests/unit/ipc-handlers.spec.ts 实测抓到）。 单测里没有 app.getAppPath() 可用，所以退回 process.cwd()\data —— 与 makeStage / testStage 把暂存目录放在项目 data 下的约定一致。
 */

    if (app?.getAppPath) return join(app.getAppPath(), 'data')
    return join(process.cwd(), 'data')
  }
  return resolveStartupDataRoot(join(process.execPath, '..'))}/**
 * 取 electron 的 app 对象，**拿不到就返回 undefined**。 本模块顶层不能 import electron（单测跑在纯 node 下会直接炸）， 所以各处都是函数内 `await import('electron')`。但纯 node 下这个 动态 import **不会抛错* —— 它成功拿到 electron 包的入口 js， 那是个只有 `module.exports = <path 字符串>` 的模块，于是 `const { app } = await import('electron')` 得到 `undefined`， 紧接着 `app.isPackaged` 就是那句很难定位的 `Cannot read properties of undefined (reading 'isPackaged')`。 统一收口成这个函数，任何调用点都不用再自己判空，也不会再踩。
 */
async function electronApp(): Promise<
  | {
      isPackaged?: boolean
      getAppPath?: () => string
      /**
 * 取系统路径（downloads 等）；纯 node 下不存在
 */

      getPath?: (name: string) => string
      getVersion?: () => string
    }
  | undefined> {
  try {
    const m = (await import('electron')) as {
      app?: {
        isPackaged?: boolean
        getAppPath?: () => string
        getPath?: (name: string) => string
        getVersion?: () => string
      }
    }
    return m?.app
  } catch {
    return undefined
  }}/**
 * 把「当前用的数据目录」记进指针文件。 只有打包后才写：dev 模式的 execPath 在 node_modules 里，写那儿没有意义。 写失败**不影响主流程**（返回 false，调用方最多记条日志）—— 它只是帮下次启动少问一次，绝不能因为它让保存配置失败。
 */
async function rememberDataRoot(dataRoot: string): Promise<boolean> {
  const app = await electronApp()
  // 拿不到 app（纯 node / 单测）或非打包态：不写指针文件，见上面 startupDataRoot 的注释

  if (!app || !app.isPackaged) return false
  return writeRootPointer(join(process.execPath, '..'), dataRoot)}/**
 * 生产 WebUI 装配：懒取首窗，窗口 resize 跟随（首窗未就绪时给空实现）
 */
async function ensureElectronWebUi() {
  const { BrowserWindow } = await import('electron')
  const { createWebUiManager, createElectronWebUi } = await import('./webui/webui-manager')
  let m: ReturnType<typeof createWebUiManager> | undefined
  function ready() {
    if (!m && BrowserWindow.getAllWindows().length > 0) {
      const win = BrowserWindow.getAllWindows()[0]
      m = createWebUiManager({
        ...createElectronWebUi(win, () => {
          // 视图内按 Esc / Ctrl+W 直接退出：不经过渲染层，
          // 即使 WebUI 页面白屏、渲染层状态错乱也一定能退出来

          for (const id of m?.list() ?? []) m?.close(id)
          win.webContents.send('webui:closed')
        }),
        // createView 里已经 addChildView / destroy 里 removeChildView，这里挂载器保持空

        attach: () => undefined,
        detach: () => undefined,
        boundsOf: () => {
          // 顶部留出标题栏（44px）+ 工具条（34px），让 DOM 的退出按钮始终可见可点。
          // 之前只让出 44px，视图一旦出错渲染层那颗按钮就点不到，用户被彻底卡住。

          const cb = win.getContentBounds()
          return {
            x: 0,
            y: WEBUI_TOP_INSET,
            width: cb.width,
            height: Math.max(0, cb.height - WEBUI_TOP_INSET)
          }
        }
      })
      win.on('resize', () => m?.resize())
    }
    return m
  }
  return {
    open: async (id: string, url: string) => {
      const m = ready()
      if (!m) throw new Error('窗口尚未就绪，无法打开 WebUI')
      await m.open(id, url)
    },
    close: (id: string) => void ready()?.close(id),
    list: () => ready()?.list() ?? [],
    /**
 * 当前正在显示的那个（同一时刻只有一个，见 webui-manager 的说明）
 */

    visible: () => ready()?.visible()
  }}/**
 * QQ 安装位置缓存（进程级）。 ## 为什么要有它（指导书 P0-4 收口） `qqInstallDir()` 是**同步**的（它挂在 `defaultCommandFor` 这条同步链上， 而那条链每次启动实例都要走）。它内部用 `runSync('reg.exe')` 查两条 注册表来源，每条最坏等满 5 秒超时 —— 注册表里没有 QQ 的键时 （没装 QQ、或绿色版没登记），**启动一个 NapCat 实例会先冻 10 秒**。 ## 解法：复用**已有的异步**检测结果，而不是再造一套异步查询 `opts.qqChecker`（生产实现在 registerIpcHandlersReal 里）本来就是 异步查这些注册表键，而且它在 instance:start 里**先于**取启动命令执行： if (rec.type === 'n' && opts.qqChecker) { const qq = await opts.qqChecker() ... } const spec = commandFor(rec, ...) ← 这里才需要 qqInstallDir() 所以只要 qqChecker 顺手把"解析出来的安装位置"写进这个缓存， 同步路径命中缓存就**一次 syscall 都不做**。 缓存语义：`null` = 还没查过；`undefined` = 查过但没有（也缓存下来， 避免每次启动重复查一个注定查不到的东西）。只在进程内，不落盘。
 */
let qqInstallCache: QQInstall | undefined | null = null/**
 * 供 qqChecker 在异检查完之后回填（见上面注释里的调用时序）
 */
function rememberQqInstall(v: QQInstall | undefined): void {
  qqInstallCache = v}/**
 * 同步解析 QQ 安装位置（NapCat 注入要用 QQ.exe 的绝对路径）。 ## 为什么是同步的 它嵌在 `defaultCommandFor` 这条同步链上（每次启动实例都要走）， 为一个注册表查询把整条链改成异步不划算。两条来源都试 *（Tencent\QQNT 的 Install 值最直接，卸载项次之），都拿不到就给常见位置 兜底；仍然没有则返回 undefined，由上层报「先装 QQ」—— 不静默拿个不存在的路径去启动。 ## ★ 但它**不该真的去查注册表**（指导书 P0-4） `runSync('reg.exe')` 每条来源最坏等满 5 秒超时，两条就是 10 秒的 主进程冻结。正常路径上这个函数根本不会被"冷启动"到 —— instance:start 会**先* `await opts.qqChecker()`（异步查同一批键）， 由它把结果回填进 qqInstallCache，等这里被调用时缓存已经热的。 走缓存之后的顺序： 1. 缓存命中（含"查过但没有"）→ 立刻返回，零 syscall 2. 缓存没预热（极端路径，比如测试直接调 defaultCommandFor）→ 同步兜底查询，但把超时压到 **1.5 秒* （宁可"这次读不到 QQ 路径"也不要冻 10 秒；下一次 instance:start 的异步 qqChecker 会把缓存填好）
 */
function qqInstallDir(): QQInstall | undefined {
  if (qqInstallCache !== null) return qqInstallCache ?? undefined
  const readValue = (key: string, value: string): string | undefined => {
    const r = runSync('reg.exe', ['query', key, '/v', value], { timeoutMs: 1500 })
    if (r.status !== 0) return undefined
    // reg query 输出形如：    Install    REG_SZ    E:\QQ

    const line = r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.toLowerCase().startsWith(value.toLowerCase()))
    if (!line) return undefined
    const m = line.match(/REG_(?:SZ|EXPAND_SZ)\s+(.+)$/i)
    return m ? m[1].trim() : undefined
  }
  /**
 * 兜底查询的结果也缓存 —— 否则"没装 QQ"的机器每次启动实例都要 重新等两轮 1.5 秒超时（缓存 undefined 同样有意义的理由就在这）。
 */

  qqInstallCache = qqInstallFromRegistry(readValue)
  return qqInstallCache ?? undefined}/**
 * 生产环境的启动命令生成器。 导出是为了让真机 e2e 能走**完全同一条路径* —— 测试里自己拼命令的话， 就测不到"入口对不对""环境变量齐不齐"这些真正会出问题的地方了。
 */
export function defaultCommandFor(rec: InstanceRecord, dataRoot: string): Omit<StartSpec, 'id' | 'port'> {
  /**
 * 验收旁路：用 ACB_DEV_CMD 注入假运行时来跑端到端验收。 ## 必须**只在开发态**生效 原来这里直接 `if (process.env.ACB_DEV_CMD)`，没有环境判断。 也就是说：**打包后的成品**同样认这个环境变量。 后果：任何能在用户机器上设置环境变量的东西 （一个 .bat、另一个安装器、任务计划、甚至用户自己照着我们文档抄） 都能把实例的启动命令**整个替换**成任意程序。 这属于"调试后门留在生产里"，而且它替换的是要被执行的东西 —— 是本项目里最不该留的一个口子。 判据用 `process.defaultApp`： electron . → true （开发态，允许旁路） 打包后的 exe → undefined（生产，禁止） 纯 node（单测） → undefined（禁止） 这个标志是 electron 自己设的，环境变量改不了它， 所以它比 NODE_ENV 之类"用户也能改"的判据可靠。 保留开发态能力是必要的：scripts 里的真机验收靠它注入假运行时， 直接删掉会把那条验收路径一起废掉。
 */

  if (process.env.ACB_DEV_CMD && process.defaultApp) {
    return {
      cmd: process.env.ACB_DEV_CMD,
      args: process.env.ACB_DEV_ARGS ? (JSON.parse(process.env.ACB_DEV_ARGS) as string[]) : []
    }
  }
  // dataRoot 由调用方从 config 给出——绝不从 rec.dir 上溯猜层级
  // （老式扁平目录 instances\<id> 会让猜测少一层，指到错的盘符路径上去）

  const store = createRuntimeStore({ dataRoot })
  // 实例用哪个版本：优先读创建时写的 meta，回落最新装好的

  const tag = readInstanceTag(rec.dir) ?? store.latest(rec.type)?.tag
  const src = tag ? store.dirFor(rec.type, tag) : rec.dir
  // 已经装好的 NapCat 不会重下，所以启动时再补一次（幂等：找不到目标片段就跳过）

  if (rec.type === 'n') patchNapcatWorkerArgv(src)
  const spec = resolveLaunchSpec({
    type: rec.type,
    dir: src,
    // AstrBot 的数据落实例目录（共享运行时代码 + 各实例独立数据，
    // 否则同类实例会互相覆盖账密；NapCat 的数据走 NAPCAT_WORKDIR）

    instanceDir: rec.dir,
    // NapCat 要注入已装好的 QQ，路径从注册表解析（和官方 bat 同源）

    qqExe: rec.type === 'n' ? qqInstallDir()?.exe : undefined,
    qqAccount: rec.type === 'n' ? rec.qqAccount : undefined,
    /**
 * ══════════════════════════════════════════════════════════════════════════ WebUI Token：**首次启动不再强制注入 114514* （主人 2026-09-27：「去掉 napcat 首次启动强制设置 token 为 114514， 首次启动不需要强制设置 token」） ══════════════════════════════════════════════════════════════════════════ 演化过程： ① 最早：无条件传 `NAPCAT_DEFAULT_TOKEN` → 用户在 WebUI 里改过的 token 每次启动都被冲回 114514（用户反馈「自动覆盖 napcat 的 token」） ② 上一版：`existingNapcatToken(rec.dir) ?? NAPCAT_DEFAULT_TOKEN` —— 修好了"每次覆盖"，但**首次仍然强塞 114514**。 用户的新要求是连首次也不要：让他自己设，或者用 NapCat 自己的默认。 ③ 现在：**只读用户已有的 token；没有就不传**（不注入 = 不覆盖）。 为什么"不传"是对的： · NapCat 自己会生成/使用它自己的默认 token，我们没必要替他定 · 我们强塞一个**所有人都一样**的 114514，反而让用户以为"必须用它"， 而且这台机器上的 NapCat WebUI 会被一个公开已知的 token 保护着 · 用户想改就改，改了什么就是什么 —— 我们只负责**不去动它* 注意：`--no-强制` 只影响**启动时的注入**。界面上「重置 Token」按钮 仍然可以显式把它设成 114514（那是用户主动要求的动作，见 resetCredentials）。 日志收集器读日志时也仍会用 114514 尝试（那是"读"不是"写"， 且失败只是收不到日志，见 createNapcatLogCollector）。
 */

    // token 在 instance:start 的异步预检阶段读取；此处不做同步磁盘遍历.
    webuiToken: rec.type === 'n' ? napcatTokenCache.get(rec.id) : undefined,
    pythonExe: pythonExeFor(dataRoot),
    port: rec.port,
    dataRoot
  })
  return {
    cmd: spec.cmd,
    args: spec.args,
    cwd: spec.cwd,
    ...(spec.env ? { env: spec.env } : {})
  }}/**
 * 读 NapCat 实例自己配置里的 WebUI token。 返回 undefined 表示「实例还没配过 token」（首次启动）——调用方会给一个默认值。 读到非空值说明用户（或 NapCat 自己）已经定好了 token，**必须原样保留**， 否则每次启动都会把用户的 token 覆盖掉。 找的位置：<实例目录>\config\webui.json（NapCat 自己的工作目录结构）， 以及兼容旧布局的 config\onebot11_*.json（token 也可能只写在这里）。
 */
const napcatTokenCache = new Map<string, string | undefined>()

async function existingNapcatTokenAsync(instanceDir: string): Promise<string | undefined> {
  const root = join(instanceDir, 'config')
  const walk = async (dir: string, depth: number): Promise<string | undefined> => {
    if (depth > 4) return undefined
    let entries
    try { entries = await readdirAsync(dir, { withFileTypes: true }) } catch { return undefined }
    for (const entry of entries) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) {
        const token = await walk(file, depth + 1)
        if (token) return token
      } else if (/^(webui\.json|onebot11_.*\.json)$/.test(entry.name)) {
        try {
          const data = JSON.parse(await readFileAsync(file, 'utf8')) as Record<string, unknown>
          if (typeof data.token === 'string' && data.token.trim()) return data.token.trim()
        } catch { /* 配置尚未写完或损坏时继续找其它候选文件 */ }
      }
    }
    return undefined
  }
  return walk(root, 0)
}

/**
 * 读实例绑定的运行时版本（创建时写在 instance.json 的 runtimeTag）
 */
function readInstanceTag(instanceDir: string): string | undefined {
  /**
 * ★ 必须先挡 undefined（审查抓出的健壮性缺口） `join(undefined, 'instance.json')` 直接抛 TypeError: The "path" argument must be of type string. Received undefined 而调用方（instance:setRuntime 等）拿到的是 `rec.dir` —— 一旦索引记录 缺字段（旧版本写的 instances.json、手工改坏、外部拷入）， 这个 TypeError 会以"切换版本失败"的面目抛到用户面前， 而真正的原因（记录里没有 dir）完全看不出来。 现在：拿不到目录就当"读不出 tag"，返回 undefined 让调用方走回落路径。
 */

  if (!instanceDir || typeof instanceDir !== 'string') return undefined
  const f = join(instanceDir, 'instance.json')
  if (!existsSync(f)) return undefined
  try {
    const j = readJsonFile<{ runtimeTag?: string }>(f)
    return j.runtimeTag
  } catch {
    return undefined
  }}/**
 * 读回磁盘上的 config（进程重启后恢复状态）
 */
export function readAppConfig(dataRoot: string): AppConfig | undefined {
  const f = join(dataRoot, 'config.json')
  if (!existsSync(f)) return undefined
  return readJsonFile<AppConfig>(f)}/**
 * 把「渲染层给的路径」收敛到 `<dataRoot>\instances\` 里面。 备份的删除与回滚都收外部传入的路径，而这层如果不设防， 渲染层就能让主进程删/读任意文件 —— 而这个进程是**管理员权限**的 （NapCat 注入 QQ 需要提权），后果比普通进程严重一档。 三道检查，缺一不可： 1. 必须落在 instances\ 里（resolve 之后比目录边界，不能用裸 startsWith —— `...\instances-evil` 也以 `...\instances` 开头）； 2. 必须是备份归档那两种后缀（防止删掉实例目录里的别的东西）； 3. 必须是**文件**而不是目录（unlinkSync 一个目录会抛， 而空串那种入参根本不该往后走）。 返回规范化之后的绝对路径，调用方应当用它而不是原始入参。
 */
function assertInsideInstances(
  dataRoot: string,
  p: string,
  opts: { allowExt: string[] }): string {
  const raw = String(p ?? '')
  if (!raw.trim()) throw new Error('备份路径为空')
  const base = resolve(join(dataRoot, 'instances'))
  const target = resolve(raw)
  // 目录边界：相等 或 位于 base + 分隔符 之下

  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error('不允许操作数据目录以外的文件')
  }
  const lower = target.toLowerCase()
  if (!opts.allowExt.some((e) => lower.endsWith(e))) {
    throw new Error(`不是备份文件（只认 ${opts.allowExt.join(' / ')}）`)
  }
  if (!existsSync(target)) throw new Error('备份文件不存在（可能已被手动删掉或挪走）')
  return target}/**
 * 校验一个入参确实是**备份文件**（比 assertInsideInstances 更严）。 ## 为什么需要单独一个函数（审计抓出的严重问题） `backup:del` 原来用 `assertInsideInstances(..., { allowExt: ['.tar.gz', '.json'] })` 就放行了。但实例目录里的关键文件**全都是 `.json`**： · `<inst>\instance.json` ← 版本绑定的**唯一真相* · `<inst>\data\cmd_config.json` ← AstrBot 账密 + 模型 API key + 插件开关 · `<inst>\config\webui.json` ← NapCat token / 端口 · `<inst>\config\onebot11_*.json` 于是"在 instances 下 + .json 结尾"这个条件它们**全部满足**， 而 `deleteBackup` 会真的 unlink 掉它们。这个进程还会自我提权到管理员 *（NapCat 注入 QQ 需要），等于一个**管理员权限下的任意 .json 删除原语**。 ## 三条约束 备份的真实形态（backup.ts:82-84 写、backup-list.ts:39-44 扫）： <dataRoot>\instances\<类型>\<实例>\backups\<14位时间戳>-v<版本>.tar.gz 配套清单是**同名**的 `.json`（deleteBackup 会一起删）。 1. 仍在 `instances\` 之下（防目录穿越，与上面那个函数同一套判断） 2. **直属父目录必须叫 `backups`* ← 关键的一条： 关键文件都不住在 backups\ 里，这一步就把"删任意 .json"收紧成 "删备份目录里的文件" 3. 文件名要符合备份形状（`<14位数字>-v<数字>` 开头） 三条都过了才返回规范化路径。任何一条不过都抛错、绝不删除。
 */
function assertBackupFile(
  dataRoot: string,
  p: string,
  opts: { exts: string[] }): string {
  /**
 * 第 1 条（在 instances 之下 + 后缀匹配 + 存在性）复用基础版本 —— 这样"目录边界怎么算"只有一处实现，不会两边跑偏。 它抛出的错误信息也更通用，适合作为第一道。
 */

  const target = assertInsideInstances(dataRoot, p, {
    allowExt: opts.exts
  })
  // 2) 直属父目录必须叫 backups

  const parent = resolve(join(target, '..'))
  if (basename(parent).toLowerCase() !== 'backups') {
    throw new Error('只允许操作 backups 目录里的备份文件（这个路径不是备份）')
  }
  // 3) 文件名必须符合备份形状：<14位时间戳>-v<版本>.tar.gz ／ 同名 .json

  const name = basename(target)
  const lower = name.toLowerCase()
  const ext = opts.exts.find((e) => lower.endsWith(e))
  const stem = ext ? name.slice(0, name.length - ext.length) : name
  /**
 * 宽容一点：早期版本生成过 `20260912141734.-v1.tar.gz` 这种多一个点的名字 （backup.ts:50 的注释提过），所以点允许出现在时间戳与 -v 之间。
 */

  if (!/^\d{14}\.?-v\d+$/.test(stem)) {
    throw new Error('不是备份文件（文件名不符合备份命名规则）')
  }
  return target}/**
 * 把当前数据目录记进注册表，供**卸载程序**读取。 用户的报告：「卸载脚本遗漏了 "E:\MXBot\data"」—— 实测确认： 卸载后 MXBot.exe 没了，data\ 还在（27.29 MB 的 cache + runtimes）。 根因是 build/installer.nsh 里没有 customUnInstall 宏， electron-builder 默认不动用户数据目录。 卸载器要删 data，就得知道它在哪 —— 而用户可以把 dataRoot 改到别处 （config:moveDataRoot）。NSIS 里解析 config.json 太脆，所以由程序 主动把答案写进注册表，卸载器读一个字符串就行。 失败**绝不能影响配置保存**：注册表被策略锁死、权限不足都可能发生， 那只是「卸载时少删一个目录」，不该让用户连设置都存不上。 ## 测试环境必须跳过（这个坑是真的踩到了） 它原来是**无条件**执行的，于是 `buildHandlers()` 一旦在测试里调 `config:set({dataRoot})`，就会往**真实的* HKCU 写一条： HKCU\Software\MXBot\DataRoot = E:\MX\launcher-acb\data\cache\tmp\acb-xxx-123 实测跑完一轮单测，注册表里留下的就是**某个临时测试目录* （本项目确实出现过：DataRoot 被指到 data\cache\tmp\acb-appver2--mu0kw333）。 后果不只是"测试脏"：那个键是**卸载程序**用来决定删哪个 data 目录的。 用户装完、跑一次我们的测试（或开发者机上打包），注册表里可能就留着 一个临时路径，卸载时按它去删 —— 真正该删的 `E:\MXBot\data` 反而留下， 而删除动作指向了一个早就不存在的 temp。这个 bug 会一路藏到卸载才暴露。 所以：**没有可执行文件路径的 Electron 环境**（就是单测）一律不写注册表。 判断依据用 `process.versions.electron` —— 纯 node 下没有这个字段， 而且它不依赖 electron 模块本身（本文件顶层不能 import electron）。
 */
function recordDataRootForUninstall(dataRoot: string): void {
  // 单测跑在纯 Node 下（没有 electron），绝不能污染真实注册表

  if (!process.versions.electron) return
  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ **未打包的开发态也不许写**（主人 2026-09-27 实测抓出来的）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * ## 现场
   *
   * 他装 0.2.0 时安装包弹：
   *     ⚠ 无法保护数据目录：**E:\MX\launcher-acb\data**
   *       它正被其他程序占用…
   * 而他实际在用（也实际安装过）的是 `E:\MXbot\AstriaX\data`。
   *
   * 查注册表：
   *     HKCU\Software\MXBot\DataRoot = E:\MX\launcher-acb\data   ← **开发目录**
   *     已安装的 AstriaX            = E:\MXbot\AstriaX\
   *
   * ## 原因
   *
   * 上面那句 `if (!process.versions.electron) return` 只挡住了**纯 Node 单测**，
   * 而**开发态（`electron .` 跑源码）也是有 `process.versions.electron` 的** ——
   * 于是我在开发机上调试时，每次 `config:set` 都把
   * `E:\MX\launcher-acb\data`（开发目录）写进了**生产注册表键**。
   *
   * 后果不只是"安装包弹了个奇怪的框"：
   *   · 安装/卸载程序按这个键决定去**保护/删除**哪个 data 目录
   *   · 真正该处理的 `E:\MXbot\AstriaX\data` 被忽略
   *   · 而它指向的开发目录被当成"用户数据"去抢救/删除 —— 方向完全错了
   *
   * ## 修法：只认**打包后**的程序
   *
   * `app.isPackaged` 为 true 才是用户手里那个 exe。
   * 用延迟 require 取 app（本文件顶层不能 import electron）。
   *
   * 这也正好对应那条注释里已经写过的顾虑（"开发者机上打包"）——
   * 当时的守卫不够，现在补齐。
   */
  try {
    const { app } = require('electron') as typeof import('electron')
    if (!app?.isPackaged) return
  } catch {
    /* 取不到 app（异常环境）→ 保守不写 */
    return
  }
  try {
    // 延迟 require：本文件也被纯 Node 测试加载，顶层 import electron 会炸

    const { execFileSync } = require('child_process') as typeof import('child_process')
    execFileSync(
      'reg.exe',
      [
        'add',
        'HKCU\\Software\\MXBot',
        '/v',
        'DataRoot',
        '/t',
        'REG_SZ',
        '/d',
        dataRoot,
        '/f'
      ],
      { timeout: 8000, windowsHide: true, stdio: 'ignore' }
    )
  } catch {
    /**
 * 记不上就算了：卸载时还有 $INSTDIR\data 兜底
 */

  }}/**
 * 给**手动导入的 AstrBot 运行时**补装依赖（主人实测的报错换来的）。 ## 为什么必须有这一步 主人日志（astriax-logs-20260926-213629）： runtimes:importFile AstrBot astrbot-4.28.0-py3-none-any.whl 成功 instance:start 失败 :: File "...\v4.28.0\astrbot\cli\__main__.py", line 5, in <module> import click ModuleNotFoundError: No module named 'click' `astrbot-4.28.0-py3-none-any.whl` 只有 1.2MB —— **它只含 AstrBot 自己**， click / quart / aiohttp / anthropic 这些依赖全在 wheel 的 metadata 里， 需要 pip 去 PyPI 装。导入流程原来只做「解压 + 摆位置」， 于是**导入成功但永远起不来**，报错还发生在实例启动时， 用户根本联想不到"是导入少了一步"。 ## 做法：在运行时目录里执行 pip install 与 `runtime:install` 走同一条 pip 通道（同样的镜像参数、同样的缓存目录）， 区别只是包名从「PyPI 上的 astrbot==ver」换成「本地那个 whl 文件」—— 因为用户给的就是这个文件，用它安装能保证装到的正是他手里那个版本。 依赖装到 `--target <runtimeDir>` 里（和下载安装的形态一致）， 这样运行时的 sitecustomize / PYTHONPATH 机制照常生效。
 */
async function installAstrbotDeps(deps: {
  pythonExe: string
  runtimeDir: string
  dataRoot: string
  /**
 * 用户选择的原始 whl（有就用它装，保证与用户手里的一致）；没有则按版本从源装
 */

  wheelFile?: string
  /**
 * pip 源（不传则读用户设置）—— 让本函数可被单测注入，不去碰真实文件
 */

  source?: PythonSource
  /**
   * 阶段回调：pip 每输出一行就调一次（用于界面显示"正在装什么"）。
   *
   * 主人 2026-09-27：「导入 astrbot 的时候一直"正在处理，请稍候…"，
   * 而不是根据阶段显示进度，会让人以为卡住了」——
   * 有了它，界面就能滚动显示真实的包名。
   *
   * 可选：测试不关心时可以不传。
   */
  onStage?: (stage: string) => void
  /**
   * 取消信号 —— 按「取消」时杀掉 pip 整棵进程树。
   *
   * 主人 2026-09-27：「安装/下载一个加入取消，防止卡住了只能重启软件
   * 来换更快的安装/下载源」。导入走的也是 pip，同样要能取消。
   */
  signal?: AbortSignal
}): Promise<{ ok: boolean; reason: string }> {
  const { run } = await import('./util/async-exec')
  const { run: runCmd } = await import('./util/async-exec')
  try {
    /**
 * 源由**调用方解析好传进来**（保持本函数是纯粹的"执行器"， 不在这里读文件 —— 那会让它没法被单测注入）。
 */

    const src = deps.source ?? resolvePythonSource(deps.dataRoot)
    /**
 * ★★ 必须先补构建工具（主人 2026-09-27 日志里抓出的真实失败） 日志原文（astriax-logs-20260927-084612）： 导入的 AstrBot v4.28.0 依赖安装失败：pip 退出码 2： raise BackendUnavailable( pip._vendor.pyproject_hooks._impl.BackendUnavailable: Cannot import 'setuptools.build_meta' 原因：AstrBot 的依赖树里有**源码包（sdist）**，pip 装它们时要调 `setuptools.build_meta` 来构建 —— 而 embed 版 Python **只有 pip， 没有 setuptools/wheel**。于是"补依赖"这一步必然失败。 主安装路径（`runtime:install`）早就调了 `ensureBuildTools`， 而这条**手动导入**的路径漏了 —— 和我之前漏 pip 是同一类错误： **两条路径共用同一个前提，却只在一处做了准备**。
 */

    const pyDir = pythonDirFor(deps.dataRoot)
    try {
      await ensureBuildTools({
        runPython: (a: string[]) => runCmd(deps.pythonExe, a, { timeoutMs: 600000 }),
        pipArgs: pythonSourceToPipArgs(src),
        onNote: () => undefined
      })
    } catch {
      /**
 * 补构建工具失败不直接判死：下面 pip 会给出更具体的报错
 */

    }
    void pyDir
    /**
 * 用 --target 装进运行时目录；--upgrade 让重复导入时能覆盖半成品。 `--no-warn-script-location` / `--disable-pip-version-check` 与主安装路径一致 （前者消掉无意义的 PATH 警告，后者避免每次启动向 PyPI 问版本、拖慢时间）。
 */

    const args = [
      '-m', 'pip', 'install',
      '--no-warn-script-location',
      '--disable-pip-version-check',
      '--upgrade',
      '--target', deps.runtimeDir
    ]
    if (deps.wheelFile && existsSync(deps.wheelFile)) {
      args.push(deps.wheelFile)
    } else {
      /**
 * 没有原始 whl（用户是从 zip 导入的源码包）：退化成"按目录名里的版本 从 PyPI 装同名包"。装不上也不会更糟 —— 至少依赖齐全。
 */

      const tag = basename(deps.runtimeDir)
      const ver = tag.replace(/^v/, '').split('-')[0]
      args.push(`astrbot==${ver}`)
    }
    args.push(...pythonSourceToPipArgs(src))
    const pipRun = await runPipWithCacheFallback(run, deps.pythonExe, args, {
      timeoutMs: 1800000,
      /* 取消时杀掉 pip（含派生的编译子进程）—— 导入路径也要能取消 */
      signal: deps.signal,
      env: pipEnvFor(deps.dataRoot, {
        ...process.env,
        PYTHONHOME: pythonDirFor(deps.dataRoot)
      }),
      /*
       * ★★ 把 pip 的输出**转发出去**（主人 2026-09-27：
       *    「导入 astrbot 的时候一直'正在处理，请稍候…'，
       *      而不是根据阶段显示进度，会让人以为卡住了」）
       *
       * 装 AstrBot 的依赖要几分钟。原来这里**没有 onData** ——
       * pip 输出全被丢弃，界面只在开始/结束各收到一条事件。
       *
       * 而渲染层有"看起来卡死"的保护（`isStalled`）：
       * **超过 5 秒**没新事件 → 显示「正在处理，请稍候…」。
       * 于是导入的绝大部分时间都停在那句话上。
       *
       * 现在：pip 每输出一行就转发，界面滚动显示真实包名
       *（aiohttp-3.10.5、quart-0.19.6 …），既满足 stall 保护的时间要求，
       * 又让用户看到"确实在动"。
       */
      onData: (chunk: string) => {
        const line = String(chunk ?? '').trim()
        if (!line) return
        const lastLine = line.split(/\r?\n/).filter(Boolean).pop() ?? ''
        const clean = lastLine
          .replace(/^\s*(?:Downloading|Collecting|Using cached|Building wheel for)\s*/i, '')
          .trim()
        if (!clean) return
        deps.onStage?.(clean.slice(-60))
      }
    })
    const r = pipRun.result
    if (pipRun.retriedNoCache) {
      deps.onStage?.('（第一次失败，已绕过缓存重试）')
    }
    if (r.status === 0) {
      /**
 * 成功了：清掉这个源的失败记忆（它现在是好的）
 */

      clearPythonSourceFailures()
      return { ok: true, reason: '' }
    }
    /**
 * ★ 失败时**记下这个源坏了* —— 下次 resolvePythonSource 会跳过它。 这是主人 2026-09-27 那个故障的根治：配置里写着"清华源"， 而清华源实测 403，于是**每次**装依赖都失败，用户完全看不出原因。 记下失败之后，下一次（以及这一轮的重试）会换下一个候选源。
 */

    markPythonSourceFailed(src.indexUrl)
    const tail = String(r.stderr ?? '').trim().split(/\r?\n/).slice(-3).join(' | ')
    return { ok: false, reason: `pip 退出码 ${r.status}：${tail || '(无 stderr)'}` }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }}/**
 * 探一下"这个 AstrBot 运行时的依赖装了没有"。 ## 为什么需要它（审查抓出的死锁） 主人实测的闭环：导入 whl → 解压成功 → pip 装依赖失败 → 目录留下（且已登记进清单）→ 用户按提示再导一次 → 被 `existsSync(dest)` 拦死「已经有一个 vX 了」→ **无路可走**。 判据刻意**宽松**（只要看起来装了就在）： · 依赖是 pip 装的，标志就是那几个顶层包目录 · 只看"有没有"，不校验版本完整性 —— 误判成"装了"只是维持原来的拦死行为， 而误判成"没装"会放行重装（pip --upgrade 覆盖式，安全） · 所以宁可偏"没装"（放行）也不要偏"装了"（拦死） 用 `astrbot/cli/__main__.py` 当前提：那是 PyPI 形态 AstrBot 的入口， 没有它就说明解压都没成功，谈不上依赖。
 */
function astrbotDepsLookInstalled(runtimeDir: string): boolean {
  try {
    if (!existsSync(join(runtimeDir, 'astrbot', 'cli', '__main__.py'))) return false
    /**
 * click 与 quart 是 AstrBot CLI/WebUI 的硬依赖（启动第一行就 import click）。 两个都不在 → 判"缺依赖"。
 */

    const hasClick = existsSync(join(runtimeDir, 'click'))
    const hasQuart = existsSync(join(runtimeDir, 'quart'))
    return hasClick || hasQuart
  } catch {
    // 探不出来就当"缺"→ 放行重装（比拦死更不容易把用户卡住）

    return false
  }}/**
 * 真实系统信息：内存余量 + 数据根所在盘余量（MB）
 *
 * ★ 内部定制版会在**入口处**换成固定硬件（见 hardware-override.ts）。
 *   公开版构建时 `isInternalBuild()` 恒为 false，整段被 tree-shaking 删除。
 */
async function realSystemInfo() {
  /*
   * ── 内部定制版：直接返回固定硬件，不读真实机器 ──
   *
   * 放在函数**最前面**（而不是最后覆盖字段）：这样连 statfs
   * 都不必跑 —— 内部版的磁盘/内存都不该反映宿主机。
   */
  if (isInternalBuild()) {
    const { INTERNAL_HW, internalUsedMemMB } = await import('./hardware-override')
    const used = internalUsedMemMB()
    return {
      totalMemMB: INTERNAL_HW.totalMemMB,
      freeMemMB: INTERNAL_HW.totalMemMB - used,
      totalDiskMB: 4 * 1024 * 1024,
      freeDiskMB: 2 * 1024 * 1024,
      osVersion: os.release(),
      cpuModel: INTERNAL_HW.cpuModel,
      gpuModel: INTERNAL_HW.gpuModel
    }
  }

  const { promises: fsp } = await import('fs')
  const total = Math.floor(os.totalmem() / (1024 * 1024))
  const free = Math.floor(os.freemem() / (1024 * 1024))
  const systemFields = {
    osVersion: os.release(),
    cpuModel: os.cpus()?.[0]?.model ?? ''
  }
  try {
    /**
 * 量「数据实际住在哪个盘」的余量，不是安装盘。 用户把数据迁到 D 盘之后，该关心的是 D 盘还剩多少 —— 用 defaultDataRoot() 会一直报安装盘的空间，那个数字对用户毫无用处。 startupDataRoot() 拿不到时（没指针）会退回默认位置，正好是全新安装的情形。
 */

    const st = await fsp.statfs(await startupDataRoot())
    const toMB = (v: number) => Math.floor(v / (1024 * 1024))
    return {
      totalMemMB: total,
      freeMemMB: free,
      totalDiskMB: toMB(Number(st.blocks) * Number(st.bsize)),
      freeDiskMB: toMB(Number(st.bavail) * Number(st.bsize)),
      ...systemFields
    }
  } catch {
    // statfs 不可用（少见盘符/权限问题）时只报内存

    return { totalMemMB: total, freeMemMB: free, totalDiskMB: 0, freeDiskMB: 0, ...systemFields }
  }}
