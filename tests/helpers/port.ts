import { connect, createServer } from 'net'

/**
 * 要一个**真的空闲**的端口（系统临时端口段）。
 *
 * ⚠️ **涉及 instance:create 的测试不要用这个，要用 `freePortIn`。**
 *
 * 原因见 `freePortIn` 的注释：`instance:create` 会把端口**强制**收进
 * 类型区间（a: 6100-6199 / n: 6200-6299），段外的提示值被静默丢弃、
 * 退回该段首个端口。用本函数拿到的 49152+ 端口会被丢掉，
 * 结果固定落在 6200 —— 而 6200 正是「NapCat 注入 QQ」的默认端口，
 * 主人本机就被 QQ.exe 占着，导致假的 EACCES 与一堆看不懂的状态不一致。
 *
 * 那为什么还留着？因为它对**不经过 instance:create** 的场景仍然正确：
 * 需要「随便一个当前没人听的端口」去建真实监听/探测时（不关心段位），
 * 临时端口段比在 6100-6299 里手工找更稳妥，也不会和实例端口撞。
 * 目前没有这类调用点，但删掉会让后来者又重新手写一遍 listen(0)，
 * 所以保留并在这里写清适用边界。
 */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('拿不到端口号')))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}

/** 批量要 N 个互不相同的空闲端口 */
export async function freePorts(n: number): Promise<number[]> {
  const used = new Set<number>()
  const out: number[] = []
  while (out.length < n) {
    const p = await freePort()
    if (!used.has(p)) {
      used.add(p)
      out.push(p)
    }
  }
  return out
}

/**
 * 在**指定区间**里要一个当前空闲的端口。
 *
 * ============================================================================
 * 为什么不能只用 freePort()
 * ============================================================================
 *
 * `freePort()` 走的是 `listen(0)`，也就是让系统从**临时端口段**
 * （Windows 默认 49152-65535）分配。而 `instance:create` 会**强制**
 * 把端口收进该类型的固定区间：
 *
 *     const range = TYPE_PORT_RANGE[p.type]        // a: 6100-6199  n: 6200-6299
 *     const port = await allocate(opts.probe, [range.min, range.max], ..., p.port ?? ...)
 *
 * 传进来的 `p.port` 只是个**提示值**，越界就被丢掉，退回
 * `defaultAllocate()` → 该类型的**首个端口**。所以：
 *
 *     const port = await freePort()   // 比如 54321
 *     h['instance:create']({ type: 'n', port })   // 实际拿到的是 6200！
 *
 * 测试以为自己在用一个随机空闲端口，其实固定落在 6200。
 * 而 6200 正是「用户本机 NapCat 注入 QQ」的默认端口 —— 实测本机就被
 * QQ.exe 占着。于是假进程绑不上端口 → EACCES 立刻退出 →
 * 状态判定全乱 → 4 个用例红得莫名其妙，看起来像真 bug。
 *
 * ============================================================================
 * 为什么这个 helper 是对的解法
 * ============================================================================
 *
 * 测试要的其实不是"任意空闲端口"，而是"**生产代码真会用的那个区间里**、
 * 当前确实空闲的端口"。在区间内逐个试听（listen + 立刻关），
 * 拿到第一个能用的交给被测代码 —— 这时提示值落在区间内，allocate 会采纳它。
 *
 * 这样测试既不依赖"区间内没人用"（用户机器上不成立），
 * 也不再假设"临时端口会被采用"（生产代码不这么干）。
 *
 * @throws 区间内一个空闲端口都没有（比如 100 个全被占）——明确报错，
 *         不要静默退回某个可能被占的端口，否则又变成难查的红
 */
export async function freePortIn(min: number, max: number): Promise<number> {
  for (let p = min; p <= max; p++) {
    if (await canBind(p)) return p
  }
  throw new Error(`端口区间 ${min}-${max} 里没有空闲端口（全被占用）`)
}

/**
 * 这个端口真的空闲吗 —— **既要绑得上，又要连不通**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么"能绑上"还不够（主人 2026-09-27 实测抓出来的）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 现场
 *
 * 那两条备份用例红得莫名其妙：`expected 'running' to be 'stopped'`。
 * 逐步打印才看清：
 *
 *     挑到端口: 6200                ← freePortIn 说它空闲
 *     启动后端口通: true
 *     备份后端口通: true             ← 实例进程明明被杀掉了
 *     备份后状态: running            ← 因为端口"还通"
 *
 * 而 **6200 其实被 QQ 占着**（NapCat 注入 QQ 后开的 OneBot 端口）。
 *
 * ## 为什么原来没发现
 *
 * QQ 绑的是 **`0.0.0.0:6200`**，而这里试的是 **`127.0.0.1:6200`** ——
 * Windows 上（未开 `SO_EXCLUSIVEADDRUSE` 时）**两者可以共存**：
 * bind 成功，但**连接会被路由到那个 `0.0.0.0` 的监听者**。
 *
 * 于是：
 *   · `freePortIn` 以为 6200 空闲 → 选它
 *   · 假实例也能绑上 → `instance:start` 看起来正常
 *   · 但 `probePort(6200)` **连到的是 QQ** → 永远"通"
 *   · 实例被杀之后端口照样通 → `liveStatusOf` 判回 `running` → 测试红
 *
 * 本质：**"绑得上"和"连不通"是两件事**。生产代码判活用的是后者
 *（`probePort` 是连接探测），所以测试选端口的判据必须与它一致。
 *
 * ## 现在：两个条件都满足才算空闲
 *
 *   ① 能绑上（没人绑着 127.0.0.1）
 *   ② **连不上**（说明也没有别人在 0.0.0.0 上占着它）← 专门挡 QQ 那种
 */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => {
      srv.removeAllListeners()
      resolve(false)
    })
    srv.listen(port, '127.0.0.1', () => {
      srv.removeAllListeners()
      /*
       * ★ 顺序很重要：**先关掉自己这个 server，再测连接**。
       *
       * 我第一版是"还开着 server 的时候就测连接" —— 那时连接会被
       * **我自己**接住（server 正在 listen），于是永远"连得上"，
       * 判据恒为"端口被占"（实测：freePortIn 依然挑到 6200）。
       *
       * 关掉之后再连：
       *   · 连不上 → 真空闲 ✔（没人占这个端口）
       *   · 连得上 → 说明 `0.0.0.0` 上**另有其人**在监听（QQ 那种）✘
       */
      srv.close(() => {
        void canConnect(port).then((reachable) => resolve(!reachable))
      })
    })
  })
}

/** 能不能连上 127.0.0.1:port（与生产代码 probePort 同一套判据） */
function canConnect(port: number, ms = 300): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1')
    const done = (v: boolean): void => {
      s.destroy()
      resolve(v)
    }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    setTimeout(() => done(false), ms)
  })
}
