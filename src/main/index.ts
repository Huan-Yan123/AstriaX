import { app, BrowserWindow, dialog, shell } from 'electron'
import { dirname, join } from 'path'
import { readFileSync, existsSync } from 'fs'
import { spawnSync } from 'child_process'
/* 联系方式：原生错误框也要带（主人 2026-09-27 指出的遗漏） */
import { FEEDBACK_LINES } from './feedback'
/*
 * ★ `readAppConfig` 是**必须的导入**（主人 2026-09-27 实测的崩溃）
 *
 * 我给托盘改"读盘拿关闭策略"时用了它，却**没导入** —— 于是点 ✕ 时抛
 *     ReferenceError: readAppConfig is not defined
 * 关窗流程当场中断：**窗口关不掉，但软件还活着**（主人截图里的
 * 「按了没反应，反而还能用」正是这个）。
 *
 * ## 为什么守卫没拦住（值得记下来）
 *
 * 我写的 `no-undefined-identifiers.spec.ts` 只扫 **`TS2304`**
 *（Cannot find name），而 tsc 对"有个名字很像的变量存在"的情况
 * 报的是 **`TS2552`**（Cannot find name ... Did you mean 'appConfig'?）。
 * 这个文件里正好有 `appConfig`，所以报的是 2552 —— **从守卫的眼皮底下溜过去了**。
 *
 * 守卫已同步扩到两个码（见那个 spec 的说明）：
 * 这类"用了没导入"的错必须**一次都别放过**，因为它的表现是
 * 静默降级或半死状态，最难查。
 *
 * 它定义在 `ipc.ts`（不是 store 里），所以从这里导入。
 */
import { readAppConfig } from './ipc'
import {
  registerIpcHandlersReal,
  defaultDataRoot,
  createCrashHandler,
  /* 阻塞看门狗用它抓"卡住时主进程在跑什么"（见 startBlockWatchdog 处） */
  currentIpcScene
} from './ipc'
import { sweepStaleTmp } from './util/workdir'
import { startBlockWatchdog } from './util/block-watchdog'
import {
  beginRun,
  checkPreviousRun,
  endRun,
  installWerLocalDumps,
  startCrashReporter,
  writeLastRunReport
} from './util/crash-logs'
import { captureStartupFailure } from './logs/startup-failure'
/*
 * ★ 这一行是**恢复**回来的（守卫测试 no-undefined-identifiers 抓出）。
 *
 * 我早前插入 captureStartupFailure 的 import 时，
 * 用它**替换**了原本这行 pruneUpdateBackupsAsync ——
 * 而那行是被下面代码真实调用的（清理过期的更新备份）。
 *
 * 后果：`Cannot find name 'pruneUpdateBackupsAsync'`（TS2304）。
 * 这类错会被 try/catch 静默吞掉，表现为"过期备份永远不清"这种
 * 无声的功能缺失 —— 正是那条守卫专门要挡的东西。
 *
 * 教训：插 import 时要用"在前面插入"，不要拿它替换相邻行。
 */
import { pruneUpdateBackupsAsync } from './update/update-backups'
import { initTrayAndCloseFlow } from './tray/tray'
import type { AppConfig } from './ipc'
import {
  alreadyRelaunched,
  argsForRelaunch,
  buildStartProcessCommand,
  decideElevate,
  isElevatedFromWhoami
} from './elevate'
/*
 * 启动健康看门狗 —— 静态导入（**不能用 require**：本文件是 ESM）。
 *
 * 这几个函数负责"起不来 1 次弹窗 / 连崩 3 次弹窗"的**计数推进**：
 *   beginBoot / markWindowReady / markBootOk / noteCrash / noteBootFailure
 * 日志审查抓到第一版只接了 beginBoot 与 markWindowReady，导致
 * crashAttempts 永远为 0、"连崩三次"成了死代码 —— 所以这里全部接上。
 */
import {
  beginBoot,
  markWindowReady,
  markBootOk,
  noteCrash,
  noteBootFailure,
  shouldAlertBootFailure,
  shouldAlertCrash,
  markBootAlerted,
  markCrashAlerted,
  buildBootFailureMessage,
  readBootState
} from './logs/boot-watch'

/** 窗口/任务栏图标（dev=工程 build\icon.png；打包=exe 同级的 resources\icon.png） */
function winIcon(): import('electron').NativeImage | undefined {
  const { nativeImage } = require('electron') as typeof import('electron')
  const exeDir = dirname(process.execPath)
  // 打包后 = <安装目录>\resources；extraResources 落在这里，且在 asar 外面
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath
  const candidates = [
    // 打包态（首选）：electron-builder.yml 的 extraResources 放成 resources\icon.png
    ...(resourcesPath ? [join(resourcesPath, 'icon.png')] : []),
    join(process.cwd(), 'build', 'icon.png'),
    join(exeDir, 'resources', 'icon.png'),
    join(exeDir, 'icon.png')
  ]
  for (const p of candidates) {
    try {
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) return img
    } catch {
      /* 继续试下一个 */
    }
  }
  return undefined
}

let crash: (e: unknown, scope?: string) => void
let appConfig: AppConfig | undefined
/**
 * 上次运行是否异常退出（启动时由 running.lock 判定，见 util/crash-logs.ts）。
 *
 * 渲染层通过 `app:lastCrash` 取它，弹一个"是否导出诊断日志"的提示 ——
 * 这正是指导书 3.2 要的"下次启动检测异常退出"。
 * 用模块级变量而不是局部：要在注册 IPC 时被引用。
 */
let lastCrash: { crashed: boolean; startedAt?: number } = { crashed: false }
/** 崩溃诊断的依赖（正常退出时用它清 running.lock） */
let crashLogDeps: { dataRoot: string; log: (l: 'INFO' | 'WARN' | 'ERROR', c: string, m: string, d?: string) => void } | undefined
/**
 * 启动阶段的日志引用。
 *
 * 为什么单独一个变量：logger 是 `registerIpcHandlersReal()` 的返回值，
 * 而"启动失败"的 catch 在它外面 —— catch 里要写日志就得先拿到它。
 * 启动日志恰恰是排查"双击没反应"最需要的东西。
 */
let bootLogger: { log: (l: 'INFO' | 'WARN' | 'ERROR' | 'CRASH', c: string, m: string, d?: string) => void; exportZipSync: () => string } | undefined
/**
 * 启动健康看门狗用的数据根。
 *
 * 为什么单独记一个：`beginBoot()` 在**拿到 logger 之前**就要跑
 *（要捕捉"窗口建之前就挂了"），而启动失败的 catch 里需要它来落
 * "这次为什么没起来"。
 */
let bootWatchRoot: string | undefined

let closeFlow: Awaited<ReturnType<typeof initTrayAndCloseFlow>> | undefined

/**
 * 自我提权：让整个启动器以管理员运行。
 *
 * 为什么必须这么做：NapCat 是注入 QQ.exe 运行的，注入需要管理员权限。
 * 但我们不能用「让 NapCat 的 bat 自己提权」那条路——bat 里 runas 出的是另一个进程，
 * 我们 spawn 的那个立刻退出，于是子进程句柄、stdout、taskkill /T 的进程树全失效，
 * 用户点「停止」也停不掉那个真正在跑的实例。
 *
 * 让启动器自己是管理员，NapCat 才是我们普通的子进程，控制权完整；
 * 而 bat 里的 `net session` 自检会因为已是管理员而直接通过，不会 runas 重开。
 *
 * 用户拒绝 UAC 时不强求：继续以普通权限跑（AstrBot 完全不受影响），
 * 只有启动 NapCat 时才会提示需要管理员。
 */
function tryElevate(): 'already' | 'relaunched' | 'declined' {
  // 开发态（electron-vite dev）不提权：否则每次热重载都弹 UAC，没法干活
  const dev = !!process.env.ELECTRON_RENDERER_URL
  const isElevated = dev
    ? true
    : isElevatedFromWhoami(() => {
        /*
         * ════════════════════════════════════════════════════════════════
         * 启动阶段的同步子进程调用（**刻意保留，但已收紧**）
         * ════════════════════════════════════════════════════════════════
         *
         * 指导书 P0(4) 要求"禁止同步阻塞"。这一处与下面 relaunch 那处
         * 是**仅存的两个例外**，理由如下（其余同步调用本轮已全部清零：
         * netstat 按端口补杀、qqInstallDir 查注册表都改成了异步/缓存）：
         *
         *   1. 它们不在 IPC handler 里，而在**窗口出现之前**的启动阶段 ——
         *      没有界面可"冻"，用户感知是"图标点下去到窗口出现"的延迟。
         *   2. 提权判定必须在 `app.requestSingleInstanceLock()` **之前**
         *      出结果：否则我们会先占住单实例锁，再拉起提权副本，
         *      而那个副本拿不到锁 → 直接退出 → 用户看到"双击没反应"。
         *      把判定改成异步要重排「提权 → 单实例锁 → whenReady」整条顺序，
         *      风险远大于收益（这段代码有专门测试守着）。
         *   3. 代价已被**有界**：whoami 从 8 秒 → 3 秒 → 现在 **1.5 秒**；
         *      本机实测 ~90ms，只有域环境/超多组/安全软件挂钩时才接近上限。
         *
         * 另外：起了一个**事件循环阻塞监视器**（util/block-watchdog），
         * 一旦这段真的超 500ms，日志里会留下 `perf` 记录 ——
         * 将来要改成完全异步时，先用它拿到真实数据再动手。
         *
         * 长远解法（记在待处理里）：先建窗口、再异步判定提权，
         * 用一次"需要管理员才能做的事"失败来触发提权引导。
         */
        const r = spawnSync('whoami.exe', ['/groups'], { encoding: 'utf8', timeout: 1500 })
        return { status: r.status, stdout: String(r.stdout ?? '') }
      })

  return decideElevate({
    isElevated,
    argv: process.argv,
    relaunch: () => {
      // 打包后用 exe 自身；开发态不该走到这里
      const exe = process.execPath
      const args = argsForRelaunch(process.argv.slice(1))
      const cmd = buildStartProcessCommand(exe, args)
      /*
       * 这里的同步等待是"等用户对 UAC 弹窗做决定"，与"卡死"性质不同：
       *   · 此刻还没有窗口，不存在界面冻结
       *   · 用户在 UAC 上点「是/否」之前，我们本来就什么都做不了
       * 超时从 60 秒收紧到 30 秒：用户一直不理 UAC 时，
       * 最多等 30 秒就当作"拒绝了提权"，继续以普通权限启动
       *（AstrBot 不需要管理员；只有 NapCat 注入 QQ 需要）。
       */
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
        encoding: 'utf8',
        timeout: 30000,
        windowsHide: true
      })
      // 用户点「否」时 PowerShell 会报 "The operation was canceled by the user"
      return r.status === 0
    }
  })
}

const elevateVerdict = tryElevate()

/*
 * 单实例锁：同一时间只允许一个启动器。
 *
 * 用户的报告：「为什么可以同时启动一堆 MX 机器人启动器」。
 *
 * 原来完全没有这道锁，而双击图标 / 任务栏固定项 / 开始菜单各点一下
 * 就会各起一个完整进程。后果很严重，不只是多几个窗口：
 *   - 每个进程都会去读写同一份 instances.json / 配置文件，
 *     互相覆盖对方的写入（谁的缓存旧谁就把它写回去）
 *   - 每个进程都可能去启/停同一个实例，端口争抢、
 *     同一个实例被两个进程同时 spawn
 *   - 都挂在托盘上，用户根本分不清哪个是哪个
 *
 * 而且它自己**也会**让启动变慢：多个进程同时解压/扫盘/拉运行时，
 * 磁盘和 CPU 互相抢（用户说的「启动速度贼慢」很可能是这么来的）。
 *
 * ## 提权交接时的锁竞争（很隐蔽，差点踩进去）
 *
 * 提权的做法是：普通权限进程用 runas 拉起一个管理员副本，然后自己退出。
 * 两个进程的判定分别是：
 *   - 原进程：       elevateVerdict === 'relaunched'（它拉起完就走）
 *   - 管理员副本：   elevateVerdict === 'already'（它是以管理员身份起来的）
 *
 * 注意**管理员副本拿到的是 'already'，不是 'relaunched'**。
 * 所以「谁该跳过抢锁」不能看 verdict —— 看 verdict 会正好搞反：
 * 让马上要退出的原进程跳过、让真正要活下来的副本去抢，
 * 而副本启动时原进程还没退干净、锁还在它手上，副本抢不到就自杀，
 * 原进程也退了 —— **软件直接起不来，双击图标毫无反应**。
 *
 * 正确的判定是「我是不是被提权拉起来的那一个」，用 argv 里的标记判断。
 */
const isElevatedRelaunch = alreadyRelaunched(process.argv)

function acquireLockWithRetry(): boolean {
  if (!isElevatedRelaunch) return app.requestSingleInstanceLock()
  /*
   * 被提权拉起来的副本：原进程正在退出，锁可能还没释放。
   * 给它最多 5 秒重试窗口（原进程退出通常几十毫秒就完成了）。
   *
   * 用 Atomics.wait 做同步小睡：这里是启动最早期，没有事件循环可用，
   * 而且只用几百毫秒，不会有可感知的卡顿。
   */
  const deadline = Date.now() + 5000
  for (;;) {
    if (app.requestSingleInstanceLock()) return true
    if (Date.now() > deadline) return false
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120)
    } catch {
      // 极端环境（无 SharedArrayBuffer）退化成忙等一轮
    }
  }
}

const gotTheLock = acquireLockWithRetry()
if (!gotTheLock) {
  /*
   * 第二个实例：什么都不做，直接退。
   * 真正的「把已有窗口调到前面」由第一个实例的 second-instance 事件处理
   * （见下面的 app.on('second-instance')）。
   *
   * 这里用 app.exit(0) 而不是 app.quit()：quit 会走一遍
   * before-quit / window-all-closed 流程，而此刻窗口都还没建，
   * 某些平台下会多绕一圈甚至短暂闪一个空窗口。
   */
  app.exit(0)
}

/**
 * 主进程 → 渲染层 → 回主进程的问询桥：
 * 首次点 ✕ 时用它弹软件自己的确认框（风格统一），用户选完再把结果给回主进程。
 */
let pendingCloseAsk: ((v: 'tray' | 'quit') => void) | undefined
export function resolveCloseAsk(v: 'tray' | 'quit'): void {
  const fn = pendingCloseAsk
  pendingCloseAsk = undefined
  fn?.(v)
}
function askRendererClosePolicy(): Promise<'tray' | 'quit'> {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return Promise.resolve('tray')
  return new Promise<'tray' | 'quit'>((resolve) => {
    // 兜底：15 秒没答就当缩回托盘，别把关闭流程卡死
    const timer = setTimeout(() => {
      if (pendingCloseAsk) {
        pendingCloseAsk = undefined
        resolve('tray')
      }
    }, 15000)
    pendingCloseAsk = (v) => {
      clearTimeout(timer)
      resolve(v)
    }
    win.webContents.send('close:ask')
  })
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 600,
    autoHideMenuBar: true,
    frame: false, // GUI 全接管：自绘标题栏与窗口控制
    roundedCorners: true,
    show: false,
    /*
     * 先渲染成白底再显示，避免「白屏一闪」。
     *
     * 用户报告「启动速度贼慢，卡半天白屏」。
     * 原来 show:false + ready-to-show 才 show()，而 ready-to-show 等的是
     * **渲染进程首次绘制完成** —— 那要等 Vue 整个应用挂载，
     * 期间窗口完全不出现。用户点图标后盯着桌面干等，体感就是"没反应/很慢"。
     *
     * 给 backgroundColor 之后，Electron 可以**立刻**把窗口显示出来
     * （一块和界面同色的底），渲染完成后再把内容填进去 ——
     * 用户一点就看到窗口，不再是"点了没动静"。
     */
    backgroundColor: '#f4f6fa',
    icon: winIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  win.webContents.on('render-process-gone', (_e, details) => {
    crash?.(new Error(`渲染进程消失：${details.reason}`), 'renderer-gone')
  })

  /*
   * 窗口**立刻**显示，别等 ready-to-show。
   *
   * 用户报告「启动速度贼慢，卡半天白屏」。
   * ready-to-show 要等渲染进程完成首次绘制（Vue 应用挂载 + 首屏数据），
   * 这期间窗口压根不存在 —— 用户点完图标盯着桌面干等，就是"很慢"的体感。
   *
   * 上面给了 backgroundColor，所以先显示出来是一块和界面同色的底，
   * 不会看到刺眼的白闪；内容准备好后自然填进去。
   *
   * 用 once 只挂一次；ready-to-show 到了就聚焦一下（此时内容已就绪）。
   */
  win.show()
  win.once('ready-to-show', () => {
    // 内容画好了，确保窗口在最前面（启动瞬间用户可能已经切走了）
    if (!win.isDestroyed()) win.focus()
  })

  // 关闭策略拦截（M4）：✕ 不直接退，走 closePolicy（tray/quit/首点询问）
  const w = win as BrowserWindow & { __allowClose?: boolean }
  w.on('close', (e) => {
    if (closeFlow && !w.__allowClose) {
      e.preventDefault()
      void closeFlow.onWindowCloseRequest().then((proceed) => {
        if (proceed) {
          w.__allowClose = true
          w.close()
        }
      })
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

app.whenReady().then(async () => {
  // 已经拉起提权实例：当前这个普通权限的进程立刻退，别开两份窗口
  if (elevateVerdict === 'relaunched') {
    app.quit()
    return
  }

  /*
   * ══════════════════════════════════════════════════════════════════════
   * ★ 启动健康看门狗：起不来时**主动介入**（主人 2026-09-26 的要求）
   * ══════════════════════════════════════════════════════════════════════
   *
   * 主人原话：「如果软件无法正常启动或者多次崩溃，日志系统应该主动介入，
   * 收集信息，即使软件无法正常使用，遇到这种无法正常启动/多次崩溃，
   * 也应该主动弹出窗口让用户导出日志」。
   *
   * 这一条针对的是**真实发生过的死角**：0.1.4 那次"装完启动不了、
   * 进程在但界面不出现" —— 窗口根本没建，导出日志的按钮也就不存在，
   * 用户完全无路可走，只能说"它坏了"。
   *
   * `beginBoot()` 必须在**窗口创建之前**调用：我们要捕捉的正是
   * "窗口建之前就挂了"那类失败，晚了就漏掉最需要它的情况。
   * 成功进入主界面后由 `markBootOk()` 清零（见 createWindow 之后那段）。
   *
   * 这里是"尽力而为"：任何异常都不许影响启动本身。
   */
  const bootDataRoot = app.getPath('userData')
  bootWatchRoot = bootDataRoot
  try {
    /*
     * ══════════════════════════════════════════════════════════════════════
     * ★ 判断要用**自增之前**的读数（第三轮终审抓出的 Critical）
     * ══════════════════════════════════════════════════════════════════════
     *
     * 第一版是这样写的：
     *     const st = beginBoot(bootDataRoot)          // ← 返回的是**已 +1** 的状态
     *     const isBootFail = shouldAlertBootFailure(st)   // ← 阈值是 1
     *
     * 而 `beginBoot` 内部先 `bootAttempts + 1` 再返回 —— 于是**任何一次启动**
     * 都满足 `bootAttempts >= 1`，`isBootFail` **恒为真**。净效果：
     *   · 全新安装、健康机器**每次启动都弹**"AstriaX 没能正常打开"的假错误框
     *   · 而且 `isCrashLoop = !isBootFail && ...` 被短路，
     *     **"连崩 3 次"的告警永远弹不出来** —— 主人指定的功能彻底失效
     * 这比修之前更糟（之前只是死代码，现在是每次启动误报）。
     *
     * 为什么 978 个测试全绿也没抓到：`boot-watch.spec.ts` 只测单函数语义
     * （每个用例自己排调用序列），**没有覆盖 index.ts 这里的真实编排** ——
     * 接线层的 bug 在单函数测试里是看不见的。
     *
     * 现在：先读**上一次**留下的状态来判断，判断完再记"本次启动开始了"。
     */
    const prev = readBootState(bootDataRoot)

    /*
     * ★ 两条线、两个阈值（主人 2026-09-26 指定：「起不来一次就弹，
     *   起来了但崩溃三次弹」）。
     *
     * 判的是**上一次**留下的计数：
     *   · 上次连窗口都没建起来（bootAttempts≥1）→ 立刻介入
     *   · 上次起来了但连续崩了 3 次 → 也介入
     *
     * 用**系统原生框**：此刻我们自己的窗口还没建，没有任何界面可用。
     * 这正是主人要的"即使软件无法正常使用，也要弹窗让用户导出日志"。
     */
    const isBootFail = shouldAlertBootFailure(prev)
    const isCrashLoop = !isBootFail && shouldAlertCrash(prev)

    // 判断完再自增（顺序不能反，见上面那段）
    beginBoot(bootDataRoot)

    if (isBootFail || isCrashLoop) {
      try {
        const { dialog } = await import('electron')
        dialog.showErrorBox(
          isBootFail ? 'AstriaX 没能正常打开' : 'AstriaX 连续崩溃了',
          buildBootFailureMessage({
            state: prev,
            dataRoot: bootDataRoot,
            kind: isBootFail ? 'boot' : 'crash'
          })
        )
        if (isBootFail) markBootAlerted(bootDataRoot)
        else markCrashAlerted(bootDataRoot)
      } catch {
        /* 弹不出来也不能影响启动 */
      }
    }
  } catch {
    /* 看门狗自己出问题不该拦住启动 */
  }

  /*
   * ══════════════════════════════════════════════════════════════════════
   * 启动失败必须**看得见**（0.1.4 用户报告换来的）
   * ══════════════════════════════════════════════════════════════════════
   *
   * 用户实测：「0.1.4 安装之后启动不了，在进程里但是不出现」。
   * 排查时最难受的一点是：**什么线索都没有** —— 日志只写到某一行就断了，
   * 没有异常、没有弹窗、没有错误码，进程还在那儿（或悄悄退掉）。
   *
   * 原因：`app.whenReady().then(async () => {...})` 里任何一步抛错，
   * 都只会变成一次 rejected promise。窗口还没建（失败点通常在它之前），
   * 所以用户看到的就是"点了没反应"。
   *
   * 现在把这段整体包起来：出错就
   *   1. 用同步写日志记下错误与堆栈（进程可能马上退出，必须同步落地）
   *   2. 落一份 `startup-error.txt` 到数据根（用户能直接发给我）
   *   3. 记进 `boot-attempts.json`（下次启动时主动提醒 + 说明原因）
   *   4. 弹一个**系统错误框**（此时我们自己的界面还没起来，只能用原生框）
   * 哪怕这次的问题不是这里的 bug，以后任何启动期异常也都有据可查。
   */
  try {
  // pm 不在这里解构：退出清理统一走 killEverythingForExit 由主进程自己完成
  /*
   * ★ 把提权判定结果传进去（它会写进导出包的设备信息里）
   *
   * 这台软件核心行为依赖管理员（NapCat 注入 QQ）。用户报"NapCat 起不来"时，
   * 第一句要问的就是"你是不是管理员跑的"—— `elevateVerdict` 在启动最早期
   * 就算出来了（见上面 `tryElevate()`），但一直没进任何日志。
   */
  const boot = await registerIpcHandlersReal({ elevateVerdict })
  
  // 窗口控制 IPC 处理器
  const mainWindow = BrowserWindow.getAllWindows()[0]
  
  if (mainWindow) {
    ipcMain.handle('window:minimize', () => mainWindow.minimize())
    ipcMain.handle('window:toggleMaximize', () => {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize()
      } else {
        mainWindow.maximize()
      }
    })
    ipcMain.handle('window:close', () => mainWindow.close())
    ipcMain.handle('window:isMaximized', () => mainWindow.isMaximized())
    
    mainWindow.on('maximize', () => mainWindow.webContents.send('window:maximize-change', true))
    mainWindow.on('unmaximize', () => mainWindow.webContents.send('window:maximize-change', false))
  }
  /*
   * bootLogger：给下面"启动失败"的 catch 用。
   * logger 是 boot 的返回值，catch 作用域里访问不到 —— 而启动失败时
   * 最需要写日志，所以单独留一个引用。
   */
  bootLogger = boot.logger
  const { logger, getConfig, setClosePolicy, killEverythingForExit, setLastCrash } = boot
  appConfig = getConfig()

  /*
   * ══════════════════════════════════════════════════════════════════════
   * 崩溃诊断三层（指导书 3.2 的第三层 + 异常退出判据）
   * ══════════════════════════════════════════════════════════════════════
   *
   * 主人的问题（3.1）：崩溃闪退、日志什么都没有、不弹窗，完全不知道发生了什么。
   * 第一层（滚动日志）与第二层（uncaughtException / unhandledRejection）
   * 项目已有，这里补齐第三层：
   *
   *   · running.lock：**判断上次是否异常退出**的唯一可靠证据
   *     （进程被杀时来不及写任何日志，只剩这个锁文件）
   *   · crashReporter：V8/进程崩溃时落 .dmp
   *   · WER LocalDumps：原生崩溃、Node 崩溃这些可能漏掉的场景，系统兜底
   *
   * 顺序有意：**先查上次（读锁），再写本次锁** —— 反过来的话
   * 一启动就把证据覆盖掉了，"上次异常退出"永远查不出来。
   *
   * ══════════════════════════════════════════════════════════════════════
   * ★ 事故复盘（0.1.4 用户实测：装完启动不了，进程在但界面不出现）
   * ══════════════════════════════════════════════════════════════════════
   *
   * 原来这里是 `dataRoot: appConfig.dataRoot`。而**全新安装**（用户先卸载
   * 再重装，或者第一次用）时还没有 config.json —— `getConfig()` 会返回
   * undefined，于是这一行直接抛：
   *
   *     TypeError: Cannot read properties of undefined (reading 'dataRoot')
   *
   * 后果被放大成一整类"最难查"的现象：
   *   · 这段在 `createWindow()` **之前**，所以窗口压根没建 → 用户什么都没看到
   *   · 异常发生在 whenReady 的 async 回调里 → 变成一次 rejected promise，
   *     没有弹窗、没有日志（日志写在它之前的那行之后就断了）
   *   · **进程还活着**（没有窗口 → window-all-closed 不触发 → 不退出），
   *     并且**占着单实例锁** → 用户再双击多少次都只是默默退出
   * 于是就成了"进程列表里能看到，但界面永远不出现"。
   *
   * 修法有两层：
   *   ① 数据根**取不到就回落**（诊断功能不该依赖"配置已经存在"）
   *   ② 整段包 try/catch —— 诊断是附加功能，**任何情况下都不许拦住启动**
   */
  let crashDeps: {
    dataRoot: string
    appVersion: string
    log: (lv: 'INFO' | 'WARN' | 'ERROR', ch: string, msg: string, detail?: string) => void
  } | undefined
  try {
    /*
     * 数据根的三级回落：
     *   1. 已加载的配置（正常情况）
     *   2. defaultDataRoot()（全新安装：还没有 config.json 时算出来的位置）
     *   3. userData 目录（极端兜底，确保"一定有地方写日志"）
     */
    const root = appConfig?.dataRoot ?? (await defaultDataRoot()) ?? app.getPath('userData')
    crashDeps = {
      dataRoot: root,
      /*
       * 版本戳：用来识别"覆盖更新留下的锁"（不是崩溃）。
       * 安装器更新时会把整个数据目录连 running.lock 一起搬个来回，
       * 并用 taskkill /F 结束旧进程（will-quit 不跑 → 锁没删）。
       * 没有这一戳，**每次更新完的第一次启动都会误报崩溃并弹导出提示**。
       */
      appVersion: app.getVersion(),
      log: (lv: 'INFO' | 'WARN' | 'ERROR', ch: string, msg: string, detail?: string) =>
        logger.log(lv, ch, msg, detail)
    }
    const previousRun = checkPreviousRun(crashDeps)
    /*
     * 只有**真崩溃**才交给渲染层弹提示。
     * 「覆盖更新残留」不算（updated=true），否则用户每次更新后都被问一遍
     * "要不要导出诊断日志"，久了就再也不看了 —— 那比不提示更糟。
     */
    lastCrash = previousRun.crashed ? previousRun : { crashed: false }
    setLastCrash(lastCrash)
    // 把结论落一份到磁盘：导出诊断包时读它（不能等导出时再判，见 crash-logs 注释）
    writeLastRunReport(crashDeps, previousRun)

    if (previousRun.crashed) {
      /*
       * 用 CRASH 级别记一条：导出日志时一眼能看到"上次是异常退出"，
       * 而且能算出它活了多久（锁里存的是启动时刻）。
       */
      logger.log(
        'CRASH',
        'app',
        '检测到上次是异常退出（运行锁没被正常清理）',
        previousRun.startedAt
          ? `上次启动于 ${new Date(previousRun.startedAt).toISOString()}`
          : '（读不出上次启动时刻）'
      )
    } else if (previousRun.updated) {
      // 覆盖更新也会留下锁 —— 如实记成 INFO，不当崩溃
      logger.log(
      'INFO',
      'app',
      '上次是覆盖更新（旧进程被安装器结束，运行锁随之残留；不是崩溃）',
      previousRun.startedAt
        ? `上次启动于 ${new Date(previousRun.startedAt).toISOString()}`
        : undefined
    )
  }
  beginRun(crashDeps)
  crashLogDeps = crashDeps
  } catch (e) {
    /*
     * 崩溃诊断自己出错：**记一笔就放过**，绝不许拦住启动。
     * （0.1.4 的事故就是这段把整个启动带崩了 —— 见上面那段复盘。）
     */
    logger.log(
      'WARN',
      'app',
      `崩溃诊断初始化失败（不影响使用）：${e instanceof Error ? e.message : String(e)}`
    )
  }
  if (crashDeps) {
    // 转储与注册表都不阻塞启动：它们是"锦上添花"，失败只记日志
    void startCrashReporter(crashDeps)
    void (async () => {
      const { run } = await import('./util/async-exec')
      await installWerLocalDumps({
        ...crashDeps!,
        run: (cmd, args, opts) => run(cmd, args, { timeoutMs: opts?.timeoutMs })
      })
    })()
  }

  /*
   * 顺手清扫陈旧的暂存残留（下载/解压到一半被杀留下的）。
   *
   * 代码里多处注释都写着「删不掉就算了，下次启动可清理」——
   * 这里就是那个"下次启动"。不做的话 cache\tmp 会无限堆积
   * （实测 916 个条目，其中 rt-* 能到 GB 级，且永不回收）。
   *
   * 放在 registerIpcHandlersReal 之后：那时才知道真正的 dataRoot
   * （用户可能迁移过数据目录）。用 void + catch 包住，
   * 清理失败绝不能挡住启动。
   */
  void (async () => {
    try {
      const root = await defaultDataRoot()
      /*
       * sweepStaleTmp 已改 **async**（性能审计实测：同步版每次启动
       * 冻结约 14 秒 —— cache\tmp 实测 45,391 个待删文件 × 0.31ms/文件）。
       * 注意 `void (async () => {})()` 这个包装**本身**并不能避免冻结：
       * 它只解决"谁来等"，不解决"事件循环是否被占"。
       * 真正的原因在 sweepStaleTmp 内部已改成异步 IO。
       */
      const n = await sweepStaleTmp(root)
      if (n > 0) logger.log('INFO', 'app', `已清理 ${n} 个陈旧的暂存残留`)
    } catch {
      /* 清理是尽力而为，失败不影响启动 */
    }
  })()

  /*
   * 清理覆盖更新时安装器打的自动备份，只留最近几份。
   *
   * 安装器（build/installer.nsh）每次覆盖更新前都会往
   * `<数据目录>\backups\update\<时间戳>\` 放一份数据备份 —— 那是用户的
   * 最后退路，所以安装器只打不删。但不管的话就是**无上限增长**：
   * 实测连续更新两次就攒了 3 份，用户一年下来几百个目录。
   * （本项目在 cache\tmp 上踩过一模一样的坑：攒到 916 个条目。）
   *
   * 保留份数复用用户已有的 `config.backupKeep`（和实例备份同一个旋钮），
   * 不让他学第二个设置。保底至少留 1 份 —— 见 pruneUpdateBackups 的注释。
   *
   * 同样用 void + catch：清理失败绝不能挡住启动。
   */
  void (async () => {
    try {
      const root = await defaultDataRoot()
      /*
       * ★ 同一类坑的第二处：全新安装时还没有 config.json，
       * `getConfig()` 返回 undefined —— 直接读 .backupKeep 会抛。
       * 这里虽然被 try/catch 兜住不会崩，但**清理备份这件事会静默失效**
       *（用户表现为"更新备份越攒越多"）。所以取不到就用默认 5 份。
       */
      const removed = await pruneUpdateBackupsAsync(root, getConfig()?.backupKeep ?? 5)
      if (removed.length > 0) {
        logger.log('INFO', 'app', `已清理 ${removed.length} 份陈旧的更新前备份`)
      }
    } catch {
      /* 尽力而为 */
    }
  })()

  /**
   * 退出时的实例清理（**幂等**：重复调用只真正执行一次）。
   *
   * 为什么是 killEverythingForExit 而不是 pm.killAllSync()：
   * process-manager 只知道我们 spawn 的那棵树，而 NapCat 是注入 QQ 跑的，
   * QQ 早已脱离我们的父子链 —— `taskkill /T` 杀不到它。
   * 只调 killAllSync 的话，用户点「退出（停止全部实例）」后软件没了，
   * NapCat 却还在后台跑着（继续连 QQ、继续收发消息、端口还占着）。
   * killEverythingForExit 里补了一道按端口精确清理。
   *
   * ## 为什么要幂等（审计抓出的问题）
   *
   * 实例清理原来只挂在**托盘关闭流程**上。只要有哪条退出路径绕过它，
   * 实例就留在后台。已发现的具体路径：
   *   · uncaughtException → app.exit(1)（app.exit **不触发** will-quit）
   *   · 窗口全关 → window-all-closed → app.quit()
   *   · 将来新增的退出入口（没人会记得去挂 killAll）
   *
   * 所以现在挂两处：托盘流程 + `will-quit`（Electron 真正退出前必发）。
   * 两处都会调这个函数，而 killEverythingForExit 里有 netstat/taskkill
   * 同步调用（按端口扫描），跑两遍纯属让用户多等 —— 所以加 once 保护。
   */
  let didKillAll = false
  const killAll = (): void => {
    if (didKillAll) return
    didKillAll = true
    try {
      killEverythingForExit()
      logger.log('INFO', 'app', '已停止全部实例')
    } catch {
      /* 清理绝不卡死退出 */
    }
  }

  const onCrash = createCrashHandler({
    logger,
    dialog,
    dataRoot: await defaultDataRoot()
  })
  crash = onCrash
  process.on('uncaughtException', (e) => {
    /*
     * ★ 崩溃退出前也必须把实例停掉（审计抓出的真问题）
     *
     * 原来这里是裸的 `onCrash(e); app.exit(1)`。而 `app.exit()` 是
     * **立即退出**，它**不触发** `before-quit` / `will-quit` 流程 ——
     * 而实例清理（killAll → killEverythingForExit）只挂在托盘关闭流程上
     * （下面 initTrayAndCloseFlow 的 killAll 参数）。
     *
     * 后果：主进程一崩，**一个实例都不会被停**。NapCat 还在后台连着 QQ、
     * 继续收发消息、继续占着端口；用户以为"软件都崩了肯定是全关了"，
     * 实际它还在跑。这比崩溃本身更难受 —— 崩溃至少看得见，
     * 而后台残留的实例用户完全不知道。
     *
     * 注意 killAll 内部整段包了 try/catch（"清理绝不卡死退出"），
     * 所以在这里调用不会因为清理本身出错而妨碍崩溃处理。
     */
    /*
     * ★ 崩溃要**计数**（日志审查抓出的"只接了一半"）
     *
     * `boot-watch` 里定义了 noteCrash（连崩计数 +1），但第一版**零调用** ——
     * 于是 crashAttempts 永远是 0，`shouldAlertCrash()` 恒假，
     * 主人要的"起来了但崩溃三次弹窗"变成**死代码**；
     * 更糟的是落盘的 `crashAttempts: 0` 会被误读成"从未崩溃"。
     *
     * 必须在 app.exit(1) **之前**记：exit 是立即退出，之后什么都写不了。
     * （用顶部静态导入的 noteCrash —— 这里不能 require：
     *   本文件是 ESM，require 不存在，项目里踩过这个坑。）
     */
    try {
      if (bootWatchRoot) noteCrash(bootWatchRoot, e instanceof Error ? e.message : String(e))
    } catch {
      /* 计数失败不能妨碍崩溃处理本身 */
    }
    onCrash(e)
    killAll()
    app.exit(1)
  })
  process.on('unhandledRejection', (e) => {
    /*
     * 未处理的 Promise 拒绝同样计入"连崩"—— 0.1.4 那次"装完启动不了"
     * 就是这种形态：异常发生在 whenReady 的 async 回调里，
     * 不触发 uncaughtException，**一声不响**，用户只看到没反应。
     */
    try {
      if (bootWatchRoot) {
        noteCrash(
          bootWatchRoot,
          `unhandledRejection: ${e instanceof Error ? e.message : String(e)}`
        )
      }
    } catch {
      /* 同上 */
    }
    onCrash(e, 'unhandledRejection')
  })
  // 渲染层对「关闭方式」问询的应答
  const { ipcMain } = await import('electron')
  ipcMain.on('close:answer', (_e, v: unknown) => {
    resolveCloseAsk(v === 'quit' ? 'quit' : 'tray')
  })
  logger.log('INFO', 'app', '软件启动')

  /*
   * ★ 主进程事件循环阻塞监视（指导书 0.1.3 → 自检 1 的产品化）
   *
   * "界面卡飞了"在 Electron 里有两种成因，其中主进程同步代码把
   * 事件循环占死那种最难归因。这个监视器每 50ms 醒一次，
   * 醒超过 500ms 就把"刚才被阻塞了多久"写进日志 —— 与 IPC 延迟埋点
   * （registerIpcHandlersReal 里的 perf 计时）互相对账：
   * 界面卡的瞬间，日志里要么有 block WARN、要么有慢 channel WARN。
   * 判断"还卡不卡"从此有了数据，不再凭体感。
   *
   * ★ snapshot：抓"阻塞期间主进程在跑什么"
   *
   * 主人 2026-09-27 死机前的日志只有"卡了 5941ms"，**没有"谁卡的"** ——
   * 那条信息才是全部价值。现在把 ipc.ts 的现场探针接上，
   * 日志会变成"卡了 6 秒；正在执行：xxx；最近完成：yyy(1200ms, 3秒前)"。
   */
  startBlockWatchdog({
    log: (lv, ch, msg) => logger.log(lv, ch, msg),
    snapshot: () => currentIpcScene()
  })

  createWindow()
  
  // 窗口控制 IPC 处理器（必须在 createWindow 之后注册）
  {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      // 移除旧处理器（避免热重载时重复注册）
      ipcMain.removeHandler('window:minimize')
      ipcMain.removeHandler('window:toggleMaximize')
      ipcMain.removeHandler('window:close')
      ipcMain.removeHandler('window:isMaximized')
      
      ipcMain.handle('window:minimize', () => win.minimize())
      ipcMain.handle('window:toggleMaximize', () => {
        if (win.isMaximized()) {
          win.unmaximize()
        } else {
          win.maximize()
        }
      })
      ipcMain.handle('window:close', () => win.close())
      ipcMain.handle('window:isMaximized', () => win.isMaximized())
      
      win.on('maximize', () => win.webContents.send('window:maximize-change', true))
      win.on('unmaximize', () => win.webContents.send('window:maximize-change', false))
    }
  }

  /*
   * ★ 窗口已经建出来了 → "起不来"那条线终止（主人 2026-09-26 的阈值设计）。
   *
   * 为什么要区分：窗口建出来意味着**用户有了界面**，也就能自己点"导出日志"。
   * 从那之后的失败属于"起来了但崩溃"，按 3 次才介入（见 boot-watch 的注释）。
   *
   * 注意这里**不清 crashAttempts** —— 那个要等真正稳定运行（markBootOk）
   * 才清。刚开窗口就崩，仍然算在"连崩"里。
   */
  try {
    if (bootWatchRoot) markWindowReady(bootWatchRoot)
  } catch {
    /* 看门狗自己出问题不该影响启动 */
  }

  closeFlow = await initTrayAndCloseFlow({
    getApp: async () => ({ app, Tray: (await import('electron')).Tray, Menu: (await import('electron')).Menu, nativeImage: (await import('electron')).nativeImage, dialog, BrowserWindow }),
    getMainWindow: () => BrowserWindow.getAllWindows()[0],
    /*
     * ══════════════════════════════════════════════════════════════════════════
     * ★★ 必须**从磁盘读**，不能读内存里的 appConfig
     *   （主人 2026-09-27 实测：「之前选的缩小到托盘，后面改成直接关闭，
     *     但是点 X 依旧缩小到托盘了」）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * ## 原来的错
     *
     *     readClosePolicy: async () => appConfig?.closePolicy
     *
     * `appConfig` 是**这个模块（index.ts）的变量**，只在启动时
     * `appConfig = getConfig()` 赋一次。而设置页改关闭行为走的是
     * `config:set` —— 那条路径更新的是 **ipc.ts 闭包里的另一个 `config` 变量**
     *（见 ipc.ts 的 `config = { ...base, ...patch }`）+ 写盘，
     * **从来不会碰到 index.ts 这个 `appConfig`**。
     *
     * 于是：用户改了设置、也写进了 `config.json`，但点 ✕ 时
     * 托盘读到的还是**启动那一刻的旧值** —— 改了等于没改。
     *
     * 两个模块各持一份同名配置、只更新其中一个，是这个 bug 的本质。
     *
     * ## 修法：读盘
     *
     * `readAppConfig(liveRoot())` 直接读 `config.json` ——
     * **写盘是唯一的真相来源**，因此无论谁改的、什么时候改的，
     * 下一次点 ✕ 一定读到最新值。
     *
     * 代价是每次点 ✕ 多一次小文件读（几毫秒）——
     * 而"关窗"是低频动作，完全值得。
     *
     * 配套：`setClosePolicy` 那边也**写盘**（它本来就调了 setClosePolicy），
     * 并同步更新 `appConfig` 以防别处读它。
     *
     * ## `liveRoot()` 在这个文件里**不存在**（守卫抓出来的一处错）
     *
     * 我第一版照抄了 ipc.ts 的 `readAppConfig(liveRoot())` ——
     * 而 `liveRoot` 是 **ipc.ts 闭包里的函数**，index.ts 里没有它
     *（这就是本项目反复出现的"用了没导入"，被 `no-undefined-identifiers`
     *  守卫当场拦下）。
     *
     * 这里改用 index.ts 真正持有的那个变量：`appConfig?.dataRoot`。
     * 它是启动时读进来的**数据根路径**（不是配置内容），
     * 而配置内容每次都从磁盘重读 —— 两者职责不同，别混。
     */
    readClosePolicy: async () => readAppConfig(appConfig?.dataRoot ?? (await defaultDataRoot()) ?? app.getPath('userData'))?.closePolicy,
    setClosePolicy: async (p) => {
      appConfig = { ...(appConfig ?? ({} as AppConfig)), closePolicy: p }
      await setClosePolicy(p)
    },
    // 首次点 ✕：问渲染层，用软件自己的弹窗（不用系统原生框）
    askClosePolicy: () => askRendererClosePolicy(),
    killAll,
    /*
     * 图标没找到就记一笔。
     *
     * 用户报过「托盘还是没图标」，而原来是**完全静默**的 ——
     * 找不到就默默用一个 32px 色块，日志里一个字都没有，
     * 排查时只能靠猜。现在这条 WARN 会直接写在日志里，
     * 下次看日志就知道是图标没找到还是托盘没建起来。
     */
    onIconFallback: (why) => logger.log('WARN', 'app', why)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  /*
   * ★ 最后一道兜底：任何"正常退出"路径都要把实例停掉
   *
   * 为什么要有它（审计抓到的问题）：
   * 实例清理原来只挂在**托盘关闭流程**上（上面那个 killAll 参数）。
   * 只要有哪条退出路径绕过了托盘流程，实例就会留在后台。
   * 已经发现的具体路径：
   *   · uncaughtException → app.exit(1)（已在上面显式补了 killAll）
   *   · 渲染进程崩溃后窗口全关 → window-all-closed → app.quit()
   *   · 将来的新退出入口（没人会记得去挂 killAll）
   *
   * `will-quit` 是 Electron 在**真正退出前**一定会发出的事件，
   * 所以挂在这里覆盖面最广。`app.exit()` 不会触发它 ——
   * 那种情况由上面那处的显式 killAll 负责，两条路互补。
   *
   * killAll 内部整段 try/catch，且用了幂等保护（下面的 didKillAll），
   * 所以重复触发（托盘已经杀过一遍）不会出问题，也不会卡住退出。
   */
  app.on('will-quit', () => {
    killAll()
    /*
     * 正常退出 → 清掉运行锁（crash-logs 的"证人"）。
     *
     * 只有走到这里才算正常退出；崩溃路径（uncaughtException → app.exit）
     * **刻意不清** —— 留着锁，下次启动才能知道"上次是异常退出"并提示
     * 用户导出诊断日志。这就是整个判据的设计。
     */
    if (crashLogDeps) endRun(crashLogDeps)
    /*
     * ★ 同时清掉"连崩"计数（日志审查抓出的漏接线）。
     *
     * 走到 will-quit 说明软件**稳定运行到了正常退出** —— 从那之后再启动，
     * 不该还背着上几轮崩溃的账。不清的话 `crashAttempts` 只增不减，
     * 用户某天正常用一次、下次一启动就被弹"连续崩溃了"的框，纯属误报。
     */
    try {
      if (bootWatchRoot) markBootOk(bootWatchRoot)
    } catch {
      /* 看门狗失败不能影响退出流程 */
    }
  })
  } catch (e) {
    /*
     * 启动期异常：**必须让用户看得见**（见上面那段长注释）。
     * 这里不 throw —— 已经没救了，重点是留下证据并告诉用户怎么办。
     */
    const msg = e instanceof Error ? `${e.message}\n\n${e.stack ?? ''}` : String(e)
    try {
      bootLogger?.log('CRASH', 'app', '启动失败（窗口创建之前就抛错了）', msg.slice(0, 4000))
    } catch {
      /* 日志都写不进去也不能再抛 */
    }
    /*
     * ★ 把"这次为什么没起来"记进看门狗状态（日志审查抓出的漏接线）。
     *
     * 记了它，用户下次启动时那个主动弹窗里才会写出**具体原因** ——
     * 否则只有一句"你上次没打开成功"，对用户毫无帮助。
     */
    try {
      if (bootWatchRoot) noteBootFailure(bootWatchRoot, msg.split('\n')[0] ?? msg)
    } catch {
      /* 计数失败不能妨碍下面的落盘与弹窗 */
    }
    let reportMessage = `原始日志位置：${appConfig?.dataRoot ?? app.getPath('userData')}`
    try {
      const root = appConfig?.dataRoot ?? app.getPath('userData')
      const report = captureStartupFailure({
        dataRoot: root,
        error: e,
        version: app.getVersion(),
        log: (level, scope, message, detail) => bootLogger?.log(level, scope, message, detail),
        exportZipSync: () => bootLogger!.exportZipSync()
      })
      reportMessage = report.message
    } catch {
      /* 报告生成失败也要继续弹窗 */
    }
    try {
      const { dialog } = await import('electron')
      dialog.showErrorBox(
        'AstriaX 启动失败',
        `软件在创建窗口之前出错了，所以你没有看到界面。\n\n` +
          `错误信息：\n${(e instanceof Error ? e.message : String(e)).slice(0, 800)}\n\n` +
          `${reportMessage}\n\n` +
          `把日志包发给我就能定位问题。` +
          FEEDBACK_LINES
      )
    } catch {
      /* 连框都弹不出来就只剩日志了 */
    }
    /*
     * ★ 必须退出进程（0.1.4 事故的直接教训）
     *
     * 出错时不退出的话，会留下一个**没有窗口的主进程**：
     *   · 用户看到"任务管理器里有 AstriaX，但桌面上什么都没有"
     *   · 它还**占着单实例锁** → 用户再双击多少次都只是默默退出
     *     （第二个实例被锁挡掉，而第一个又没窗口可显示）
     * 于是软件看起来"彻底坏了"，而且用户连重启软件都做不到。
     *
     * 用 app.exit(1)：立即退出，不走 will-quit（此时没有实例需要清理，
     * 也避免在出错状态下再执行清理逻辑）。
     */
    app.exit(1)
  }
})

app.on('window-all-closed', () => {
  // 只有 closePolicy=quit 或托盘「退出」会真正走到这里；届时 window-all-closed 触发 quit
  app.quit()
})

/**
 * 用户又双击了一次图标（第二个实例被单实例锁挡掉了）。
 *
 * 这时要做的是把**已有的窗口**显示出来并聚焦，而不是无动于衷 ——
 * 否则用户点半天没反应，会以为软件卡死了，
 * 然后去别的地方再点，最后桌面上躺着好几个（旧版本的情形）。
 *
 * 三种状态都要处理：
 *   - 窗口被隐藏到托盘了（hide）→ show() 出来
 *   - 窗口最小化了 → restore()
 *   - 窗口正常开着但被别的程序盖住 → focus()
 */
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  try {
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
  } catch {
    /* 窗口正在销毁等边缘情况：忽略即可，不该因为聚焦失败而崩 */
  }
})
