import { describe, it, expect } from 'vitest'
import { waitForReady } from '../../src/main/proc/startup-guard'

/**
 * 启动预算：**还在输出的进程不该被当卡死**。
 *
 * 这是用户真实日志暴露的问题：AstrBot 冷启动 33 秒，期间一直正常打印
 * （Python 解释器 → 依赖 → 数据库迁移 → 插件加载），而我们是固定 30 秒
 * 超时，到点就把进程 kill 了。用户看到的是「重置完账密直接卡在启动中」。
 *
 * 所以判据从「等满 N 秒」改成「静默 N 秒」：
 *   - 持续有输出 → 续期（怕慢，不怕等）
 *   - 停止输出 → 收手（真卡住）
 *   - 无论怎样都有个总上限（防刷屏进程永不超时）
 *
 * 测试全部注入 now/sleep，不真的等时间。
 */
describe('启动守卫：静默才算卡死，有输出就续期', () => {
  /** 造一个可手动推进的假时钟 */
  function clock(startAt = 0) {
    let t = startAt
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms
      }
    }
  }

  it('一直有输出 → 过了原来的 30 秒也不判失败，直到端口就绪', async () => {
    const c = clock()
    let lastOut = 0
    let probes = 0
    const r = await waitForReady({
      port: 6100,
      timeoutMs: 30000,
      intervalMs: 1000,
      // 第 40 次探测（40 秒）才通 —— 超过原来的固定超时
      probePort: async () => {
        probes++
        return probes >= 40
      },
      isAlive: () => true,
      lastOutputAt: () => lastOut,
      idleGraceMs: 20000,
      maxTotalMs: 180000,
      now: c.now,
      sleep: async (ms) => {
        c.advance(ms)
        // 每轮都模拟「进程刚打印了一行」→ 持续活跃
        lastOut = c.now()
      }
    })
    expect(r.ok, '持续输出的进程不该被 30 秒超时杀掉').toBe(true)
    expect(r.elapsedMs).toBeGreaterThan(30000)
  })

  it('停止输出 → 静默超过宽限期就判 timeout（真卡住要收手）', async () => {
    const c = clock()
    const r = await waitForReady({
      port: 6100,
      timeoutMs: 30000,
      intervalMs: 1000,
      probePort: async () => false,
      isAlive: () => true,
      // 只在最开始有输出，之后一直沉默
      lastOutputAt: () => 0,
      idleGraceMs: 20000,
      maxTotalMs: 180000,
      now: c.now,
      sleep: async (ms) => c.advance(ms)
    })
    expect(r.ok).toBe(false)
    expect(r.reason, '沉默的进程最终要判超时').toBe('timeout')
  })

  it('输出没停但总时间超过上限 → 也要收手（防刷屏进程永不超时）', async () => {
    const c = clock()
    let lastOut = 0
    const r = await waitForReady({
      port: 6100,
      timeoutMs: 30000,
      intervalMs: 1000,
      probePort: async () => false,
      isAlive: () => true,
      lastOutputAt: () => lastOut,
      idleGraceMs: 20000,
      maxTotalMs: 60000, // 总上限 60 秒
      now: c.now,
      sleep: async (ms) => {
        c.advance(ms)
        lastOut = c.now() // 一直在输出
      }
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('timeout')
    expect(r.elapsedMs, '不能超过总上限太多').toBeLessThanOrEqual(62000)
  })

  it('进程死了要立刻返回 exited，跟输出多少无关', async () => {
    const c = clock()
    let alive = true
    let lastOut = 0
    const r = await waitForReady({
      port: 6100,
      timeoutMs: 30000,
      intervalMs: 1000,
      probePort: async () => false,
      isAlive: () => alive,
      lastOutputAt: () => lastOut,
      idleGraceMs: 20000,
      now: c.now,
      sleep: async (ms) => {
        c.advance(ms)
        lastOut = c.now() // 甚至还在输出
        if (c.now() > 3000) alive = false
      }
    })
    expect(r.ok).toBe(false)
    expect(r.reason, '进程没了就是 exited').toBe('exited')
  })

  it('不传 lastOutputAt → 退化成原来的固定超时（老行为不能被破坏）', async () => {
    const c = clock()
    const r = await waitForReady({
      port: 6100,
      timeoutMs: 30000,
      intervalMs: 1000,
      probePort: async () => false,
      isAlive: () => true,
      now: c.now,
      sleep: async (ms) => c.advance(ms)
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('timeout')
    // 固定超时：就在 30 秒附近收手，不会因为静默参数缺失而无限等
    expect(r.elapsedMs).toBeGreaterThanOrEqual(30000)
    expect(r.elapsedMs).toBeLessThanOrEqual(32000)
  })

  it('端口一开始就通 → 立刻成功（别把正常快启动拖慢）', async () => {
    const c = clock()
    const r = await waitForReady({
      port: 6100,
      timeoutMs: 30000,
      intervalMs: 1000,
      probePort: async () => true,
      isAlive: () => true,
      lastOutputAt: () => 0,
      idleGraceMs: 20000,
      now: c.now,
      sleep: async (ms) => c.advance(ms)
    })
    expect(r.ok).toBe(true)
    expect(r.elapsedMs).toBe(0)
  })

  /**
   * 下面两条复刻用户那次**真实失败**的时序，是这次调超时的依据。
   *
   * 用户日志（2026-09-13）：
   *   19:19:54  AstrBot 打完一串 "Config key missing; added default."
   *   19:19:54 → 19:20:27   ★ 整整 33 秒一个字都没有（在导入 faiss/numpy）
   *   19:20:27  打印 "AstrBot v4.28.0"（说明它一直在正常推进）
   *   启动器在 43282ms 判超时，把进程杀了
   *
   * 结论：30 秒基础预算**短于**一次正常冷启动，必须加长。
   */
  it('复刻用户那次失败：静默 33 秒后继续输出 → 用旧预算(30s)会误杀', async () => {
    const c = clock()
    // 第 8 秒是最后一次输出（用户那次约在第 8 秒打完 Config key）
    let lastOut = 8000
    // 第 45 秒端口才通（用户那次 43 秒被杀时其实快好了）
    const r = await waitForReady({
      port: 6100,
      timeoutMs: 30000, // 旧的 30 秒预算
      intervalMs: 1000,
      probePort: async () => c.now() >= 45000,
      isAlive: () => true,
      lastOutputAt: () => lastOut,
      idleGraceMs: 20000,
      maxTotalMs: 180000,
      now: c.now,
      sleep: async (ms) => {
        c.advance(ms)
        // 静默到第 41 秒（8 + 33）后恢复输出
        if (c.now() >= 41000) lastOut = c.now()
      }
    })
    expect(r.ok, '30 秒预算配 20 秒宽限，兜不住 33 秒静默 —— 这正是用户踩的坑').toBe(false)
    expect(r.reason).toBe('timeout')
  })

  it('同样的时序、用现在的预算(90s 基础 + 60s 宽限) → 能正常起来', async () => {
    const c = clock()
    let lastOut = 8000
    const r = await waitForReady({
      port: 6100,
      timeoutMs: 90000, // 现在的基础预算
      intervalMs: 1000,
      probePort: async () => c.now() >= 45000,
      isAlive: () => true,
      lastOutputAt: () => lastOut,
      idleGraceMs: 60000,
      maxTotalMs: 300000,
      now: c.now,
      sleep: async (ms) => {
        c.advance(ms)
        if (c.now() >= 41000) lastOut = c.now()
      }
    })
    expect(r.ok, '给足预算后，慢但在推进的启动要能成功').toBe(true)
    expect(r.elapsedMs).toBeGreaterThanOrEqual(45000)
  })

  /**
   * 反向验证用：这几条常量必须与 ipc.ts 里真正使用的值一致。
   *
   * 单独测 guard 的算法没用 —— 参数配错了算法再对也白搭
   * （用户那次就是这么栽的：算法支持续期，但基础预算太短，
   * 续期条件从没成立）。所以这里把「实际生效的配置」也钉住。
   */
  it('ipc 里实际用的预算必须够长（钉住真配置，别再退回 30 秒）', async () => {
    // 直接按工作目录找，别用 import.meta.url（这个测试环境下不是 file 协议）
    const src = await import('fs').then((m) => m.readFileSync('src/main/ipc.ts', 'utf8'))
    const grab = (name: string): number => {
      const m = new RegExp(`const ${name} = (\\d+)`).exec(src)
      if (!m) throw new Error(`没找到 ${name}`)
      return Number(m[1])
    }
    expect(grab('START_PORT_WAIT_MS'), '基础预算要长于实测的 33 秒静默').toBeGreaterThan(40000)
    expect(grab('START_IDLE_GRACE_MS'), '静默宽限要能盖住导入重库的那 33 秒').toBeGreaterThan(33000)
    expect(grab('START_MAX_TOTAL_MS')).toBeGreaterThanOrEqual(grab('START_PORT_WAIT_MS'))
  })
})
