import { describe, expect, it, vi } from 'vitest'
import { waitForReady } from '../../src/main/proc/startup-guard'

/**
 * 启动流程的保护 —— 用户的诉求是「实例需要验证是否真的进入启动流程以及启动超时保护」。
 *
 * 这三个问题都是真的，不是假想：
 *
 *   1. **只验端口不算数**。原来就一句 waitPort：端口能连上就判成功。
 *      但残留的旧进程、或者别的软件恰好占了同一个端口，照样通过 ——
 *      用户看到「运行中」，实际连上去的是别人的服务。
 *      所以必须「进程活着 **且** 端口通」才算进入启动流程。
 *
 *   2. **进程中途死了不该傻等**。缺依赖、配置错、被安全软件拦掉时，
 *      进程几百毫秒就退了，而我们还在等满 30 秒。用户对着转圈干等，
 *      最后只拿到一句笼统的「端口没起来」。应该在发现进程没了的那一刻
 *      立刻失败，并明确说「进程退出了（退出码 N）」。
 *
 *   3. **超时保护**。服务真的卡住（比如端口被占、初始化死锁）时，
 *      到点必须放弃，不能无限等。超时和退出要给出不同的措辞：
 *      前者是"还在但没就绪"，后者是"程序自己没了"，排查方向完全不同。
 */
describe('waitForReady：进入启动流程的判定', () => {
  /** 造一个可控的假环境：手工推进时间，手工控制进程存活与端口状态 */
  function harness(opts: {
    /** 第几次探测时端口变通（从 1 开始数） */
    portOkAt?: number
    /** 第几次探测时进程死掉 */
    diesAt?: number
    intervalMs?: number
  }) {
    const interval = opts.intervalMs ?? 100
    let tick = 0
    let now = 0
    const probePort = vi.fn(async () => {
      tick++
      return opts.portOkAt !== undefined && tick >= opts.portOkAt
    })
    const isAlive = vi.fn(() => !(opts.diesAt !== undefined && tick >= opts.diesAt))
    return {
      probePort,
      isAlive,
      now: () => now,
      sleep: async (ms: number) => {
        now += ms
      },
      intervalMs: interval,
      ticks: () => tick
    }
  }

  it('进程活着 + 端口通 → 判定成功', async () => {
    const h = harness({ portOkAt: 2 })
    const r = await waitForReady({
      port: 6102,
      timeoutMs: 30000,
      intervalMs: h.intervalMs,
      probePort: h.probePort,
      isAlive: h.isAlive,
      now: h.now,
      sleep: h.sleep
    })
    expect(r.ok).toBe(true)
    expect(r.elapsedMs).toBeLessThan(30000)
  })

  it('端口通但进程已经没了 → 失败（连上的不是我们的实例）', async () => {
    /*
     * 最关键的一条：光看端口会把「旧进程残留占着端口」误判成启动成功。
     * 这里让端口一直通，但我们的进程**从头就不在** ——
     * 那说明连上的是别人的服务，必须判失败。
     */
    const r = await waitForReady({
      port: 6102,
      timeoutMs: 30000,
      intervalMs: 100,
      probePort: async () => true, // 端口一直通
      isAlive: () => false, // 但我们的进程不在了
      now: () => 0,
      sleep: async () => undefined
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('exited')
  })

  it('探端口期间进程刚好退出 → 不算成功（挡住"起来一秒就崩"）', async () => {
    /*
     * 探测本身是有耗时的，这段时间里进程可能刚好退出
     * （典型：服务监听成功、打印完欢迎语、然后因为配置错崩掉）。
     * 只在探测前查一次存活是不够的，探测后要再确认一次。
     */
    let alive = true
    const r = await waitForReady({
      port: 6102,
      timeoutMs: 30000,
      intervalMs: 100,
      probePort: async () => {
        alive = false // 就在探测的这一刻进程死了
        return true // 而且端口是通的
      },
      isAlive: () => alive,
      now: () => 0,
      sleep: async () => undefined
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('exited')
  })

  it('进程中途死掉 → 立刻失败，不傻等满超时', async () => {
    const h = harness({ diesAt: 2, intervalMs: 100 })
    const r = await waitForReady({
      port: 6102,
      timeoutMs: 30000,
      intervalMs: h.intervalMs,
      probePort: h.probePort,
      isAlive: h.isAlive,
      now: h.now,
      sleep: h.sleep
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('exited')
    // 关键：远小于 30 秒就放弃了
    expect(r.elapsedMs).toBeLessThan(2000)
    // 而且不该白探很多次
    expect(h.ticks()).toBeLessThan(5)
  })

  it('进程一直活着但端口始终不通 → 到点超时放弃', async () => {
    const h = harness({ intervalMs: 100 })
    const r = await waitForReady({
      port: 6102,
      timeoutMs: 1000,
      intervalMs: h.intervalMs,
      probePort: h.probePort,
      isAlive: h.isAlive,
      now: h.now,
      sleep: h.sleep
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('timeout')
    expect(r.elapsedMs).toBeGreaterThanOrEqual(1000)
  })

  it('已退出时带上退出码，超时不带（两者排查方向不同）', async () => {
    const exited = await waitForReady({
      port: 6102,
      timeoutMs: 30000,
      intervalMs: 100,
      probePort: async () => false,
      isAlive: () => false,
      now: () => 0,
      sleep: async () => undefined,
      exitCode: () => 1
    })
    expect(exited.ok).toBe(false)
    expect(exited.reason).toBe('exited')
    expect(exited.exitCode).toBe(1)

    const timedOut = await waitForReady({
      port: 6102,
      timeoutMs: 200,
      intervalMs: 100,
      probePort: async () => false,
      isAlive: () => true,
      now: (() => {
        let t = 0
        return () => (t += 100)
      })(),
      sleep: async () => undefined
    })
    expect(timedOut.reason).toBe('timeout')
    expect(timedOut.exitCode).toBeUndefined()
  })
})
