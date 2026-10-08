/*
 * ★★ 检查更新**必须用上全部加速源**（主人 2026-10-08 实测）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 现场
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人装了 1.0.0 公开版，界面显示「已是最新版本啦」——
 * 而线上清单明明是 1.0.0、他装的是 0.2.1（正是为了测更新）。
 *
 * 日志实据（用户机器导出的 zip）：
 *
 *     检查更新：源 https://raw.githubusercontent.com/Huan-Yan123/AstriaX/
 *               main/latest.json 失败，换下一个源试试（fetch failed）
 *     检查更新失败（**1 个源**都不可用，按最新版处理）：fetch failed
 *
 * 关键词是「**1 个源**」—— 程序只试了直链就放弃了。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 根因：换源时漏改了一处
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 换 GitHub 源那次，我写好了 `manifestUrls()`（展开成六个加速源 + 直链），
 * 但 `safeCheck` 里仍然用**旧常量**拼 url：
 *
 *     const urls = MX_OFFICIAL_BASES.map((b) => `${b}latest.json`)
 *
 * 而 `MX_OFFICIAL_BASES` 是兼容旧代码的别名，**只有一个直链** ——
 * 于是六个加速源一个都没用上，"多源回落"在真机上是**死代码**。
 *
 * 为什么后果特别严重：`safeCheck` 的设计是「任何失败都收敛成
 * hasUpdate:false」= 界面显示「已是最新版本」。于是**源全挂时
 * 用户看到的是"最新版"** —— 一个静默的错误结论，
 * 用户以为自己已经是最新的，实际上什么都没查到。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 实测（哪些源真的能用）
 * ══════════════════════════════════════════════════════════════════════════
 *
 *     gh-proxy       ✅ 1132ms
 *     ghproxy.net    ✅ 2292ms
 *     isteed         ✅ 1336ms
 *     ghfast         ❌ 超时
 *     moeyy          ❌ 超时
 *     llkk           ❌ 超时
 *     直连            ❌ UNABLE_TO_VERIFY_LEAF_SIGNATURE（TLS 被干扰）
 *
 * **直连是唯一一个"必然失败"的** —— 而修复前程序只试它。
 *
 * 这条测试守的是**接线**：`safeCheck` 必须真的去用那批加速源。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { manifestUrls, installerUrls, GITHUB_ACCELERATORS } from '../../src/main/update/publish-urls'

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8')

describe('★ 检查更新：必须用上全部加速源', () => {
  it('manifestUrls 至少给出 3 个加速源 + 直链兜底', () => {
    const urls = manifestUrls()
    expect(
      urls.length,
      '候选源太少 —— 单一源一旦不通，用户就会看到"已是最新版本"这个错误结论'
    ).toBeGreaterThanOrEqual(4)

    /* 直链必须**在最后**（最慢且国内常失败，但最不依赖第三方） */
    const last = urls[urls.length - 1]
    expect(last.url, '直链应当排在最后作为兜底').toContain('raw.githubusercontent.com')
    expect(last.label, '最后一个应当标成直连').toMatch(/直连/)
  })

  it('★ 加速源地址格式正确（拼在 github 直链前面，而不是替换）', () => {
    const urls = manifestUrls()
    const acc = urls.filter((u) => u.label !== 'GitHub 直连')
    for (const u of acc) {
      /*
       * 形态必须是 `<前缀>https://raw.githubusercontent.com/...`
       * —— 前缀是"前置拼接"，不是把 github 域名换掉。
       * 写反了会得到一个不存在的地址（然后表现为"所有源都不通"）。
       */
      expect(
        /^https:\/\/[^/]+\/https:\/\/raw\.githubusercontent\.com\//.test(u.url),
        `${u.label} 的地址形态不对：${u.url}\n` +
          '应当形如 https://<加速前缀>/https://raw.githubusercontent.com/...'
      ).toBe(true)
    }
    expect(acc.length, '加速源数量应当与配置一致').toBe(GITHUB_ACCELERATORS.length)
  })

  it('installerUrls 同样给出全部加速源（下载 exe 走的是它）', () => {
    const urls = installerUrls('AstriaX-Setup-1.0.0.exe')
    expect(urls.length, '安装包也要有多源').toBeGreaterThanOrEqual(4)
    expect(urls[urls.length - 1].url).toContain('releases/latest/download/')
    for (const u of urls.filter((x) => x.label !== 'GitHub 直连')) {
      expect(u.url).toContain('AstriaX-Setup-1.0.0.exe')
    }
  })

  it('★★ safeCheck 必须调用 manifestUrls（而不是旧的单源常量）', () => {
    /*
     * 这是本次缺陷的**接线守卫** —— 函数级测试照不到它，
     * 因为它不是"某个函数算错了"，而是"根本没调用那个函数"。
     *
     * 我为此吃过一次亏：`manifestUrls()` 写好了、测试也有，
     * 但没人检查 `safeCheck` 到底用没用它 —— 于是那个函数在
     * 真机上是死代码。
     */
    const ipc = read('src', 'main', 'ipc.ts')
    const start = ipc.indexOf('const safeCheck = async')
    expect(start, '找不到 safeCheck').toBeGreaterThan(-1)
    /* 取到整个函数体（到下一个顶层 `}` 之后的下一个 `const`） */
    const body = ipc.slice(start, start + 4000)

    expect(
      body.includes('manifestUrls()'),
      '★safeCheck 没有调用 manifestUrls() ——\n' +
        '那样它就只会试一个源（旧常量只剩直链），而直链在国内**实测必然失败**。\n' +
        '后果：用户永远看到「已是最新版本啦」，即使源上明明有新版本。'
    ).toBe(true)

    expect(
      /MX_OFFICIAL_BASES/.test(body.replace(/\/\*[\s\S]*?\*\//g, '')),
      '★safeCheck 的**代码**里还在用 MX_OFFICIAL_BASES（那是只剩直链的旧别名）——\n' +
        '注释里提到它没关系，但代码不能再依赖它。'
    ).toBe(false)
  })
})
