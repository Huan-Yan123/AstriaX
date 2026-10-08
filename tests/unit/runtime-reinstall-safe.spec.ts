/*
 * ★ 重装同一个版本，不能把**已有的可用运行时**弄坏
 *
 * ## 这条测试来自一份真实的崩溃日志（0.1.0 用户导出）
 *
 * `acb-logs-20260914-230529.zip` 的 `audit-2026-09-14.log`：
 *
 *   23:01:13  runtime:install  AstrBot v4.28.0  成功   ← 装好了，实例能跑
 *   23:04:11  runtime:install  AstrBot v4.28.0  失败
 *             :: 装 AstrBot 失败：...
 *                File "shutil.py", line 863, in move
 *                File "<frozen os>", line 225, in makedirs
 *                FileExistsError: [WinError 183] 当文件已存在时，无法创建该文件:
 *                'E:\MXbot\AstriaX\data\runtimes\a\v4.28.0\bs4'
 *   23:05:15  instance:start  1  失败
 *             :: AstrBot 运行时结构不对（...\runtimes\a\v4.28.0），重新下载这个版本
 *
 * 用户只是又点了一次「下载 AstrBot v4.28.0」（同一个版本），
 * 结果**那个原本好好的运行时被毁了**，实例从此再也起不来。
 *
 * ## 两个叠加的根因（都在 ipc.ts 的 runtime:install）
 *
 * 1. **pip 直接装进正在使用的目标目录**
 *        const dest = store.dirFor(p.type, pick.tag)
 *        mkdirSync(dest, { recursive: true })      ← 先建目录
 *        ... pip install --target dest ...          ← 再往"已存在"的目录里装
 *    `pip install --target` 到已存在且已有包的目录时，pip 用 `shutil.move`
 *    把包搬进去；目标子目录已存在 → Windows 上 `makedirs` 抛 WinError 183
 *    （POSIX 会直接覆盖，Windows 不会）。
 *
 * 2. **失败分支把整个目标目录删掉**（这条才是"毁数据"的那一下）
 *        if (r.status !== 0) {
 *          await removeDirAsync(dest)   ← 连原来那份**可用**的安装一起删
 *          throw ...
 *        }
 *    于是 pip 失败之后，用户不是"没更新成"，而是"环境没了"。
 *
 * ## 修法
 *
 * 装进**暂存目录**，校验通过后再原子替换：
 *     pip --target <dest>.stage-<rand>   →  校验本体在  →
 *     旧 dest 改名成 <dest>.old-<rand> → stage 改名成 dest → 删掉 .old
 *
 * 于是：pip 失败时 dest **从未被碰过**（用户还能用旧环境）；
 * 成功后才有替换动作；失败清理只涉及暂存目录。
 *
 * ## ★ 写这条测试时踩的坑（必须记下来）
 *
 * 第一版测试**立刻通过了** —— 那是危险信号，不是好消息。
 * 用 `scripts/_dbg-reinstall.cjs` 把抛错原文打出来才看清：
 *
 *     抛错原文: 还没装内置 Python——先去「下载」页装好 Python 再下载 AstrBot
 *
 * `runtime:install` 在 `ipc.ts:2710` 有前置检查
 * `if (!existsSync(pyExe)) throw ...`，测试环境没有 python.exe →
 * **提前抛出、pip 那行和失败分支一行都没跑**。
 * 而我的断言写的是 `/Python/i`，正好匹配这句提前抛错。
 *
 * 教训：**断言必须来自"我要验的危险行为"，不能来自"我观察到的错误文本"**。
 * 修法：造一个假的 `python.exe`（只为越过 `existsSync`），
 * spawn 一个非可执行文件必然失败 → `run()` 返回 status=-1 →
 * 正好落进那个会删目录的失败分支。
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'
import { testStage } from '../helpers/stage'

/**
 * 造一个"已经装好 v4.28.0"的现场。
 *
 * 关键：要有**真实的包目录内容**（`bs4/` 就是日志里撞的那个子目录），
 * 并且放一个**假的 python.exe** —— 后者是让代码真的走到 pip 失败分支的前提。
 */
function setupInstalled(): { dataRoot: string; dest: string; cleanup: () => void } {
  const dataRoot = testStage('reinstall-')
  const dest = join(dataRoot, 'runtimes', 'a', 'v4.28.0')
  mkdirSync(join(dest, 'astrbot'), { recursive: true })
  writeFileSync(join(dest, 'astrbot', '__init__.py'), '# astrbot', 'utf8')
  // 模拟一个依赖包目录已经存在（日志里撞的就是 bs4）
  mkdirSync(join(dest, 'bs4'), { recursive: true })
  writeFileSync(join(dest, 'bs4', '__init__.py'), '# bs4', 'utf8')

  writeFileSync(
    join(dataRoot, 'runtimes.json'),
    JSON.stringify({
      versions: [{ type: 'a', tag: 'v4.28.0', installedAt: new Date().toISOString() }]
    }),
    'utf8'
  )

  // ★ 假 python.exe：只为越过 existsSync 前置检查，内容无所谓
  mkdirSync(join(dataRoot, 'runtime', 'python'), { recursive: true })
  writeFileSync(join(dataRoot, 'runtime', 'python', 'python.exe'), 'not a real exe', 'utf8')

  return { dataRoot, dest, cleanup: () => rmSync(dataRoot, { recursive: true, force: true }) }
}

/** 版本列表返回 v4.28.0（走 pypi 分支） */
const pypiStub = async (url: string): Promise<string> => {
  if (url.includes('pypi')) {
    return JSON.stringify({
      info: { version: '4.28.0' },
      releases: {
        '4.28.0': [
          {
            filename: 'astrbot-4.28.0-py3-none-any.whl',
            url: 'https://files.pythonhosted.org/x.whl',
            size: 1000,
            digests: { sha256: 'aa' }
          }
        ]
      }
    })
  }
  throw new Error('404')
}

async function makeHandlers(dataRoot: string): Promise<ReturnType<typeof buildHandlers>> {
  const h = buildHandlers({
    probe: () => Promise.resolve(true),
    processManager: createProcessManager(),
    fetchVersionJson: pypiStub
  })
  await h['config:set']({ dataRoot })
  return h
}

describe('★重装同一版本：不能把已有运行时弄坏（真实崩溃日志的回归）', () => {
  /*
   * ★ 显式超时（第三轮验证时抓到的偶发）
   *
   * 这条用例走完整的 `runtime:install`（要真的 spawn 一个假 python、
   * 等它失败、再走"pip 失败"分支并做收尾）。单跑约 4.4 秒，
   * 但在 `--no-file-parallelism` 的全量运行里受其它重用例影响会超过 5 秒，
   * 于是偶发报 "Test timed out in 5000ms" —— 那是**测试基础设施的超时**，
   * 不是产品缺陷（同一份代码单独跑稳定通过）。
   *
   * 给足余量：这类"要等子进程真失败"的用例本来就该比默认 5 秒宽。
   */
  it('★pip 失败时，原有可用的运行时必须一字不动', { timeout: 30_000 }, async () => {
    const s = setupInstalled()
    try {
      const h = await makeHandlers(s.dataRoot)

      /*
       * 假 python.exe → spawn 失败 → run() 返回 status=-1 →
       * 进入"pip 失败"分支。这正是会删目录的那条路径。
       */
      await expect(
        h['runtime:install']({ type: 'a', tag: 'v4.28.0' }),
        '假 python 应当让安装失败'
      ).rejects.toThrow()

      /*
       * ★ 核心断言：失败之后，**原有的可用运行时必须还在**。
       *
       * 修之前这里必红 —— `removeDirAsync(dest)` 把它整个删了。
       */
      const mainPkg = join(s.dest, 'astrbot', '__init__.py')
      expect(
        existsSync(mainPkg),
        `原有的运行时本体被删掉了（${mainPkg}）——` +
          `用户下次启动就会看到"运行时结构不对，重新下载这个版本"`
      ).toBe(true)
      expect(readFileSync(mainPkg, 'utf8'), '内容也不能被改').toBe('# astrbot')
      // 依赖目录也得在（日志里撞的就是它）
      expect(existsSync(join(s.dest, 'bs4', '__init__.py')), 'bs4 也不该被删').toBe(true)

      // 不许留下暂存垃圾
      const parent = join(s.dataRoot, 'runtimes', 'a')
      const junk = readdirSync(parent).filter((d) => /\.stage-|\.installing-|\.old-/.test(d))
      expect(junk, `安装失败后留下了暂存目录：${junk.join(', ')}`).toEqual([])
    } finally {
      s.cleanup()
    }
  })

  it('★失败时不能把实例的运行时目录变成"空壳"（那正是"结构不对"的成因）', async () => {
    /*
     * 用户看到的报错是「运行时结构不对」—— 那个判据检查的是
     * `<dest>\astrbot\__init__.py` 在不在。
     *
     * 所以"目录还在但本体没了"和"目录被删了"对用户是**同一个后果**。
     * 这条单独钉住"本体必须在"，免得有人只把删除改成"清空目录"就算修好。
     */
    const s = setupInstalled()
    try {
      const h = await makeHandlers(s.dataRoot)
      await expect(h['runtime:install']({ type: 'a', tag: 'v4.28.0' })).rejects.toThrow()

      expect(
        existsSync(join(s.dest, 'astrbot', '__init__.py')),
        '本体文件必须还在，否则实例启动会报"运行时结构不对"'
      ).toBe(true)
    } finally {
      s.cleanup()
    }
  })

  it('★失败后实例仍然可用（这是用户真正在意的）', async () => {
    /*
     * 上两条验的是"文件在不在"。这条验**用户视角的结论**：
     * 一次失败的重装之后，`instance:start` 不该因为"运行时结构不对"而失败。
     *
     * 注意：这里不一定能真的启动成功（测试环境没有真运行时），
     * 但要确认它**不是因为运行时结构被毁**而失败 —— 那是这次要修的 bug。
     */
    const s = setupInstalled()
    try {
      const h = await makeHandlers(s.dataRoot)

      // 先造一个绑定 v4.28.0 的实例
      const instDir = join(s.dataRoot, 'instances', 'AstrBot', 'a_re1')
      mkdirSync(join(instDir, 'data'), { recursive: true })
      writeFileSync(
        join(instDir, 'instance.json'),
        JSON.stringify({ id: 'a_re1', type: 'a', name: '重装测试', runtimeTag: 'v4.28.0', port: 6101 }),
        'utf8'
      )
      writeFileSync(
        join(s.dataRoot, 'instances.json'),
        JSON.stringify({
          instances: [
            {
              id: 'a_re1',
              type: 'a',
              name: '重装测试',
              dir: instDir,
              port: 6101,
              status: 'stopped',
              templateVersion: 4280,
              createdAt: new Date().toISOString()
            }
          ]
        }),
        'utf8'
      )

      // 一次失败的重装
      await expect(h['runtime:install']({ type: 'a', tag: 'v4.28.0' })).rejects.toThrow()

      // 现在尝试启动：失败的原因**不能是**"运行时结构不对"
      let startErr = ''
      try {
        await h['instance:start']('a_re1')
      } catch (e) {
        startErr = e instanceof Error ? e.message : String(e)
      }
      expect(
        startErr,
        `一次失败的重装把运行时弄成了"结构不对"，实例永远起不来：${startErr}`
      ).not.toMatch(/运行时结构不对/)
    } finally {
      s.cleanup()
    }
  })
})
