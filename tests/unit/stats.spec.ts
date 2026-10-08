import { describe, it, expect } from 'vitest'
import { createStats } from '../../src/main/proc/stats'
import { createProcessManager } from '../../src/main/proc/process-manager'

describe('createStats（注入假 pidusage，不读真系统）', () => {
  it('按 pid 换算 memMB/cpuPct，丢弃取不到的 pid', async () => {
    const stats = createStats({
      pidusage: async (pid: number) => {
        if (pid === 101) return { memory: 250 * 1024 * 1024, cpu: 12.3 }
        if (pid === 202) return { memory: 8 * 1024 * 1024, cpu: 0 }
        throw new Error('gone')
      }
    })
    const out = await stats.forPids([
      { id: 'a', pid: 101 },
      { id: 'b', pid: 202 },
      { id: 'gone', pid: 303 }
    ])
    expect(out).toEqual([
      { id: 'a', memMB: 250, cpuPct: 12.3 },
      { id: 'b', memMB: 8, cpuPct: 0 }
    ])
  })

  it('空列表返空数组；pidusage 全挂时返空数组不炸', async () => {
    const stats = createStats({ pidusage: async () => Promise.reject(new Error('boom')) })
    expect(await stats.forPids([])).toEqual([])
    const out = await stats.forPids([{ id: 'x', pid: 1 }])
    expect(out).toEqual([])
  })
})

describe('process-manager pidsOf（给统计供 pid 通道）', () => {
  it('未启动时返回空 Map', () => {
    const pm = createProcessManager()
    expect(pm.pidsOf().size).toBe(0)
  })
  
  it('running 实例返回 pid；stopped 不返回', async () => {
    const pm = createProcessManager()
    const h = await pm.start({
      id: 'test-pid',
      cmd: process.platform === 'win32' ? 'timeout' : 'sleep',
      args: ['30'],
      port: 9001,
      detached: true
    })
    await h.eventually('running', 3000)
    const snap = pm.pidsOf()
    expect(snap.has('test-pid')).toBe(true)
    expect(snap.get('test-pid')).toBeTypeOf('number')
    pm.killTreeSync('test-pid')
    await h.eventually('stopped', 3000)
    expect(pm.pidsOf().has('test-pid')).toBe(false)
  })
})
