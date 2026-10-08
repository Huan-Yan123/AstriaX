import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { pythonEnvFor, ensureSiteCustomize } from '../../src/main/runtime/python-runtime'
import { resolveLaunchSpec } from '../../src/main/runtime/layout'
import { mkdirSync, writeFileSync } from 'fs'
import { testStage } from '../helpers/stage'

/**
 * AstrBot 真能启动所需的每一个前提，都在这里钉住。
 *
 * 这些不是"理论上应该"——每一条都是实机踩出来的，报错原文都记在注释里。
 * 谁要是把这些"清理"掉，AstrBot 会以各种难懂的姿势挂掉，所以钉死。
 */
describe('AstrBot 能启动的硬前提', () => {
  let root = ''
  beforeEach(() => {
    root = testStage('mxbot-abpre-')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('入口是 `-m astrbot.cli run --port N`，不是 `-m astrbot`', () => {
    /*
     * 实机报错（原来的写法）：
     *   No module named astrbot.__main__; 'astrbot' is a package and
     *   cannot be directly executed
     * astrbot 包根目录没有 __main__.py。真实入口在 wheel 的 entry_points.txt：
     *   [console_scripts]
     *   astrbot = astrbot.cli.__main__:cli
     * 而 cli 是 click group，--port 挂在 run 子命令上。
     */
    const dir = join(root, 'rt')
    mkdirSync(join(dir, 'astrbot'), { recursive: true })
    writeFileSync(join(dir, 'mxbot-runtime.json'), '{"kind":"pypi"}', 'utf8')

    const spec = resolveLaunchSpec({
      type: 'a',
      dir,
      instanceDir: join(root, 'inst'),
      pythonExe: 'E:\\py\\python.exe',
      port: 6102
    })
    expect(spec.args).toEqual(['-m', 'astrbot.cli', 'run', '--port', '6102'])
  })

  it('PYTHONIOENCODING=utf-8：不设会丢掉初始账密', () => {
    /*
     * 实机现象：中文 Windows 控制台默认 GBK，AstrBot 启动时打的欢迎语里有 ✨，
     * 直接炸 UnicodeEncodeError。被炸掉的正是含初始账号密码的那一行 ——
     * 用户因此拿不到凭据，登不上面板，而界面上只会看到一段 logging error。
     */
    const env = pythonEnvFor({ dataRoot: root })
    expect(env.PYTHONIOENCODING).toBe('utf-8')
    expect(env.PYTHONUTF8).toBe('1')
  })

  it('不会把外部 PYTHONPATH 串进子进程', () => {
    // 继承外部 PYTHONPATH 会把系统解释器的包带进来，多开时互相污染
    const env = pythonEnvFor({ dataRoot: root, extra: { PYTHONPATH: 'C:\\somewhere\\bad' } })
    expect(env.PYTHONPATH).toBeUndefined()
  })

  it('sitecustomize.py 补上 pywin32 在 --target 下缺失的三条路径', async () => {
    /*
     * `pip install --target` 不跑 post-install，pywin32.pth 永远不生效。
     * 它本该做的三件事（win32 / win32\lib / pythonwin + import pywin32_bootstrap）
     * 全都没人做，于是 AstrBot 炸：
     *   ModuleNotFoundError: No module named 'pywintypes'
     * 包明明在，只是路没接上 —— 这个报错极具误导性。
     */
    const { ensureSiteCustomize } = await import('../../src/main/runtime/python-runtime')
    ensureSiteCustomize(root)
    const f = join(root, 'Lib', 'site-packages', 'sitecustomize.py')
    expect(existsSync(f)).toBe(true)
    const body = readFileSync(f, 'utf8')
    expect(body).toContain('win32')
    expect(body).toContain('pywin32_bootstrap')
    expect(body).toContain('MXBOT_SITE')
  })
})
