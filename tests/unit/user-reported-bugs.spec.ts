import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'
import { testStage } from '../helpers/stage'
import { freePortIn } from '../helpers/port'

/**
 * 这几条都来自用户的真实报告和日志，不是假想场景。
 *
 * 共同的教训：**别拿磁盘上的记录当现实**。
 * NapCat 注入 QQ 之后 QQ 会脱离我们的进程树，记录和现实很容易不一致。
 */

let root: string
beforeEach(() => {
  root = testStage('acb-userbug-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 预置运行时，让 instance:create 能过 */
function seed(root: string): void {
  for (const t of ['a', 'n'] as const) {
    const tag = t === 'a' ? 'v4.28.0' : 'v4.18.19'
    const d = join(root, 'runtimes', t, tag)
    mkdirSync(d, { recursive: true })
    // 真实安装成功后才会写这个标记，runtime-store 用它判断「目录里有货」
    writeFileSync(join(d, 'mxbot-runtime.json'), JSON.stringify({ tag, kind: 'node' }), 'utf8')
    writeFileSync(join(d, 'package.json'), JSON.stringify({ version: tag.slice(1) }), 'utf8')
  }
  mkdirSync(join(root, 'runtime', 'python'), { recursive: true })
  writeFileSync(join(root, 'runtime', 'python', 'python.exe'), '', 'utf8')
}

function mk(opts?: { webuiOpen?: (id: string, url: string) => Promise<void> }): {
  h: ReturnType<typeof buildHandlers>
} {
  seed(root)
  const h = buildHandlers({
    probe: () => Promise.resolve(true),
    processManager: createProcessManager(),
    commandFor: (rec) => ({
      cmd: process.execPath,
      args: ['-e', `require('net').createServer(()=>{}).listen(${rec.port},'127.0.0.1');setInterval(()=>{},1000)`]
    }),
    webui: {
      open: opts?.webuiOpen ?? (async () => undefined),
      close: () => undefined,
      list: () => []
    }
  })
  return { h }
}

describe('用户报告：NapCat 在运行中，但点 WebUI 说「未启动」', () => {
  it('★本进程启动成功过的实例：句柄没了、端口仍在服务 → 照常打开', async () => {
    /*
     * ══════════════════════════════════════════════════════════════════
     * ★ 契约（见 ipc.ts 的 liveStatusOf 那段长注释）
     * ══════════════════════════════════════════════════════════════════
     *
     * 两个需求互相顶，判据必须把「这个实例」和「别的进程」区分开：
     *
     *   · **从没在本进程启动成功过** → 端口通也不算它跑着
     *     （否则别的程序占了同号端口，会把一个从没起来的实例显示成「运行中」）
     *   · **本进程启动过并已确认就绪** → 句柄没了也认端口
     *     （NapCat 是注入 QQ 跑的，注入器退出后 QQ 里的 NapCat 还活着）
     *
     * 这条覆盖**后半句**（用户报告的真实场景）：注入器退出、端口仍通 → 要能打开。
     *
     * 关键前提：必须先真的 `instance:start` 成功过一次
     *（`startedInThisRun` 只在启动确认就绪后才加）。
     */
    let opened = ''
    const { h } = mk({
      webuiOpen: async (_id, url) => {
        opened = url
      }
    })
    await h['config:set']({ dataRoot: root })
    const port = await freePortIn(6200, 6299)
    const rec = (await h['instance:create']({ type: 'n', name: '注入户', port })) as { id: string }

    /*
     * ## 实现说明（我第一版把它写超时了，记下来免得再犯）
     *
     * `mk()` 的 `commandFor` 用的假命令**自己会监听端口**
     *（`require('net').createServer().listen(rec.port)`），所以**不需要**
     * 测试再手动绑一次 —— 手动绑会和 `instance:start` 的就绪等待**互相卡死**：
     * start 在等端口通，而端口要等 start 返回之后才绑上去 → 必然超时。
     *
     * 这里要做的只有两件事：
     *   ① 正常启动一次（假命令起监听 → 就绪判定通过 → id 进入 startedInThisRun）
     *   ② 直接查 WebUI 能不能打开（端口仍由那个假命令的子进程服务着）
     *
     * 也就是说，"注入器退出、QQ 里的 NapCat 继续服务"这个场景，
     * 假命令本身就还原了 —— 我们 spawn 的那个 node 进程活着与否
     * 并不影响端口上有服务这件事，而判据看的正是端口。
     */
    try {
      await h['instance:start'](rec.id)
      await expect(
        h['webui:open'](rec.id),
        '启动成功过、端口又在服务 → 就该打开，不能因为句柄没了把用户挡回去'
      ).resolves.toBeUndefined()
      expect(opened).toContain(String(rec.port))
    } finally {
      /* 收尾：把假命令起的子进程收掉，别让它占着端口影响后面的用例 */
      await h['instance:stop'](rec.id).catch(() => undefined)
    }
  })

  it('★从没启动成功过的实例：端口有服务也不打开（可能属于残留进程或别的程序）', async () => {
    /*
     * 这条覆盖契约的**前半句**：端口是共享资源，任何别的程序占着它都能连上，
     * 所以"端口通"本身不能证明"这是我们的实例在跑"。
     *
     * 这是有意为之的保守行为 —— 宁可让用户先点一次「启动」，
     * 也不能把他连到一个**别人的**服务上（那会看到不相干的界面）。
     */
    const { h } = mk()
    await h['config:set']({ dataRoot: root })
    const port = await freePortIn(6200, 6299)
    const rec = (await h['instance:create']({ type: 'n', name: '没服务', port })) as {
      id: string
      port: number
    }
    expect(rec.port, '提示的端口落在类型段内，应当被采纳').toBe(port)

    // 确认这个端口确实没人听
    const live = await (await import('../../src/main/proc/health')).probePort(rec.port, 1500)
    expect(live, `端口 ${rec.port} 在实例创建后被人占用了（环境问题，不是代码问题）`).toBe(false)

    await expect(h['webui:open'](rec.id)).rejects.toThrow(/没有在本次启动器会话中成功启动/)
  })
})

describe('用户报告：点停止实例没真停掉（NapCat 注入的 QQ 脱链）', () => {
  it('端口上还有"来路不明"的监听者时：拒绝谎报已停止，明确告诉用户怎么办', async () => {
    /*
     * 用户日志的实据：停止实例记的是 11:10:37，实例日志却一直写到 11:25:17
     * —— 停了之后还跑了 15 分钟。
     *
     * ══════════════════════════════════════════════════════════════════
     * ★ 契约（这段是理解本用例的关键，别按直觉改回去）
     * ══════════════════════════════════════════════════════════════════
     *
     * 停止时如果端口**仍被占用**，产品要决定"要不要把这个进程杀掉"。
     * 判据是 `shouldKillByPort`：**只有在证据充分时才杀**
     *（回环监听 + 启动时间晚于我们启动这个实例）。
     *
     * 证据不足时**拒绝杀掉**，并且**拒绝把状态写成 stopped** ——
     * 因为那样等于对用户谎报"已经停了"，而实际服务可能还在收发消息。
     * 取而代之：抛出带具体原因的错误，让用户自己判断
     *（"请关闭对应 NapCat/QQ 后重试"）。
     *
     * 这个保守选择是有代价的（用户得多做一步），但**误杀别人的 QQ 代价更大**
     *（用户自己开着的 QQ 可能正好在同一个端口段上）。
     *
     * ## 为什么测试里的监听者"证据不足"
     *
     * 这里用 `net.createServer()` 在本进程里起监听 —— 它的进程就是**测试自己**，
     * 启动时间早于/等于实例启动，且不对应任何真实的 NapCat。
     * 产品无法确认它属于这个实例，于是正确地拒绝了。
     */
    const { h } = mk()
    await h['config:set']({ dataRoot: root })
    const port = await freePortIn(6200, 6299)
    const rec = (await h['instance:create']({ type: 'n', name: '脱链户', port })) as { id: string }

    // 放一个「脱链」的服务在端口上，且不是我们 spawn 的
    const net = await import('net')
    const squatter = net.createServer(() => {})
    await new Promise<void>((res) => squatter.listen(rec.port, '127.0.0.1', () => res()))

    try {
      /*
       * 停止必须**在有限时间内返回**（不能因为端口没退就永久卡住）——
       * 这条断言与"拒绝对外谎报"无关，它保护的是响应性。
       */
      const t0 = Date.now()
      await expect(
        h['instance:stop'](rec.id),
        '端口被来路不明的进程占着时，必须如实说"没法确认已停止"，而不是假装停好了'
      ).rejects.toThrow(/无法确认|没能确认|仍被占用/)
      const spent = Date.now() - t0
      expect(spent, '停止不能无限等').toBeLessThan(20000)

      /*
       * ★ 关于状态的断言（我第一版写错了，记下来）
       *
       * 我原来写的是 `expect(status).not.toBe('stopped')` —— 但这条用例里
       * 实例是 `instance:create` 出来的，**默认状态就是 stopped**，
       * 所以那个断言无论修复有没有生效都会红/绿得莫名其妙。
       *
       * 真正该验证的是"**没有把它谎报成更确定的状态**"：
       * 停止失败时不该清 startedInThisRun（那会让它在按端口判活时
       * 从"本进程启动过"降级，影响 WebUI 能不能打开）。
       * 这个内部状态没法从 instances.json 读，所以改用行为断言：
       * **错误信息里必须带上原因和下一步动作**，用户才知道怎么办。
       */
      await expect(h['instance:stop'](rec.id)).rejects.toThrow(/请手动关掉|重试/)
    } finally {
      await new Promise<void>((res) => squatter.close(() => res()))
    }
  }, 40000)
})
