/*
 * 数据目录搬家：两条硬契约（主人 0.1.3 实测抓出的缺陷）
 *
 * ## 契约一：实例还在运行时，必须先停掉再搬（不许带病复制）
 *
 * 主人日志实锤：两个实例 08:00/08:01 启动着，08:36 点搬家，
 * 一条"停止实例"的记录都没有就直接开搬了 —— 于是 QQ/NapCat 一边往旧根
 * 写 .db-wal，一边被复制走，目标根里那份是**半新半旧**的。
 *
 * 病因：守卫读的是**磁盘上的 status 字段**（审计点过的那批"读盘判活"
 * 调用点之一），字段一旦被 config:set 的重启恢复归位、或与真实进程脱节，
 * 守卫就放行。修法与 instance:update 统一：liveStatusOf + pm.statusOf。
 *
 * ## 契约二：搬家进行中不许再开第二次（防重入）
 *
 * 原来"进行中"只存在设置页的组件变量里：关掉设置页再进来，
 * 界面又显示"可以搬"（而主进程的复制还在跑）—— 用户可能再点一次，
 * 两份复制交错写同一个目标。修法：状态提到主进程（relocateActive），
 * 第二次触发直接拒绝，状态经 config:moving 暴露给界面轮询。
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager, type ProcessManager } from '../../src/main/proc/process-manager'
import { testStage } from '../helpers/stage'

/** 造一个带实例的旧根（+ 一个可搬的目标目录） */
function setup(opts: { runtimes?: boolean } = {}): {
  srcRoot: string
  dstRoot: string
  id: string
  cleanup: () => void
} {
  const root = testStage('move-guard-')
  const srcRoot = join(root, 'old')
  const dstRoot = join(root, 'new')
  mkdirSync(srcRoot, { recursive: true })
  mkdirSync(dstRoot, { recursive: true })

  const id = 'n_move0001'
  const instDir = join(srcRoot, 'instances', 'NapCat', id)
  mkdirSync(instDir, { recursive: true })
  // 实例自己的数据（搬家时必须原样过去）
  writeFileSync(join(instDir, 'config.json'), '{"precious":true}', 'utf8')
  // NapCat 那种「注入 QQ 后还在写文件」的现场：一个模拟的 db-wal
  writeFileSync(join(instDir, 'napcat.db-wal'), 'WRITING-NOW', 'utf8')
  writeFileSync(
    join(srcRoot, 'instances.json'),
    JSON.stringify({
      instances: [
        {
          id,
          type: 'n',
          name: '搬家测试实例',
          dir: instDir,
          /*
           * ══════════════════════════════════════════════════════════════════
           * ★ 端口**不能**用 NapCat 的真实端口（6200）
           * ══════════════════════════════════════════════════════════════════
           *
           * 踩过的坑（主人机器实测）：原来这里写死 `port: 6200`，
           * 而他的机器上**真的有一个 NapCat 在 6200 上跑** ——
           * 于是这两条测试里的 `stopInstanceHard` 走到
           *     waitPortGone(6200, 3000) → 永远不 gone → 再 findListenerPidAsync
           * 一路等下来直接 **5 秒超时**，测试红了。
           *
           * 那是**环境干扰**，不是代码缺陷；但测试不该依赖"这台机器
           * 恰好没人占 6200" —— 所以改用一个高位端口。
           *
           * 选 59731 的理由：高位（避开常见服务与端口段约定），
           * 且这个测试**从不起真监听**（port 只用来让 waitPortGone 探测），
           * 所以只要它没被别人占，路径就是"秒回 gone"。
           */
          port: 59731,
          status: 'running',
          templateVersion: 41819,
          createdAt: new Date().toISOString()
        }
      ]
    }),
    'utf8'
  )
  writeFileSync(
    join(srcRoot, 'config.json'),
    JSON.stringify({ dataRoot: srcRoot, portMin: 6100, portMax: 6299, backupKeep: 5 }),
    'utf8'
  )
  if (opts.runtimes) {
    mkdirSync(join(srcRoot, 'runtimes', 'n', 'v4.18.19'), { recursive: true })
    writeFileSync(join(srcRoot, 'runtimes.json'), JSON.stringify({ versions: [] }), 'utf8')
  }
  return { srcRoot, dstRoot, id, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** 一个"实例确实在跑"的进程管理器（照 instance-status.spec 的既有形态） */
function runningPm(): ProcessManager {
  return {
    start: async () => ({
      status: 'running' as const,
      pid: () => 4242,
      eventually: async () => undefined,
      exitCode: () => undefined,
      tail: () => '',
      lastOutputAt: () => Date.now()
    }),
    statusOf: () => 'running' as const,
    killTreeSync: () => undefined,
    killAllSync: () => undefined,
    pidsOf: () => new Map<string, number>(),
    onStatus: () => () => undefined,
    tailOf: () => ''
  }
}

async function makeHandlers(
  srcRoot: string,
  pm?: ProcessManager,
  opts: { probe?: () => Promise<boolean>; logger?: { log: (lv: 'INFO' | 'WARN' | 'ERROR', ch: string, msg: string, d?: string) => void } } = {}
): Promise<ReturnType<typeof buildHandlers>> {
  const h = buildHandlers({
    /*
     * 探活默认恒 true + runningPm：凑出"真的在运行"（与 instance:update 的用例同款）。
     *
     * 但"实例是停的"那条用例需要相反的世界 —— 所以探活可覆盖。
     * 第一版把 true 写死在这里，导致那条用例怎么写都不对：
     * 盘上标 stopped、探活却说通、pm 也说 running → 判活判成"在跑"，
     * 于是搬家用例里真的会去停它（暴露成一条失败的断言）。
     * 判活口径统一之后，"停"的世界必须三处一致：盘上 stopped +
     * 探活 false + pm.statusOf 非 running。
     */
    probe: opts.probe ?? (() => Promise.resolve(true)),
    processManager: pm ?? createProcessManager(),
    commandFor: () => ({ cmd: 'x', args: [] }) as never,
    // logger 可注入：用来验"关键操作标记"确实被写下（见下面那条用例）
    logger: opts.logger
  })
  await h['config:set']({ dataRoot: srcRoot })
  return h
}

/** 一个"实例确实已停"的进程管理器（与 stopped 的盘上状态、探活 false 配套） */
function stoppedPm(): ProcessManager {
  return {
    ...runningPm(),
    statusOf: () => 'stopped' as const
  }
}

describe('★搬家守卫：实例在运行时必须先停干净', () => {
  it('★实例真的在跑 → 搬家过程中必须留下"停止实例"的动作（不许静默开搬）', async () => {
    /*
     * 判据不是"抛不抛错"（搬完与否取决于实现），而是：
     * **有没有真的去停那个实例**。修之前完全不停（日志里一条没有）——
     * 于是复制走的是正在写的文件。
     *
     * 怎么观察"停了"：给一个记账的 pm，killTreeSync / stopInstanceHard
     * 会经过它。只要有调用就说明守卫生效了。
     */
    const s = setup()
    try {
      const calls: string[] = []
      const pm = runningPm()
      const spyPm: ProcessManager = {
        ...pm,
        killTreeSync: (id: string) => {
          calls.push(`kill:${id}`)
        },
        killAllSync: () => undefined,
        pidsOf: () => new Map<string, number>()
      }
      const h = await makeHandlers(s.srcRoot, spyPm)

      // 搬家（可能因为测试环境的额外检查而抛错，但重点是"有没有去停"）
      try {
        await h['config:moveDataRoot'](s.dstRoot)
      } catch {
        /* 允许失败：本用例只验"守卫有没有动手" */
      }

      expect(
        calls.length,
        '实例明明在跑，搬家却一次都没去停它 —— 数据会被"边写边复制"，新根是半新半旧的'
      ).toBeGreaterThan(0)
      expect(calls[0], '要停的是那个正在跑的实例').toContain(s.id)
    } finally {
      s.cleanup()
    }
  })

  it('实例已停止 → 不产生多余的"停止"动作（别把正常路径也拦了）', async () => {
    const s = setup()
    try {
      /*
       * ★ calls 必须真的接上（审计抓出的空断言）
       *
       * 第一版这里声明了 `const calls: string[] = []`，却用**默认的**
       * createProcessManager 建 handler —— 没有任何 spy 往 calls 里写，
       * 于是 `expect(calls.length).toBe(0)` **恒真**：就算代码真的多停了
       * 一次，这条也照样绿。这种"安慰剂断言"比没有测试更糟，
       * 因为它给的是**虚假的安全感**。
       *
       * 现在注入 spy（与上一条"在跑的实例"用例同一套做法），
       * 断言才有意义：实例是 stopped，就不该出现任何 kill 调用。
       */
      const calls: string[] = []
      const pm = stoppedPm()
      const spyPm: ProcessManager = {
        ...pm,
        killTreeSync: (id: string) => {
          calls.push(`kill:${id}`)
        },
        killAllSync: () => undefined,
        pidsOf: () => new Map<string, number>()
      }
      // 三处一致地表达"这个实例是停的"：探活 false + pm.statusOf stopped（+ 盘上 stopped）
      const h = await makeHandlers(s.srcRoot, spyPm, { probe: () => Promise.resolve(false) })
      // 先把盘上状态改成 stopped（且没有真假难辨的运行进程）
      const insts = JSON.parse(
        (await import('fs')).readFileSync(join(s.srcRoot, 'instances.json'), 'utf8')
      ) as { instances: Array<{ status: string }> }
      insts.instances[0].status = 'stopped'
      writeFileSync(join(s.srcRoot, 'instances.json'), JSON.stringify(insts), 'utf8')

      const r = (await h['config:moveDataRoot'](s.dstRoot)) as { failed?: unknown[] }
      expect(Array.isArray(r.failed), '正常路径应当走完并返回结果').toBe(true)
      // 数据确实过去了
      expect(
        existsSync(join(s.dstRoot, 'instances', 'NapCat', s.id, 'config.json')),
        '实例数据必须搬到新根'
      ).toBe(true)
      /*
       * 这条断言现在**真的会失败**：spy 已经接上，任何多余的停止动作
       * 都会出现在 calls 里。（原来 calls 永远是空的，所以断言恒真。）
       */
      expect(calls, '实例本来是停的，不该产生任何停止动作').toEqual([])
    } finally {
      s.cleanup()
    }
  })

  it('★关键操作标记：搬家会写下 [op:start]/[op:end]（崩溃时靠它定位）', async () => {
    const s = setup()
    try {
      const logs: string[] = []
      const h = await makeHandlers(s.srcRoot, runningPm(), {
        logger: {
          log: (lv, ch, msg) => {
            logs.push(`${lv}|${ch}|${msg}`)
          }
        }
      })
      await h['config:moveDataRoot'](s.dstRoot).catch(() => undefined)

      /*
       * 指导书 3.2 要求"关键操作前后打标记"。判据很硬：
       *   有 [op:start] 没有 [op:end] → 进程死在那个操作里。
       * 所以这对标记必须**真的被写下**，而且搬家这种重操作一定要有 ——
       * 这条用例就是防"以后有人清理日志时顺手把它删了"。
       */
      expect(
        logs.some((l) => l.includes('[op:start] moveDataRoot')),
        '搬家没有写开始标记 —— 崩溃时将无法定位"死在搬家里面"'
      ).toBe(true)
      expect(
        logs.some((l) => l.includes('[op:end] moveDataRoot')),
        '搬家没有写结束标记 —— 正常完成也会被误判成"卡在搬家"'
      ).toBe(true)
    } finally {
      s.cleanup()
    }
  })

  it('★搬家进行中不许启动实例（否则会写到正在复制的旧目录里）', async () => {
    const s = setup()
    try {
      const h = await makeHandlers(s.srcRoot, runningPm())
      /*
       * 四厂商审计（三家一致）指出的数据安全问题：
       * 搬家的复制窗口可能持续几分钟，而 state() 里的 config/repo 要等
       * 复制结束才切到新根 —— 这期间启动的实例会往**正在被复制的旧目录**
       * 写数据，复制出的副本半新半旧；实例日志还会写进 logs\instances
       *（logs 也是被复制的成员）。原来的守卫只防"开始时在跑的"实例，
       * 没防"搬家期间新起来的"。
       *
       * 触发方式：**不 await** 搬家调用 —— relocateActive 在 handler
       * 开头就同步置 true（在任何 await 之前），所以紧接着调
       * instance:start 必然落在"正在搬"的窗口里。
       */
      const moving = h['config:moveDataRoot'](s.dstRoot).catch(() => undefined)
      const err = await h['instance:start'](s.id).then(
        () => null,
        (e: unknown) => String(e instanceof Error ? e.message : e)
      )
      expect(err, '搬家期间竟然允许启动实例 —— 它会写进正在复制的旧目录').not.toBeNull()
      expect(err).toMatch(/搬家/)
      await moving
    } finally {
      s.cleanup()
    }
  })
})

describe('★搬家防重入：进行中不许再开第二次', () => {
  it('★搬家进行中再调一次 → 明确拒绝（不许并行复制同一目标）', async () => {
    const s = setup({ runtimes: true })
    try {
      const h = await makeHandlers(s.srcRoot)
      /*
       * 同时发两次（不 await 第一次）：真实场景就是用户"没等完又点一次"。
       * 第二次必须被拒 —— 否则两份复制交错写同一个目标。
       */
      const first = h['config:moveDataRoot'](s.dstRoot)
      const second = h['config:moveDataRoot'](s.dstRoot)

      const results = await Promise.allSettled([first, second])
      const rejected = results.filter((r) => r.status === 'rejected')
      expect(
        rejected.length,
        '第二次搬家必须被拒绝（并行复制会把目标写成半新半旧）'
      ).toBeGreaterThan(0)
      expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/进行中/)
    } finally {
      s.cleanup()
    }
  })

  it('状态可查：config:moving 如实反映进行中/已结束', async () => {
    const s = setup({ runtimes: true })
    try {
      const h = await makeHandlers(s.srcRoot)
      // 空闲时：不在搬
      expect(await h['config:moving']()).toMatchObject({ active: false })
      // 搬完之后也必须复位（finally 无条件释放，否则软件永远拒绝再搬）
      await h['config:moveDataRoot'](s.dstRoot)
      expect(await h['config:moving']()).toMatchObject({ active: false })
    } finally {
      s.cleanup()
    }
  })
})
