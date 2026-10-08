import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'
import { NAPCAT_DEFAULT_TOKEN } from '../../src/main/constants'
import { testStage } from '../helpers/stage'
import { freePort, freePortIn } from '../helpers/port'

let root: string
beforeEach(() => {
  root = testStage('acb-ipc-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/*
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 端口探测桩：**不能无条件说"都可用"**（主人 2026-09-27 踩到）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 原来它是 `() => Promise.resolve(true)` —— 等于宣称"6200-6299 全是空的"。
 * 而**开发机上真有一套 QQ+NapCat 在跑**（NapCat 注入 QQ 后就在 6200 开
 * OneBot 端口，本机实测就是）。于是：
 *
 *   · 实例自动分配到 **6200**（因为桩说它空着）
 *   · 而 QQ 真的在 6200 上监听
 *   · `backup:make` 里的 `probePort(rec.port)` 探到端口通
 *     → 判定"实例正在跑" → `stoppedFirst` 返回 true
 *   · 测试红：`expected true to be false`
 *
 * 这个教训在文件里其实**早就有**（见下面"不能依赖 6200 段没人用"那段），
 * 但当时只落到了 `freePortIn` 上 —— **桩还是无条件 true**，于是换个入口
 * 又撞了同一堵墙。
 *
 * ## 现在：桩也做**真实的占用探测**
 *
 * 保留"注入"的意义（测试不直接依赖 handler 层的网络实现），
 * 但结果与真实一致 —— 只对**真的能监听**的端口说 true。
 * 这样实例永远不会被分到别人占着的端口上。
 */
const stubProbe = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const net = require('net') as typeof import('net')
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    /* 绑回环：与主进程真实的 createTcpProbe 同一套判据 */
    srv.listen(port, '127.0.0.1')
  })

/**
 * 预置一个「已安装的运行时」。
 * instance:create 现在要求该类型至少装了一个版本（没装就不许建空壳实例），
 * 所以测试得先造出 runtimes/<type>/<tag> 目录——store 会自己从磁盘补全清单。
 */
function seedRuntime(dataRoot: string, type: 'a' | 'n', tag = type === 'a' ? 'v4.28.0' : 'v4.18.19'): void {
  const dir = join(dataRoot, 'runtimes', type, tag)
  mkdirSync(dir, { recursive: true })
  // 放个标记文件，让目录非空（真实安装目录里当然有东西）
  writeFileSync(join(dir, 'mxbot-runtime.json'), JSON.stringify({ tag, kind: type === 'a' ? 'pypi' : 'node' }), 'utf8')
}

/**
 * 假的实例进程：必须真的监听端口。
 * instance:start 现在以「端口能连上」为就绪判据——只看 spawn 会把
 * 「进程活着但服务没起来」误判成成功（NapCat 就栽在这上面，端口不通却显示运行中）。
 */
function fakeServerArgs(port: number): string[] {
  return [
    '-e',
    `require('net').createServer(()=>{}).listen(${port},'127.0.0.1');setInterval(()=>{},1000)`
  ]
}

function mk(
  withCmd: boolean,
  extra?: {
    /*
     * 注意：这里**故意没有 stats 注入**了。
     * buildHandlers 也不再接受 statsProvider —— 那条链路用的 pidusage 在
     * Windows 上要 spawn 已被移除的 wmic.exe，每次卡 2.4~5.1 秒，
     * 是整个界面卡死的根因，已整体移除。
     */
    system?: () => Promise<{ totalMemMB: number; freeMemMB: number; totalDiskMB: number; freeDiskMB: number }>
    webui?: { openIds: string[] }
  }
) {
  const pm = createProcessManager()
  // 预置两种类型的运行时：instance:create 要求先装好版本，否则会拒绝建空壳实例
  seedRuntime(root, 'a')
  seedRuntime(root, 'n')
  // AstrBot 还要求内置 Python 就绪（靠它运行）
  mkdirSync(join(root, 'runtime', 'python'), { recursive: true })
  writeFileSync(join(root, 'runtime', 'python', 'python.exe'), '', 'utf8')
  const h = buildHandlers({
    probe: stubProbe,
    processManager: pm,
    // 假进程监听实例自己的端口，才能通过就绪判定
    commandFor: withCmd
      ? (rec) => ({ cmd: process.execPath, args: fakeServerArgs(rec.port) })
      : undefined,
    systemInfo: extra?.system,
    webui: extra?.webui
      ? {
          open: async () => undefined,
          close: () => undefined,
          list: () => extra.webui!.openIds
        }
      : undefined
  })
  return h
}

describe('IPC handlers（直接调 handler，不开真窗口）', () => {
  it('config:set 记数据根 → instance:create 落库可 list', async () => {
    const h = mk(false)
    await h['config:set']({ dataRoot: root })
    const rec = (await h['instance:create']({ type: 'a', name: '测试机' })) as {
      id: string
      port: number
    }
    expect(rec.id).toMatch(/^a_/)
    expect(rec.port).toBeGreaterThanOrEqual(6100)
    const list = (await h['instance:list']()) as Array<{ id: string }>
    expect(list.map((x) => x.id)).toContain(rec.id)
  })

  it('instance:list 无数据根时报错提示而非崩', () => {
    const h = mk(false)
    return expect(h['instance:list']()).resolves.toEqual([])
  })

  it('instance:start/stop 更新状态（注入假命令进程）', async () => {
    const h = mk(true)
    await h['config:set']({ dataRoot: root })
    /*
     * 显式给一个**当前真的空闲**的端口。
     *
     * 不能依赖「6200 段没人用」——开发机上可能真有一套 QQ+NapCat 在跑
     * （NapCat 注入 QQ 后就在 6200 开 OneBot 端口），实测本机就是。
     * 假进程绑不上会 EACCES 退出，测试就报一堆看不懂的状态不一致。
     */
    const port = await freePortIn(6200, 6299)
    const rec = (await h['instance:create']({ type: 'n', name: '假 NapCat', port })) as {
      id: string
    }
    await h['instance:start'](rec.id)
    const running = (await h['instance:list']()) as Array<{ id: string; status: string }>
    expect(running.find((x) => x.id === rec.id)?.status).toBe('running')
    await h['instance:stop'](rec.id)
    const stopped = (await h['instance:list']()) as Array<{ id: string; status: string }>
    expect(stopped.find((x) => x.id === rec.id)?.status).toBe('stopped')
  }, 15000)

  it('端口被别的程序占着时，进程没起来的实例**不能**显示成运行中', async () => {
    /*
     * 这条是真实 bug 的回归测试（跑上面那条 QQ 用例时暴露出来的）。
     *
     * 原来的判定只看「端口能不能连上」。而端口是共享资源：用户自己另开的
     * 一套 QQ/NapCat、上一个没退干净的残留进程、甚至不相干的软件占了同号端口，
     * 探测都会连得上 —— 于是一个**启动失败、进程根本没起来**的实例
     * 被标成「运行中」。用户会以为它在跑，去点 WebUI 才发现什么都没有。
     *
     * 这里直接制造这个场景：实例没启动（进程管理器里没有它），
     * 但往它的端口上真起一个监听者，然后看状态。
     */
    const h = mk(true)
    await h['config:set']({ dataRoot: root })
    const port = await freePortIn(6200, 6299)
    const rec = (await h['instance:create']({ type: 'n', name: '端口被占', port })) as {
      id: string
      port: number
    }

    // 冒充「别人的程序」占住这个端口
    const net = await import('net')
    const squatter = net.createServer(() => {})
    await new Promise<void>((res) => squatter.listen(rec.port, '127.0.0.1', () => res()))

    try {
      // 这个实例从没启动过
      const list = (await h['instance:list']()) as Array<{ id: string; status: string }>
      expect(
        list.find((x) => x.id === rec.id)?.status,
        '端口通 ≠ 这个实例在运行；它的进程根本不存在，必须是 stopped'
      ).toBe('stopped')
    } finally {
      await new Promise<void>((res) => squatter.close(() => res()))
    }
  }, 20000)

  it('进程真的活着 + 端口通 → 才算运行中（别把正常情况也判死）', async () => {
    // 上一条的对照：不能为了修 bug 就把「真在跑」也判成 stopped
    const h = mk(true)
    await h['config:set']({ dataRoot: root })
    /*
     * ★ 用**区间靠后**的端口段，避开本文件前面用例刚用过的那些
     *
     * `freePortIn` 从区间头开始扫，于是总返回"最早空闲"的那个 ——
     * 而前面几条用例刚放开的端口可能还处在 TIME_WAIT / 进程回收窗口里：
     *   · `canBind` 这时**已经能绑上**（内核允许绑 TIME_WAIT 的端口）
     *   · 但上一个用例留下的监听进程还没退干净
     *   · 于是 `instance:start` 探到"端口已有服务" → 拒绝启动 → 偶发红
     *
     * 这是**全量跑才偶发**的那类红（单独跑这个文件永远绿，因为前面的
     * 用例少、端口回收来得及）。从 6260 起跳开前面常用的 6200-6250，
     * 让这条用例拿到的端口不会被别人的残留占着。
     */
    const port = await freePortIn(6260, 6299)
    const rec = (await h['instance:create']({ type: 'n', name: '真在跑', port })) as { id: string }
    await h['instance:start'](rec.id)
    const list = (await h['instance:list']()) as Array<{ id: string; status: string }>
    expect(list.find((x) => x.id === rec.id)?.status).toBe('running')
    await h['instance:stop'](rec.id)
  }, 15000)

  /*
   * stats:overview 现在**只回系统余量**，不再采集每个实例的 CPU/内存。
   *
   * 为什么砍掉（这是「整个软件各种互动都卡」的根因）：
   *   采集靠 pidusage，它在 Windows 上 spawn wmic.exe 取数据，
   *   而 wmic 在新版 Windows 里**已被移除** —— 每次调用要等这条命令
   *   失败超时，实测 2.4~5.1 秒。界面原本每 2 秒轮询一次，
   *   比单次耗时还短，于是主进程几乎永远在等它，所有 IPC 全部排队。
   *   AstrBot / NapCat 自己的 WebUI 都有资源监控，不必重复采集。
   */
  it('stats:overview：只回系统余量，不再采集实例资源', async () => {
    // 要用真进程启动实例，所以 withCmd = true
    const h = mk(true, {
      system: async () => ({ totalMemMB: 16000, freeMemMB: 8000, totalDiskMB: 500000, freeDiskMB: 100000 })
    })
    await h['config:set']({ dataRoot: root })
    const rec = (await h['instance:create']({ type: 'a', name: '看清凉' })) as { id: string }

    // 没注入 systemInfo 时为 undefined
    const h2 = mk(false)
    await h2['config:set']({ dataRoot: join(root, 'lone') })
    const ov2 = (await h2['stats:overview']()) as { system: unknown; perInstance: unknown[] }
    expect(ov2.system).toBeUndefined()
    expect(ov2.perInstance).toEqual([])

    await h['instance:start'](rec.id)
    const ov = (await h['stats:overview']()) as {
      system: { totalMemMB: number }
      perInstance: Array<{ id: string; status: string; name: string; memMB?: unknown; cpuPct?: unknown }>
    }
    expect(ov.system.totalMemMB).toBe(16000)
    const row = ov.perInstance.find((x) => x.id === rec.id)!
    expect(row.name).toBe('看清凉')
    expect(row.status).toBe('running')
    // 关键：不再返回资源字段（省掉那次要命的 wmic 调用）
    expect(row.memMB, '不该再有 memMB —— 它来自会卡死主进程的 pidusage').toBeUndefined()
    expect(row.cpuPct, '不该再有 cpuPct').toBeUndefined()
  })

  it('config:moveDataRoot：迁移实例数据并切换仓库', async () => {
    const h = mk(false)
    await h['config:set']({ dataRoot: root })
    const rec = (await h['instance:create']({ type: 'a', name: '搬迁户' })) as { id: string }
    const { mkdirSync, writeFileSync } = await import('fs')
    mkdirSync(join(rec.dir, 'data'), { recursive: true })
    writeFileSync(join(rec.dir, 'data', 'x.db'), 'payload', 'utf8')

    const target = join(root, 'next-home')
    await h['config:moveDataRoot'](target)
    const json = JSON.parse((await import('fs')).readFileSync(join(target, 'instances.json'), 'utf8'))
    expect(json.instances.map((x: { id: string }) => x.id)).toContain(rec.id)
    const list = (await h['instance:list']()) as Array<{ id: string; dir: string; name: string }>
    expect(list.find((x) => x.id === rec.id)?.dir).toBe(join(target, 'instances', 'AstrBot', rec.id))
    expect(list.find((x) => x.id === rec.id)?.name).toBe('搬迁户')
    expect(((await h['config:get']()) as { dataRoot: string }).dataRoot).toBe(target)
  })

  it('webui:open/close/list 通到管理器（注入假 WebUI）', async () => {
    const openCalls: Array<{ id: string; url: string }> = []
    const pm = createProcessManager()
    seedRuntime(root, 'a')
    mkdirSync(join(root, 'runtime', 'python'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'python', 'python.exe'), '', 'utf8')
    const h2 = buildHandlers({
      probe: stubProbe,
      processManager: pm,
      commandFor: (rec) => ({ cmd: process.execPath, args: fakeServerArgs(rec.port) }),
      webui: {
        open: async (id, url) => {
          openCalls.push({ id, url })
        },
        close: () => undefined,
        list: () => ['a_1']
      }
    })
    await h2['config:set']({ dataRoot: root })
    const rec = (await h2['instance:create']({ type: 'a', name: '内嵌机' })) as {
      id: string
      port: number
    }

    /*
     * 判据是**端口上真有服务**，不是「记录里写着 running」。
     *
     * 这里没启动 → 端口不通 → 拒绝，措辞要说清是没运行。
     *
     * 为什么不显式指定端口：instance:create 强制从类型端口段（AstrBot
     * 6100-6199）里分配，传进来的 port 只要不在段内就会被忽略（用户要求
     * 分段端口）。而 6100 起的那几个端口可能被**本文件前面用例**起的假实例
     * 进程占着没释放 —— 那种情况下本条测的就不是「没运行就拒绝」了。
     * 所以这里先确认端口确实是空闲的，不空闲就跳过该断言（环境问题，不是代码问题）。
     */
    const livePort = await import('../../src/main/proc/health').then((m) =>
      m.probePort(rec.port, 1500)
    )
    if (!livePort) {
      await expect(h2['webui:open'](rec.id)).rejects.toThrow(/没有在本次启动器会话中成功启动|没在运行/)
      expect(openCalls).toEqual([])
    }

    // 真跑起来（且端口确实通）之后才允许开
    await h2['instance:start'](rec.id)
    await h2['webui:open'](rec.id)
    expect(openCalls).toEqual([{ id: rec.id, url: `http://127.0.0.1:${rec.port}` }])
    expect(await h2['webui:list']()).toEqual(['a_1'])
    await h2['webui:close'](rec.id)
    expect(await h2['webui:list']()).toEqual(['a_1']) // fake list 固定，close 不炸即可
  })

  it('logs:export 返回 zip 路径（注入假 logger）', async () => {
    const h = mk(false)
    await h['config:set']({ dataRoot: root })
    const loggerFake = {
      log: () => undefined,
      crash: () => undefined,
      exportZip: async () => join(root, 'logs-export', 'astriax-logs-20260912-120000.zip')
    }
    const h2 = buildHandlers({
      probe: stubProbe,
      processManager: createProcessManager(),
      logger: loggerFake
    })
    const zipPath = (await h2['logs:export']()) as string
    expect(zipPath).toMatch(/\.zip$/)
    expect(zipPath).toContain('astriax-logs')
  })

  it('没装任何运行时 → 创建实例被拒绝（不许建跑不起来的空壳）', async () => {
    // 用一个干净的数据根：里面没有任何 runtimes
    const empty = testStage('acb-empty-')
    try {
      const h = buildHandlers({ probe: stubProbe, processManager: createProcessManager() })
      await h['config:set']({ dataRoot: empty })
      await expect(h['instance:create']({ type: 'a', name: '空壳' })).rejects.toThrow(/还没下载 AstrBot 的任何版本/)
      await expect(h['instance:create']({ type: 'n', name: '空壳2' })).rejects.toThrow(/还没下载 NapCat 的任何版本/)
      // 拒绝了就不该留下半成品记录
      expect(await h['instance:list']()).toEqual([])
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('装了 AstrBot 但没装 Python → 创建被拒绝（AstrBot 靠它跑）', async () => {
    const bare = testStage('acb-nopy-')
    try {
      seedRuntime(bare, 'a') // 只有 AstrBot，没有 runtime/python/python.exe
      const h = buildHandlers({ probe: stubProbe, processManager: createProcessManager() })
      await h['config:set']({ dataRoot: bare })
      await expect(h['instance:create']({ type: 'a', name: '没Python' })).rejects.toThrow(
        /AstrBot 需要先装好 Python 才能运行/
      )
      // NapCat 自带 Node，不受 Python 影响，照样能建
      seedRuntime(bare, 'n')
      const n = (await h['instance:create']({ type: 'n' })) as { id: string }
      expect(n.id).toMatch(/^n_/)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('内置 Python 就绪后 AstrBot 实例才能建出来', async () => {
    const ok = testStage('acb-withpy-')
    try {
      seedRuntime(ok, 'a')
      // 造出 runtime/python/python.exe（isPythonReady 只看这个文件在不在）
      mkdirSync(join(ok, 'runtime', 'python'), { recursive: true })
      writeFileSync(join(ok, 'runtime', 'python', 'python.exe'), '', 'utf8')
      const h = buildHandlers({ probe: stubProbe, processManager: createProcessManager() })
      await h['config:set']({ dataRoot: ok })
      const rec = (await h['instance:create']({ type: 'a' })) as { id: string; port: number }
      expect(rec.id).toMatch(/^a_/)
      expect(rec.port).toBeGreaterThanOrEqual(6100)
    } finally {
      rmSync(ok, { recursive: true, force: true })
    }
  })

  it('不填名字 → 自动叫「AstrBot 实例」，第二个叫「AstrBot 实例2」', async () => {
    const h = mk(false)
    await h['config:set']({ dataRoot: root })
    const a = (await h['instance:create']({ type: 'a' })) as { name: string }
    const b = (await h['instance:create']({ type: 'a' })) as { name: string }
    const n = (await h['instance:create']({ type: 'n' })) as { name: string }
    expect(a.name).toBe('AstrBot 实例')
    expect(b.name).toBe('AstrBot 实例2')
    // NapCat 自己从「NapCat 实例」数起，不与 AstrBot 的序号混用
    expect(n.name).toBe('NapCat 实例')
  })

  it('备份：实例在跑时自动先停下再备份（渲染层已先问过用户）', async () => {
    seedRuntime(root, 'n')
    // 注入一个长命命令当实例进程，走真实的 instance:start 路径（状态才会被标成 running）
    const h = buildHandlers({
      probe: stubProbe,
      processManager: createProcessManager(),
      commandFor: (rec) => ({ cmd: process.execPath, args: fakeServerArgs(rec.port) })
    })
    await h['config:set']({ dataRoot: root })
    const port = await freePortIn(6200, 6299)
    const rec = (await h['instance:create']({ type: 'n', name: '备份户', port })) as { id: string }
    await h['instance:start'](rec.id)
    await new Promise((r) => setTimeout(r, 300))
    const before = (await h['instance:list']()) as Array<{ id: string; status: string }>
    expect(before.find((x) => x.id === rec.id)?.status).toBe('running')

    const res = (await h['backup:make'](rec.id)) as { stoppedFirst?: boolean }
    // 告诉调用方「我把它停了」，好在提示里说清楚
    expect(res.stoppedFirst).toBe(true)
    // 备份完确实是停着的（用户得自己再启动）
    const list = (await h['instance:list']()) as Array<{ id: string; status: string }>
    expect(list.find((x) => x.id === rec.id)?.status).toBe('stopped')
  })

  it('备份：实例本来就停着 → stoppedFirst 为 false，不折腾', async () => {
    seedRuntime(root, 'n')
    const h = buildHandlers({ probe: stubProbe, processManager: createProcessManager() })
    await h['config:set']({ dataRoot: root })
    /*
     * ★ 显式挑一个**真的空闲**的端口（不能让它自己分配）。
     *
     * 为什么必须这样（主人 2026-09-27 实测踩到的）：
     * `defaultAllocate` **只看 instances.json 里已占的端口**，
     * 不知道"这个端口被系统上别的程序占着"。而开发机上真有一套
     * QQ+NapCat 在 6200-6202 跑（本机实测就是），于是：
     *
     *   实例被分到 6200 → 而 QQ 真在那监听
     *   → `backup:make` 的 `probePort(6200)` 返回"通"
     *   → 判定"实例在跑" → `stoppedFirst = true`（期望 false）→ 测试红
     *
     * 用 `freePortIn` 拿一个真的空端口，测试就不受本机环境影响。
     */
    const port = await freePortIn(6200, 6299)
    const rec = (await h['instance:create']({ type: 'n', name: '静止户', port })) as { id: string }
    const res = (await h['backup:make'](rec.id)) as { stoppedFirst?: boolean }
    expect(res.stoppedFirst).toBe(false)
  })

  it('重置账密：实例在跑时先停下再写配置（否则旧值会被写回去，表现为「重置了还是登不上」）', async () => {
    seedRuntime(root, 'a')
    // AstrBot 还必须有内置 Python 才能启动（NapCat 不需要）
    const py = join(root, 'runtime', 'python', 'python.exe')
    mkdirSync(join(root, 'runtime', 'python'), { recursive: true })
    writeFileSync(py, '', 'utf8')
    const h = buildHandlers({
      probe: stubProbe,
      processManager: createProcessManager(),
      commandFor: (rec) => ({ cmd: process.execPath, args: fakeServerArgs(rec.port) })
    })
    await h['config:set']({ dataRoot: root })
    /*
     * AstrBot 实例属于 6100-6199 段 —— 传 6200+ 的提示值同样会被
     * instance:create 丢弃、退回该段首个端口（6100）。
     * 所以这里必须用 AstrBot 的区间。
     */
    const port = await freePortIn(6100, 6199)
    const rec = (await h['instance:create']({ type: 'a', name: '重置户', port })) as { id: string }
    await h['instance:start'](rec.id)
    await new Promise((r) => setTimeout(r, 300))

    const res = (await h['instance:resetCreds'](rec.id)) as {
      list: Array<{ label: string; value: string }>
      stoppedFirst?: boolean
    }
    expect(res.stoppedFirst).toBe(true)
    // 重置完必须停着，让用户重启后才生效
    const list = (await h['instance:list']()) as Array<{ id: string; status: string }>
    expect(list.find((x) => x.id === rec.id)?.status).toBe('stopped')
    // 新凭据要能返回给界面展示（账密都是 astrbot，用户要求）
    expect(res.list.some((c) => c.value === 'astrbot')).toBe(true)
    // 配置要写到 AstrBot 真正读的位置，且密码存的是哈希
    const cfg = JSON.parse(readFileSync(join(rec.dir, 'data', 'cmd_config.json'), 'utf8')) as {
      dashboard: { username: string; pbkdf2_password: string }
    }
    expect(cfg.dashboard.username).toBe('astrbot')
    expect(cfg.dashboard.pbkdf2_password).toMatch(/^pbkdf2_sha256\$600000\$/)
  })

  /*
   * 这条原来断言「NapCat 不给重置 Token」，理由是「token 由启动器固定注入」。
   * 那个前提已经不成立：启动器现在**不再覆盖**用户改过的 token
   * （见 runtime/layout.ts 的 webuiToken 参数），token 真的归用户管，
   * 改乱了、忘了，就得能重置回去。
   */
  it('NapCat 也能重置 Token（启动器不再固定覆盖，用户可能改乱）', async () => {
    seedRuntime(root, 'n')
    const h = buildHandlers({ probe: stubProbe, processManager: createProcessManager() })
    await h['config:set']({ dataRoot: root })
    const rec = (await h['instance:create']({ type: 'n', name: '猫猫' })) as { id: string }

    const res = (await h['instance:resetCreds'](rec.id)) as {
      list: Array<{ label: string; value: string }>
    }
    expect(res.list.some((c) => c.value === NAPCAT_DEFAULT_TOKEN)).toBe(true)
  })

  /*
   * 这两个用例原来断言「有实例在用就拦住删除」，但用户明确要求**改成可以删**
   * （原话：「为什么删除对应文件提示说有 n 个实例正在用这个文件，不让删，
   * 但是点删除的时候又说可以删，已经创建的实例不受影响，改成可以删」）。
   *
   * 原来确实是自相矛盾的：主进程拦，而下载页的确认弹窗同时写着「不受影响」。
   * 现在统一成「可以删」，但要把「谁在用」回传给界面，让用户在删之前就知道后果。
   */
  it('删除运行时：即使有实例在用也允许删（用户要求可删），并回传使用方', async () => {
    seedRuntime(root, 'n')
    const h = buildHandlers({ probe: stubProbe, processManager: createProcessManager() })
    await h['config:set']({ dataRoot: root })
    const rec = (await h['instance:create']({ type: 'n', name: '在用户' })) as { id: string }

    // 这个实例绑定着 v4.18.19 —— 删除**不再被拦**，但要把使用者报回来
    const out = (await h['runtimes:remove']({ type: 'n', tag: 'v4.18.19' })) as { usedBy?: string[] }
    expect(out.usedBy, '要告诉界面有谁在用，好让用户在确认框里看到后果').toContain('在用户')
    expect((await h['runtimes:list']()) as unknown[], '记录已摘掉').toHaveLength(0)

    // 实例记录本身不受影响，仍然在列表里（删的是运行时，不是实例）
    const list = (await h['instance:list']()) as Array<{ id: string }>
    expect(list.map((i) => i.id)).toContain(rec.id)
  })

  it('删除运行时：没人用时也照删，usedBy 为空', async () => {
    seedRuntime(root, 'n', 'v4.18.19')
    seedRuntime(root, 'n', 'v4.17.0')
    const h = buildHandlers({ probe: stubProbe, processManager: createProcessManager() })
    await h['config:set']({ dataRoot: root })
    await h['instance:create']({ type: 'n', name: '旧版户', tag: 'v4.17.0' })

    // 没人用 v4.18.19 → 删掉，usedBy 空
    const a = (await h['runtimes:remove']({ type: 'n', tag: 'v4.18.19' })) as { usedBy?: string[] }
    expect(a.usedBy ?? []).toEqual([])
    // 有人用的 v4.17.0 → 同样可删，但要报出使用方
    const b = (await h['runtimes:remove']({ type: 'n', tag: 'v4.17.0' })) as { usedBy?: string[] }
    expect(b.usedBy).toContain('旧版户')
    expect((await h['runtimes:list']()) as unknown[]).toHaveLength(0)
  })

  it('创建实例后 instance.json 记下了所用版本（换版本/删版本都靠它判断）', async () => {
    seedRuntime(root, 'n')
    const h = buildHandlers({ probe: stubProbe, processManager: createProcessManager() })
    await h['config:set']({ dataRoot: root })
    const rec = (await h['instance:create']({ type: 'n', name: '记版本户' })) as { id: string; dir: string }
    const meta = JSON.parse(readFileSync(join(rec.dir, 'instance.json'), 'utf8')) as { runtimeTag?: string }
    expect(meta.runtimeTag).toBe('v4.18.19')
  })

  it('QQ 没装 → 建 NapCat 实例被拦，理由可直接展示（界面据此弹窗去官网）', async () => {
    seedRuntime(root, 'n')
    const h = buildHandlers({
      probe: stubProbe,
      processManager: createProcessManager(),
      qqChecker: () => ({ ok: false, installed: false, minBuild: 40768, reason: '没有检测到 QQ' })
    })
    await h['config:set']({ dataRoot: root })
    await expect(h['instance:create']({ type: 'n', name: '没QQ' })).rejects.toThrow(/没有检测到 QQ/)
  })

  it('QQ 版本过低 → 建 NapCat 实例被拦，理由里带版本对比', async () => {
    seedRuntime(root, 'n')
    const h = buildHandlers({
      probe: stubProbe,
      processManager: createProcessManager(),
      qqChecker: () => ({
        ok: false,
        installed: true,
        version: '9.9.10-30000',
        build: 30000,
        minBuild: 40768,
        reason: 'QQ 版本太低（当前 9.9.10-30000，构建号 30000），NapCat 需要 40768 以上'
      })
    })
    await h['config:set']({ dataRoot: root })
    await expect(h['instance:create']({ type: 'n', name: '旧QQ' })).rejects.toThrow(/版本太低/)
  })

  it('QQ 检测不妨碍 AstrBot（它不需要 QQ）', async () => {
    seedRuntime(root, 'a')
    mkdirSync(join(root, 'runtime', 'python'), { recursive: true })
    writeFileSync(join(root, 'runtime', 'python', 'python.exe'), '', 'utf8')
    const h = buildHandlers({
      probe: stubProbe,
      processManager: createProcessManager(),
      qqChecker: () => ({ ok: false, installed: false, minBuild: 40768, reason: '没有检测到 QQ' })
    })
    await h['config:set']({ dataRoot: root })
    const rec = (await h['instance:create']({ type: 'a', name: '不关QQ事' })) as { id: string }
    expect(rec.id).toMatch(/^a_/)
  })

  it('启动 NapCat 前也要复核 QQ（下载时合格、后来卸载了要能拦住）', async () => {
    seedRuntime(root, 'n')
    let qqOk = true
    const h = buildHandlers({
      probe: stubProbe,
      processManager: createProcessManager(),
      commandFor: (rec) => ({ cmd: process.execPath, args: fakeServerArgs(rec.port) }),
      qqChecker: () =>
        qqOk
          ? { ok: true, installed: true, minBuild: 40768, build: 49738 }
          : { ok: false, installed: false, minBuild: 40768, reason: '没有检测到 QQ' }
    })
    await h['config:set']({ dataRoot: root })
    const rec = (await h['instance:create']({ type: 'n', name: '先好后坏' })) as { id: string }
    // 中途 QQ 没了
    qqOk = false
    await expect(h['instance:start'](rec.id)).rejects.toThrow(/没有检测到 QQ/)
    // 没启动起来就别留个 running 的假状态
    const list = (await h['instance:list']()) as Array<{ id: string; status: string }>
    expect(list.find((x) => x.id === rec.id)?.status).not.toBe('running')
  })

  it('qq:status 未接线时不误报（测试环境放行）', async () => {
    const h = buildHandlers({ probe: stubProbe, processManager: createProcessManager() })
    await h['config:set']({ dataRoot: root })
    const st = (await h['qq:status']()) as { ok: boolean }
    expect(st.ok).toBe(true)
  })
})
