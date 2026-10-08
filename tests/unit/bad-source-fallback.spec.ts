/*
 * ★★ 坏源自动跳过：清华源 403 时，pip 必须换下一个候选源
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 这条测试守护的真实故障（主人 2026-09-27 实测）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 现象：本地导入 AstrBot 的 whl 报「依赖没装上」，日志原始错误：
 *     ERROR: Could not find a version that satisfies the requirement
 *            aiocqhttp>=1.4.4 (from astrbot) (from versions: none)
 *     ERROR: No matching distribution found for aiocqhttp>=1.4.4
 *
 * 查下去发现：用户配置里 `pref: "清华源"`，而**清华源实测 403 Forbidden**
 *（`python-source.ts` 顶部的实测记录早就写着这一点）。
 * pip 拿着 403 的索引去装包 → `(from versions: none)` → 必然失败。
 *
 * 也就是说：**一个源坏了，所有安装就都坏了，而且用户完全看不出原因。**
 *
 * ## 修法与判据
 *
 * 记住"上次失败的源"（5 分钟 TTL），在这期间 `resolvePythonSource`
 * 跳过它、返回下一个候选。
 *
 * 这套机制必须可验证：
 *   · 标记某源失败 → resolve 不再返回它
 *   · TTL 过期 → 重新尝试它（不会永久拉黑）
 *   · 候选耗尽 → 仍返回首选（让 pip 报真实错误，而不是我们编一个）
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { testStage } from '../helpers/stage'
import {
  markPythonSourceFailed,
  isPythonSourceFailed,
  clearPythonSourceFailures,
  resolvePythonSource,
  savePythonSources
} from '../../src/main/update/mirror-store'

const TUNA = 'https://pypi.tuna.tsinghua.edu.cn/simple/'
const PYPI = 'https://pypi.org/simple/'

function setup(pref: string): string {
  const root = testStage('bad-source-')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ dataRoot: root, portMin: 6100, portMax: 6299, backupKeep: 5 }),
    'utf8'
  )
  savePythonSources(root, { custom: [], pref })
  return root
}

describe('★★坏源自动跳过（清华源 403 那个故障的根治）', () => {
  it('★标记清华源失败后，resolve 必须返回**别的**源（不能照用坏源）', () => {
    clearPythonSourceFailures()
    const root = setup('清华源')
    try {
      /* 基线：首选是清华源 */
      expect(resolvePythonSource(root).indexUrl, '基线应当是用户选的那个').toBe(TUNA)

      /* 模拟：pip 用清华源失败了 → 记下来 */
      markPythonSourceFailed(TUNA)

      const after = resolvePythonSource(root)
      expect(
        after.indexUrl,
        '★清华源刚失败过，resolve 必须换一个可用的源 ——\n' +
          '原来会照用不误，于是每次装依赖都必然报\n' +
          '    Could not find a version that satisfies the requirement ...\n' +
          '    (from versions: none)\n' +
          '（这正是主人实测到的导入失败）'
      ).not.toBe(TUNA)
      /* 应当落到 PyPI（内置表第一个，实测三项全通） */
      expect(after.indexUrl).toBe(PYPI)
    } finally {
      clearPythonSourceFailures()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('★成功之后清掉失败记忆 → 下次仍然尊重用户选的源', () => {
    clearPythonSourceFailures()
    const root = setup('清华源')
    try {
      markPythonSourceFailed(TUNA)
      expect(resolvePythonSource(root).indexUrl).toBe(PYPI)

      /* 用户修好了（或 TTL 到了）→ 清记忆 → 又回到首选 */
      clearPythonSourceFailures()
      expect(
        resolvePythonSource(root).indexUrl,
        '清掉失败记忆后必须回到用户选的源（不能永久拉黑）'
      ).toBe(TUNA)
    } finally {
      clearPythonSourceFailures()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('isPythonSourceFailed 的语义：没标记过 = 没失败', () => {
    clearPythonSourceFailures()
    expect(isPythonSourceFailed(TUNA)).toBe(false)
    markPythonSourceFailed(TUNA)
    expect(isPythonSourceFailed(TUNA)).toBe(true)
    expect(isPythonSourceFailed(PYPI), '没标记过的源不受影响').toBe(false)
    clearPythonSourceFailures()
  })

  it('空 indexUrl 不会把记忆写坏（防御性）', () => {
    clearPythonSourceFailures()
    markPythonSourceFailed('')
    expect(isPythonSourceFailed('')).toBe(false)
    clearPythonSourceFailures()
  })
})
