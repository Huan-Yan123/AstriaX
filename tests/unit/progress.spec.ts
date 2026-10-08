import { describe, it, expect } from 'vitest'
import { createProgressTracker } from '../../src/main/update/progress'

describe('下载进度与速度', () => {
  it('按已收/总量给出百分比', () => {
    const p = createProgressTracker({ now: () => 0 })
    const s = p.update('a', 'v4.28.0', 250, 1000)
    expect(s.percent).toBe(25)
    expect(s.got).toBe(250)
    expect(s.total).toBe(1000)
  })

  it('速度按时间差计算（字节/秒）', () => {
    let t = 0
    const p = createProgressTracker({ now: () => t })
    p.update('a', 'v4.28.0', 0, 1000)
    t = 1000 // 过 1 秒
    const s = p.update('a', 'v4.28.0', 2_000_000, 10_000_000)
    expect(s.bytesPerSec).toBeGreaterThan(1_000_000)
  })

  it('总量未知时 percent 为 null，仍给已收与速度', () => {
    let t = 0
    const p = createProgressTracker({ now: () => t })
    p.update('n', 'v4.18.19', 0)
    t = 500
    const s = p.update('n', 'v4.18.19', 5_000_000)
    expect(s.percent).toBeNull()
    expect(s.got).toBe(5_000_000)
    expect(s.bytesPerSec).toBeGreaterThan(0)
  })

  it('速度做平滑：不会因一次抖动暴涨', () => {
    let t = 0
    const p = createProgressTracker({ now: () => t, smooth: 0.5 })
    p.update('a', 'v4.28.0', 0, 100_000_000)
    t = 1000
    p.update('a', 'v4.28.0', 1_000_000, 100_000_000) // 1 MB/s
    t = 2000
    const s = p.update('a', 'v4.28.0', 10_000_000, 100_000_000) // 这一秒 9MB/s
    // 平滑后应显著低于瞬时 9MB/s、高于 1MB/s
    expect(s.bytesPerSec).toBeLessThan(9_000_000)
    expect(s.bytesPerSec).toBeGreaterThan(1_000_000)
  })

  it('格式化：人类可读的速度与大小', () => {
    const p = createProgressTracker({ now: () => 0 })
    const s = p.update('a', 'v4.28.0', 1_500_000, 6_000_000)
    expect(s.gotText).toMatch(/1\.\d MB/)
    expect(s.percent).toBe(25)
  })

  it('不同任务互不串台（多实例/多版本同时下）', () => {
    let t = 0
    const p = createProgressTracker({ now: () => t })
    p.update('a', 'v4.28.0', 0, 1000)
    p.update('n', 'v4.18.19', 0, 2000)
    t = 1000
    const a = p.update('a', 'v4.28.0', 500, 1000)
    const n = p.update('n', 'v4.18.19', 2000, 2000)
    expect(a.percent).toBe(50)
    expect(n.percent).toBe(100)
  })

  it('完成态标记 done', () => {
    const p = createProgressTracker({ now: () => 0 })
    const s = p.update('a', 'v4.28.0', 1000, 1000)
    expect(s.done).toBe(true)
  })
})
