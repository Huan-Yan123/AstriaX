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
// 真实链路：装内置 Python → 从官方源探测版本 → 装运行时（AstrBot 走 PyPI / NapCat 走 zip）
//
// 注意：这个文件会**真去服务器下载资产**（地址取自 publish-urls.ts 的
// MX_OFFICIAL_BASE，见下面的 BASE 常量）。
// 因此它同时也是服务器资产的守门人 —— 服务器发错东西时，这里必须红。
// 实测抓到的真实问题（2026-09-13）：
//   astrbot: AstrBot-v4.28.0-dashboard.zip (6.0MB) —— 只有前端 dist，不含后端包，
//            解压完是个空目录，AstrBot 根本跑不起来
//   napcat:  NapCat.Shell.Windows.Node.zip (117MB) —— 需要独立 Node 的老形态
// 现在的正确形态（服务器已按此上架）：
//   AstrBot → 清单里是一条 `asset: "pypi:astrbot"` 提示，**服务器不分发包体**，
//             由内置 Python 的 pip 从 PyPI 装（见 ipc.ts 的 kind==='pypi' 分支）
//   NapCat  → NapCat.Shell.zip（28MB，含 NapCatWinBootMain.exe，直接注入 QQ）
import { describe, it, expect, afterAll } from 'vitest'
import { MX_OFFICIAL_BASE } from '../../src/main/update/publish-urls'
import { existsSync, rmSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { createRuntimeStore } from '../../src/main/update/runtime-store'
import { listVersions } from '../../src/main/update/version-catalog'
import { downloadRuntime } from '../../src/main/update/runtime-download'
import { PYTHON_SOURCES, pythonDirFor, pythonExeFor, enableEmbedSite, ensurePip } from '../../src/main/runtime/python-runtime'
import { testStage } from '../helpers/stage'

const root = testStage('mx-full-')
const BASE = `${MX_OFFICIAL_BASE}files/`

describe('完整链路（真实网络）', () => {
  it('1) 装内置 Python 3.12', async () => {
    const dir = pythonDirFor(root)
    const zip = join(root, 'py.zip')
    let ok = false
    for (const url of PYTHON_SOURCES) {
      try {
        const r = await fetch(url)
        if (!r.ok) continue
        writeFileSync(zip, Buffer.from(await r.arrayBuffer()))
        ok = true
        break
      } catch {
        /* 换下一个源 */
      }
    }
    expect(ok).toBe(true)
    const ex = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`], { timeout: 300000 })
    expect(ex.status).toBe(0)
    enableEmbedSite(dir)
    await ensurePip({
      dir,
      runPython: (args) => {
        const r = spawnSync(pythonExeFor(root), args, { encoding: 'utf8', timeout: 600000, env: { ...process.env, PYTHONHOME: dir } })
        return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
      }
    })
    expect(existsSync(pythonExeFor(root))).toBe(true)
  }, 1200000)

  it('2) 官方源探测 AstrBot：应识别为 pypi 分发（服务器不再发 zip）', async () => {
    const list = await listVersions({ dataRoot: root, type: 'a', onlyBase: BASE })
    expect(list.length).toBeGreaterThan(0)
    /*
     * AstrBot 的列表实际长这样（实测打印确认）：
     *   v4.28.0  astrbot-4.28.0-py3-none-any.whl  kind=pypi  from=PyPI 官方
     *   v4.28.0b1 ...                             kind=pypi  from=PyPI 官方
     *   v4.27.5  ...
     *
     * 服务器清单里那条 `asset: "pypi:astrbot"` 提示**不会出现在最终列表里** ——
     * 它的 tag 也是 v4.28.0，被 PyPI 的真实条目同 tag 去重顶掉了。
     * 这没问题，而且更好：顶替它的是**真能装**的 wheel。
     *
     * 所以要断言的是：AstrBot 能拿到可安装的 pypi 条目。
     */
    const installable = list.filter((v) => v.kind === 'pypi' && v.assetName.endsWith('.whl'))
    expect(
      installable.length,
      `AstrBot 列表里没有可安装的 pypi 条目（共 ${list.length} 条）。`
        + `服务器那条 pypi:astrbot 只是提示、不带包体，真正可装的是 PyPI 的 wheel。`
        + `实际条目：${list.slice(0, 3).map((v) => v.assetName).join(', ')}`
    ).toBeGreaterThan(0)
    // 最新版要对得上 PyPI 的版本号
    expect(installable[0].tag).toMatch(/^v\d/)
    // 绝不能出现 dashboard.zip（那是只有前端的坏包）
    expect(
      list.filter((v) => /dashboard/.test(v.assetName)),
      'dashboard.zip 出现在可装列表里了 —— 它只有前端 dist/，装了跑不起来'
    ).toEqual([])
    console.log('AstrBot 可装条目数:', installable.length, '最新:', installable[0].tag, installable[0].assetName)
  }, 120000)

  it('2b) NapCat 从官方源下载并解压出可用运行时（守门真实资产）', async () => {
    const list = await listVersions({ dataRoot: root, type: 'n', onlyBase: BASE })
    /*
     * ★ 源上没内容时**跳过而不是红**（与 official-source.e2e 的前置检查同一理由）
     *
     * 这条测的是"线上源上的真实资产能不能下下来并解压出可用运行时"，
     * 前提是**源上已经发布了内容**。仓库刚建、`files/versions.json`
     * 还没上传时，断言会红成"官方源应有 NapCat 版本: expected 0 to be
     * greater than 0" —— 那长得像功能坏了，实际只是内容还没发布。
     *
     * 内容发布后重跑即可验证；形态不对（比如又发成 Node 版）时，
     * 下面那些断言照常会红 —— 那才是真该报的。
     */
    if (list.length === 0) {
      console.warn(
        `[跳过] 线上源（${BASE}）暂无 NapCat 版本 ——\n` +
          `  可能是还没发布 files/versions.json，或网络/加速源不可用。\n` +
          `  这不是代码缺陷；发布内容后重跑即可验证。`
      )
      return
    }
    const v = list[0]
    /*
     * 资产守门：必须是 Shell 形态（NapCat.Shell.zip，约 28MB），
     * 不是自带 Node 的旧形态 NapCat.Shell.Windows.Node.zip（117MB）。
     * 我们的启动路径直接注入 QQ，用不上自带 node 的那套。
     *
     * ★ 2026-10-08 断言放宽：只看**文件名后缀**，不绑死目录前缀。
     *
     * 线上源现在的路径是 `napcat/v4.18.28/NapCat.Shell.zip`
     *（带版本号子目录，便于多版本共存与回滚），而这条原来写死
     * `napcat/NapCat.Shell.zip` —— 功能完全正常（清单读到了、版本也对、
     * 大小也在区间内），却因为一个**目录结构**红了。
     *
     * 要守的是"Shell 形态而非 Node 形态"，用后缀匹配更贴近意图，
     * 也不会因为发布结构微调就误报。下面那两条（不含 Node.zip、
     * 大小 <60MB）继续守着同样的意图。
     */
    expect(
      v.assetName,
      `NapCat 资产是 ${v.assetName}，文件名应以 NapCat.Shell.zip 结尾（Shell 形态）。`
        + `Node.zip 是自带 node 的旧形态，我们的启动路径不用它。`
    ).toMatch(/NapCat\.Shell\.zip$/)
    expect(v.assetName, '不该再出现 Node.zip').not.toContain('Node.zip')
    expect(v.sizeMB, 'Shell 包应在 20-60MB 之间（Node 版是 117MB）').toBeLessThan(60)

    const store = createRuntimeStore({ dataRoot: root })
    const dest = store.dirFor('n', v.tag)
    const zip = join(root, 'n.zip')
    const r = await downloadRuntime({
      dataRoot: root,
      type: 'n',
      release: { tag: v.tag, assetName: v.assetName, assetUrl: v.assetUrl, sha256: v.sha256 },
      destFile: zip,
      onlyBase: BASE
    })
    expect(r.sha256, 'sha256 必须与清单一致').toBe(v.sha256)

    mkdirSync(dest, { recursive: true })
    const ex = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`], { timeout: 300000 })
    expect(ex.status).toBe(0)
    store.register({ type: 'n', tag: v.tag, from: r.usedLabel })

    const entries = readdirSync(dest)
    expect(entries.length, `资产 ${v.assetName} 解压后是空的`).toBeGreaterThan(0)
    // Shell 形态的关键文件：注入 QQ 用的引导程序
    expect(
      entries.some((e) => /NapCatWinBootMain\.exe/i.test(e)),
      `解压后没找到 NapCatWinBootMain.exe（实际条目：${entries.join(', ')}）——`
        + `说明拿到的不是 Shell 形态，我们的启动路径会失败。`
    ).toBe(true)
    console.log('installed NapCat', v.tag, 'at', dest, '顶层条目:', entries.length)
  }, 600000)

  it('3) pypi 条目能定位到真实 PyPI 版本，且入口形态正确（真 pip 安装见 astrbot-pypi.e2e）', async () => {
    /*
     * 这条测试的边界要说清楚：**它不做真实的 pip 安装**。
     *
     * 真实的 pip 装 AstrBot（200+ 依赖）由 astrbot-pypi.e2e.spec.ts 完整覆盖，
     * 那边已经验到 import / pywin32 / 反向确认。《—— 我一开始在这里又写了一遍
     * pip install，还漏了 PIP_MIRROR_ARGS，结果傻等 30 分钟被超时杀掉。
     * 重复劳动 + 更差实现，删掉换成下面这段。
     *
     * 这里只补它没覆盖的一环：**官方源清单 → 识别为 pypi → 能对上 PyPI 的真实版本**。
     * 也就是「服务器说的」和「PyPI 上有的」是一致的。
     */
    const fromServer = await listVersions({ dataRoot: root, type: 'a', onlyBase: BASE })
    const v = fromServer[0]
    expect(v.kind, 'AstrBot 必须是 pypi 分发').toBe('pypi')

    // 从 PyPI 官方列版本，确认服务器提示的这个 tag 真的存在
    const fromPypi = await listVersions({ dataRoot: root, type: 'a', onlyBase: 'pypi' })
    const hit = fromPypi.find((x) => x.tag === v.tag)
    expect(
      hit,
      `服务器提示 AstrBot ${v.tag} 走 PyPI，但 PyPI 上没有这个版本。`
        + `PyPI 最新几个：${fromPypi.slice(0, 5).map((x) => x.tag).join(', ')}`
    ).toBeTruthy()
    expect(hit!.kind).toBe('pypi')
    console.log('AstrBot', v.tag, '在 PyPI 上存在，wheel:', hit!.assetName)
  }, 120000)

  it('4) 删掉版本后目录和记录都没了', () => {
    /*
     * 这里自己造一个已注册的运行时，**不依赖前面的测试留下的东西**。
     *
     * 原来写的是 `store.latest('a')!` —— 依赖测试 2 往 runtimes/a 装过东西。
     * 测试 2 改成「只验分发方式、不真装」之后，latest('a') 就成 undefined 了，
     * 直接 `Cannot read properties of undefined`。
     * 测试之间靠共享目录隐式传状态，改一处就会连带炸一片 —— 自己造数据最稳。
     */
    const store = createRuntimeStore({ dataRoot: root })
    const dir = store.dirFor('n', 'v0.0.1-test')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'marker.txt'), 'x', 'utf8')
    store.register({ type: 'n', tag: 'v0.0.1-test', from: '自造' })

    expect(store.list('n').length, '注册后应能列出来').toBeGreaterThan(0)
    expect(existsSync(dir)).toBe(true)

    store.remove('n', 'v0.0.1-test')
    expect(existsSync(dir), '删掉后目录也要没').toBe(false)
    expect(
      store.list('n').some((r) => r.tag === 'v0.0.1-test'),
      '删掉后记录也要没'
    ).toBe(false)
  })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))
