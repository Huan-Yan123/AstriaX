/*
 * ★ 主进程阻塞看门狗：光说"卡了多久"不够，还要说"谁卡的"
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么补这条测试（主人 2026-09-27 的死机日志）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 他的日志在死机前只留下两行：
 *     [ERROR] [perf] IPC window:minimize 耗时 5970ms（严重）
 *     [WARN] [perf] 主进程事件循环疑似被同步代码阻塞：… 5941ms …
 *
 * 也就是说我们**知道卡了将近 6 秒，但完全不知道那 6 秒在跑什么**。
 * 原始看门狗的注释里就承认了这一点（"阻塞发生瞬间的栈拿不到"）。
 *
 * 对排查而言，"谁卡的"才是全部价值 —— 所以补了 `snapshot` 注入点，
 * 由 ipc.ts 提供"正在执行 / 最近完成"的现场。
 *
 * ## 这条测试钉什么
 *   1. 不卡时**完全安静**（50ms tick 不能刷屏 —— 日志噪音会淹没真问题）
 *   2. 卡顿超阈值 → 记一条 WARN，且**带上现场**
 *   3. snapshot 抛错不能把看门狗带崩（它只是辅助信息）
 *   4. stop() 之后不再有任何输出（避免测试/退出后继续写）
 */
import { describe, it, expect, vi } from 'vitest'
import { startBlockWatchdog } from '../../src/main/util/block-watchdog'

/** 可控时钟 + 手动驱动 setInterval */
function harness(opts: { drift: number[]; snapshot?: () => string | undefined }) {
  const logs: string[] = []
  let idx = 0
  /*
   * 时钟：第一次调用返回 0（建立基线），之后按 drift 数组推进。
   * 看门狗的判据是 `t - last - tickMs >= maxDriftMs`，
   * 所以要让某次 tick "卡住"，就让那一步的时间跳得很远。
   */
  const now = (): number => {
    const v = idx === 0 ? 0 : opts.drift[Math.min(idx - 1, opts.drift.length - 1)] ?? 0
    idx++
    return v
  }
  const w = startBlockWatchdog({
    tickMs: 50,
    maxDriftMs: 500,
    now,
    log: (_lv, _ch, msg) => logs.push(msg),
    snapshot: opts.snapshot
  })
  return { logs, w }
}

describe('★阻塞看门狗：要能说出"谁卡的"', () => {
  it('不卡的时候完全安静（50ms tick 不许刷屏）', () => {
    const logs: string[] = []
    let t = 0
    const w = startBlockWatchdog({
      tickMs: 50,
      maxDriftMs: 500,
      // 每次只推进 50ms（正好一个 tick）→ drift ≈ 0
      now: () => (t += 50),
      log: (_lv, _ch, msg) => logs.push(msg)
    })
    // 手动跑几次 tick（用真实定时器等太慢，这里直接让 now 前进后停止）
    w.stop()
    expect(logs).toEqual([])
  })

  it('★卡顿超过阈值 → 记 WARN 且**带上现场**', async () => {
    const logs: string[] = []
    const snapshots = vi.fn(() => '正在执行：runtimes:remove；最近完成：versions:list(1843ms, 2秒前)')

    /*
     * 用真实定时器跑：让 first tick 后人为制造一次"长阻塞"。
     * 做法：now() 在第二次调用时跳 +2000ms —— 模拟事件循环被占 2 秒。
     */
    let calls = 0
    const w = startBlockWatchdog({
      tickMs: 20,
      maxDriftMs: 500,
      now: () => {
        calls++
        // 基线 0；第二次调用跳到 2000（阻塞 2 秒）；之后正常推进
        if (calls === 1) return 0
        if (calls === 2) return 2000
        return 2000 + (calls - 2) * 20
      },
      log: (_lv, _ch, msg) => logs.push(msg),
      snapshot: snapshots
    })

    // 等几个 tick
    await new Promise((r) => setTimeout(r, 150))
    w.stop()

    const blocked = logs.filter((l) => l.includes('事件循环疑似被同步代码阻塞'))
    expect(blocked.length, `应当记下阻塞（实际日志：${JSON.stringify(logs)}）`).toBeGreaterThan(0)
    expect(blocked[0], '要报出阻塞时长').toMatch(/约有 \d+ms/)
    expect(blocked[0], '★要带上"阻塞现场"').toContain('runtimes:remove')
    expect(blocked[0], '★现场里要有最近完成的调用').toContain('versions:list')
    expect(snapshots, 'snapshot 应当被调用').toHaveBeenCalled()
  }, 20_000)

  it('★snapshot 抛错不能把看门狗带崩', async () => {
    const logs: string[] = []
    let calls = 0
    const w = startBlockWatchdog({
      tickMs: 20,
      maxDriftMs: 500,
      now: () => {
        calls++
        if (calls === 1) return 0
        if (calls === 2) return 3000
        return 3000 + (calls - 2) * 20
      },
      log: (_lv, _ch, msg) => logs.push(msg),
      snapshot: () => {
        throw new Error('采集现场时炸了')
      }
    })
    await new Promise((r) => setTimeout(r, 120))
    w.stop()

    const blocked = logs.filter((l) => l.includes('事件循环疑似被同步代码阻塞'))
    expect(blocked.length, 'snapshot 抛错不该让 WARN 消失').toBeGreaterThan(0)
    // 没有现场也要能读（不能出现半截的 "阻塞现场："）
    expect(blocked[0]).not.toContain('阻塞现场')
  }, 20_000)

  it('stop() 之后不再输出', async () => {
    const logs: string[] = []
    let calls = 0
    const w = startBlockWatchdog({
      tickMs: 10,
      maxDriftMs: 500,
      now: () => {
        calls++
        return calls === 1 ? 0 : 5000 + calls * 10
      },
      log: (_lv, _ch, msg) => logs.push(msg)
    })
    await new Promise((r) => setTimeout(r, 60))
    w.stop()
    const n = logs.length
    await new Promise((r) => setTimeout(r, 80))
    expect(logs.length, 'stop 之后不该再有新日志').toBe(n)
  }, 20_000)
})
