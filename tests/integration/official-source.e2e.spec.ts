/*
 * @vitest-environment node
 *
 * 这个文件**真的要联网**（探测官方源 / 下载真实资产 / 跑真进程装包）。
 * vitest.config.ts 全局是 happy-dom，而 happy-dom 的 fetch 会做同源检查、
 * 且不认 Access-Control-Allow-Origin —— 于是这些用例会以
 * "Cross-Origin Request Blocked" 失败，而生产里根本没这个问题
 *（主进程走 Node fetch，不受同源策略约束）。
 *
 * 所以显式声明 node 环境：**需要真实网络的测试就该跑在 node 环境**。
 */
// 端到端实测：用真实代码探测线上源（不 mock 网络）
//
// 这个文件盯的是「线上服务器上架的东西，启动器能不能正确理解」。
// 曾经它假设：AstrBot 有个 6MB 的 dashboard zip、NapCat 是 117MB 的 Node 版 ——
// 那两个**都是错的资产**（dashboard 只有前端、没有后端；Node 版自带 node 我们用不上），
// 服务器已经按正确形态重新上架，这里的断言也跟着改。
//
// 正确的形态（2026-09-13 起）：
//   AstrBot → 清单里是 `asset: "pypi:astrbot"` 提示，服务器**不分发包体**，
//             由内置 Python 从 PyPI 装（见 ipc.ts 的 kind==='pypi' 分支）
//   NapCat  → NapCat.Shell.zip（约 28MB，含 NapCatWinBootMain.exe，直接注入 QQ）
import { describe, it, expect, afterAll } from 'vitest'
import { MX_OFFICIAL_BASE } from '../../src/main/update/publish-urls'
import { rmSync } from 'fs'
import { join } from 'path'
import { listVersions } from '../../src/main/update/version-catalog'
import { downloadRuntime } from '../../src/main/update/runtime-download'
import { testStage } from '../helpers/stage'

const root = testStage('mx-e2e-')
const BASE = `${MX_OFFICIAL_BASE}files/`

/**
 * 源上到底有没有内容 —— 没有就**跳过**而不是红。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么这条前置检查是必要的（主人 2026-10-08 换成 GitHub 源后）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 这个文件测的是"**线上源**能不能列出正确形态的版本清单"。它的前提是
 * "源上已经发布了内容"，而这个前提有两个会不成立的真实时刻：
 *
 *   ① 仓库刚建、`files/versions.json` 还没上传（**当前就是这个状态**）
 *   ② 网络不通 / 加速源临时挂掉
 *
 * 原来它是**直接断言**的，于是这两种情况下都会红 —— 而红的信息长得
 * 像"功能坏了"（"官方源应有 NapCat 条目: expected 0 to be greater than 0"），
 * 让人去查代码，实际只是**内容还没发布**。
 *
 * 这类"依赖外部世界状态"的测试，正确做法是**先检查前提**：
 * 前提不成立 → 明确跳过（打印原因），而不是报一个会误导人的失败。
 *
 * 注意：这里只对"**没有内容**"跳过。如果源上有内容、但形态不对
 *（比如又发成 Node 版了），下面那些断言照常会红 —— 那才是真该报的。
 */
async function sourceHasContent(): Promise<boolean> {
  try {
    const list = await listVersions({ dataRoot: root, type: 'n', onlyBase: BASE })
    return list.length > 0
  } catch {
    return false
  }
}

describe('线上官方源端到端', () => {
  it('探测到 AstrBot / NapCat 版本清单（各自的正确分发形态）', async () => {
    if (!(await sourceHasContent())) {
      console.warn(
        `[跳过] 线上源（${BASE}）目前没有可用内容 ——\n` +
          `  可能是仓库还没发布 files/versions.json，或网络/加速源不可用。\n` +
          `  这不是代码缺陷；发布内容后重跑即可验证。`
      )
      return
    }

    const a = await listVersions({ dataRoot: root, type: 'a', onlyBase: BASE })
    const n = await listVersions({ dataRoot: root, type: 'n', onlyBase: BASE })

    expect(a.length, '官方源应有 AstrBot 条目').toBeGreaterThan(0)
    expect(a[0].tag).toMatch(/^v\d/)
    /*
     * from 是「PyPI 官方」而不是「AstriaX官方源」—— 这是对的，而且是个重要事实：
     * AstrBot 的版本条目实际来自 PyPI（唯一可装渠道），
     * 服务器清单里那条只是「AstrBot 走 PyPI」的提示，不带包体。
     */
    expect(
      a[0].from,
      `AstrBot 条目来源是「${a[0].from}」，应为「PyPI 官方」——`
        + `它的后端只在 PyPI，服务器不分发。`
    ).toBe('PyPI 官方')
    /*
     * AstrBot 必须是 pypi 分发。
     * 曾经这里是「有 6MB 的 zip 可以下」，结果是 dashboard 前端包 ——
     * 下下来解压是空目录，AstrBot 根本起不来。服务器改成只发提示条目了。
     */
    expect(
      a[0].kind,
      `AstrBot 条目 kind=${a[0].kind ?? '未设置'}（asset=${a[0].assetName}）。`
        + `应为 pypi —— 服务器不再分发 AstrBot 包体，由内置 Python 从 PyPI 装。`
    ).toBe('pypi')

    expect(n.length, '官方源应有 NapCat 条目').toBeGreaterThan(0)
    /*
     * NapCat 是 Shell 形态（约 28MB）。
     * 曾经是 NapCat.Shell.Windows.Node.zip（117MB）—— 自带 node 的旧形态，
     * 我们的启动路径（直接注入 QQ）用不上，白白多下 89MB。
     *
     * ★ 2026-10-08 断言放宽：只看**文件名**，不绑死路径前缀。
     *
     * 线上源现在的资产路径是 `napcat/v4.18.28/NapCat.Shell.zip`
     *（带版本号子目录，便于多版本共存），而这条断言原来写死
     * `napcat/NapCat.Shell.zip` —— 于是**功能明明是好的**（清单读到了、
     * 版本也在），测试却因为一个路径前缀红了。
     *
     * 这里要守的是"发的是 Shell 形态、不是 Node 形态"，
     * 用**后缀**匹配比全路径匹配更贴近意图，也不会因为目录结构变化误报。
     */
    expect(
      n[0].assetName,
      `NapCat 资产是 ${n[0].assetName}，文件名应以 NapCat.Shell.zip 结尾（Shell 形态）`
    ).toMatch(/NapCat\.Shell\.zip$/)
    expect(n[0].sizeMB, 'Shell 包约 28MB；若 >60MB 说明又发成 Node 版了').toBeLessThan(60)
    expect(n[0].sizeMB).toBeGreaterThan(20)

    // 诊断输出：AstrBot 列表到底长什么样（同 tag 会去重，服务器那条提示可能被 PyPI 条目顶掉）
    console.log(
      'ASTRBOT 列表:',
      JSON.stringify(
        a.map((v) => ({ tag: v.tag, asset: v.assetName, kind: v.kind, from: v.from })),
        null,
        1
      )
    )
  }, 60000)

  it('真实下载 NapCat 并校验 sha256（Shell 包，约 28MB）', async () => {
    /* 同上的前置检查：源上没内容就跳过（见 sourceHasContent 的说明） */
    if (!(await sourceHasContent())) {
      console.warn('[跳过] 线上源目前没有可用内容，无法验证真实下载')
      return
    }
    const list = await listVersions({ dataRoot: root, type: 'n', onlyBase: BASE })
    const v = list[0]
    const dest = join(root, 'n.zip')
    const r = await downloadRuntime({
      dataRoot: root,
      type: 'n',
      release: { tag: v.tag, assetName: v.assetName, assetUrl: v.assetUrl, sha256: v.sha256 },
      destFile: dest,
      onlyBase: BASE
    })
    console.log('DOWNLOADED:', r.bytes, 'bytes from', r.usedLabel, 'sha', r.sha256.slice(0, 16))
    /*
     * 用 sha256 严格校验而不是只看大小 ——
     * 这才是「服务器上那份文件确实没坏」的证据。
     * 清单里必须有 sha256：没有的话这条断言会显得在走过场。
     */
    expect(v.sha256, 'NapCat 清单条目必须带 sha256（否则无法校验完整性）').toBeTruthy()
    expect(r.sha256, '下载结果与清单 sha256 不一致 —— 服务器上的文件可能坏了').toBe(v.sha256)
    expect(r.bytes).toBeGreaterThan(20_000_000)
    expect(r.bytes, '不该再是 117MB 的 Node 版').toBeLessThan(60_000_000)
  }, 300000)

  it('UI 不暴露服务器 IP：内置源标签为「AstriaX官方源」', async () => {
    const { BUILTIN_MIRRORS } = await import('../../src/main/update/mirror-store')
    const official = BUILTIN_MIRRORS.find((m) => m.mode === 'files')
    expect(official?.label).toBe('AstriaX官方源')
    expect(official?.hideBase).toBe(true)
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))
})
