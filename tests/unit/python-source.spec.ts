/*
 * AstrBot 的「Python 源」与 NapCat 的「GitHub 源」必须**彻底分开**。
 *
 * 主人 2026-09-26：
 *   「把 astrbot 从 GitHub 源剥离，单独做一个 python 源来安装 astrbot」
 *   「github 源只有 napcat」
 *
 * ## 拆分前的问题（真实存在，不是假想）
 *
 * 两类运行时共用同一份 `MirrorState.pref = {a, n}`：
 *   1. AstrBot 会被分配一个 **GitHub 代理源**（gh-proxy.com 等）——
 *      而 AstrBot 的后端只在 PyPI，那些代理**根本列不出 AstrBot 版本**，
 *      界面显示空列表，用户以为"没得装"。
 *   2. pip 实际用的是**硬编码的清华源**，与界面选择的源无关 ——
 *      显示的和真实行为不一致；而清华源实测已 403。
 *
 * 这里钉住拆分后的四条契约。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import {
  loadPythonSources,
  savePythonSources,
  resolvePythonSource
} from '../../src/main/update/mirror-store'
import {
  BUILTIN_PYTHON_SOURCES,
  DEFAULT_PYTHON_SOURCE,
  METADATA_SOURCE,
  pythonSourceToPipArgs,
  findPythonSource
} from '../../src/main/update/python-source'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('pysrc-')
  mkdirSync(root, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('★AstrBot 的 Python 源（与 GitHub 源分离）', () => {
  it('默认源是 PyPI 官方（实测唯一"索引+元数据+下载"三项全通的）', () => {
    const src = resolvePythonSource(root)
    expect(src.indexUrl).toBe('https://pypi.org/simple/')
    expect(src.jsonApi, '默认源必须能列版本').toContain('/pypi/{pkg}/json')
    expect(src).toEqual(DEFAULT_PYTHON_SOURCE)
  })

  it('内置表的第一项就是默认（顺序即优先级）', () => {
    expect(BUILTIN_PYTHON_SOURCES[0]).toEqual(DEFAULT_PYTHON_SOURCE)
  })

  it('★pip 参数来自选中的源（不是硬编码的清华源）', () => {
    /*
     * 拆分前 pip 用的是写死的 `PIP_MIRROR_ARGS`（清华源），
     * 而清华源实测 403 —— 那是"显示与真实行为不一致"+"必然失败"。
     */
    const args = pythonSourceToPipArgs(DEFAULT_PYTHON_SOURCE)
    expect(args[0]).toBe('-i')
    expect(args[1]).toBe('https://pypi.org/simple/')
    expect(args.join(' '), '不该再出现清华源').not.toContain('tuna.tsinghua')
  })

  it('★用户切换源后，pip 参数跟着变（选了就用，不含糊）', () => {
    const st = loadPythonSources(root)
    const custom = st.sources.filter((s) => !s.builtin)
    savePythonSources(root, {
      custom: [...custom, { label: '我的私有源', indexUrl: 'https://my.pypi/simple/' }],
      pref: '我的私有源'
    })
    const active = resolvePythonSource(root)
    expect(active.indexUrl).toBe('https://my.pypi/simple/')
    expect(pythonSourceToPipArgs(active)).toEqual(['-i', 'https://my.pypi/simple/'])
  })

  it('★首选源指向不存在的源 → 回落默认（不能把无效值带给 pip）', () => {
    savePythonSources(root, {
      custom: [{ label: '临时源', indexUrl: 'https://tmp.pypi/simple/' }],
      pref: '临时源'
    })
    expect(resolvePythonSource(root).indexUrl).toBe('https://tmp.pypi/simple/')
    // 删掉之后 pref 指向了一个不存在的 label
    savePythonSources(root, { custom: [], pref: '临时源' })
    expect(
      resolvePythonSource(root).indexUrl,
      '无效 pref 会让 pip 带上错的 -i，必须回落'
    ).toBe(DEFAULT_PYTHON_SOURCE.indexUrl)
  })

  it('★老数据：pref.a 存的是 GitHub 代理 base → 不能当成 Python 源', () => {
    /*
     * 拆分前 mirrors.json 里 pref.a 存的是 GitHub 代理的 base（如
     * https://gh-proxy.com/）。那是 NapCat 的源，绝不能拿去当 pip 的 -i。
     * Python 源读的是**独立文件**，天然不会读到它 —— 这条测试钉住这一点。
     */
    writeFileSync(
      join(root, 'mirrors.json'),
      JSON.stringify({ pref: { a: 'https://gh-proxy.com/', n: 'https://gh-proxy.com/' } }),
      'utf8'
    )
    expect(
      resolvePythonSource(root).indexUrl,
      'mirrors.json 里的 GitHub base 不该影响 Python 源'
    ).toBe(DEFAULT_PYTHON_SOURCE.indexUrl)
  })

  it('Python 源存在独立文件里，不写进 mirrors.json', () => {
    savePythonSources(root, { custom: [{ label: 'x', indexUrl: 'https://x.pypi/simple/' }], pref: 'x' })
    expect(existsSync(join(root, 'python-sources.json')), '应当写独立文件').toBe(true)
    const mirrorsTouched = existsSync(join(root, 'mirrors.json'))
    expect(mirrorsTouched, '存 Python 源不该碰 mirrors.json').toBe(false)
  })

  it('自定义源会被持久化，重读还在', () => {
    savePythonSources(root, {
      custom: [{ label: '公司源', indexUrl: 'https://corp.pypi/simple/', note: '内网' }],
      pref: '公司源'
    })
    const st = loadPythonSources(root)
    const found = st.sources.find((s) => s.label === '公司源')
    expect(found?.indexUrl).toBe('https://corp.pypi/simple/')
    expect(st.pref).toBe('公司源')
  })

  it('★列版本固定走 PyPI 官方（腾讯云这类"只能装不能列"的源不会污染列表）', () => {
    /*
     * ★ 这条替换了原来的两条弱断言（第二轮复审指出它们在空目录下恒真）：
     *   · `metadataSourceFor(DEFAULT_PYTHON_SOURCE)` 必然等于它自己（x ?? x）
     *   · `resolvePythonSource(root)` 找不到 pref 时**就是**返回默认源
     *
     * 而真正要守的契约是：**列版本只能用 PyPI 官方** ——
     * 实测（scripts/test-python-sources.py）腾讯云/阿里云的
     * `/pypi/{pkg}/json` 都是 404，界面若按"用户选的源"去列版本会显示空列表。
     *
     * `metadataSourceFor` 已删除（它从未被生产调用，是死抽象），
     * 现在直接钉住"腾讯云没有元数据接口"这个事实 —— 那是决策依据本身。
     */
    /*
     * ★ 按 **indexUrl** 找，而不是按 label ——
     * 标签名会变（主人 2026-09-27 要求「名称只保留 Python源，腾讯源」，
     * 于是「腾讯云（仅安装加速）」改名成「腾讯源」），
     * 而 indexUrl 是**功能性标识**，不会因为文案调整而变。
     * 按 label 找的测试会在每次改名时假红（这次就是），没必要。
     */
    const tencent = findPythonSource(
      BUILTIN_PYTHON_SOURCES,
      'https://mirrors.cloud.tencent.com/pypi/simple/'
    )
    expect(tencent, '腾讯源应当在表里（作为安装加速选项）').toBeTruthy()
    expect(
      tencent!.jsonApi,
      '腾讯云没有 /pypi/{pkg}/json 接口（实测 404），所以它不能用来列版本'
    ).toBeUndefined()

    // 唯一能列版本的是 METADATA_SOURCE（PyPI 官方）
    expect(METADATA_SOURCE.jsonApi, '只有 PyPI 官方有元数据接口').toContain('/pypi/{pkg}/json')
    expect(DEFAULT_PYTHON_SOURCE.jsonApi, '默认源也必须能列版本').toBeTruthy()
  })

  it('损坏的 python-sources.json 要留证，且不让读源崩掉', () => {
    writeFileSync(join(root, 'python-sources.json'), '{ 这不是 json', 'utf8')
    const st = loadPythonSources(root)
    expect(st.sources.length, '读不出来也要给出内置源').toBeGreaterThan(0)
    expect(st.pref).toBe('')
    // 留证：原文件应被改名成 .corrupt-*
    const quarantined = require('fs')
      .readdirSync(root)
      .filter((f: string) => f.startsWith('python-sources.json.corrupt-'))
    expect(quarantined.length, '坏文件要留证（不能静默丢用户配的源）').toBe(1)
    // 留证文件里内容还在（用户能手工抢救）
    expect(readFileSync(join(root, quarantined[0]), 'utf8')).toContain('这不是 json')
  })

  it('内置源标记为 builtin（界面据此禁止删除）', () => {
    for (const s of BUILTIN_PYTHON_SOURCES) {
      expect(s.builtin, `${s.label} 应标记 builtin`).toBe(true)
    }
  })
})
