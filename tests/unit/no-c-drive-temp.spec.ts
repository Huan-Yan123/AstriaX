import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import { describe, expect, it } from 'vitest'
import { testStage } from '../helpers/stage'

/**
 * 守门测试：**测试自己的临时文件也不许碰 C 盘**。
 *
 * 这条是拿教训换来的。之前 41 个测试文件写 `mkdtempSync(join(tmpdir(), ...))`，
 * 也就是 C:\Users\<用户>\AppData\Local\Temp。单个看着无所谓，但几个 e2e
 * 会真装 Python、真下 NapCat（117MB）、真 pip 装 AstrBot（200+ 依赖），
 * 跑一遍全量就是好几个 GB —— 反复跑直接把 C 盘吃爆，用户得手动清半天。
 *
 * src/main/util/workdir.ts 里早有 makeStage 专治这件事，
 * 注释里甚至写着"之前用 os.tmpdir() 把 6.8GB 全压在 C 盘上"，
 * 说明产品代码踩过一次，结果测试代码又踩了一遍。
 * 所以这里钉死：谁再往 tmpdir 扔东西，这个测试就红。
 */
function walkSpecs(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walkSpecs(p))
    else if (p.endsWith('.spec.ts')) out.push(p)
  }
  return out
}

describe('测试临时目录必须落在项目 data 下', () => {
  it('没有任何测试用 os.tmpdir() 做暂存', () => {
    // 允许注释里提到 tmpdir（解释为什么不用它），但不允许真的调用
    const offenders: string[] = []
    for (const f of walkSpecs(join(process.cwd(), 'tests'))) {
      // workdir.spec.ts 用 tmpdir() 做「不等于系统临时目录」的反向断言，是正当用途
      if (f.endsWith('workdir.spec.ts')) continue
      // 本文件自己含有 tmpdir() 字面量（就在下面的正则里），跳过自己
      if (f.endsWith('no-c-drive-temp.spec.ts')) continue
      const src = readFileSync(f, 'utf8')
      // 去掉注释行再查，避免把说明文字当成调用
      const code = src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
      if (/\btmpdir\s*\(\s*\)/.test(code)) offenders.push(relative(process.cwd(), f))
    }
    expect(offenders, `这些测试还在用系统临时目录（会吃 C 盘）：\n${offenders.join('\n')}`).toEqual([])
  })

  it('★testStage 建的目录在**项目内**、且与真实 data 分开', () => {
    /*
     * ══════════════════════════════════════════════════════════════════════════
     * ★ 这条的判据被一次修复**改进**了（如实记录）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * 原来断言的是：
     *     expect(d).toContain('/data/cache/tmp/')
     * 也就是"测试暂存必须在**真实 data** 下的 cache/tmp 里"。
     *
     * 那个约定的**意图**是好的（绝不用 C 盘），但它带来一个实测出来的后果：
     * `data/cache/tmp` 里积了 **925 个残留目录 / 48004 个文件 / 940 MB**，
     * 全是测试建的而没被清理（详见 tests/helpers/stage.ts 的说明）。
     * 其中 `repo- 189 / tplver- 105 / open- 105` 之类还只是暂存，
     * 更糟的是有些 e2e 直接 `config:set({dataRoot: 真实data})` ——
     * 往**真实 instances.json** 里写了 31 个假实例。
     *
     * 现在 testStage 改用独立根 `data-test/<runId>/`，于是这条断言要跟着变。
     *
     * ## 但**核心意图一字不改**
     *
     *   · 仍然必须在项目内（`process.cwd()` 之下）
     *   · 仍然绝不能碰 C 盘（`appdata` / `temp` 这类）
     *   · 新增一条：**不能落在真实 data 里** —— 那正是要修的病
     */
    const d = testStage('guard-')
    const norm = d.replace(/\\/g, '/')
    const proj = process.cwd().replace(/\\/g, '/')

    expect(norm, '必须在项目目录下').toContain(proj)
    expect(d.toLowerCase(), '绝不能落在 C 盘用户目录').not.toContain('appdata')
    expect(
      norm,
      '★不能落在**真实 data** 下 —— 那会让测试产物混进用户数据（实测积了 4.8 万文件）'
    ).not.toContain('/data/cache/tmp/')
    expect(norm, '应当落在独立的测试根里').toContain('/data-test/')
  })
})
