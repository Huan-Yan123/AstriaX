/*
 * 启动健康看门狗 —— 软件**起不来时主动介入**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么需要它（主人 2026-09-26 的要求）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人原话：「如果软件无法正常启动或者多次崩溃，日志系统应该主动介入，
 * 收集信息，即使软件无法正常使用，遇到这种无法正常启动/多次崩溃，
 * 也应该主动弹出窗口让用户导出日志」。
 *
 * 这个需求戳中了一个**真实发生过的死角**：0.1.4 那次"装完启动不了、
 * 进程在但界面不出现"，就是启动阶段抛异常 → 窗口根本没建 →
 * 用户什么都看不到，也**没有任何入口**能导出日志（导出按钮在界面里，
 * 而界面压根没起来）。用户只能说"它坏了"，我们只能靠猜。
 *
 * ## ★ 两条路径、两个阈值（主人 2026-09-26 明确指定）
 *
 * 主人原话：「**起不来，一次就弹；起来了但崩溃，三次弹**」。
 * 这个区分是有道理的，因为两种情况对用户的意义完全不同：
 *
 *   ┌────────────────┬──────┬──────────────────────────────────────────┐
 *   │ 情况           │ 阈值 │ 为什么                                     │
 *   ├────────────────┼──────┼──────────────────────────────────────────┤
 *   │ 起不来         │  1   │ 用户**完全没办法用**，也没有任何自助入口   │
 *   │ （窗口没建）   │      │ （导出按钮在界面里，界面没起来）→ 立刻介入 │
 *   ├────────────────┼──────┼──────────────────────────────────────────┤
 *   │ 起来了但崩溃   │  3   │ 界面能开、能重试、能自己导出日志；         │
 *   │ （有窗口）     │      │ 偶发一次就弹框是打扰 → 连崩 3 次才介入     │
 *   └────────────────┴──────┴──────────────────────────────────────────┘
 *
 * 所以本模块把两者**分开计数、分开判断**，不要混成一个计数器。
 *
 * ## 设计：**先记一笔"我要启动了"，成功进入主界面才算数**
 *
 *   启动时   → beginBoot()      ：bootAttempts+1（窗口建之前调用）
 *   窗口建好 → markWindowReady()：bootOk=true → 连挂计数清零
 *   正常运行 → markBootOk()     ：连崩计数也清零（说明这次真的稳了）
 *   崩溃     → noteCrash()      ：crashAttempts+1
 *   失败退出 → 什么都不用做     ：下次启动读到计数已经涨上去了
 *
 * 为什么用"次数"而不是"时间窗"：用户遇到起不来时，通常是**反复双击**
 * （这也是他们唯一的反应）。连击计数天然对应"他试了几次都不行"，
 * 不依赖时钟，也不会因为"隔了一天再试"而丢掉信号。
 *
 * ## 降噪：同一轮连击只弹一次
 *
 * 弹过之后写对应的 `bootNotified` / `crashNotified`，**同一轮只弹一次** ——
 * 否则用户每双击一次就被弹一次框，那是骚扰而不是帮助。
 * 成功启动后整份状态清零，下次出问题还能再弹。
 */
import { existsSync, writeFileSync } from 'fs'
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
/* 联系方式：原生错误框也要带（主人 2026-09-27 指出的遗漏） */
import { FEEDBACK_LINES } from '../feedback'
// 读 JSON 必须走它：项目约定 + 它处理 BOM（AstrBot 写的文件就带 BOM）
import { readJsonFile } from '../util/json-file'

/** 起不来几次开始介入 —— **主人指定：1 次就弹**（用户完全没法用，没有自助入口） */
export const BOOT_FAIL_ALERT_THRESHOLD = 1

/** 起来了但崩溃几次开始介入 —— **主人指定：3 次才弹**（能重试、能自己导出日志） */
export const CRASH_ALERT_THRESHOLD = 3

export interface BootWatchState {
  /** 连续"连窗口都没建起来"的次数（成功建出窗口后清零） */
  bootAttempts: number
  /** 连续崩溃次数（实例已建窗口、运行中崩了）—— 成功稳定运行后清零 */
  crashAttempts: number
  /** 这一轮"起不来"是否已经弹过窗 */
  bootNotified: boolean
  /** 这一轮"连崩"是否已经弹过窗 */
  crashNotified: boolean
  /** 最近一次启动尝试的时间（ISO） */
  lastAttemptAt?: string
  /** 最近一次"进入主界面"的时间（ISO）—— 用来算"上次正常是什么时候" */
  lastOkAt?: string
  /** 最近一次失败/崩溃时记录的原因（尽力而为，可能为空） */
  lastReason?: string
}

const FILE = 'boot-attempts.json'

function stateFile(dataRoot: string): string {
  return join(dataRoot, FILE)
}

/** 读启动健康状态（读不出来就当全新，绝不抛） */
export function readBootState(dataRoot: string): BootWatchState {
  const f = stateFile(dataRoot)
  try {
    if (!existsSync(f)) return { bootAttempts: 0, crashAttempts: 0, bootNotified: false, crashNotified: false }
    /*
     * 走 readJsonFile（项目统一入口）而不是裸 JSON.parse —— 它会处理 BOM，
     * 而 project 的守卫测试专门拦"裸 JSON.parse(readFileSync(...))"。
     */
    const raw = readJsonFile<Partial<BootWatchState> & {
      // 兼容第一版的字段名（attempts / notified / lastFailReason）
      attempts?: number
      notified?: boolean
      lastFailReason?: string
    }>(f)
    const num = (v: unknown): number => (typeof v === 'number' && v >= 0 ? v : 0)
    return {
      bootAttempts: num(raw.bootAttempts ?? raw.attempts),
      crashAttempts: num(raw.crashAttempts),
      bootNotified: raw.bootNotified === true || raw.notified === true,
      crashNotified: raw.crashNotified === true,
      lastAttemptAt: typeof raw.lastAttemptAt === 'string' ? raw.lastAttemptAt : undefined,
      lastOkAt: typeof raw.lastOkAt === 'string' ? raw.lastOkAt : undefined,
      lastReason:
        typeof raw.lastReason === 'string'
          ? raw.lastReason
          : typeof raw.lastFailReason === 'string'
            ? raw.lastFailReason
            : undefined
    }
  } catch {
    /*
     * 读不出来就当"全新" —— 这个文件只用于"要不要提醒用户"，
     * 它坏了不该影响启动，也不该让用户看到报错。
     */
    return { bootAttempts: 0, crashAttempts: 0, bootNotified: false, crashNotified: false }
  }
}

function writeBootState(dataRoot: string, st: BootWatchState): void {
  const f = stateFile(dataRoot)
  try {
    mkdirSync(dirname(f), { recursive: true })
    writeFileSync(f, JSON.stringify(st, null, 2), 'utf8')
  } catch {
    /* 写不进去也不影响启动：顶多下次不提醒 */
  }
}

/**
 * 启动开始：记一笔"这次启动还没到窗口那一步"。
 *
 * **必须在窗口创建之前调用** —— 我们要捕捉的正是"窗口创建之前就挂了"
 * 那种情况，晚了就漏掉了最需要它的一类失败。
 */
export function beginBoot(dataRoot: string, now = new Date()): BootWatchState {
  const st = readBootState(dataRoot)
  const next: BootWatchState = {
    ...st,
    bootAttempts: st.bootAttempts + 1,
    lastAttemptAt: now.toISOString()
  }
  writeBootState(dataRoot, next)
  return next
}

/**
 * 窗口已经建出来了：**"起不来"这条线终止**（连挂计数清零）。
 *
 * 注意这**不等于**"启动完全成功"（主界面可能还在加载），
 * 但对本模块的目的是够的：窗口建出来意味着用户**有了界面**，
 * 也就能自己点"导出日志"。从那之后出问题属于"起来了但崩溃"那条线。
 */
export function markWindowReady(dataRoot: string): void {
  const st = readBootState(dataRoot)
  writeBootState(dataRoot, { ...st, bootAttempts: 0, bootNotified: false })
}

/**
 * 本次运行"算稳定"的最短时长。
 *
 * 为什么需要这个阈值（复审抓出的真实缺陷）：
 * 原来 `will-quit` 里**无条件**调 `markBootOk` 清零 `crashAttempts`。于是：
 *   用户遇到"窗口建出来、还没用就崩"的场景（托盘/渲染初始化失败很常见），
 *   每轮崩溃 +1，但只要**有一次正常退出**（哪怕只活了几秒）就把计数清 0 →
 *   「连崩 3 次弹窗」**永远不会触发**，主人指定的功能形同死代码。
 * 实测（复审模拟）：2 次崩溃 + 1 次正常退出 → crashAttempts = 0。
 *
 * 现在：只有"从开始启动到正常退出"超过这个时长，才认为这次是真的稳，
 * 才清连崩计数。几秒钟就退出的，当作没成功过。
 */
const STABLE_RUN_MS = 60_000

/**
 * 真正稳定运行了：连崩计数也清零（下次出问题还能再提醒）。
 *
 * **不是无条件清零** —— 见 STABLE_RUN_MS 的说明。
 * 判断依据是 `lastAttemptAt`（beginBoot 写的本次启动时刻）到现在的间隔。
 *
 * 返回是否真的清了（便于测试与日志）。
 */
export function markBootOk(dataRoot: string, now = new Date()): boolean {
  const st = readBootState(dataRoot)
  /*
   * 本次运行了多久？读不到 lastAttemptAt 时**保守地当作"够久"**：
   * 那种情况说明状态文件异常，此时清零不会更糟（总比永远不清、让用户
   * 反复看到"连续崩溃"强），而状态文件正常的路径是靠时长判断。
   */
  const startedAt = st.lastAttemptAt ? Date.parse(st.lastAttemptAt) : NaN
  const ranMs = Number.isFinite(startedAt) ? now.getTime() - startedAt : Number.POSITIVE_INFINITY
  if (ranMs < STABLE_RUN_MS) {
    /*
     * 活得太短 —— 不算"稳定运行"，**保留 crashAttempts**。
     * 但要清 bootAttempts（窗口确实建出来了，"起不来"这条线确实结束了）。
     */
    writeBootState(dataRoot, {
      ...st,
      bootAttempts: 0,
      bootNotified: false,
      lastOkAt: now.toISOString()
    })
    return false
  }
  writeBootState(dataRoot, {
    ...st,
    bootAttempts: 0,
    crashAttempts: 0,
    bootNotified: false,
    crashNotified: false,
    lastOkAt: now.toISOString()
  })
  return true
}

/**
 * 运行期崩溃一次（有窗口的情况下）：连崩计数 +1。
 *
 * 与"起不来"分开计数：用户能重试、能自己导出日志，
 * 所以按主人指定的**3 次**才介入。
 */
export function noteCrash(dataRoot: string, reason: string, now = new Date()): BootWatchState {
  const st = readBootState(dataRoot)
  const next: BootWatchState = { ...st, crashAttempts: st.crashAttempts + 1, lastReason: String(reason).slice(0, 600) }
  void now
  writeBootState(dataRoot, next)
  return next
}

/**
 * 启动期失败时补记原因（窗口没建起来那条线）。
 *
 * 这样下次那个"主动弹窗"里能直接写出**上次为什么失败**，
 * 而不是只说"你上次没启动起来" —— 后者对用户毫无帮助。
 */
export function noteBootFailure(dataRoot: string, reason: string): void {
  const st = readBootState(dataRoot)
  writeBootState(dataRoot, { ...st, lastReason: String(reason).slice(0, 600) })
}

/** "起不来"是否需要主动介入（≥1 次，且这一轮还没提醒过） */
export function shouldAlertBootFailure(st: BootWatchState): boolean {
  return st.bootAttempts >= BOOT_FAIL_ALERT_THRESHOLD && !st.bootNotified
}

/** "连崩"是否需要主动介入（≥3 次，且这一轮还没提醒过） */
export function shouldAlertCrash(st: BootWatchState): boolean {
  return st.crashAttempts >= CRASH_ALERT_THRESHOLD && !st.crashNotified
}

/** 标记"这一轮的起不来已经提醒过"，避免反复骚扰 */
export function markBootAlerted(dataRoot: string): void {
  const st = readBootState(dataRoot)
  writeBootState(dataRoot, { ...st, bootNotified: true })
}

/** 标记"这一轮的连崩已经提醒过" */
export function markCrashAlerted(dataRoot: string): void {
  const st = readBootState(dataRoot)
  writeBootState(dataRoot, { ...st, crashNotified: true })
}

/**
 * 组一段给用户看的说明（含"上次失败原因"与日志位置）。
 *
 * 单独抽出来是为了**可测**：这段话是用户唯一能看到的线索，
 * 不能靠临时拼字符串。
 */
export function buildBootFailureMessage(deps: {
  state: BootWatchState
  dataRoot: string
  logsExportDir?: string
  appName?: string
  /** 'boot' = 起不来（1 次） / 'crash' = 连崩（3 次）—— 影响措辞 */
  kind?: 'boot' | 'crash'
}): string {
  const appName = deps.appName ?? 'AstriaX'
  const kind = deps.kind ?? 'boot'
  const lines: string[] = []

  if (kind === 'boot') {
    lines.push(
      `${appName} 没能正常打开（连续 ${deps.state.bootAttempts} 次都没成功）。`
    )
    lines.push('', '我已经把诊断信息自动收集好了 —— 你把日志发给我，就能定位问题。')
  } else {
    lines.push(
      `${appName} 连续崩溃了 ${deps.state.crashAttempts} 次。`
    )
    lines.push('', '崩溃现场我已经自动收集好了 —— 你把日志发给我，就能定位问题。')
  }

  if (deps.state.lastReason) {
    lines.push('', `${kind === 'boot' ? '上次没能打开的原因' : '最近一次崩溃'}：${deps.state.lastReason}`)
  }
  if (deps.state.lastOkAt) {
    lines.push('', `上次正常运行是：${deps.state.lastOkAt}`)
  }
  lines.push(
    '',
    `日志位置：${deps.logsExportDir ?? join(deps.dataRoot, 'logs-export')}`,
    `（原始日志：${join(deps.dataRoot, 'logs')}）`,
    '',
    '把整个日志压缩包发出去，比描述现象快得多。',
    /*
     * ★ 联系方式（主人 2026-09-27 指出：原生错误框漏了）
     *
     * 「没能正常打开」和「连续崩溃」这两个框是原生 `dialog.showErrorBox`，
     * 而之前联系方式只加在自研弹窗和设置页里 —— 恰恰漏了最需要它的地方。
     */
    FEEDBACK_LINES
  )
  return lines.join('\n')
}
