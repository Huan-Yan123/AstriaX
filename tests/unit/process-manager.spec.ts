import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { createProcessManager } from '../../src/main/proc/process-manager'
import { testStage } from '../helpers/stage'

let root: string // 只为保证各用例独立（manager 不落盘，依然规范起见）
beforeEach(() => {
  root = testStage('acb-pm-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const foreverScript = `setInterval(()=>{}, 1000)`

describe('进程管理器', () => {
  it('start → running；stop → stopped（跨平台树杀）', async () => {
    const pm = createProcessManager()
    const h = await pm.start({
      id: 'a_test0',
      cmd: process.execPath,
      args: ['-e', foreverScript],
      port: 0
    })
    try {
      await h.eventually('running', 10000)
      pm.killTreeSync('a_test0')
      await h.eventually('stopped', 10000)
    } finally {
      pm.killAllSync()
    }
  })

  it('同一 id 重复 start 抛 DuplicateInstance', async () => {
    const pm = createProcessManager()
    await pm.start({ id: 'a_test1', cmd: process.execPath, args: ['-e', foreverScript], port: 0 })
    try {
      await expect(
        pm.start({ id: 'a_test1', cmd: process.execPath, args: ['-e', '1'], port: 0 })
      ).rejects.toThrow()
    } finally {
      pm.killAllSync()
    }
  })

  it('stop 不存在的 id 是安全 no-op', () => {
    const pm = createProcessManager()
    expect(() => pm.killTreeSync('a_nope')).not.toThrow()
  })

  it('启动即失败：标记 error 而不是 stopped，并把真实输出留在 tailOf', async () => {
    const pm = createProcessManager()
    // 模拟 AstrBot 那种「能起来但立刻崩」：打印错误后非 0 退出
    const h = await pm.start({
      id: 'a_crash',
      cmd: process.execPath,
      args: ['-e', 'console.error("ModuleNotFoundError: No module named astrbot"); process.exit(1)'],
      port: 0
    })
    // 等它退干净
    await sleep(1500)
    expect(pm.statusOf('a_crash')).toBe('error')
    const tail = pm.tailOf('a_crash')
    // 关键：用户能看到真正的原因，而不是只有一句「超时」
    expect(tail).toContain('ModuleNotFoundError')
    expect(tail).toContain('退出码 1')
    expect(h.tail?.()).toContain('ModuleNotFoundError')
  })

  it('进程已死时 eventually("running") 立刻失败，不干等到超时', async () => {
    const pm = createProcessManager()
    const h = await pm.start({
      id: 'a_dead',
      cmd: process.execPath,
      args: ['-e', 'process.exit(3)'],
      port: 0
    })
    await sleep(1200)
    const t0 = Date.now()
    await expect(h.eventually('running', 15000)).rejects.toThrow(/进程没能起来/)
    // 必须马上返回，而不是等满 15 秒
    expect(Date.now() - t0).toBeLessThan(2000)
  })

  it('正常退出（退出码 0）标 stopped，不算失败', async () => {
    const pm = createProcessManager()
    await pm.start({ id: 'a_ok', cmd: process.execPath, args: ['-e', 'process.exit(0)'], port: 0 })
    await sleep(1200)
    expect(pm.statusOf('a_ok')).toBe('stopped')
  })

  it('tailOf 收得到 stderr，即使没配 logFile', async () => {
    const pm = createProcessManager()
    await pm.start({
      id: 'a_tail',
      cmd: process.execPath,
      args: ['-e', 'console.error("我坏了"); process.exit(2)'],
      port: 0
    })
    await sleep(1200)
    expect(pm.tailOf('a_tail')).toContain('我坏了')
    expect(pm.tailOf('a_tail')).toContain('2')
  })
})

/*
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 绝不误杀：已经退出的进程，它的 PID 不能再被拿去杀
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么这一组是最重要的
 *
 * 项目设计文档白纸黑字立过规矩（docs/.../2026-09-12-...-design.md:121）：
 *
 *   「清理是白名单式 —— 只杀管理器自己 spawn 并持有 pid 的进程树，
 *     绝不按进程名扫描系统（用户另跑的 napcat/astrbot/QQ 一概不碰）」
 *
 * 而审计发现这条规矩有一条**实际的破口**（不是理论风险）：
 *
 *   · `process-manager.ts:230-253` 的 exit 回调**故意保留** procs 记录
 *     （为了让 statusOf 能返回终态，有测试依赖它）
 *   · Node 的 `child.pid` 在进程退出后**依然是个数字**，不会变 undefined
 *   · `killTreeSync` 只判 `p.child.pid` 真值，**不判 status**
 *   · `killAllSync` 遍历 `procs.keys()` 的**全部**条目（含 stopped / error）
 *
 * 于是「实例崩溃过（记录还在 error）→ 用户点托盘退出 →
 * killAllSync → 对一个早就死掉的 PID 执行 taskkill /T /F」。
 *
 * ## 为什么这会真的杀错人
 *
 * PID 是会被**回收复用**的。审计员在本机实测：60 个释放的 PID 里，
 * 1.7 秒内 42 次 spawn 就有 5 个被复用（约 6.5~7.7 秒窗口）。
 * 也就是说旧 PID 很可能已经属于一个**完全无关的活进程**
 * （用户自己的 QQ、NapCat、甚至别的软件）。此时 taskkill 返回 0，
 * 无辜进程被打死 —— 而且是在管理员权限下。
 *
 * 这比"杀不掉"严重得多：杀不掉只是不好用，杀错了是毁用户的东西。
 *
 * ## 怎么测（不真杀任何进程）
 *
 * 给进程管理器注入一个**假的 taskkill**，把"被要求杀的 PID"记下来。
 * 然后：起一个真子进程 → 等它自己退出（拿一个陈旧 PID）→
 * 调 killAllSync / killTreeSync → 断言**这个陈旧 PID 没有被要求杀**。
 *
 * 用真子进程而不是 mock PID：要验的正是"真进程退出后 pid 字段还在"
 * 这个事实本身。如果哪天 Node 改成退出后清 pid，这些用例会提醒我们。
 */
describe('★绝不误杀：已退出的进程不再被 taskkill', () => {
  /** 记录所有被要求杀的 PID（替代真实 taskkill） */
  function spyKiller() {
    const killed: string[][] = []
    const killer = ((cmd: string, args: string[]) => {
      killed.push([cmd, ...args])
      // 返回一个最小的假 ChildProcess：本模块只用到 spawn 的返回值
      // 来（可选）挂 error 监听，所以给个带 on() 的空壳即可
      return {
        on: () => undefined,
        once: () => undefined,
        kill: () => undefined
      } as unknown as ReturnType<typeof spawn>
    }) as unknown as typeof spawn
    const pids = () => killed.map((a) => a[a.indexOf('/PID') + 1]).filter(Boolean)
    return { killed, killer, pids }
  }

  it('子进程自己退出后，killAllSync 不再去杀它的旧 PID', async () => {
    /*
     * ★ 这里**不能**把 spawnImpl 换成"什么都不起"的假实现 ——
     * 我们要的是**真子进程**跑起来再自己退出，
     * 才能拿到"进程已死但 pid 字段还在"这个真实状态。
     *
     * 所以只替换 kill 通道（killImpl），spawn 用真的。
     * 第一版我把 spawnImpl 也换成假的，于是进程压根没起来、
     * eventially('stopped') 等满 5 秒超时 —— 那是测试自己的错。
     */
    const { killer, pids } = spyKiller()
    const pm = createProcessManager({ killImpl: (pid) => void killer('taskkill', ['/PID', String(pid)]) })

    const h = await pm.start({
      id: 'a_gone',
      cmd: process.execPath,
      args: ['-e', 'process.exit(0)'],
      port: 0
    })
    // 等它真的退出（状态落到终态）
    await h.eventually('stopped', 10000)
    const stalePid = String(h.pid())
    expect(stalePid, '子进程应当有过 pid').not.toBe('undefined')

    /*
     * 关键断言：现在 killAllSync 不该对那个旧 PID 动手。
     *
     * 修之前这里会失败 —— 因为 killAllSync 遍历全部记录、
     * killTreeSync 只看 pid 真值。
     */
    pm.killAllSync()
    expect(
      pids(),
      `对一个已退出的 PID（${stalePid}）发出了杀令 —— ` +
        `该 PID 可能已被系统回收给无关进程，会误杀用户的东西`
    ).not.toContain(stalePid)
  })

  it('启动失败（error 态）的旧 PID 同样不许杀', async () => {
    /*
     * 这条对应最现实的触发路径：实例崩溃 → 记录留在 error 态
     * （exit 回调**故意**保留记录，见 process-manager.ts 的说明）
     * → 用户点托盘「退出（停止全部实例）」→ killEverythingForExit
     * → pm.killAllSync() → 对崩溃进程的陈旧 PID 树杀。
     */
    const { killer, pids } = spyKiller()
    const pm = createProcessManager({ killImpl: (pid) => void killer('taskkill', ['/PID', String(pid)]) })

    const h = await pm.start({
      id: 'a_crashed',
      cmd: process.execPath,
      args: ['-e', 'process.exit(1)'],
      port: 0
    })
    await h.eventually('error', 10000)
    const stalePid = String(h.pid())

    pm.killAllSync()
    expect(pids(), '崩溃进程的旧 PID 也不该被拿去杀').not.toContain(stalePid)
  })

  it('对单个已退出的 id 调 killTreeSync 也不该动手', async () => {
    const { killer, pids } = spyKiller()
    const pm = createProcessManager({ killImpl: (pid) => void killer('taskkill', ['/PID', String(pid)]) })

    const h = await pm.start({
      id: 'a_stale_one',
      cmd: process.execPath,
      args: ['-e', 'process.exit(0)'],
      port: 0
    })
    await h.eventually('stopped', 10000)
    const stalePid = String(h.pid())

    pm.killTreeSync('a_stale_one')
    expect(pids(), 'killTreeSync 也不该对已退出的 pid 动手').not.toContain(stalePid)
  })

  it('★但还活着的进程必须照杀（别把这条修成"谁也不杀"）', async () => {
    /*
     * 上一条的镜像。收紧判据时最容易犯的错是收得太狠 ——
     * 那会让"停止实例"彻底失效（用户报过「点停止停不掉」）。
     * 所以这里必须钉住：running 的进程照样要被杀。
     */
    const { killer, pids } = spyKiller()
    const pm = createProcessManager({ killImpl: (pid) => void killer('taskkill', ['/PID', String(pid)]) })

    const h = await pm.start({
      id: 'a_alive',
      cmd: process.execPath,
      args: ['-e', 'setInterval(()=>{}, 1000)'],
      port: 0
    })
    await h.eventually('running', 10000)
    const livePid = String(h.pid())

    pm.killTreeSync('a_alive')
    expect(pids(), '活着的实例必须照常被杀，否则「停止」就废了').toContain(livePid)

    // 真把它收干净，别留给后面的用例
    try {
      process.kill(Number(livePid), 'SIGKILL')
    } catch {
      /* 已经死了 */
    }
  })
})
