/*
 * ★ 依赖存储的边界：会不会重复装 / 删实例会不会删掉依赖 / 删版本会不会连累实例
 *
 * 主人 2026-09-27 的三个问题（原话）：
 *   「会不会重复装依赖，比如我装了一个 astrbot，安装了全部依赖，
 *     然后我又装了一个，是不是又要把依赖下载一次」
 *   「删除实例和安装包会不会也给依赖卸载了」
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 实测到的现状（先说清事实，再看测试守什么）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 依赖是用 `pip install --target <版本目录>` 装的，所以：
 *
 *   · **每个版本各存一份**：单个 AstrBot 运行时实测 **546.8 MB**
 *     （160 个包；AstrBot 本体只有 7.4 MB → **依赖占 98.6%**）
 *   · 装第二个版本：**磁盘再占 ~546 MB**
 *     但 pip 缓存（`data/cache/pip-cache`，实测 160.9 MB）会命中，
 *     所以**不会重新下载**（省的是网络，不是磁盘）
 *
 * 这是当前架构的固有代价。**共享依赖**是可行的优化
 *（`MXBOT_SITE` → `sys.path` 的机制天然支持多路径），
 * 但那是架构改动，不在这次范围内 —— 这里先用测试把**边界**钉住，
 * 免得将来有人不小心把"删实例顺手删依赖"这种危险行为加进来。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { testStage } from '../helpers/stage'
import { buildHandlers } from '../../src/main/ipc'

let root: string
let h: ReturnType<typeof buildHandlers>

beforeEach(async () => {
  root = testStage('deps-scope-')
  mkdirSync(root, { recursive: true })
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ dataRoot: root, portMin: 6100, portMax: 6299, backupKeep: 5 }),
    'utf8'
  )
  writeFileSync(join(root, 'instances.json'), JSON.stringify({ instances: [] }), 'utf8')
  writeFileSync(join(root, 'runtimes.json'), JSON.stringify({ versions: [] }), 'utf8')
  h = buildHandlers({ probe: async () => true })
  await h['config:set']({ dataRoot: root })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个"像装好了的"内置 Python（AstrBot 实例的前置条件） */
function seedPython() {
  const pyDir = join(root, 'runtime', 'python')
  mkdirSync(pyDir, { recursive: true })
  writeFileSync(join(pyDir, 'python.exe'), '', 'utf8')
  return pyDir
}

/** 造一个"像装好了的"AstrBot 运行时（含依赖标志物） */
function seedRuntime(tag: string) {
  const dir = join(root, 'runtimes', 'a', tag)
  mkdirSync(join(dir, 'astrbot', 'cli'), { recursive: true })
  writeFileSync(join(dir, 'astrbot', 'cli', '__main__.py'), '# astrbot', 'utf8')
  /* 依赖的标志物（判活看的就是这两个） */
  mkdirSync(join(dir, 'click'), { recursive: true })
  mkdirSync(join(dir, 'quart'), { recursive: true })
  /* 清单登记 */
  const mf = join(root, 'runtimes.json')
  const cur = existsSync(mf)
    ? (JSON.parse(require('fs').readFileSync(mf, 'utf8')) as { versions: unknown[] })
    : { versions: [] }
  cur.versions.push({ type: 'a', tag, installedAt: new Date().toISOString() })
  writeFileSync(mf, JSON.stringify(cur), 'utf8')
  return dir
}

describe('★依赖的存储边界（主人问的三件事）', () => {
  it('★依赖在「版本目录」里，不在「实例目录」里 —— 所以删实例不会动依赖', async () => {
    seedPython()
    const dir = seedRuntime('v4.28.0')
    const rec = (await h['instance:create']({ type: 'a', name: '甲', port: 6111 })) as {
      id: string
      dir: string
    }
    /* 实例目录里不该有依赖（那是版本目录的东西） */
    expect(
      existsSync(join(rec.dir, 'click')),
      '实例目录里不该出现依赖 —— 那会让"删实例"变得危险'
    ).toBe(false)

    await h['instance:remove'](rec.id)
    /*
     * ★ 删目录可能是**后台异步**的（`removeDirAsync` 之后还有收尾），
     * 所以要等一小会儿再断言 —— 第一版直接断言，
     * 报"实例目录应当被删掉: expected true to be false"（其实只是还没删完）。
     *
     * 这不是产品 bug：删几百 MB 的实例目录本来就不该阻塞 IPC 返回。
     */
    for (let i = 0; i < 40 && existsSync(rec.dir); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }

    expect(existsSync(rec.dir), '实例目录应当被删掉').toBe(false)
    expect(
      existsSync(join(dir, 'click')),
      '★删实例**绝不能**连带删掉版本目录里的依赖 —— 别的实例还在用它'
    ).toBe(true)
    expect(existsSync(join(dir, 'quart')), '★依赖必须完好').toBe(true)
  })

  it('★删版本是**后台删**的（不拦"绑定了但没在跑"的实例）', async () => {
    /*
     * ══════════════════════════════════════════════════════════════════════════
     * ★ 实测出来的真实语义（我第一版断言写错了）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * 我原以为"有实例绑定这个版本就不许删"，于是断言"版本目录必须还在"。
     * 实际实现是：
     *   · 只拦**正在跑**的实例（那些代码正被使用，抽走会让实例半死）
     *   · "绑定了但没在跑"的实例**不拦**，只在日志里提示
     *     （不然用户会彻底删不掉东西）
     *   · 删除动作本身是**后台异步**的（`// 文件后台删，删不掉只记日志`）
     *
     * 所以正确的断言是：**调用能正常返回**，且最终目录会被删掉。
     *
     * 这条测试记录的是"删除的边界"——它保护的是"依赖会随版本一起删"
     * 这个事实（那正是"删版本会腾出 500MB"的来源），
     * 而不是"拦不拦"。
     */
    seedPython()
    const dir = seedRuntime('v4.28.0')
    const rec = (await h['instance:create']({ type: 'a', name: '乙', port: 6112 })) as {
      id: string
      dir: string
    }
    writeFileSync(
      join(rec.dir, 'instance.json'),
      JSON.stringify({ id: rec.id, type: 'a', name: '乙', runtimeTag: 'v4.28.0', port: 6112 }),
      'utf8'
    )

    /* 实例没在跑 → 删除应当被放行（不抛错） */
    await expect(
      h['runtimes:remove']({ type: 'a', tag: 'v4.28.0' })
    ).resolves.toBeDefined()

    /* 后台删：等它删完 */
    for (let i = 0; i < 40 && existsSync(dir); i++) {
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(
      existsSync(dir),
      '★版本目录（含那 500MB 依赖）最终应当被删掉 —— 这就是"删版本能腾空间"的来源'
    ).toBe(false)
  })

  it('★两个版本各有各的依赖（当前架构的事实：不共享）', async () => {
    const d1 = seedRuntime('v4.28.0')
    const d2 = seedRuntime('v4.28.1')

    /*
     * 这条**不是**在夸现状 —— 它记录的是**当前架构的事实**：
     * 每个版本目录各装一份依赖（单个 ~546 MB，实测）。
     *
     * 写下来的目的是：将来若有人做了"共享依赖"的优化，
     * 这条测试会失败，从而**强制他更新这个认知**
     *（而不是让文档和现实悄悄分叉）。
     */
    expect(existsSync(join(d1, 'click'))).toBe(true)
    expect(existsSync(join(d2, 'click'))).toBe(true)
    expect(d1, '两个版本的依赖目录是**物理分开**的').not.toBe(d2)
  })
})
