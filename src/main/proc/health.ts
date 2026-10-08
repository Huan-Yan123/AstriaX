import type { Socket } from 'net'
import net = require('net')

/**
 * 探测 127.0.0.1:port 是否在监听（timeoutMs 内未连上视为未就绪）。
 *
 * ## 端口必须先做范围校验，否则会炸掉**整条调用链**
 *
 * `net.connect({port})` 在端口越界时会**同步抛 RangeError**：
 *
 *   net.connect({ host: '127.0.0.1', port: 99999 })
 *   → RangeError [ERR_SOCKET_BAD_PORT]: Port should be >= 0 and < 65536.
 *
 * 抛出点在 `new Promise` 的执行器里 —— executor 里同步抛出的异常会让
 * 这个 promise 变成 **rejected**（不是像 setTimeout 里那样变成 uncaught）。
 *
 * 而 `instance:list` 用的是 `Promise.all(repo.list().map(rec => liveStatusOf(rec)))`：
 * **一条记录 rejected，整个 Promise.all 就 rejected**。于是：
 *
 *   用户用记事本把 instances.json 里某个实例的 port 改成 99999（或 0、-1）
 *   → 整个 instance:list 抛错
 *   → App.vue 的 `.catch(() => [])` 把它静默降级成空数组
 *   → **界面上一个实例都不显示**，用户以为实例全丢了
 *
 * 实例数据其实完好无损，只是这一条坏输入把整屏列表带崩了。
 * 端口非法就是「没在监听」，返回 false 是最贴切的语义 ——
 * 不该让一个坏数字有掀桌子的能力。
 *
 * 用 Number.isInteger 而不是只判范围：`undefined` / `NaN` / 字符串 `'6100'`
 * 都会落进来（readAll 目前不校验 port 类型，坏文件里什么都可能有）。
 */
export function probePort(port: number, timeoutMs = 3000): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    // 非法端口 = 不可能有服务在监听，直接给否，不碰 net.connect
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const sock: Socket = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    sock.once('connect', () => {
      clearTimeout(timer)
      done(true)
    })
    sock.once('error', () => {
      clearTimeout(timer)
      done(false)
    })
  })
}

/** 轮询直到就绪或总超时，返回最终布尔值 */
export async function waitPort(port: number, totalMs = 15000, intervalMs = 400): Promise<boolean> {
  const deadline = Date.now() + totalMs
  while (Date.now() < deadline) {
    if (await probePort(port, Math.max(intervalMs, 1000))) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return await probePort(port, intervalMs)
}
