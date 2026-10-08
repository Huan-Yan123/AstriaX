import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveLaunchSpec } from '../../src/main/runtime/layout'
import { testStage } from '../helpers/stage'

/**
 * 实例数据必须各归各的，代码共享。
 *
 * 真 bug：cwd 原来指向共享的 runtimes\<tag>\，而 AstrBot 把数据写进 <cwd>\data、
 * NapCat 把配置写进 <cwd>\config。于是**所有同类实例共用一个数据目录**——
 * 账密互相覆盖、重置了不生效、备份也保不到东西（实例目录里根本没有 runtime）。
 *
 * 两类的解法不同：
 * - AstrBot：直接把 cwd 设成实例目录（它从 cwd 找 data\）。
 * - NapCat：cwd **必须**是运行时目录（官方 launcher.bat 全靠 %cd% 定位
 *   qqnt.json / loadNapCat.js / NapCatWinBootHook.dll，挪了就注入不了），
 *   所以改用官方的 NAPCAT_WORKDIR 环境变量把 config/logs/plugins/cache
 *   重定向到实例目录 —— 代码共享、数据隔离，两边都满足。
 */
describe('实例数据必须隔离（代码共享、数据各归各的）', () => {
  let root = ''
  beforeEach(() => {
    root = testStage('mxbot-cwd-')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /**
   * 造一个 Shell 版 NapCat 运行时目录。
   * 现在不再跑 bat，而是直接起 NapCatWinBootMain.exe，所以这些文件都得在：
   * 注入器、Hook dll、napcat.mjs、qqnt.json（缺一个都会明确报错，不半残启动）。
   */
  function mkNapcatRuntime(rt: string): void {
    mkdirSync(rt, { recursive: true })
    writeFileSync(join(rt, 'NapCatWinBootMain.exe'), 'MZ', 'utf8')
    writeFileSync(join(rt, 'NapCatWinBootHook.dll'), 'MZ', 'utf8')
    writeFileSync(join(rt, 'napcat.mjs'), '// x', 'utf8')
    writeFileSync(join(rt, 'qqnt.json'), '{}', 'utf8')
    // bat 仍然留在包里（官方包自带），但我们不靠它启动
    writeFileSync(join(rt, 'launcher-win10.bat'), '@echo off', 'utf8')
  }

  /** 测试里反复要传的 QQ 路径（真机上由注册表解析出来） */
  const QQ = 'E:\\QQ\\QQ.exe'

  it('AstrBot：cwd 是实例目录，运行时目录只用来放代码', () => {
    const rt = join(root, 'runtimes', 'a', 'v4.28.0')
    const inst = join(root, 'instances', 'AstrBot', 'a_1')
    mkdirSync(rt, { recursive: true })
    mkdirSync(inst, { recursive: true })
    mkdirSync(join(rt, 'astrbot'), { recursive: true })
    writeFileSync(join(rt, 'mxbot-runtime.json'), JSON.stringify({ kind: 'pypi' }), 'utf8')

    const spec = resolveLaunchSpec({
      type: 'a',
      dir: rt,
      instanceDir: inst,
      pythonExe: join(root, 'runtime', 'python', 'python.exe'),
      port: 6100,
      dataRoot: root
    })

    expect(spec.cwd).toBe(inst)
    // 代码位置仍然靠 MXBOT_SITE 指到共享运行时
    expect(spec.env?.MXBOT_SITE).toBe(rt)
  })

  it('NapCat：cwd 是运行时目录（注入要靠它找文件），数据靠 NAPCAT_WORKDIR 隔离', () => {
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    const inst = join(root, 'instances', 'NapCat', 'n_1')
    mkdirSync(inst, { recursive: true })
    mkNapcatRuntime(rt)

    const spec = resolveLaunchSpec({
      type: 'n',
      dir: rt,
      instanceDir: inst,
      port: 6200,
      dataRoot: root,
      qqExe: QQ
    })

    // qqnt.json / loadNapCat.js / napcat.mjs 都在运行时目录，所以 cwd 只能是它
    expect(spec.cwd).toBe(rt)
    // 直接起注入器，不经过 cmd/bat
    expect(spec.cmd).toBe(join(rt, 'NapCatWinBootMain.exe'))
    // 数据隔离靠官方开关：config/logs/plugins/cache 都落到实例目录
    expect(spec.env?.NAPCAT_WORKDIR).toBe(inst)
  })

  it('两个 NapCat 实例的数据目录互不相同（否则配置会互相覆盖）', () => {
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    mkNapcatRuntime(rt)
    const i1 = join(root, 'instances', 'NapCat', 'n_1')
    const i2 = join(root, 'instances', 'NapCat', 'n_2')
    mkdirSync(i1, { recursive: true })
    mkdirSync(i2, { recursive: true })

    const s1 = resolveLaunchSpec({
      type: 'n',
      dir: rt,
      instanceDir: i1,
      port: 6200,
      dataRoot: root,
      qqExe: QQ
    })
    const s2 = resolveLaunchSpec({
      type: 'n',
      dir: rt,
      instanceDir: i2,
      port: 6201,
      dataRoot: root,
      qqExe: QQ
    })
    expect(s1.env?.NAPCAT_WORKDIR).not.toBe(s2.env?.NAPCAT_WORKDIR)
    expect(s1.env?.NAPCAT_WORKDIR).toBe(i1)
    expect(s2.env?.NAPCAT_WORKDIR).toBe(i2)
  })

  it('没传 instanceDir 时不设 NAPCAT_WORKDIR（退回 NapCat 默认行为，不炸）', () => {
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    mkNapcatRuntime(rt)
    const spec = resolveLaunchSpec({ type: 'n', dir: rt, port: 6200, dataRoot: root, qqExe: QQ })
    expect(spec.cwd).toBe(rt)
    expect(spec.env?.NAPCAT_WORKDIR).toBeUndefined()
  })

  it('NapCat：端口靠环境变量传；没指定 token 时**不传**这个变量（不覆盖用户改过的 token）', () => {
    // 端口：NapCat 的 WebUI 默认写死 6099，不传的话第二个实例必然起不来
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    const inst = join(root, 'instances', 'NapCat', 'n_1')
    mkdirSync(inst, { recursive: true })
    mkNapcatRuntime(rt)

    const spec = resolveLaunchSpec({
      type: 'n',
      dir: rt,
      instanceDir: inst,
      port: 6234,
      dataRoot: root,
      qqExe: QQ
    })
    expect(spec.env?.NAPCAT_WEBUI_PREFERRED_PORT).toBe('6234')
    /*
     * 关键变化：没传 webuiToken 时**绝不能**塞默认值。
     *
     * 原来这里无条件写 `NAPCAT_WEBUI_SECRET_KEY: '114514'`，而 NapCat 每次启动
     * 都会拿它写回 webui.json —— 用户在 WebUI 里改过的 token 每次启动被冲回
     * 114514（用户反馈「掉自动覆盖 napcat 的 token」）。现在由调用方先读实例
     * 已有配置，已经有 token 就不传，让 NapCat 用配置文件里的值。
     */
    expect(
      spec.env?.NAPCAT_WEBUI_SECRET_KEY,
      '没明确要求时不该注入 token，否则会覆盖用户改过的值'
    ).toBeUndefined()
  })

  it('NapCat：明确传了 webuiToken 时才注入（首次启动给默认值 / 用户点重置）', () => {
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    const inst = join(root, 'instances', 'NapCat', 'n_2')
    mkdirSync(inst, { recursive: true })
    mkNapcatRuntime(rt)
    const spec = resolveLaunchSpec({
      type: 'n',
      dir: rt,
      instanceDir: inst,
      port: 6235,
      dataRoot: root,
      qqExe: QQ,
      webuiToken: 'my-own-token'
    })
    expect(spec.env?.NAPCAT_WEBUI_SECRET_KEY).toBe('my-own-token')
  })

  it('NapCat 完全不需要 Python（哪怕内置 Python 没装也能启动）', () => {
    // 实测 Shell 包：napcat.mjs 里 "python" 出现 0 次，包内没有任何 .py/.pyc/.whl，
    // 原生依赖全是 .node/.dll。它是注入进 QQ.exe、借用 QQ 自带的 Node 运行时跑的，
    // 跟 Python 毫无关系。所以 useBuiltinPython 必须是 false，
    // 且该分支不能因为「Python 没装」而报错（AstrBot 才会）。
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    const inst = join(root, 'instances', 'NapCat', 'n_1')
    mkdirSync(inst, { recursive: true })
    mkNapcatRuntime(rt)

    const spec = resolveLaunchSpec({
      type: 'n',
      dir: rt,
      instanceDir: inst,
      pythonExe: undefined, // 故意不提供内置 Python
      port: 6200,
      dataRoot: root,
      qqExe: QQ
    })
    expect(spec.useBuiltinPython).toBe(false)
    // 不能把内置 Python 的路径混进环境变量
    expect(spec.env?.MX_PYTHON).toBeUndefined()
    expect(spec.env?.MXBOT_SITE).toBeUndefined()
    expect(spec.requiresDeps).toBe(false)
  })

  it('AstrBot 的配置读写位置和启动目录一致（否则重置密码写了不生效）', () => {
    const rt = join(root, 'runtimes', 'a', 'v4.28.0')
    const inst = join(root, 'instances', 'AstrBot', 'a_1')
    mkdirSync(rt, { recursive: true })
    mkdirSync(inst, { recursive: true })
    mkdirSync(join(rt, 'astrbot'), { recursive: true })
    writeFileSync(join(rt, 'mxbot-runtime.json'), JSON.stringify({ kind: 'pypi' }), 'utf8')

    const spec = resolveLaunchSpec({
      type: 'a',
      dir: rt,
      instanceDir: inst,
      pythonExe: join(root, 'runtime', 'python', 'python.exe'),
      port: 6100,
      dataRoot: root
    })
    // resetCredentials 写的是 <实例>\data\config\astrbot_config.json，
    // 进程必须也从这里读，所以 cwd 必须等于实例目录
    expect(spec.cwd).toBe(inst)
    expect(readFileSync(join(rt, 'mxbot-runtime.json'), 'utf8')).toContain('pypi')
  })
})
