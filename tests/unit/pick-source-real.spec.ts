/*
 * ★★★ 严格验证：「点哪个源，pip 就用哪个源」—— 捕获**真实传给 pip 的参数**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么要有这条（上一版测试是假绿的）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人 2026-09-27 实测反馈：「我点哪个都是 python 源」。
 * 而当时我已经"修好"了，并且有 10 条测试通过 ——
 * **说明那些测试根本没测到真实链路**：
 *
 *   它们用的是**源码守卫**（正则查 `findPythonSource(...p.base...)` 在不在）
 *   只能证明"代码长得对"，**证明不了运行时真的用对了源**。
 *
 * ## 这条测试怎么做到"严格"
 *
 * 走**完整的 `runtime:install` 链路**，注入一个**记账的假命令执行器**：
 * 参数原样记下来、立刻返回成功。于是可以断言：
 *
 *     pip 的 `-i` 后面那个 URL == 用户点的那个源的 indexUrl
 *
 * pip 只认 `-i` 参数 —— 参数对 = 真的用对了；参数错 = 界面写什么都白搭。
 *
 * ## 造现场的关键点
 *
 * 要让 `runtime:install` 真的走到 pip 那一步，必须：
 *   1. 内置 Python "看起来已装"（`pythonExeFor` 指向的文件存在）
 *   2. 版本列表里能找到目标版本（注入 `versions` 的 fetchJson）
 *   3. 配置与清单齐备
 *
 * 三样都备齐，install 才会走到 pip —— 否则它会在前置检查处提前抛错，
 * 我们就什么都捕获不到（那种"测试通过但其实没跑到"正是要避免的）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { testStage } from '../helpers/stage'
import { BUILTIN_PYTHON_SOURCES } from '../../src/main/update/python-source'

const TENCENT = 'https://mirrors.cloud.tencent.com/pypi/simple/'
const PYPI = 'https://pypi.org/simple/'

let root: string
beforeEach(() => {
  root = testStage('pick-src-real-')
  mkdirSync(root, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * 造一个"能走到 pip"的现场。
 *
 * 返回捕获到的命令列表（caller 用 `ran` 断言）。
 */
async function installWith(opts: {
  /** 传给 runtime:install 的 base（模拟用户点的那张源卡片） */
  base?: string
  /** 先设成配置里的首选源（模拟"上次设过"的状态） */
  prefSource?: string
}): Promise<{ ran: Array<{ cmd: string; args: string[] }> }> {
  const { buildHandlers } = await import('../../src/main/ipc')

  /* ① 内置 Python 看起来已装：pythonExeFor 指向的文件必须存在 */
  const pyDir = join(root, 'runtime', 'python')
  mkdirSync(pyDir, { recursive: true })
  writeFileSync(join(pyDir, 'python.exe'), '', 'utf8')

  /* ② 配置与清单 */
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({ dataRoot: root, portMin: 6100, portMax: 6299, backupKeep: 5 }),
    'utf8'
  )
  writeFileSync(join(root, 'instances.json'), JSON.stringify({ instances: [] }), 'utf8')
  writeFileSync(join(root, 'runtimes.json'), JSON.stringify({ versions: [] }), 'utf8')

  const ran: Array<{ cmd: string; args: string[] }> = []
  const h = buildHandlers({
    probe: () => Promise.resolve(false),
    /*
     * ★ 记账的执行器：不是"假装成功"，而是**捕获参数**。
     * 这就是"严格验证"与"源码守卫"的区别。
     */
    runCommand: async (cmd, args) => {
      ran.push({ cmd, args })
      return { status: 0, stdout: '', stderr: '' }
    },
    /*
     * 让列版本能返回 v4.28.0 —— 否则 install 会在"找不到这个版本"处抛错，
     * 根本走不到 pip（那样测试就变成了空转）。
     */
    fetchManifest: async () =>
      JSON.stringify({ version: '0.1.7', url: 'x.exe', size: 1, sha256: 'aa' })
  })

  await h['config:set']({ dataRoot: root })
  if (opts.prefSource) {
    try {
      await h['pysrc:pref'](opts.prefSource)
    } catch {
      /* 通道不存在就跳过（不影响"点哪个源"的断言） */
    }
  }

  try {
    await h['runtime:install']({ type: 'a', tag: 'v4.28.0', base: opts.base })
  } catch {
    /*
     * 安装失败无所谓 —— 我们要的是"pip 参数里用了哪个源"。
     * 走到 pip 那一步就够了（前置检查失败时 ran 会是空的，断言会报出来）。
     */
  }
  return { ran }
}

/** 从捕获的命令里取出 pip 的 -i 参数 */
function pipIndexOf(ran: Array<{ cmd: string; args: string[] }>): string | undefined {
  const pip = ran.find((r) => r.args.includes('pip') && r.args.includes('install'))
  if (!pip) return undefined
  const i = pip.args.indexOf('-i')
  return i >= 0 ? pip.args[i + 1] : undefined
}

describe('★★★点哪个源就用哪个源（捕获真实 pip 参数）', () => {
  it('★点腾讯源 → pip 的 -i 必须是腾讯云', async () => {
    /*
     * 关键设计：**把配置里的首选源设成 PyPI**。
     * 这样如果实现仍然只看配置，捕获到的就是 PyPI —— 测试立刻失败。
     * 这正是主人看到的"点哪个都是 python 源"。
     */
    const { ran } = await installWith({ base: TENCENT, prefSource: PYPI })
    const used = pipIndexOf(ran)
    expect(
      used,
      `应当执行过 pip install 并带 -i（实际捕获 ${ran.length} 条命令：` +
        `${ran.map((r) => r.args.slice(0, 2).join(' ')).join(' | ')}）`
    ).toBeTruthy()
    expect(
      used,
      `★ 用户点的是腾讯源，pip 必须用它。\n` +
        `    实际用了：${used}\n` +
        `    这正是主人实测到的 bug：只看配置里的首选源（PyPI），界面点哪个都不管用。`
    ).toBe(TENCENT)
  }, 60_000)

  it('★点 Python源(PyPI) → pip 的 -i 必须是 PyPI（配置里是腾讯也一样）', async () => {
    const { ran } = await installWith({ base: PYPI, prefSource: TENCENT })
    const used = pipIndexOf(ran)
    expect(used).toBeTruthy()
    expect(
      used,
      '配置里是腾讯源、但用户点的是 Python源 —— pip 必须用用户点的那个'
    ).toBe(PYPI)
  }, 60_000)

  it('★点清华源 → pip 的 -i 必须是清华', async () => {
    const TUNA = 'https://pypi.tuna.tsinghua.edu.cn/simple/'
    const { ran } = await installWith({ base: TUNA, prefSource: PYPI })
    expect(pipIndexOf(ran), '三个源要各用各的，不能都落到同一个').toBe(TUNA)
  }, 60_000)

  it('界面没指定源 → 回落到配置里的首选源（不能因此装不了）', async () => {
    const { ran } = await installWith({ prefSource: TENCENT })
    const used = pipIndexOf(ran)
    expect(used, '没指定源也必须能走到 pip（回落路径）').toBeTruthy()
    expect(used, '回落时用配置里的首选源').toBe(TENCENT)
  }, 60_000)

  it('配置里也没有首选源 → 用内置表第一个', async () => {
    const { ran } = await installWith({})
    const used = pipIndexOf(ran)
    expect(used).toBeTruthy()
    expect(used).toBe(BUILTIN_PYTHON_SOURCES[0].indexUrl)
  }, 60_000)
})
