/*
 * ★ 主进程事件循环阻塞监视（指导书 0.1.3 自检 1 的产品化）
 *
 * ## 为什么必须有它（主人的原话：整个界面卡飞了，主进程 UI 永远在阻塞）
 *
 * Electron 里渲染进程"卡"有两种成因：渲染进程长任务，或**主进程事件
 * 循环被同步代码占死**。后者最隐蔽：主进程卡住时，渲染层所有
 * invoke 都在排队，但 DevTools 里看到的只是"网络挂起"，很难归因。
 * 用户感知的顺序永远是： squares 界面卡 → 想知道卡在哪 → 没有任何日志。
 *
 * 这个监视器做的事：
 *   每 50ms 醒一次。若两次醒来之间实际过了 >maxDriftMs，
 *   说明事件循环在那段窗口里被某段同步代码占住了 —— 立刻记 WARN，
 *   并带上**当时的调用栈**（阻塞发生瞬间的栈不拿不到，去抖窗口结束
 *   时抓栈 ≈ 阻塞代码已经返回、栈已回退 —— 所以这里记录的是
 *   *发生*与*发现*的时间差 + 发生窗口，用于跟 IPC 延迟埋点互相对账）。
 *
 *
 *   数值：每 50ms tick 一次，窗口内漂移 ≥500ms 记 WARN。
 *   若将来要在发布版里静音，把阈值调到 >1000ms 即可，结构不动。
 */

export interface BlockWatchdog {
  stop: () => void
}

/** 与项目其余日志同一签名的窄接口（避免依赖具体 logger 实现） */
export type WatchdogLog = (level: 'INFO' | 'WARN' | 'ERROR', channel: string, msg: string) => void

export function startBlockWatchdog(opts: {
  /** 检查间隔（指导书原值 50ms） */
  tickMs?: number
  /** 多久算"卡住"（指导书原值 500ms） */
  maxDriftMs?: number
  /** 注入主进程真实 logger（保持全局日志口径一致；不传则打到 stdout，供测试用） */
  log?: WatchdogLog
  /** 只用于测试注入时钟 */
  now?: () => number
  /**
   * 抓"阻塞期间在跑什么"。
   *
   * ★ 这个回调是主人 2026-09-27 的诊断包逼出来的。
   *
   * 他的日志里只有：
   *     [ERROR] [perf] IPC window:minimize 耗时 5970ms（严重）
   *     [WARN] [perf] 主进程事件循环疑似被同步代码阻塞：… 5941ms …
   * 然后**电脑死机了**。也就是说我们**知道卡了 6 秒，但完全不知道是谁卡的** ——
   * 原始看门狗的注释里就坦白了这一点（"阻塞发生瞬间的栈拿不到"）。
   *
   * 但对排查来说，"谁卡的"才是全部价值。所以这里提供一个注入点：
   * 由调用方在**检测到阻塞的那一刻**去采集现场（比如读最近完成/进行中的
   * IPC 名、同步审计的最近记录）。采集本身必须是**廉价且不阻塞**的
   *（此刻事件循环刚恢复，再塞一个重活儿就本末倒置了）。
   */
  snapshot?: () => string | undefined
} = {}): BlockWatchdog {
  const tickMs = opts.tickMs ?? 50
  const maxDriftMs = opts.maxDriftMs ?? 500
  const now = opts.now ?? Date.now
  const log: WatchdogLog =
    opts.log ?? ((lv, ch, msg) => console.log(`[${ch}] ${lv}: ${msg}`))

  let last = now()
  const timer = setInterval(() => {
    const t = now()
    const drift = t - last - tickMs
    last = t
    if (drift >= maxDriftMs) {
      /*
       * 采集现场（可能拿不到 —— 那就只有一个空串，日志照旧要写）。
       * 用 try/catch 包住：采集失败绝不能把看门狗自己带崩。
       */
      let scene = ''
      try {
        scene = opts.snapshot?.() ?? ''
      } catch {
        scene = ''
      }
      log(
        'WARN',
        'perf',
        `主进程事件循环疑似被同步代码阻塞：窗口内约有 ${drift}ms 不在此定时器上`
          + `（tick=${tickMs}ms，阈值=${maxDriftMs}ms）。`
          + `排查入口：同时间点的 IPC 延迟日志（perf: ipc）。`
          + (scene ? `\n阻塞现场：${scene}` : '')
      )
    }
  }, tickMs)
  timer.unref?.()

  return { stop: () => clearInterval(timer) }
}
