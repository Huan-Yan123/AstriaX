/*
 * versionNumOf 是「实例绑的是哪个运行时」的换算函数。
 *
 * 原来有两份重复实现（ipc.ts 私有的一份 + template-dl.ts 抄的一份），
 * 两边算出来的值必须一致，所以抽到一处。这个测试锁住换算规则本身。
 *
 * 顺带记录一个**已知的有损性**：这个换算不能用来比较版本大小。
 * 不是 bug（它本来只当指纹用），但必须写下来，
 * 免得以后有人拿它去比大小。
 */
import { describe, it, expect } from 'vitest'
import { versionNumOf } from '../../src/main/runtime/instance-version'

describe('versionNumOf：版本号 → 数字指纹', () => {
  it('标准三段版本号换算正确', () => {
    expect(versionNumOf('v4.28.0')).toBe(4280)
    expect(versionNumOf('v4.18.19')).toBe(41819)
    expect(versionNumOf('v4.27.4')).toBe(4274)
  })

  it('不带 v 前缀也认（用户手动导入的 tag 可能是裸版本号）', () => {
    expect(versionNumOf('4.28.0')).toBe(4280)
    expect(versionNumOf('V4.28.0'), '大写 V 也要认').toBe(4280)
  })

  it('两段/一段版本号补齐到至少三位', () => {
    // padEnd(3,'0')：'42' → '420'
    expect(versionNumOf('v4.2')).toBe(420)
    expect(versionNumOf('v4')).toBe(400)
  })

  it('超过三段的只取前三段（预发布后缀不影响指纹）', () => {
    expect(versionNumOf('v4.28.0-beta.1')).toBe(4280)
    expect(versionNumOf('v4.28.0.1')).toBe(4280)
  })

  it('认不出来时兜底成 1，而不是 NaN', () => {
    /*
     * 兜底成 1 很重要：NaN 会让所有算术比较都变 false，
     * 于是「这个实例用哪个版本」的判断会静默失灵。
     */
    expect(versionNumOf('')).toBe(1)
    expect(versionNumOf('latest')).toBe(1)
    expect(Number.isNaN(versionNumOf('latest'))).toBe(false)
  })

  it('同一个版本号必须得到同一个数字（两份实现抽成一份的意义）', () => {
    // 这正是当初重复实现的风险点：两边漂移就会算出不同的指纹
    const tags = ['v4.28.0', '4.28.0', 'V4.28.0', 'v4.28.0-beta']
    const nums = tags.map((t) => versionNumOf(t))
    expect(new Set(nums).size, `${tags.join(',')} 应该都得到同一个数`).toBe(1)
  })

  it('已知局限：不能拿它比较版本大小（写成测试防止误用）', () => {
    /*
     * 4.2.10 和 4.21.0 都会变成 4210 这种有歧义的数字，
     * 所以这个函数只适合当「同一性指纹」，不适合比大小。
     * 如果哪天有人改成能比大小了，这个测试会红，提醒他更新注释和调用方。
     */
    expect(versionNumOf('v4.2.10')).toBe(4210)
    expect(versionNumOf('v4.21.0')).toBe(4210)
    // 两者相等 —— 正说明它比不了大小
    expect(versionNumOf('v4.2.10')).toBe(versionNumOf('v4.21.0'))
  })
})
