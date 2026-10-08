import { describe, it, expect } from 'vitest'
import { allocate, createTcpProbe, PortRangeExhausted } from '../../src/main/ports/allocator'

describe('allocate（端口分配）', () => {
  it('无 hint：默认从段首找第一个空闲', async () => {
    const probe = (p: number) => Promise.resolve(p !== 6100)
    expect(await allocate(probe, [6100, 6199], [])).toBe(6101)
  })

  it('hint=上一个实例端口+1：从 hint 顺延，占用则跳过到下一个', async () => {
    const probe = (p: number) => Promise.resolve(p !== 6101 && p !== 6102)
    // taken=[]，probe 视 6101/6102 被系统占用；hint=6100 → 6101 占 → 6102 占 → 6103
    expect(await allocate(probe, [6100, 6199], [6100], 6101)).toBe(6103)
  })

  it('hint 后段全满：回头扫段首补位', async () => {
    const probe = (p: number) => Promise.resolve(true)
    // 已分配 6100..6103，hint=6199 之后段尾无位 → 回头 6104
    expect(await allocate(probe, [6100, 6105], [6100, 6101, 6102, 6103], 6199)).toBe(6104)
  })

  it('段真耗尽：抛 PortRangeExhausted', async () => {
    const probe = () => Promise.resolve(false)
    await expect(allocate(probe, [6100, 6101], [])).rejects.toBeInstanceOf(PortRangeExhausted)
  })

  it('已在仓库分配过的端口天然跳过', async () => {
    const probe = () => Promise.resolve(true)
    expect(await allocate(probe, [6100, 6102], [6100, 6101])).toBe(6102)
  })
})
