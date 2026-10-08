import { describe, expect, it } from 'vitest'
import { createProcessManager } from '../../src/main/proc/process-manager'

/**
 * 进程结束后**终态必须可读**，而且反复启停不能累积记录。
 *
 * 这里曾经走过一段弯路，值得记下来：
 *   一开始我担心 procs/exitInfo/killing 三个 Map 只增不减，就把 exit 回调里
 *   的记录删掉了 —— 结果立刻打破了对外契约：process-manager.spec.ts 要求
 *   「启动即失败 → statusOf 返回 'error'」「正常退出 → statusOf 返回 'stopped'」，
 *   删了之后 statusOf 变 undefined，调用方拿不到终态，两个测试当场变红。
 *
 * 正确结论：**终态要留着**；增长问题在 start() 入口按 id 覆盖就已经解决了
 * （同一个 id 反复启停不会留多条），残余记录随实例数封顶。
 *
 * 所以这条测试守的是两件真正重要的事：
 *   1) 进程死后 statusOf 给出正确的终态（error / stopped），不是 running；
 *   2) 反复启停同一 id，不会攒出多份存活记录。
 */
describe('process-manager: 终态可读且不累积', () => {
  it('进程死后 statusOf 给出终态，不停留在 running', async () => {
    const pm = createProcessManager()
    const h = await pm.start({
      id: 'term',
      cmd: process.execPath,
      args: ['-e', 'setTimeout(()=>{}, 60000)'],
      port: 1
    })
    // start() 现在等 spawn 之后才 resolve，所以拿到 handle 时已经是 running
    expect(pm.statusOf('term'), 'start() 应在 spawn 之后才 resolve').toBe('running')

    pm.killTreeSync('term')
    await new Promise((r) => setTimeout(r, 1200))

    const st = pm.statusOf('term')
    expect(st, '主动杀掉后应是 stopped，不能停在 running').toBe('stopped')
    void h
  }, 30000)

  it('反复启停同一个 id 不会累积存活记录', async () => {
    const pm = createProcessManager()
    for (let i = 0; i < 5; i++) {
      const handle = await pm.start({
        id: 'cycle',
        cmd: process.execPath,
        args: ['-e', 'setTimeout(()=>{}, 30000)'],
        port: 1
      })
      pm.killTreeSync('cycle')
      // Windows 的 taskkill 是异步子进程；等状态机确认退出，避免用固定睡眠猜时序。
      await handle.eventually('stopped', 5000)
    }
    // 全部停完，不该有任何"存活"的 pid 记录
    expect(pm.pidsOf().size, '全部停止后不该还有存活的 pid 记录').toBe(0)
    // 终态可读（stopped），而不是残留 running
    expect(pm.statusOf('cycle')).toBe('stopped')
  }, 60000)

  it('start() 在 spawn 之后才 resolve（不再出现 starting 窗口）', async () => {
    /*
     * 原实现是在 spawn() 调用返回后就 resolve，那时 spawn 事件还没派发，
     * 状态还是 'starting' —— 调用方想判断"起来了没"只能自己轮询。
     * 改成等 spawn 事件结算后，resolve 出来的那一刻状态就是 running。
     */
    const pm = createProcessManager()
    const h = await pm.start({
      id: 'spawn-order',
      cmd: process.execPath,
      args: ['-e', 'setTimeout(()=>{}, 5000)'],
      port: 1
    })
    expect(pm.statusOf('spawn-order'), 'resolve 时状态应已是 running').toBe('running')
    pm.killTreeSync('spawn-order')
    await new Promise((r) => setTimeout(r, 800))
    void h
  }, 30000)
})
