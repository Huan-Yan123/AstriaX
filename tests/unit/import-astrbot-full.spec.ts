/*
 * 手动导入的**完整落盘**过程（问题报告v2 第 10 条）。
 *
 * 用户原话：「astrbot-4.28.0-py3-none-any.whl 选择到入astrbot怎么就这样了，不下载」
 *
 * 探测阶段已经单独验过（kind=a / version=4.28.0）。这里继续往下走
 * `importArchive` —— 真正把包解开落到 `runtimes\a\v4.28.0\` 那一步。
 * 如果这一步抛异常，界面上就是「点了导入没反应 / 一直不出现在已装版本里」。
 *
 * 用真实的 7.7 MB wheel（成品目录里那个），目标目录用测试暂存区。
 * 包不在就跳过，不假装通过。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readdirSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { probeArchive, importArchive } from '../../src/main/update/import-archive'
import { readBuiltinVersion } from '../../src/main/runtime/builtin-version'
import { testStage } from '../helpers/stage'

const WHL = 'E:\\MX机器人启动器成品\\astrbot-4.28.0-py3-none-any.whl'

let root: string
beforeEach(() => {
  root = testStage('acb-importfull-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('手动导入 · AstrBot wheel 真的能装上', () => {
  it('★完整导入后：目录里有 astrbot，且读得出 4.28.0 版本', { timeout: 180_000 }, async () => {
    if (!existsSync(WHL)) {
      console.log('  跳过：成品目录里没有那个 whl')
      return
    }
    const dest = join(root, 'runtimes', 'a', 'v4.28.0')
    mkdirSync(dest, { recursive: true })

    const probe = await probeArchive(WHL)
    expect(probe.kind).toBe('a')

    // 这一步是真正会抛的地方（wheel 有几千个文件，Expand-Archive 慢，放宽超时）
    await importArchive({ dataRoot: root, file: WHL, type: 'a', destDir: dest, probe })

    // 落盘后必须有 astrbot 包本体
    expect(existsSync(join(dest, 'astrbot')), 'astrbot 目录没落下来').toBe(true)
    expect(
      existsSync(join(dest, 'astrbot', '__init__.py')),
      'astrbot/__init__.py 不在 —— 装了个空壳'
    ).toBe(true)

    // 而且能读出权威版本号（已装版本卡片上显示的就是它）
    const v = readBuiltinVersion({ dir: dest, type: 'a' })
    expect(v, '装完之后版本又读不出来，卡片会显示「版本未知」').toBe('4.28.0')

    // dist-info 也该在（pip 元数据，AstrBot 启动时要用）
    const infos = readdirSync(dest).filter((n) => /^astrbot[-_].*\.dist-info$/i.test(n))
    expect(infos.length, 'dist-info 没落下来，pip 会认为没装').toBeGreaterThan(0)
  })
})
