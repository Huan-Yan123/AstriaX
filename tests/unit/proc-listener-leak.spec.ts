import { describe, expect, it } from 'vitest'
import { createProcessManager } from '../../src/main/proc/process-manager'

/**
 * `eventually` 超时后必须把自己挂在 bus 上的监听器摘掉。
 *
 * 为什么会漏：回调里只在「等到目标状态」那条路径上
 * `clearTimeout` + `removeListener`，而**定时器超时那条路径只调了 bad()**。
 * 于是每超时一次就在 EventEmitter 上永久留一个监听器：
 *   - 攒多了触发 MaxListenersExceededWarning（用户日志里会看到刺眼警告）；
 *   - 这些监听器还会被后续每一次状态变更回调，纯属白跑；
 *   - 闭包抓着 p / spec / timer，是实打实的内存泄漏。
 *
 * 这个测试用「让进程一直不进入目标状态」来逼出超时路径，然后检查监听器数量。
 */
describe('process-manager: eventually 超时不留监听器', () => {
  it('超时后 bus 上的监听器回到基线', async () => {
    const pm = createProcessManager()

    // 一个不会自己退出的进程：拿 node 跑个长休眠（跨平台，不依赖平台命令）
    const h = await pm.start({
      id: 'leak-test',
      cmd: process.execPath,
      args: ['-e', 'setTimeout(()=>{}, 60000)'],
      port: 1
    })

    // 通过 statusOf 观察不到 bus，所以用 Node 的 EventEmitter 警告与
    // 「重复超时是否越来越慢/报错」来间接判断：直接连打多次超时，
    // 若监听器不摘，次数够多就会触发 MaxListenersExceededWarning。
    const warnings: string[] = []
    const onWarn = (w: Error): void => {
      warnings.push(w.message)
    }
    process.on('warning', onWarn)

    // 每次等一个绝不会到达的状态，短超时，快速堆叠
    for (let i = 0; i < 25; i++) {
      await h.eventually('stopped', 5).catch(() => undefined)
    }
    // 给 warning 事件一点时间派发
    await new Promise((r) => setTimeout(r, 50))
    process.off('warning', onWarn)

    pm.killTreeSync('leak-test')
    await new Promise((r) => setTimeout(r, 300))

    const maxListener = warnings.filter((w) => /MaxListeners/i.test(w))
    expect(
      maxListener,
      `eventually 超时后没摘监听器，触发了 EventEmitter 告警：\n${maxListener.join('\n')}`
    ).toEqual([])
  }, 30000)

  it('等到目标状态后也不留监听器（正常路径）', async () => {
    const pm = createProcessManager()
    const warnings: string[] = []
    const onWarn = (w: Error): void => {
      warnings.push(w.message)
    }
    process.on('warning', onWarn)

    const h = await pm.start({
      id: 'ok-path',
      cmd: process.execPath,
      args: ['-e', 'setTimeout(()=>{}, 5000)'],
      port: 1
    })
    // 此时已经是 running，等 running 会立即返回
    await h.eventually('running', 1000)
    // 再等一次已经到达的状态
    await h.eventually('running', 1000)
    await new Promise((r) => setTimeout(r, 50))
    process.off('warning', onWarn)

    pm.killTreeSync('ok-path')
    await new Promise((r) => setTimeout(r, 300))
    expect(warnings.filter((w) => /MaxListeners/i.test(w))).toEqual([])
  }, 30000)
})
