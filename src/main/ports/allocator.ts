export class PortRangeExhausted extends Error {
  /**
   * 端口段耗尽的提示。
   *
   * **不要再写「请在设置里扩大端口段」** —— 设置里根本没有这一项
   * （`config.portMin/portMax` 在 ipc.ts 里声明过、DEFAULTS 里也有，
   * 但全项目没有任何地方读它们，SettingsPanel 里也搜不到「端口」）。
   * 让用户去找一个不存在的开关，比不提示还糟。
   *
   * 端口段是**按实例类型硬编码分段**的（AstrBot 6100-6199 / NapCat 6200-6299，
   * 见 instance-repo 的 TYPE_PORT_RANGE），所以这里如实说清出路。
   */
  constructor(what = '实例') {
    super(
      `${what}数量已经到上限了（端口段用满了）。`
        + `把不用的实例删掉一些再创建，就能腾出位置。`
    )
    this.name = 'PortRangeExhausted'
  }
}

export type OccupancyProbe = (port: number) => Promise<boolean> | boolean

/**
 * 找一个可用端口（不在 alreadyAllocated 且 probe(port)===true）。
 * hintPort（用户指令：默认=上一个实例端口+1）：从 hint 顺延探测到 hi，都满了再回头扫 [lo, hint)。
 *
 * @param what 类型化的名字（"AstrBot" / "NapCat"），只用来把耗尽提示写得具体一点。
 *             缺省"实例"——这样老调用点不改也能编译。
 */
export async function allocate(
  probe: OccupancyProbe,
  range: readonly [number, number],
  alreadyAllocated: number[],
  hintPort?: number,
  what?: string
): Promise<number> {
  const used = new Set(alreadyAllocated)
  const [lo, hi] = range
  if (hintPort !== undefined && hintPort >= lo && hintPort <= hi) {
    for (let p = hintPort; p <= hi; p++) {
      if (used.has(p)) continue
      if (await probe(p)) return p
    }
    for (let p = lo; p < hintPort; p++) {
      if (used.has(p)) continue
      if (await probe(p)) return p
    }
    throw new PortRangeExhausted(what)
  }
  for (let p = lo; p <= hi; p++) {
    if (used.has(p)) continue
    if (await probe(p)) return p
  }
  throw new PortRangeExhausted(what)
}

/** 真实探测：尝试监听该端口 */
export function createTcpProbe(): OccupancyProbe {
  // 延迟 import，保持本模块可被无 net 环境的纯单测 mock 掉
  const net = require('net') as typeof import('net')
  return (port) =>
    new Promise((resolve) => {
      const srv = net.createServer()
      srv.once('error', () => resolve(false))
      srv.once('listening', () => {
        srv.close(() => resolve(true))
      })
      srv.listen(port, '127.0.0.1')
    })
}
