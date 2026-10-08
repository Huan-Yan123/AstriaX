import { describe, expect, it } from 'vitest'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'
import { testStage } from '../helpers/stage'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * `instance:stop` 声称停掉了，就**必须真的停掉**。
 *
 * 现在的问题：`killTreeSync` 是「发射后不管」—— 它 spawn 一个 taskkill 就返回，
 * 完全不看结果；紧接着 handler 就把状态写成 'stopped'、并登记 justStopped 宽限期。
 *
 * 后果：如果 kill 失败（权限不足、进程已僵死、taskkill 自身出错），
 * 界面会显示「已停止」，进程却还在跑、还占着端口。用户看到的是一句谎话，
 * 而且因为 justStopped 的宽限期，接下来 5 秒内探活还会**主动忽略**端口，
 * 把这个错误状态确认得更死。
 *
 * 这条测试要的是：stop 之后，进程是真的没了（而不是"我们以为没了"）。
 */
describe('instance:stop 必须真的停掉进程', () => {
  /** 造出一个「前置条件都满足」的数据根：运行时 + 内置 Python 标记 */
  function seedRoot(tag: string): string {
    const root = testStage(tag)
    mkdirSync(join(root, 'runtimes', 'a', 'v4.28.0', 'astrbot'), { recursive: true })
    writeFileSync(
      join(root, 'runtimes', 'a', 'v4.28.0', 'astrbot', '__init__.py'),
      '__version__ = "4.28.0"',
      'utf8'
    )
    writeFileSync(
      join(root, 'runtimes', 'a', 'v4.28.0', 'mxbot-runtime.json'),
      '{"kind":"pypi","tag":"v4.28.0"}',
      'utf8'
    )
    // AstrBot 实例要求内置 Python 就绪
    mkdirSync(join(root, 'runtime', 'python'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'python', 'python.exe'), '', 'utf8')
    return root
  }

  it('stop 之后进程不再存活', async () => {
    const root = seedRoot('real-stop-')
    const pm = createProcessManager()
    const h = buildHandlers({ probe: async () => true, processManager: pm })
    await h['config:set']({ dataRoot: root })
    const rec = (await h['instance:create']({ type: 'a', name: '待停' })) as { id: string }

    // 直接经 pm 起一个真进程，占住这个实例 id
    await pm.start({
      id: rec.id,
      cmd: process.execPath,
      args: ['-e', 'setTimeout(()=>{}, 60000)'],
      port: 1
    })
    const pidBefore = pm.pidsOf().get(rec.id)
    expect(pidBefore, '进程应该已经起来了').toBeTruthy()

    await h['instance:stop'](rec.id)

    // 给 taskkill 一点时间
    await new Promise((r) => setTimeout(r, 1500))

    // 真的死了吗？直接问操作系统
    let alive = false
    try {
      process.kill(pidBefore!, 0) // 信号 0 = 只探测存在性
      alive = true
    } catch {
      alive = false
    }
    expect(alive, `stop 之后 pid ${pidBefore} 仍然活着 —— 状态写成了已停止，进程却还在跑`).toBe(false)
  }, 40000)

  it('stop 之后管理器里不该还报 running', async () => {
    const root = seedRoot('real-stop2-')
    const pm = createProcessManager()
    const h = buildHandlers({ probe: async () => true, processManager: pm })
    await h['config:set']({ dataRoot: root })
    const rec = (await h['instance:create']({ type: 'a', name: '待停2' })) as { id: string }
    await pm.start({
      id: rec.id,
      cmd: process.execPath,
      args: ['-e', 'setTimeout(()=>{}, 60000)'],
      port: 1
    })

    await h['instance:stop'](rec.id)
    await new Promise((r) => setTimeout(r, 1500))

    expect(pm.pidsOf().size, '不该还有存活的实例 pid').toBe(0)
  }, 40000)
})
