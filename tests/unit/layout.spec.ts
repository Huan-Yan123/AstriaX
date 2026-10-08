import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { resolveLaunchSpec, detectLayout } from '../../src/main/runtime/layout'
import { testStage } from '../helpers/stage'

let root: string

beforeEach(() => {
  root = testStage('mx-layout-')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function fakeAstrBot(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'main.py'), 'print("astrbot")', 'utf8')
  writeFileSync(join(dir, 'requirements.txt'), 'aiohttp', 'utf8')
}

/**
 * 造 Shell 版 NapCat 布局（现在下载的就是这个）。
 * 它靠注入已装 QQ 运行：launcher-win10.bat + NapCatWinBootMain.exe + NapCatWinBootHook.dll。
 */
function fakeNapCat(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'launcher-win10.bat'), '@echo off\r\nNapCatWinBootMain.exe QQ.exe NapCatWinBootHook.dll', 'utf8')
  writeFileSync(join(dir, 'launcher.bat'), '@echo off\r\nwt.exe', 'utf8')
  writeFileSync(join(dir, 'NapCatWinBootMain.exe'), 'MZ', 'utf8')
  writeFileSync(join(dir, 'NapCatWinBootHook.dll'), 'MZ', 'utf8')
  writeFileSync(join(dir, 'napcat.mjs'), '// napcat', 'utf8')
  writeFileSync(join(dir, 'qqnt.json'), '{}', 'utf8')
  mkdirSync(join(dir, 'config'), { recursive: true })
}

/** 旧的 Windows.Node 版布局（已不再下载，但要能兼容已装的） */
function fakeNapcatLegacyNode(dir: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'node.exe'), 'MZ', 'utf8')
  writeFileSync(join(dir, 'index.js'), '// napcat', 'utf8')
}

describe('运行时布局识别', () => {
  it('认 AstrBot：根目录有 main.py', () => {
    const dir = join(root, 'a')
    fakeAstrBot(dir)
    expect(detectLayout(dir)).toBe('astrbot')
  })

  it('认 NapCat（Shell 版）：根目录有 launcher.bat + napcat.mjs', () => {
    const dir = join(root, 'n')
    fakeNapCat(dir)
    expect(detectLayout(dir)).toBe('napcat')
  })

  it('认 NapCat（旧的 node 版）：根目录有 node.exe + index.js', () => {
    const dir = join(root, 'n-legacy')
    fakeNapcatLegacyNode(dir)
    expect(detectLayout(dir)).toBe('napcat')
  })

  it('认不出 → unknown（UI 可提示结构不对）', () => {
    const dir = join(root, 'x')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'readme.txt'), 'nothing', 'utf8')
    expect(detectLayout(dir)).toBe('unknown')
  })

  it('认 PyPI 形态的 AstrBot：有 astrbot 包 + mxbot-runtime.json 标记', () => {
    const dir = join(root, 'py-a')
    mkdirSync(join(dir, 'astrbot'), { recursive: true })
    writeFileSync(join(dir, 'mxbot-runtime.json'), JSON.stringify({ tag: 'v4.28.0', kind: 'pypi' }), 'utf8')
    expect(detectLayout(dir)).toBe('astrbot')
  })
})

describe('启动命令生成', () => {
  it('AstrBot：用内置 Python 3.12 跑 main.py（不是系统的）', () => {
    const inst = join(root, 'inst-a')
    fakeAstrBot(inst)
    const python = join(root, 'runtime', 'python', 'python.exe')
    const spec = resolveLaunchSpec({ type: 'a', dir: inst, pythonExe: python, port: 6100 })
    expect(spec.cmd).toBe(python)
    // AstrBot 的 WebUI 端口由配置决定，启动时带 --port 便于首启占位
    // main.py 用绝对路径：cwd 现在是实例目录（数据各归各的），相对路径会找不到入口
    expect(spec.args.some((a) => a.endsWith('main.py'))).toBe(true)
    expect(spec.args).toContain('--port')
    expect(spec.args).toContain('6100')
    expect(spec.cwd).toBe(inst)
    expect(spec.useBuiltinPython).toBe(true)
  })

  it('AstrBot 缺内置 Python → 明确报错（不静默用系统解释器）', () => {
    const inst = join(root, 'inst-a2')
    fakeAstrBot(inst)
    expect(() => resolveLaunchSpec({ type: 'a', dir: inst, pythonExe: undefined, port: 6101 })).toThrow(/Python/)
  })

  it('NapCat：直接起 NapCatWinBootMain.exe（注入已装 QQ），不需要 Python', () => {
    const inst = join(root, 'inst-n')
    fakeNapCat(inst)
    const spec = resolveLaunchSpec({
      type: 'n',
      dir: inst,
      pythonExe: undefined,
      port: 6200,
      qqExe: 'E:\\QQ\\QQ.exe'
    })
    // 不走 bat：绕开它的 net session + runas（那会弹出提权窗口并让我们丢掉子进程控制权）
    expect(spec.cmd).toBe(join(inst, 'NapCatWinBootMain.exe'))
    expect(spec.args).toEqual(['E:\\QQ\\QQ.exe', join(inst, 'NapCatWinBootHook.dll')])
    // cwd 必须是运行时目录：qqnt.json / loadNapCat.js / napcat.mjs 都靠它定位
    expect(spec.cwd).toBe(inst)
    expect(spec.useBuiltinPython).toBe(false)
    // 注入 QQ 要管理员
    expect(spec.needsAdmin).toBe(true)
  })

  it('NapCat 缺 NapCatWinBootMain.exe → 报错让用户重新下载', () => {
    const inst = join(root, 'inst-n2')
    mkdirSync(inst, { recursive: true })
    // 有 napcat.mjs 所以结构能认出是 NapCat，但缺注入器 → 要明确报错
    writeFileSync(join(inst, 'napcat.mjs'), '// x', 'utf8')
    expect(() =>
      resolveLaunchSpec({ type: 'n', dir: inst, pythonExe: undefined, port: 6201, qqExe: 'E:\\QQ\\QQ.exe' })
    ).toThrow(/NapCatWinBootMain|不完整/)
  })

  it('NapCat 缺 NapCatWinBootHook.dll → 同样报错（不给半残启动）', () => {
    const inst = join(root, 'inst-n2b')
    mkdirSync(inst, { recursive: true })
    writeFileSync(join(inst, 'napcat.mjs'), '// x', 'utf8')
    writeFileSync(join(inst, 'NapCatWinBootMain.exe'), 'MZ', 'utf8')
    expect(() =>
      resolveLaunchSpec({ type: 'n', dir: inst, pythonExe: undefined, port: 6201, qqExe: 'E:\\QQ\\QQ.exe' })
    ).toThrow(/Hook|不完整/)
  })

  it('NapCat 写不出 QQ 路径时明确报错（不静默启动）', () => {
    const inst = join(root, 'inst-n3')
    fakeNapCat(inst)
    expect(() => resolveLaunchSpec({ type: 'n', dir: inst, pythonExe: undefined, port: 6202 })).toThrow(
      /QQ/
    )
  })

  it('AstrBot 首启要装依赖：给出 pip install 步骤（用内置 python 的 pip）', () => {
    const inst = join(root, 'inst-a3')
    fakeAstrBot(inst)
    const python = join(root, 'runtime', 'python', 'python.exe')
    const spec = resolveLaunchSpec({ type: 'a', dir: inst, pythonExe: python, port: 6102 })
    expect(spec.env?.MX_PYTHON).toBe(python)
    expect(spec.env?.PYTHONHOME).toBe(join(root, 'runtime', 'python'))
    // 依赖清单存在时，声明需要先装依赖
    expect(spec.requiresDeps).toBe(true)
  })

  it('PyPI 形态 AstrBot：跑 `-m astrbot.cli run`，并带上 MXBOT_SITE（PYTHONPATH 在 embed 下无效）', () => {
    const inst = join(root, 'inst-pypi')
    mkdirSync(join(inst, 'astrbot'), { recursive: true })
    writeFileSync(join(inst, 'mxbot-runtime.json'), JSON.stringify({ tag: 'v4.28.0', kind: 'pypi' }), 'utf8')
    const python = join(root, 'runtime', 'python', 'python.exe')

    const spec = resolveLaunchSpec({ type: 'a', dir: inst, pythonExe: python, port: 6100, dataRoot: root })
    expect(spec.cmd).toBe(python)
    /*
     * 必须是 `-m astrbot.cli run`。曾经写成 `-m astrbot`，实机报错：
     *   No module named astrbot.__main__; 'astrbot' is a package and
     *   cannot be directly executed
     * astrbot 包根没有 __main__.py，真实入口在 entry_points.txt 写的
     * astrbot = astrbot.cli.__main__:cli，而 --port 是 run 子命令的选项。
     */
    expect(spec.args.slice(0, 3)).toEqual(['-m', 'astrbot.cli', 'run'])
    expect(spec.args).toContain('6100')
    // 关键：embed 版带 ._pth 会忽略 PYTHONPATH，必须靠 MXBOT_SITE + sitecustomize
    expect(spec.env?.MXBOT_SITE).toBe(inst)
    // 同时保留 PYTHONPATH 作为非 embed 解释器的兜底
    expect(spec.env?.PYTHONPATH).toBe(inst)
  })
})
