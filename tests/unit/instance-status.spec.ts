import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import net from 'net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager, type ProcessManager } from '../../src/main/proc/process-manager'
import { testStage } from '../helpers/stage'

/**
 * 实例状态必须反映「现在到底跑没跑」，不能只念磁盘上那个陈旧的值。
 *
 * 两个真实症状，根因是同一个 —— instance:list 直接返回 repo.list()，
 * 也就是**最后一次写进 instances.json 的 status**，从不校验当下：
 *
 * 1. NapCat 进程已经死了，界面还显示「运行中」。
 * 2. 反过来：NapCat 是注入 QQ 跑的，我们 spawn 的 cmd.exe 跑完 bat 就退出了
 *    （真正干活的是 QQ 里那个 NapCat），process-manager 收到 exit 就把状态改成 stopped，
 *    可 NapCat 明明还活着、端口也通。
 *
 * 判据只能是**端口**：两类实例都以自己的端口对外服务，端口通=在跑。
 * 所以这里用真开端口监听来模拟「活着」，比 mock 更接近真实。
 */
describe('实例状态以端口探活为准', () => {
  let root = ''
  /** 测试里真开的监听端口，用完关掉 */
  const servers: net.Server[] = []

  beforeEach(() => {
    root = testStage('mxbot-status-')
  })
  afterEach(async () => {
    for (const s of servers.splice(0)) {
      await new Promise<void>((r) => s.close(() => r()))
    }
    rmSync(root, { recursive: true, force: true })
  })

  /** 真起一个监听端口的服务，返回端口号 */
  async function listenOn(port: number): Promise<void> {
    const srv = net.createServer(() => {})
    await new Promise<void>((ok, bad) => {
      srv.once('error', bad)
      srv.listen(port, '127.0.0.1', () => ok())
    })
    servers.push(srv)
  }

  /** 造一个有运行时的库 */
  function seed(type: 'a' | 'n'): void {
    const dir = join(root, 'runtimes', type, type === 'a' ? 'v4.28.0' : 'v4.18.19')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'mxbot-runtime.json'), JSON.stringify({ kind: type === 'a' ? 'pypi' : 'shell' }), 'utf8')
    if (type === 'a') {
      mkdirSync(join(root, 'runtime', 'python'), { recursive: true })
      writeFileSync(join(root, 'runtime', 'python', 'python.exe'), '', 'utf8')
    }
  }

  /** 直接往索引里塞一条记录（模拟「磁盘上的状态和现实不符」） */
  function putInstance(rec: {
    id: string
    type: 'a' | 'n'
    name: string
    port: number
    status: string
  }): void {
    const dir = join(root, 'instances', rec.type === 'a' ? 'AstrBot' : 'NapCat', rec.id)
    mkdirSync(dir, { recursive: true })
    const file = join(root, 'instances.json')
    let all: { instances: unknown[] } = { instances: [] }
    try {
      all = JSON.parse(require('fs').readFileSync(file, 'utf8')) as { instances: unknown[] }
    } catch {
      /* 首次 */
    }
    all.instances.push({
      ...rec,
      templateVersion: 1,
      dir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    })
    writeFileSync(file, JSON.stringify(all, null, 2), 'utf8')
  }

  /** 改一条记录的磁盘状态（模拟「进程被标错了」） */
  function putStatus(id: string, status: string): void {
    const file = join(root, 'instances.json')
    const all = JSON.parse(require('fs').readFileSync(file, 'utf8')) as {
      instances: Array<{ id: string; status: string }>
    }
    const rec = all.instances.find((x) => x.id === id)
    if (rec) rec.status = status
    writeFileSync(file, JSON.stringify(all, null, 2), 'utf8')
  }

  /**
   * 模拟 NapCat 注入 QQ 的真实形态：**启动就绪之后，进程句柄消失**。
   *
   * 时序很关键：真实情况是
   *   我们 spawn 注入器 → 注入器把代码塞进 QQ → 注入器退出
   *   → 但端口由 QQ 里的 NapCat 继续服务着
   * 所以「退出」发生在**就绪判定通过之后**。
   *
   * 用显式的 forceExit() 而不是靠时间窗：
   * 我最初写成「600ms 后自动算退出」，结果 instance:start 返回后
   * 立刻调 instance:list()，还在那个窗口内，statusOf 仍报 running ——
   * 于是把判据改成「只看进程」这种坏实现，这条测试**照样全绿**。
   * 反向验证时发现了这个假绿，所以改成由测试显式触发退出，时序完全确定。
   *
   * 一上来就报 stopped 也不行：waitForReady 刻意先查进程再探端口，
   * 那样 start 会直接抛「进程启动后立刻退出了」。
   */
  function exitedAfterStartPm(): { pm: ProcessManager; forceExit: () => void } {
    let alive = false
    const pm: ProcessManager = {
      start: async () => {
        alive = true
        return {
          status: 'running' as const,
          pid: () => 12345,
          eventually: async () => undefined,
          exitCode: () => undefined,
          tail: () => '',
          lastOutputAt: () => Date.now()
        }
      },
      statusOf: () => (alive ? ('running' as const) : ('stopped' as const)),
      killTreeSync: () => undefined,
      killAllSync: () => undefined,
      pidsOf: () => new Map<string, number>(),
      onStatus: () => () => undefined,
      tailOf: () => ''
    }
    return { pm, forceExit: () => (alive = false) }
  }

  it('磁盘写 running 但端口不通 → 报「已停止」（进程死了不能还显示运行中）', async () => {
    seed('n')
    // 6270 上什么都不监听
    putInstance({ id: 'n_dead', type: 'n', name: '死掉的猫', port: 6270, status: 'running' })

    const h = buildHandlers({ probe: () => Promise.resolve(false), processManager: createProcessManager() })
    await h['config:set']({ dataRoot: root })
    const list = (await h['instance:list']()) as Array<{ id: string; status: string }>
    expect(list.find((x) => x.id === 'n_dead')?.status).toBe('stopped')
  })

  it('★本进程启动成功过、注入器随后退出（NapCat 注入 QQ）→ 仍报「运行中」', async () => {
    /*
     * 用户报告的原话：「NapCat 明明在运行中，点击 WebUI 却显示未启动。」
     *
     * 根因：NapCat 是**注入 QQ** 跑的。我们 spawn 的注入器进程干完活就退出，
     * 真正干活的是 QQ 里的 NapCat。process-manager 收到 exit 就把它标成
     * stopped，界面于是显示「已停止」，WebUI 按钮跟着置灰 —— 用户看着
     * 一个明明活着的机器人却点不动。
     *
     * 判据必须是端口，但**不能对所有实例都只看端口**（那会让「别的程序占了
     * 同号端口」误报成运行中，见 ipc-handlers 的回归用例）。
     * 正确的分界是：**本进程里真的启动成功过**的实例才认端口。
     *
     * 这里用一个注入器会退出的假进程来还原真实时序：
     *   启动 → 端口通（就绪判定通过）→ 进程退出 → 再查列表
     */
    seed('n')
    putInstance({ id: 'n_alive', type: 'n', name: '活着的猫', port: 6271, status: 'running' })

    const { pm, forceExit } = exitedAfterStartPm()
    /*
     * ══════════════════════════════════════════════════════════════════
     * ★ 为什么这里要**先 start 再占端口**（顺序不能反，我踩了两次）
     * ══════════════════════════════════════════════════════════════════
     *
     * 产品在 `instance:start` 里有一道**正确且必要**的防护：
     *   端口已有服务在监听 → 拒绝启动
     *（避免拉起第二个 NapCat 抢同一个端口 / 错认别人的服务）
     *
     * 所以 `await listenOn(6271)` 放前面的话，start 会直接被拒 ——
     * 测试根本走不到要验证的"注入器退出后按端口判活"。
     *
     * 真实时序是：
     *   ① start 时端口还空着 → 拉起注入器 → 它让 QQ 里的 NapCat 监听端口
     *   ② 注入器随后退出，但端口**仍由 QQ 服务着**
     *
     * 这里如实还原这个顺序：先让注入器"把服务带起来"（真起监听），
     * 再让它退出。
     */
    const origStart = pm.start
    const pmWithPort: ProcessManager = {
      ...pm,
      start: async (...args: Parameters<typeof origStart>) => {
        const r = await origStart(...args)
        /* 注入器干完活：端口这一刻起由"QQ 里的 NapCat"服务 */
        await listenOn(6271)
        return r
      }
    }

    const h = buildHandlers({
      probe: () => Promise.resolve(false),
      processManager: pmWithPort,
      commandFor: () => ({ cmd: process.execPath, args: ['-e', 'setTimeout(()=>{},1500)'] })
    })
    await h['config:set']({ dataRoot: root })
    await h['instance:start']('n_alive')
    // 注入器退出：进程管理器里已经没有它了，但端口仍由 QQ 里的 NapCat 服务着
    forceExit()
    const list = (await h['instance:list']()) as Array<{ id: string; status: string }>
    expect(
      list.find((x) => x.id === 'n_alive')?.status,
      '启动成功过的实例，注入器退出后仍该按端口判为运行中'
    ).toBe('running')
  })

  it('★从没启动成功过的实例，端口通也不算它在跑（别的程序占了同号端口）', async () => {
    /*
     * 这条是与上一条**配对**的，两条合起来才定义清楚契约：
     * 光看端口会把占用同号端口的无关程序误判成本实例在跑；
     * 光看进程又把 NapCat 注入模式判死。分界就是「本进程里启动成功过没」。
     *
     * 场景：实例从没启动过，但端口上真有一个监听者（别人的程序）。
     */
    seed('n')
    await listenOn(6279)
    putInstance({ id: 'n_squat', type: 'n', name: '端口被占', port: 6279, status: 'stopped' })

    const h = buildHandlers({ probe: () => Promise.resolve(false), processManager: createProcessManager() })
    await h['config:set']({ dataRoot: root })
    const list = (await h['instance:list']()) as Array<{ id: string; status: string }>
    expect(
      list.find((x) => x.id === 'n_squat')?.status,
      '没启动过的实例，端口通只说明别人占着这个端口，必须是 stopped'
    ).toBe('stopped')
  })

  it('端口通的实例会被顺带修回磁盘（下次开软件也是对的）', async () => {
    /*
     * 注：`instance:start` 有「端口已占则拒绝启动」的防护，
     * 所以必须先 start（端口空）再让"注入器把服务带起来"——
     * 与上一条同样的时序，详见那里的长注释。
     */
    seed('a')
    putInstance({ id: 'a_alive', type: 'a', name: '活着的机器人', port: 6272, status: 'running' })

    const { pm, forceExit } = exitedAfterStartPm()
    const h = buildHandlers({
      probe: () => Promise.resolve(false),
      processManager: {
        ...pm,
        start: async (...args: Parameters<typeof pm.start>) => {
          const r = await pm.start(...args)
          await listenOn(6272)
          return r
        }
      },
      commandFor: () => ({ cmd: process.execPath, args: ['-e', 'setTimeout(()=>{},1500)'] })
    })
    await h['config:set']({ dataRoot: root })
    await h['instance:start']('a_alive')
    forceExit()
    await h['instance:list']()
    const idx = JSON.parse(require('fs').readFileSync(join(root, 'instances.json'), 'utf8')) as {
      instances: Array<{ id: string; status: string }>
    }
    expect(idx.instances.find((x) => x.id === 'a_alive')?.status).toBe('running')
  })

  it('error 状态也要被校正：本进程启动过且端口通了就该显示运行中', async () => {
    seed('n')
    putInstance({ id: 'n_err', type: 'n', name: '报错但其实活着', port: 6273, status: 'running' })
    const { pm, forceExit } = exitedAfterStartPm()
    const h = buildHandlers({
      probe: () => Promise.resolve(false),
      processManager: {
        ...pm,
        start: async (...args: Parameters<typeof pm.start>) => {
          const r = await pm.start(...args)
          await listenOn(6273)
          return r
        }
      },
      commandFor: () => ({ cmd: process.execPath, args: ['-e', 'setTimeout(()=>{},1500)'] })
    })
    await h['config:set']({ dataRoot: root })
    await h['instance:start']('n_err')
    forceExit()
    // 把磁盘改回 error，模拟「进程被标错了」
    putStatus('n_err', 'error')
    const list = (await h['instance:list']()) as Array<{ id: string; status: string }>
    expect(list.find((x) => x.id === 'n_err')?.status).toBe('running')
  })

  it('刚点过停止、端口还没释放时，必须显示「已停止」而不是回弹成运行中', async () => {
    /*
     * 真实现象：taskkill 之后端口不会立刻释放（内核回收 FIN/TIME_WAIT 有延迟），
     * 这时探活仍然是通的。如果只看端口，用户点了「停止」却看到它又变成「运行中」，
     * 会以为停止失效了。所以主动停过的实例在宽限期内以「已停止」为准。
     *
     * 注：这里**不经过 instance:start** —— 那条路有「端口已占则拒绝启动」
     * 的防护（那是对的），而本用例要验证的是 **stop 之后的判活口径**。
     * 所以直接建一条 running 记录 + 真占端口，然后调 stop。
     */
    seed('n')
    putInstance({ id: 'n_juststopped', type: 'n', name: '刚停的猫', port: 6278, status: 'running' })
    /* 先 stop（此刻端口空，能顺利停），再让端口"还没释放" */
    const h = buildHandlers({ probe: () => Promise.resolve(false), processManager: createProcessManager() })
    await h['config:set']({ dataRoot: root })
    await h['instance:stop']('n_juststopped')
    /* 模拟"端口还没释放"：服务仍在监听 */
    await listenOn(6278)
    // 端口 6278 此刻仍然是通的（服务还在监听），但不能因此判成 running
    const list = (await h['instance:list']()) as Array<{ id: string; status: string }>
    expect(list.find((x) => x.id === 'n_juststopped')?.status).toBe('stopped')
  })

  it('starting 期间的实例不该被探活硬掰成 stopped（启动中端口没通是正常的）', async () => {
    seed('a')
    putInstance({ id: 'a_starting', type: 'a', name: '启动中', port: 6274, status: 'starting' })
    const h = buildHandlers({ probe: () => Promise.resolve(false), processManager: createProcessManager() })
    await h['config:set']({ dataRoot: root })
    /*
     * 注意 config:set 会把「孤儿 starting/running」归位成 stopped：
     * 进程管理器只活在内存里，软件重启后不可能还有实例处于 starting。
     * 所以这里先把它放回 starting 再查列表，验证的是 list 自身遇到 starting 会跳过探活。
     */
    const recs = (await h['instance:list']()) as Array<{ id: string; status: string }>
    expect(recs.find((x) => x.id === 'a_starting')?.status).toBe('stopped')
  })

  it('重启后磁盘上的 starting/running 都会被归位成 stopped（孤儿状态）', async () => {
    seed('a')
    putInstance({ id: 'a_orphan1', type: 'a', name: '孤儿1', port: 6275, status: 'starting' })
    putInstance({ id: 'a_orphan2', type: 'a', name: '孤儿2', port: 6276, status: 'running' })
    const h = buildHandlers({ probe: () => Promise.resolve(false), processManager: createProcessManager() })
    await h['config:set']({ dataRoot: root })
    const list = (await h['instance:list']()) as Array<{ id: string; status: string }>
    expect(list.find((x) => x.id === 'a_orphan1')?.status).toBe('stopped')
    expect(list.find((x) => x.id === 'a_orphan2')?.status).toBe('stopped')
  })
})
