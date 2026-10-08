/*
 * ★★★ 严格验证：「点哪个源，就用哪个源下载」
 *   （主人 2026-09-27：「严格验证是否我点哪个源就是从哪个源下载」）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么这件事值得"严格验证"
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人的怀疑（原话）：
 *   「为啥要有用这个的选项，我用哪个我直接点下载不就好了」
 *   「真的是用对应的源来下载的吗，这么混乱」
 *
 * 查下去发现**他猜对了，而且比他说的更严重**：
 *
 *     const pySrc = resolvePythonSource(cfg.dataRoot)
 *
 * 主进程只读**配置里的首选源**，界面传下来的 `p.base`（用户点的那张卡片）
 * **从头到尾没被看过** —— 也就是说：
 *
 *     无论点腾讯源还是清华源，pip 用的都是同一个源。
 *
 * 「点哪个源就用哪个源」**从来没有实现过**。
 *
 * ## 为什么不用"跑一次真安装"来验证
 *
 * 试过：`runtime:install` 里的 `run` 是**直接 import 的**（`await import(
 * './util/async-exec')`），没有注入点 —— 要截获 pip 的真实参数就得真起
 * pip 进程（几分钟 + 联网），单测不该这么干。
 *
 * 所以分两层验证，合起来等价于"严格"：
 *
 *   ① **纯函数层**：`findPythonSource` 能否按 indexUrl 精确找到源
 *      （找到的那个就是喂给 pip 的，见 ② 的守卫）
 *   ② **源码守卫**：`runtime:install` 里必须先看 `p.base`、找不到才回落 ——
 *      直接钉住那几行的形状，防止有人改回"只看配置"
 *
 * ② 是关键：**接口对了不等于接线对了**（本项目反复出现的教训）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  BUILTIN_PYTHON_SOURCES,
  findPythonSource,
  pythonSourceToPipArgs
} from '../../src/main/update/python-source'

const TENCENT = 'https://mirrors.cloud.tencent.com/pypi/simple/'
const PYPI = 'https://pypi.org/simple/'

/** 去掉注释，避免把说明文字当代码 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
    .join('\n')
}

describe('① findPythonSource：按 indexUrl 精确找到用户点的那个源', () => {
  it('腾讯源的 indexUrl → 找到腾讯源', () => {
    const s = findPythonSource(BUILTIN_PYTHON_SOURCES, TENCENT)
    expect(s, 'indexUrl 必须能查到源（这是"点哪个用哪个"的落点）').toBeTruthy()
    expect(s!.indexUrl).toBe(TENCENT)
  })

  it('PyPI 的 indexUrl → 找到 PyPI', () => {
    const s = findPythonSource(BUILTIN_PYTHON_SOURCES, PYPI)
    expect(s!.indexUrl).toBe(PYPI)
  })

  it('★不同源查到的是不同对象（不能都回落到默认源）', () => {
    const a = findPythonSource(BUILTIN_PYTHON_SOURCES, TENCENT)
    const b = findPythonSource(BUILTIN_PYTHON_SOURCES, PYPI)
    expect(a!.indexUrl, '腾讯与 PyPI 必须是两个不同的源').not.toBe(b!.indexUrl)
  })

  it('认不出的地址 → undefined（让对方回落，而不是瞎选一个）', () => {
    expect(findPythonSource(BUILTIN_PYTHON_SOURCES, 'https://not-a-real-mirror.example/')).toBeUndefined()
  })

  it('★拼给 pip 的参数里带着这个源（-i <url>）', () => {
    const s = findPythonSource(BUILTIN_PYTHON_SOURCES, TENCENT)!
    const args = pythonSourceToPipArgs(s)
    const i = args.indexOf('-i')
    expect(i, '要有 -i').toBeGreaterThanOrEqual(0)
    expect(args[i + 1], 'pip 的 -i 就是真正生效的那个源').toBe(TENCENT)
  })
})

describe('② 源码守卫：install 必须先看界面传的 base', () => {
  const IPC = () => readFileSync(join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8')

  it('★runtime:install 里出现"按 p.base 查源"的写法', () => {
    const src = stripComments(IPC())
    /*
     * 改之前这里只有：
     *     const pySrc = resolvePythonSource(cfg.dataRoot)
     * 而现在必须是"拿 p.base 去查"：
     *     const pickedSrc = p.base ? findPythonSource(..., p.base) : undefined
     *     const pySrc = pickedSrc ?? resolvePythonSource(cfg.dataRoot)
     *
     * 正则要够宽：`findPythonSource(<源表>, p.base)` 的第一个参数是
     * `loadPythonSources(...).sources`（表达式，可能含括号），
     * 用 `[^;]*` 匹配到分号为止 —— 只要求"同一句里同时出现
     * findPythonSource 与 p.base"，这才是要守的语义。
     */
    expect(
      /findPythonSource\([^;]*p\.base/.test(src),
      'install 里没有按 p.base 查源的代码 —— 那意味着界面点哪个源都不管用\n' +
        '（这正是改之前的真实行为：只看配置里的首选源）。'
    ).toBe(true)
    expect(
      /pickedSrc\s*\?\?\s*resolvePythonSource/.test(src),
      '没有"优先用界面传的源、找不到才回落配置"这个形状 —— 回落路径必须保留，\n' +
        '否则界面没传源时就装不了了。'
    ).toBe(true)
  })

  it('★不许只靠 resolvePythonSource 决定 pip 源（那正是原 bug）', () => {
    const src = stripComments(IPC())
    /*
     * 找出所有 "resolvePythonSource(cfg.dataRoot)" 的用法，
     * 确认它们**不是**直接被喂给 pip 参数的唯一来源。
     */
    const lines = src.split('\n')
    const idx = lines.findIndex((l) => /const pySrc = resolvePythonSource\(cfg\.dataRoot\)\s*$/.test(l))
    expect(
      idx,
      '又出现了裸的 `const pySrc = resolvePythonSource(cfg.dataRoot)` ——\n' +
        '那是原 bug 的形状（忽略界面选择）。应当走 pickedSrc 优先。'
    ).toBe(-1)
  })
})

describe('③ 渲染层守卫：弹窗必须把点中的源传下去', () => {
  const PAGE = () => readFileSync(join(process.cwd(), 'src', 'renderer', 'src', 'DownloadPage.vue'), 'utf8')

  it('★install() 传的是 indexUrl（Python 源的地址在 indexUrl 上）', () => {
    const src = stripComments(PAGE())
    const i = src.indexOf('async function install')
    expect(i, '找不到 install()').toBeGreaterThan(0)
    const body = src.slice(i, i + 1200)
    expect(
      body,
      'install() 必须把 picking.indexUrl（用户点的那个源）传下去 ——\n' +
        '只传 base 的话，Python 源的 base 是空串，后端拿不到源。'
    ).toMatch(/indexUrl\s*\?\?\s*picking\.value\?\.base/)
  })

  it('★弹窗里不许再有 AstrBot/NapCat 切换器', () => {
    const src = stripComments(PAGE())
    /*
     * 主人：「napcat 源列表点下载里面有 astrbot，astrbot 源点下载里面有 napcat」
     * 根因就是弹窗里那个 seg 切换器 —— 它直接推翻了下载页的分类。
     */
    expect(
      /switchPickType/.test(src),
      '弹窗里又出现了类型切换器 —— 那会让"点哪个源都能看到另一类"，\n' +
        '与下载页的分类（AstrBot 区 / NapCat 区）直接矛盾。'
    ).toBe(false)
    expect(
      /class="seg"/.test(src),
      '`seg`（类型切换器）又回来了 —— 见上条。'
    ).toBe(false)
  })

  it('★版本列表里不再标注文件大小', () => {
    const src = stripComments(PAGE())
    /*
     * 主人：「展开的下载列表不要标注文件大小」。
     * 各版本大小几乎一样（AstrBot 都 6~7MB），那是纯噪音。
     *
     * 注意只查版本列表那段（.vitem 里），不要误伤已装版本列表
     * （那里显示大小是有用的：用户要判断"装了几个、占多大"）。
     */
    const i = src.indexOf('class="vlist"')
    expect(i, '找不到版本列表').toBeGreaterThan(0)
    const body = src.slice(i, i + 1200)
    expect(
      body,
      '版本列表里又出现了 sizeMB —— 各版本大小几乎一样，是噪音。'
    ).not.toMatch(/v\.sizeMB/)
  })
})
