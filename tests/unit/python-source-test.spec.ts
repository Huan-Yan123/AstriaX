/*
 * ★★ Python 源的测速与可用性（主人 2026-09-27：「加入和 github 一样的测通断」）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 背景
 * ══════════════════════════════════════════════════════════════════════════
 *
 * GitHub 源每一栏都有「可用 544 ms」这样的**实测延迟徽章**，
 * 而 Python 源那一栏什么都没有 —— 因为延迟当初是**写死在 note 里**的：
 *     '实测唯一可列版本·下载稳定' / '索引实测可用·不能列版本' / '实测 403·视网络环境而定'
 *
 * 主人要求：去掉那些文案，改成**当场测**。这条测试钉的就是新行为。
 *
 * ## 判据（与 GitHub 源同一套思路）
 *
 *   1. 探的是 pip 真正会打的地址：`<indexUrl>astrbot/`
 *   2. HTTP ≥400 → 不可用，且**如实报状态码**（403 说被拒绝、404 说没这个包）
 *   3. 200 但页面是空的 → 也不可用（"能连上≠能用"）
 *   4. 200 有内容 → 可用，带上真实延迟
 *   5. 抛错（超时/DNS） → 不可用，带上原因
 */
import { describe, it, expect } from 'vitest'
import { pyProbeUrl, testPythonSources } from '../../src/main/update/python-source-test'
import {
  BUILTIN_PYTHON_SOURCES,
  DEFAULT_PYTHON_SOURCE
} from '../../src/main/update/python-source'

describe('★Python 源测速（与 GitHub 源同一套形态）', () => {
  it('探测地址 = pip 真正会打的那个（索引 + 包名）', () => {
    expect(pyProbeUrl('https://pypi.org/simple/')).toBe('https://pypi.org/simple/astrbot/')
    // 结尾没斜杠也要能拼对（用户手填的自定义源可能不带）
    expect(pyProbeUrl('https://example.com/pypi')).toBe('https://example.com/pypi/astrbot/')
  })

  it('通了 → 可用 + 真实延迟', async () => {
    let t = 0
    const rows = await testPythonSources({
      sources: [BUILTIN_PYTHON_SOURCES[0]],
      now: () => (t += 37), // 每次调用 +37ms，模拟往返
      fetchText: async () => ({ status: 200, body: '<a href="astrbot-4.28.0.whl">…</a>' })
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('ok')
    expect(rows[0].ms, '要给出真实延迟（界面显示"可用 xxx ms"）').toBeGreaterThan(0)
    expect(rows[0].indexUrl).toBe(BUILTIN_PYTHON_SOURCES[0].indexUrl)
  })

  it('★403 → 不可用，且如实说"被拒绝"（不是含糊的"视网络环境而定"）', async () => {
    const rows = await testPythonSources({
      sources: [BUILTIN_PYTHON_SOURCES[0]],
      fetchText: async () => ({ status: 403, body: '' })
    })
    expect(rows[0].status).toBe('unreachable')
    expect(rows[0].ms).toBeNull()
    expect(rows[0].reason, '要说清是 403').toContain('403')
  })

  it('★404 → 不可用，且说清"这个源上没有 astrbot"（而不是笼统的失败）', async () => {
    const rows = await testPythonSources({
      sources: [BUILTIN_PYTHON_SOURCES[0]],
      fetchText: async () => ({ status: 404, body: '' })
    })
    expect(rows[0].status).toBe('unreachable')
    expect(rows[0].reason, '要指出缺的是哪个包').toContain('astrbot')
  })

  it('★200 但空页面 → 也算不可用（"能连上≠能用"）', async () => {
    const rows = await testPythonSources({
      sources: [BUILTIN_PYTHON_SOURCES[0]],
      fetchText: async () => ({ status: 200, body: '   \n  ' })
    })
    expect(rows[0].status, '一个空的索引页等于拿不到东西').toBe('unreachable')
    expect(rows[0].reason).toContain('空')
  })

  it('抛错（超时/DNS）→ 不可用，且带上原因', async () => {
    const rows = await testPythonSources({
      sources: [BUILTIN_PYTHON_SOURCES[0]],
      fetchText: async () => {
        throw new Error('The operation was aborted')
      }
    })
    expect(rows[0].status, '没测通就是 unreachable（不谎报可用）').toBe('unreachable')
    /*
     * ★ 断言的是**意图**，不是某句固定文案（主人 2026-09-27 改过一轮）
     *
     * 原来断言 `reason` 里含 `'aborted'` —— 那是把**底层异常原文**
     * 直接抛给用户的写法。
     *
     * 现在区分了两种情况（因为用户实测反馈"重新检测全不可用"，
     * 而那次只是网络抽风）：
     *   · **超时** → 「超时（…可以再点一次「重新检测」）」
     *   · 真连不上 → 「连不上：<原因>」
     *
     * 所以这里要钉的是：**超时被识别出来了，而且告诉用户可以重试**。
     * 钉死 `aborted` 反而会把"给用户一句人话"这个改进变成测试失败 ——
     * 与本文件里其它几条的教训一样（断言意图，别钉句子）。
     */
    expect(
      rows[0].reason,
      '超时要被识别出来（不是笼统的"不可用"）'
    ).toMatch(/超时/)
    expect(
      rows[0].reason,
      '要告诉用户"可以再点一次"—— 否则他会以为源坏了'
    ).toMatch(/再点/)
  })

  it('多源并行，每个独立判定（一个挂不影响另一个）', async () => {
    const rows = await testPythonSources({
      sources: BUILTIN_PYTHON_SOURCES,
      fetchText: async (url) => {
        if (url.includes('tuna')) return { status: 403, body: '' }
        return { status: 200, body: '<a>x</a>' }
      }
    })
    expect(rows, '每个源都要有结论').toHaveLength(BUILTIN_PYTHON_SOURCES.length)
    const tuna = rows.find((r) => r.indexUrl.includes('tuna'))
    const pypi = rows.find((r) => r.indexUrl.includes('pypi.org'))
    expect(tuna?.status, '清华源被拒绝').toBe('unreachable')
    expect(pypi?.status, 'PyPI 正常').toBe('ok')
  })
})

describe('★源的名字就是名字（不带括号后缀）', () => {
  it('内置源标签不含括号、不含"推荐"等字样', () => {
    /*
     * 主人 2026-09-27：「名称只保留 Python源，腾讯源，不要
     * Python源（推荐），腾讯源（xxx）这样的」。
     *
     * 这条是**防回归**：以后有人觉得"加个（推荐）更友好"就会红。
     * 判断依据不是"我记住了那几个名字"，而是"结构上不许有括号/推荐"，
     * 这样新增源时同样受约束。
     */
    for (const s of BUILTIN_PYTHON_SOURCES) {
      expect(s.label, `「${s.label}」不该带括号`).not.toMatch(/[（(]/)
      expect(s.label, `「${s.label}」不该带"推荐"之类的主观词`).not.toMatch(/推荐|实测|最佳/)
    }
  })

  it('默认源是第一个内置项', () => {
    expect(DEFAULT_PYTHON_SOURCE).toBe(BUILTIN_PYTHON_SOURCES[0])
  })
})
