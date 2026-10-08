/*
 * 一条被手改坏的记录，**不许把整份实例列表带崩**。
 *
 * ============================================================================
 * 背景（审计实跑复现出来的级联事故）
 * ============================================================================
 *
 * 用户用记事本打开 `instances.json`，把某个实例的 `"port": 6100` 改成 `99999`
 * （或者 0、-1，甚至留空），然后重新打开启动器。
 *
 * 期望：那条坏记录被当成「没在运行」，其余实例照常显示。
 * 实际（修复前）：**界面上一个实例都不显示**，用户以为实例全丢了。
 *
 * 链条：
 *   1. `net.connect({port: 99999})` **同步抛** RangeError ERR_SOCKET_BAD_PORT
 *      —— 而它在 `new Promise` 的执行器里，于是那个 promise 直接 rejected
 *   2. `instance:list` 用 `Promise.all(...)`：**一条 rejected 则整体 rejected**
 *   3. `App.vue` 的 `.catch(() => [])` 把它静默降级成空数组
 *   4. 界面上空空如也，而磁盘上的实例数据完好无损
 *
 * 修法两层：
 *   - `probePort` 入口做端口范围校验（非法 = 不可能有服务在监听 = false）
 *   - `instance:list` 逐条 catch（将来别的原因抛错也不连坐）
 *
 * 这个测试钉第一层（probePort 的纯粹行为），因为它是最根本的那道。
 */
import { describe, it, expect } from 'vitest'
import { probePort } from '../../src/main/proc/health'

describe('端口探活 · 坏输入不许抛，只回 false', () => {
  /*
   * 这些值在修复前全部会让 probePort 的 promise rejected。
   * 用真实调用而不是 mock net：要验的正是 net.connect 的真实行为。
   */
  const badPorts: Array<[string, unknown]> = [
    ['99999（大于 65535）', 99999],
    ['70000', 70000],
    ['65536（刚好越界）', 65536],
    ['-1', -1],
    ['NaN', Number.NaN],
    ['undefined', undefined],
    ['字符串 "6100"', '6100'],
    ['小数 6100.5', 6100.5],
    ['Infinity', Number.POSITIVE_INFINITY]
  ]

  for (const [label, value] of badPorts) {
    it(`★端口是 ${label} → 回 false，不抛异常`, async () => {
      /*
       * 用 await 直接断言「不 reject」。
       * 修复前这里会是：
       *   RangeError [ERR_SOCKET_BAD_PORT]: Port should be >= 0 and < 65536.
       *     Received type number (99999)
       */
      await expect(
        probePort(value as number, 200),
        `端口 ${label} 把 probePort 弄抛了 —— 在 instance:list 里会让整屏实例消失`
      ).resolves.toBe(false)
    })
  }

  it('★端口 0 → 回 false（net 不抛，但也不该说「在监听」）', async () => {
    // 0 是特例：net.connect 不抛，但实际不会连上任何服务
    await expect(probePort(0, 200)).resolves.toBe(false)
  })

  it('★合法端口但没人监听 → 回 false（正常路径没被守卫误伤）', async () => {
    /*
     * 反向对照：守卫不能把**合法**端口也一并拒了。
     * 6100 在合法范围内但本测试环境没服务 → 应当是 false（连不上），
     * 而且不能因为守卫直接短路（那样也是 false，就看不出区别了）。
     * 所以这里只断言「结果为 false 且没抛」——真正的「守卫没误伤」由
     * 下面那条「连得上就回 true」来证明。
     */
    await expect(probePort(6123, 300)).resolves.toBe(false)
  })

  it('★真起了服务就必须回 true（守卫不能把合法端口一律判死）', async () => {
    /*
     * 这条是关键的反向验证：如果守卫写成 `return Promise.resolve(false)`
     * 放在最前面（把范围判断写错成永远命中），前面几条全绿、而功能全废。
     * 起一个真实监听，确认合法端口仍然能探到。
     */
    const net = await import('net')
    const srv = net.createServer()
    const port = await new Promise<number>((resolve) => {
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })
    try {
      await expect(probePort(port, 2000), '合法端口上真有服务却没探到').resolves.toBe(true)
    } finally {
      await new Promise<void>((r) => srv.close(() => r()))
    }
  })
})
