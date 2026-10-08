import { describe, it, expect } from 'vitest'
import { allocate, PortRangeExhausted } from '../../src/main/ports/allocator'

// 探测假实现：occupied 集合里的端口视为被系统占用
const probeOf = (occupied: number[]) => (p: number) => !occupied.includes(p)

describe('端口分配器', () => {
  it('首个空闲端口直接命中', async () => {
    expect(await allocate(probeOf([]), [6100, 6199], [])).toBe(6100)
  })

  it('被系统占用的端口跳过', async () => {
    expect(await allocate(probeOf([6100, 6101]), [6100, 6199], [])).toBe(6102)
  })

  it('已分配给其他实例的端口跳过（无论探测结果）', async () => {
    expect(await allocate(probeOf([]), [6100, 6199], [6100, 6101])).toBe(6102)
  })

  it('段耗尽抛 PortRangeExhausted', async () => {
    await expect(allocate(probeOf([]), [6100, 6101], [6100, 6101])).rejects.toBeInstanceOf(
      PortRangeExhausted
    )
  })
})
