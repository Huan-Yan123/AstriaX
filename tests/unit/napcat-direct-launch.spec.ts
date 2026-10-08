import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveLaunchSpec } from '../../src/main/runtime/layout'
import { testStage } from '../helpers/stage'

/**
 * NapCat（Shell 版）的启动方式：**直接起 NapCatWinBootMain.exe**，
 * 不经过官方 launcher.bat。
 *
 * 这是照着 NapCatQQ-Desktop（一个能正常多开 NapCat 且不弹黑框的项目）的做法来的，
 * 它的 Rust 源码里就是这么拼的：
 *   program = <napcat_dir>/NapCatWinBootMain.exe
 *   args    = [ QQ.exe, NapCatWinBootHook.dll, <bot_id> ]
 *   env     = NAPCAT_PATCH_PACKAGE / NAPCAT_LOAD_PATH / NAPCAT_INJECT_PATH
 *             NAPCAT_LAUNCHER_PATH / NAPCAT_MAIN_PATH
 *   cwd     = <napcat_dir>
 *   子进程一律加 CREATE_NO_WINDOW（避免弹黑框）
 *
 * 为什么不能跑 bat（我们踩过的两个坑）：
 * 1. bat 里有 `net session` 自检 + `runas` 重开自己 —— 拉起来的是**另一个提权进程**，
 *    我们 spawn 的那个立刻退出，句柄/stdout/进程树全丢，用户点「停止」停不掉真的那个。
 * 2. bat 直接同步调用 CUI 程序（NapCatWinBootMain.exe 的 PE Subsystem = 3），
 *    在 detached 场景下 Windows 会给它**新建一个可见控制台** → 黑框糊到用户脸上。
 *
 * 第三个参数是 QQ 号（bot_id）：NapCat 拿它做快速登录和数据文件命名
 * （onebot11_<QQ号>.json），这也是多开隔离的关键。
 */
describe('NapCat 直接启动 NapCatWinBootMain.exe（不走 bat）', () => {
  let root = ''
  beforeEach(() => {
    root = testStage('mxbot-nclaunch-')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** 造一个 Shell 版 NapCat 运行时 */
  function mkRuntime(rt: string): void {
    mkdirSync(rt, { recursive: true })
    writeFileSync(join(rt, 'NapCatWinBootMain.exe'), 'MZ', 'utf8')
    writeFileSync(join(rt, 'NapCatWinBootHook.dll'), 'MZ', 'utf8')
    writeFileSync(join(rt, 'napcat.mjs'), '// x', 'utf8')
    writeFileSync(join(rt, 'qqnt.json'), '{}', 'utf8')
    writeFileSync(join(rt, 'launcher-win10.bat'), '@echo off', 'utf8')
  }

  it('启动的是 NapCatWinBootMain.exe，不是 cmd/bat', () => {
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    const inst = join(root, 'instances', 'NapCat', 'n_1')
    mkdirSync(inst, { recursive: true })
    mkRuntime(rt)

    const spec = resolveLaunchSpec({
      type: 'n',
      dir: rt,
      instanceDir: inst,
      port: 6200,
      dataRoot: root,
      qqExe: 'E:\\QQ\\QQ.exe'
    })

    expect(spec.cmd).toBe(join(rt, 'NapCatWinBootMain.exe'))
    // 不经过 cmd.exe，也就绕开了 bat 的 net session + runas（那才是弹窗/丢控的根源）
    expect(spec.args[0]).not.toContain('.bat')
    expect(spec.cmd).not.toBe('cmd.exe')
  })

  it('参数是 QQ.exe + Hook.dll + 可选 QQ 号', () => {
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    const inst = join(root, 'instances', 'NapCat', 'n_1')
    mkdirSync(inst, { recursive: true })
    mkRuntime(rt)

    const spec = resolveLaunchSpec({
      type: 'n',
      dir: rt,
      instanceDir: inst,
      port: 6200,
      dataRoot: root,
      qqExe: 'E:\\QQ\\QQ.exe',
      qqAccount: '2250713669'
    })

    expect(spec.args).toEqual([
      'E:\\QQ\\QQ.exe',
      join(rt, 'NapCatWinBootHook.dll'),
      '2250713669'
    ])
  })

  it('没填 QQ 号时只给两个参数（NapCat 会走扫码登录）', () => {
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    const inst = join(root, 'instances', 'NapCat', 'n_1')
    mkdirSync(inst, { recursive: true })
    mkRuntime(rt)

    const spec = resolveLaunchSpec({
      type: 'n',
      dir: rt,
      instanceDir: inst,
      port: 6200,
      dataRoot: root,
      qqExe: 'E:\\QQ\\QQ.exe'
    })
    expect(spec.args).toHaveLength(2)
  })

  it('五个 NAPCAT_* 环境变量都要给全（bat 里也是这几个）', () => {
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    const inst = join(root, 'instances', 'NapCat', 'n_1')
    mkdirSync(inst, { recursive: true })
    mkRuntime(rt)

    const spec = resolveLaunchSpec({
      type: 'n',
      dir: rt,
      instanceDir: inst,
      port: 6200,
      dataRoot: root,
      qqExe: 'E:\\QQ\\QQ.exe'
    })

    const env = spec.env ?? {}
    expect(env.NAPCAT_PATCH_PACKAGE).toBe(join(rt, 'qqnt.json'))
    expect(env.NAPCAT_LOAD_PATH).toBe(join(rt, 'loadNapCat.js'))
    expect(env.NAPCAT_INJECT_PATH).toBe(join(rt, 'NapCatWinBootHook.dll'))
    expect(env.NAPCAT_LAUNCHER_PATH).toBe(join(rt, 'NapCatWinBootMain.exe'))
    expect(env.NAPCAT_MAIN_PATH).toBe(join(rt, 'napcat.mjs'))
  })

  it('cwd 是运行时目录（qqnt.json / loadNapCat.js 都靠它定位）', () => {
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    const inst = join(root, 'instances', 'NapCat', 'n_1')
    mkdirSync(inst, { recursive: true })
    mkRuntime(rt)

    const spec = resolveLaunchSpec({
      type: 'n',
      dir: rt,
      instanceDir: inst,
      port: 6200,
      dataRoot: root,
      qqExe: 'E:\\QQ\\QQ.exe'
    })
    expect(spec.cwd).toBe(rt)
  })

  it('数据隔离仍然靠 NAPCAT_WORKDIR + 端口；Token 只在明确要求时注入', () => {
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    const inst = join(root, 'instances', 'NapCat', 'n_1')
    mkdirSync(inst, { recursive: true })
    mkRuntime(rt)

    const spec = resolveLaunchSpec({
      type: 'n',
      dir: rt,
      instanceDir: inst,
      port: 6234,
      dataRoot: root,
      qqExe: 'E:\\QQ\\QQ.exe'
    })
    expect(spec.env?.NAPCAT_WORKDIR).toBe(inst)
    expect(spec.env?.NAPCAT_WEBUI_PREFERRED_PORT).toBe('6234')
    /*
     * Token **不再无条件注入**：注入就会被 NapCat 写回配置文件，
     * 把用户自己改过的 token 覆盖掉（用户反馈过这个问题）。
     * 调用方只有在该实例还没有 token 时才传值过来。
     */
    expect(spec.env?.NAPCAT_WEBUI_SECRET_KEY, '不该无条件覆盖用户的 token').toBeUndefined()
  })

  it('缺 NapCatWinBootMain.exe → 明确报错（不静默退化成 bat）', () => {
    const rt = join(root, 'runtimes', 'n', 'v4.18.19')
    mkdirSync(rt, { recursive: true })
    writeFileSync(join(rt, 'napcat.mjs'), '// x', 'utf8')
    writeFileSync(join(rt, 'launcher-win10.bat'), '@echo off', 'utf8')
    expect(() =>
      resolveLaunchSpec({ type: 'n', dir: rt, port: 6200, dataRoot: root, qqExe: 'E:\\QQ\\QQ.exe' })
    ).toThrow(/NapCatWinBootMain|重新下载/)
  })
})
