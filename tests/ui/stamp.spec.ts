import { describe, expect, it } from 'vitest'
import { stampPretty } from '../../src/renderer/src/util/stamp'

/**
 * 备份时间戳展示。
 * 真实 bug：文件名 20260912141734 被显示成「2026-09-12 42:14」——
 * 因为展示端按「第 8 位是分隔符」硬切下标，而生成端当时写的是 UTC + 多一位。
 */
describe('stampPretty', () => {
  it('正常 14 位时间戳按本地时间展示', () => {
    expect(stampPretty('20260912221434')).toBe('2026-09-12 22:14:34')
  })

  it('带历史脏字符（多余的点和连字符）也能正确解析', () => {
    // 老版本生成的文件名长这样：20260912141734.-v1.tar.gz
    expect(stampPretty('20260912141734.')).toBe('2026-09-12 14:17:34')
    expect(stampPretty('2026-09-12-141734')).toBe('2026-09-12 14:17:34')
  })

  it('绝不会产出 42 分、85 秒这种不存在的时刻', () => {
    for (const s of ['20260912141734', '20260912141734.', '20260912142148']) {
      const out = stampPretty(s)
      const m = /(\d{2}):(\d{2}):(\d{2})$/.exec(out)!
      expect(Number(m[1])).toBeLessThan(24)
      expect(Number(m[2])).toBeLessThan(60)
      expect(Number(m[3])).toBeLessThan(60)
    }
  })

  it('位数不够时原样返回，别硬编一个假时间出来', () => {
    expect(stampPretty('abc')).toBe('abc')
    expect(stampPretty('2026')).toBe('2026')
  })
})
