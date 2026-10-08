/**
 * 启动流程的守卫：判断实例**真的**进入启动流程了没有。
 *
 * 背景（都是实机踩出来的，不是假想）：
 *
 * 原来只有一句 `waitPort(port, 30s)` —— 端口能连上就算成功。三个漏洞：
 *
 *   1. **端口通 ≠ 我们的实例在跑**。
 *      残留的旧进程、或者别的软件恰好占了同一个端口，照样通过。
 *      用户看到「运行中」，连上去却是别人的服务。所以必须同时满足
 *      「我们 spawn 的进程还活着」**且**「端口通了」。
 *
 *   2. **进程中途死了不该傻等**。
 *      缺依赖、配置写错、被安全软件拦掉时进程几百毫秒就退了，
 *      而我们还在等满 30 秒。用户对着转圈干等，最后只拿到一句
 *      笼统的「端口没起来」，完全不知道程序其实早就崩了。
 *      应该在发现进程没了的那一刻立刻失败，并说清「进程退出了」。
 *
 *   3. **超时要能放弃**。
 *      服务真的卡住（端口被占、初始化死锁）时到点必须收手。
 *
 * 「退出」和「超时」要给出不同的措辞，因为排查方向完全不同：
 *   退出 → 程序自己崩了，去看它输出的最后几行
 *   超时 → 程序还在但没就绪，可能是卡住、端口被占、或初始化很慢
 */

export type StartupFailReason = 'exited' | 'timeout'

export interface StartupResult {
  ok: boolean
  /** 失败原因：进程退出 / 等超时。ok=true 时无意义 */
  reason?: StartupFailReason
  /** 从开始等待到判定结束花掉的毫秒数（界面和日志都用得上） */
  elapsedMs: number
  /** 进程已退出时的退出码（超时时为 undefined） */
  exitCode?: number | null
}

export interface WaitForReadyDeps {
  port: number
  /** 总超时（毫秒）—— 静默时的预算；有输出会放宽，见 idleGraceMs */
  timeoutMs: number
  /** 轮询间隔（毫秒） */
  intervalMs: number
  /** 探一次端口是否可连 */
  probePort: () => Promise<boolean>
  /** 我们 spawn 的那个进程还活着吗 */
  isAlive: () => boolean
  /** 进程退出码（还没退出返回 undefined） */
  exitCode?: () => number | null | undefined
  /**
   * 子进程最后一次输出的时刻。
   *
   * 有了它才能区分「慢但在推进」和「真的卡死」：
   * AstrBot 冷启动实测 20~35 秒（Python 起解释器 + 加载依赖 + 数据库迁移
   * + 插件加载），期间**一直在正常打印日志**。原来的固定 30 秒超时会把
   * 这种正常启动杀掉 —— 用户日志里就有「33 秒时打印 AstrBot v4.28.0，
   * 而我们 30 秒判超时」的实例。
   *
   * 不传则退化成纯固定超时（老行为）。
   */
  lastOutputAt?: () => number
  /**
   * 只要进程在「这么久之内」还有输出，就认为它在推进，把超时往后延。
   * 真正的死锁/卡住会**停止输出**，于是静默超过这个时间就收手。
   */
  idleGraceMs?: number
  /** 有输出时最多把总预算延到多久（防止一个疯狂打日志的进程永不超时） */
  maxTotalMs?: number
  /** 当前时间（测试注入） */
  now?: () => number
  /** 睡眠（测试注入，避免真的等） */
  sleep?: (ms: number) => Promise<void>
}

/**
 * 轮询直到「进程活着 + 端口通」，或判定失败。
 *
 * 与单纯的 waitPort 的区别：
 *   - 每轮先检查进程是否还活着，死了就立刻返回 exited
 *   - 返回结构化的结果（原因 + 耗时 + 退出码），而不只是一个布尔
 *   - 还在持续输出的进程会被放宽预算（怕慢，不怕等）
 */
export async function waitForReady(deps: WaitForReadyDeps): Promise<StartupResult> {
  const now = deps.now ?? (() => Date.now())
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const start = now()
  let deadline = start + deps.timeoutMs

  /*
   * 有输出就续期：把 deadline 推到「最后一次输出 + 静默宽限」。
   * 只在真的见到过输出时才延，且总时长封顶 maxTotalMs，
   * 免得一个刷屏的坏进程把启动永远挂着。
   */
  const idleGrace = deps.idleGraceMs ?? 0
  const hardCap = start + (deps.maxTotalMs ?? deps.timeoutMs)
  const extendIfActive = (): void => {
    if (!deps.lastOutputAt || idleGrace <= 0) return
    const last = deps.lastOutputAt()
    if (!last || last <= start) return
    /*
     * 有输出就把截止时间推到「最后一次输出 + 静默宽限」（封顶 hardCap）。
     *
     * 这段逻辑本身是对的，但**只有在基础预算够长时才有意义**：
     * 用户那次实测，最后一次输出在第 8 秒、当时的静默宽限 20 秒，
     * 于是 want = 第 28 秒，而基础预算 deadline = 第 30 秒 ——
     * want 从没超过 deadline，这条规则一次都没触发过。
     *
     * 真正的病根是基础预算（timeoutMs）太短，不是这里算错了。
     * 调用方已经把基础预算从 30 秒提到 90 秒（见 ipc.ts 的
     * START_PORT_WAIT_MS），那之后这段续期才真正兜得住
     * 「启动尾段还在慢慢输出」的慢启动。
     */
    const want = Math.min(last + idleGrace, hardCap)
    if (want > deadline) deadline = want
  }

  while (now() < deadline) {
    /*
     * 顺序很重要：**先看进程活着没**。
     * 反过来的话，进程刚死、端口还由旧进程占着，会先探到端口通而误判成功。
     */
    if (!deps.isAlive()) {
      return {
        ok: false,
        reason: 'exited',
        elapsedMs: now() - start,
        exitCode: deps.exitCode?.() ?? undefined
      }
    }

    if (await deps.probePort()) {
      /*
       * 端口通了还要再确认一次进程活着 —— 探测本身是有耗时的，
       * 这期间进程可能刚好退出（比如「起来了、一秒钟后崩了」这种）。
       * 这一步能把"假成功"挡住。
       */
      if (!deps.isAlive()) {
        return {
          ok: false,
          reason: 'exited',
          elapsedMs: now() - start,
          exitCode: deps.exitCode?.() ?? undefined
        }
      }
      return { ok: true, elapsedMs: now() - start }
    }

    // 还没就绪：看看它是不是还在说话，是就再给点时间
    extendIfActive()

    if (now() >= deadline) break
    await sleep(deps.intervalMs)
  }

  // 到点了还没就绪。收尾再确认一次进程状态，让原因尽量准确。
  if (!deps.isAlive()) {
    return {
      ok: false,
      reason: 'exited',
      elapsedMs: now() - start,
      exitCode: deps.exitCode?.() ?? undefined
    }
  }
  return { ok: false, reason: 'timeout', elapsedMs: now() - start }
}

/**
 * 把失败结果变成给用户看的一句话。
 *
 * 分开措辞不是啰嗦 —— 用户看到"进程退出了"会去翻日志（程序自己崩了），
 * 看到"等了很久没起来"会去查端口/配置（程序还在但卡住）。
 * 这两种情况的下一步动作完全不同。
 */
export function startupFailMessage(r: StartupResult, port: number): string {
  if (r.reason === 'exited') {
    const code = r.exitCode === undefined || r.exitCode === null ? '未知' : String(r.exitCode)
    return `进程启动后立刻退出了（退出码 ${code}），端口 ${port} 没能提供服务`
  }
  return `等了 ${Math.round(r.elapsedMs / 1000)} 秒，端口 ${port} 也没起来——服务没能正常启动`
}
