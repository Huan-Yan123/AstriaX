/*
 * 版本比较必须是「任意低版本 → 任意更高版本」。
 *
 * 用户明确要求（原话）：
 *   「覆盖更新不能只能 0.1.0 到 0.1.1 或者到 0.2.0 才能更新，
 *     必须是任何低版本到任何更新的版本，
 *     即使是 0.1 或者 1.0 直接更新到 10.0 版本都能更新」
 *
 * 也就是说**不能有「只能相邻版本升级」这种限制** —— 更新通道是
 * 「服务器上放一份最新版，任何旧版本都能一步到位」。
 *
 * 这里把各种跨度都钉住，尤其是用户点名的几个：
 *   0.1     → 10.0
 *   1.0     → 10.0
 *   0.1.0   → 0.1.1
 *   0.1.0   → 0.2.0
 * 以及那些容易被写错、踩过的坑：
 *   - 位数不同（0.1 vs 0.1.0 谁大？应当相等 → 不算更新）
 *   - 0.9 → 0.10（文本比较会错，数字比较才对）
 *   - 1.2.9 → 1.2.10
 *   - 前导 v（v1.0.0）
 *   - 预发布后缀（0.1.0-beta）
 */
import { describe, it, expect } from 'vitest'
import { isNewerVersion, isVersionSkipped, checkAppUpdate } from '../../src/main/update/app-update'

describe('版本比较 · 任意跨度的升级都允许', () => {
  it('★用户点名的几个跨度', () => {
    // 0.1 → 10.0（跨了主版本号，必须认）
    expect(isNewerVersion('10.0', '0.1'), '0.1 不能升到 10.0 —— 用户明确要求可以').toBe(true)
    // 1.0 → 10.0
    expect(isNewerVersion('10.0', '1.0'), '1.0 不能升到 10.0').toBe(true)
    // 相邻小版本
    expect(isNewerVersion('0.1.1', '0.1.0')).toBe(true)
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true)
    // 反向都必须为 false
    expect(isNewerVersion('0.1', '10.0')).toBe(false)
    expect(isNewerVersion('1.0', '10.0')).toBe(false)
    expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false)
  })

  it('★大跨度：从很旧直接到很新', () => {
    const cases: Array<[string, string]> = [
      ['1.0.0', '0.0.1'],
      ['2.0.0', '1.9.9'],
      ['10.0.0', '9.9.9'],
      ['100.0.0', '99.99.99'],
      ['5.0', '0.1'],
      ['3.0.0', '2.99.99']
    ]
    for (const [newer, older] of cases) {
      expect(isNewerVersion(newer, older), `${older} 应该能升到 ${newer}`).toBe(true)
      expect(isNewerVersion(older, newer), `${newer} 不该"升"到 ${older}`).toBe(false)
    }
  })

  it('★数字段比较，不是文本比较（0.9 → 0.10 必须认成升级）', () => {
    expect(isNewerVersion('0.10', '0.9'), '文本比较会认为 "0.9" > "0.10"，那就错了').toBe(true)
    expect(isNewerVersion('1.2.10', '1.2.9'), '1.2.9 → 1.2.10 必须认').toBe(true)
    expect(isNewerVersion('0.1.10', '0.1.9')).toBe(true)
  })

  it('★段数不同时按「缺的补 0」处理', () => {
    // 0.1 和 0.1.0 是同一个版本 —— 不该互相算更新
    expect(isNewerVersion('0.1.0', '0.1'), '0.1 与 0.1.0 是同一版本').toBe(false)
    expect(isNewerVersion('0.1', '0.1.0')).toBe(false)
    // 但 0.1.1 比 0.1 高
    expect(isNewerVersion('0.1.1', '0.1')).toBe(true)
    expect(isNewerVersion('1.0.0.0', '1.0')).toBe(false)
  })

  it('★前导 v 与预发布后缀都要能处理', () => {
    expect(isNewerVersion('v0.2.0', '0.1.0'), '带 v 的版本号必须能比较').toBe(true)
    expect(isNewerVersion('0.2.0', 'v0.1.0')).toBe(true)
    // 预发布后缀：0.1.0-beta 的 beta 段当 0 → 与 0.1.0 相等
    expect(isNewerVersion('0.2.0', '0.1.0-beta')).toBe(true)
    expect(isNewerVersion('0.1.0', '0.1.0-beta')).toBe(false)
  })

  it('★相同的版本永远不算更新', () => {
    for (const v of ['0.1.0', '1.0', '10.0.0', 'v0.1.1']) {
      const bare = v.replace(/^v/, '')
      expect(isNewerVersion(v, v), `${v} 与自己比较`).toBe(false)
      expect(isNewerVersion(bare, v), `${bare} 与 ${v}`).toBe(false)
    }
  })

  it('★垃圾输入不能崩，且不能误报有更新', () => {
    // 空串/乱码一律比不出来 → 保守地判定「没有更新」
    expect(() => isNewerVersion('', '0.1.0')).not.toThrow()
    expect(isNewerVersion('', '0.1.0')).toBe(false)
    expect(isNewerVersion('abc', '0.1.0')).toBe(false)
    /*
     * 这两条是真正会伤到用户的：
     *   - 清单版本号被写坏成空串，而客户端报了个正常版本
     *     → 若判成"有更新"，用户每次启动都被推一个不存在的包
     *   - 客户端版本读不出来（兜底 '0.0.0' / 空串）
     *     → 不该把任何东西都当成更新
     */
    expect(isNewerVersion('0.1.0', ''), '空版本号不能算"比有效版本新"').toBe(false)
    expect(isNewerVersion('0.1.0', '   '), '纯空格同理').toBe(false)
    expect(isNewerVersion('1abc', '0.1.0'), '半截垃圾也不能瞎认').toBe(false)
  })
})

describe('检查更新 · 一步到位', () => {
  const manifest = (version: string, url = 'http://x/a.exe') =>
    JSON.stringify({ version, url, size: 1024, sha256: 'a'.repeat(64) })

  it('★0.1.0 的客户端看到 10.0 的清单 → 直接提示可更新到 10.0', async () => {
    const r = await checkAppUpdate({
      currentVersion: '0.1.0',
      manifestUrl: 'http://x/latest.json',
      fetchJson: async () => manifest('10.0')
    })
    expect(r.hasUpdate, '不能因为跨度大就不给更新').toBe(true)
    expect(r.latestVersion).toBe('10.0')
    expect(r.url).toBe('http://x/a.exe')
  })

  it('★0.1.0 的客户端看到 0.1.1 → 可更新', async () => {
    const r = await checkAppUpdate({
      currentVersion: '0.1.0',
      manifestUrl: 'http://x/latest.json',
      fetchJson: async () => manifest('0.1.1')
    })
    expect(r.hasUpdate).toBe(true)
    expect(r.latestVersion).toBe('0.1.1')
  })

  it('★客户端比清单新（用户装了个更新的）→ 不该提示降级', async () => {
    const r = await checkAppUpdate({
      currentVersion: '2.0.0',
      manifestUrl: 'http://x/latest.json',
      fetchJson: async () => manifest('1.0.0')
    })
    expect(r.hasUpdate, '不能把降级当成更新推给用户').toBe(false)
  })

  it('★版本相同 → 没有更新', async () => {
    const r = await checkAppUpdate({
      currentVersion: '0.1.1',
      manifestUrl: 'http://x/latest.json',
      fetchJson: async () => manifest('0.1.1')
    })
    expect(r.hasUpdate).toBe(false)
    expect(r.latestVersion).toBe('0.1.1')
  })

  it('★跳过的是具体版本，不是「以后都不更新了」', () => {
    // 跳过了 0.1.1
    expect(isVersionSkipped('0.1.1', '0.1.1'), '当前这个版本应当被跳过').toBe(true)
    // 出了 0.1.2 → 照样提示（用户要求「等到下一个版本再提示」）
    expect(isVersionSkipped('0.1.2', '0.1.1'), '出了新版本必须继续提示').toBe(false)
    // 哪怕只是个小版本，甚至大跨度
    expect(isVersionSkipped('10.0', '0.1.1')).toBe(false)
  })
})
