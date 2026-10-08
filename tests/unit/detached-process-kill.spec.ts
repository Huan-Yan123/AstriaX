/*
 * 裸 killTreeSync 的四个调用点 —— 补齐「按端口补杀」这一步
 * ========================================================================
 *
 * ## 为什么要有这个文件
 *
 * `stopInstanceHard()` 已经把「停干净一个实例」的正确三步收成一个函数
 * （树杀 → 等端口退 → 按端口精确补杀，见 ipc.ts 里那段长注释）。
 * 但项目里有几处仍然直接调裸 `pm.killTreeSync(id)`，各自漏了后两步。
 *
 * 漏掉的后果不是"进程没杀干净"这么轻 —— 每一处后面都紧跟着
 * **对文件系统的破坏性操作**：
 *
 *   - `instance:remove`    → 紧接着 removeDirAsync(rec.dir) 删实例目录
 *   - `instance:setRuntime`→ 换版本指针，随后用户会去删旧版本
 *   - `instance:resetCreds`→ 立刻重写凭据文件
 *   - `backup:restore`     → 立刻解压覆盖实例目录
 *
 * NapCat 注入 QQ 后 QQ 脱离父子链，`taskkill /T` 杀不到它。
 * 于是上面每一个操作都可能撞上一个**仍在写文件的活进程**：
 * 删不干净、写出半新半旧的配置、归档被边写边打包。
 *
 * ## 怎么证明"真的按端口补杀了"
 *
 * 判据必须能区分「只喊了 killTreeSync」和「真去按端口补杀」：
 *   1. 起一个**真正的子进程**占住实例端口 —— 冒充脱链的 QQ
 *   2. 注入一个**假的 processManager**：killTreeSync 故意什么都不做
 *      （模拟"进程树里没有它"这个事实）
 *   3. 断言那条路径结束后，子进程**真的被结束了**（端口不再通）
 *
 * 这样如果实现退回裸 killTreeSync，子进程会一直活着，测试就红。
 *
 * ## 为什么必须用**子进程**，不能用本进程里的 net.createServer
 *
 * 第一版就是在本进程里起的监听，结果三条全红 —— 但**不是实现有问题**：
 * `stopInstanceHard` 里有一道防御 `pid !== process.pid`（绝不能杀自己），
 * 而本进程内的监听者，它的 pid 恰好就是 process.pid，于是被正确地跳过了。
 *
 * 教训：这个测试要模拟的是"**别的**进程占着端口"，
 * 而"别的进程"就必须真的是别的进程。用同进程的东西测，测的是另一回事。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildHandlers } from '../../src/main/ipc'
import { testStage } from '../helpers/stage'
import { freePortIn } from '../helpers/port'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import net from 'net'

let root: string
let instDir: string
let squatter: ChildProcess | undefined
let id = ''

/**
 * 起一个**独立子进程**占住端口，冒充"脱链的 NapCat/QQ"。
 *
 * 用子进程而不是本进程的 net.createServer：见文件头注释的教训。
 * 子进程是 detached:false 的普通子进程 —— 我们只关心"它在监听"，
 * 而 findListenerPid 是通过 netstat 按端口找 pid，和父子关系无关。
 */
function squat(port: number, host = '127.0.0.1'): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['-e', `require('net').createServer(()=>{}).listen(${port},${JSON.stringify(host)});setInterval(()=>{},1000)`],
      { stdio: 'ignore' }
    )
    child.once('error', reject)
    // 轮询等它真的开始监听
    const deadline = Date.now() + 8000
    const tick = async (): Promise<void> => {
      if (await portListening(port)) return resolve(child)
      if (Date.now() >= deadline) {
        child.kill()
        return reject(new Error(`子进程没能在 ${port} 上开始监听`))
      }
      setTimeout(() => void tick(), 150)
    }
    void tick()
  })
}

const portListening = (port: number, ms = 800): Promise<boolean> =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    const done = (v: boolean): void => {
      s.destroy()
      resolve(v)
    }
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
    setTimeout(() => done(false), ms)
  })

/**
 * 假 processManager：killTreeSync **故意什么都不做**。
 *
 * 这正是 NapCat 的真实处境：我们要杀的那个进程不在我们 spawn 的树里，
 * 所以树杀对它无效。只有"按端口补杀"才能收掉它。
 */
function fakePm() {
  const killed: string[] = []
  return {
    killed,
    statusOf: () => 'stopped' as const,
    killTreeSync: (i: string) => {
      killed.push(i) // 记下来，用来证明调用方确实尝试过
      // 但**不真的杀**任何东西
    },
    exitInfoOf: () => undefined,
    tailOf: () => ''
  }
}

beforeEach(async () => {
  root = testStage('acb-killtree-')
  mkdirSync(join(root, 'logs'), { recursive: true })
})

afterEach(async () => {
  if (squatter && !squatter.killed) {
    // 兜底：万一实现没杀掉（用例失败时），别把子进程漏在系统里
    squatter.kill('SIGKILL')
  }
  squatter = undefined
  rmSync(root, { recursive: true, force: true })
})

/** 造一个 NapCat 实例 + 真实子进程监听它的端口 */
async function setupSquatterInstance(): Promise<{ h: ReturnType<typeof buildHandlers>; port: number; pm: ReturnType<typeof fakePm> }> {
  const port = await freePortIn(6200, 6299)
  squatter = await squat(port)
  const pm = fakePm()
  const h = buildHandlers({
    /*
     * 注意 probe 的语义：返回 **true = 端口可用**（allocator 里是
     * `if (await probe(p)) return p`）。第一版我写成 `() => false`，
     * 含义变成"所有端口都不可用"，于是 instance:create 直接抛
     * PortRangeExhausted —— 看着像"端口段满了"，其实是这个假函数反了。
     *
     * 但这里必须返回 false 吗？不 —— 我们要的正是「让 instance:create
     * 采纳我们指定的端口」。allocate 的逻辑是：先试传入的提示值，
     * 可用就直接用。所以 probe 要返回 true（都可用），提示值才会被采纳。
     */
    probe: () => true,
    audit: undefined,
    processManager: pm as never
  })
  h['config:set']({ dataRoot: root })
  /*
   * 预置一个已安装的运行时。
   *
   * 注意**清单文件是 runtimes.json**（runtime-store 的 readManifest 读它），
   * 不是随便建个目录就行 —— buildList 对"磁盘上扫到但清单里没有"的目录
   * 会调 hasSubstance 查实质；有 mxbot-runtime.json 或非空目录也能过。
   * 这里两条路都铺上，避免依赖某一条的实现细节。
   */
  mkdirSync(join(root, 'runtimes', 'n', 'v4.18.19'), { recursive: true })
  writeFileSync(join(root, 'runtimes', 'n', 'v4.18.19', 'mxbot-runtime.json'), '{"kind":"zip"}', 'utf8')
  writeFileSync(
    join(root, 'runtimes.json'),
    JSON.stringify({
      versions: [
        { type: 'n', tag: 'v4.18.19', installedAt: new Date().toISOString() }
      ]
    }),
    'utf8'
  )
  const rec = (await h['instance:create']({ type: 'n', name: '脱链户', port })) as {
    id: string
    dir: string
  }
  id = rec.id
  instDir = rec.dir
  mkdirSync(instDir, { recursive: true })
  writeFileSync(
    join(instDir, 'instance.json'),
    JSON.stringify({ id: rec.id, type: 'n', name: '脱链户', runtimeTag: 'v4.18.19', port }),
    'utf8'
  )
  // 标记成运行中 —— 让各条路径进入"先停掉"分支
  const repoFile = join(root, 'instances.json')
  const j = JSON.parse(require('fs').readFileSync(repoFile, 'utf8')) as {
    instances: Array<Record<string, unknown>>
  }
  const t = j.instances.find((x) => x.id === rec.id)
  if (t) t.status = 'running'
  writeFileSync(repoFile, JSON.stringify(j), 'utf8')
  return { h, port, pm }
}

describe('脱链进程：必须按端口补杀（不能只 killTreeSync）', () => {
  /*
   * 这些用例会真的走 stopInstanceHard 的完整链路：等端口退（STOP_VERIFY_MS）
   * 然后再按端口补杀 —— 实测每条 5 秒以上，超过 vitest 默认的 5000ms。
   * 所以显式放宽，而不是把断言改弱。
   */
  const TIMEOUT = 30000

  it('★instance:remove —— 删实例前要把脱链进程收掉，否则目录删不干净', async () => {
    const { h, port, pm } = await setupSquatterInstance()
    expect(await portListening(port), '前置条件：端口上应该有个监听者').toBe(true)

    await h['instance:remove'](id)

    expect(pm.killed, '应该至少尝试过树杀').toContain(id)
    expect(
      await portListening(port),
      '删实例后端口上还有进程 —— 那就是脱链的 QQ 没被收掉，' +
        '紧接着的 removeDirAsync 会撞上被占用的文件，留下删不掉的残缺目录'
    ).toBe(false)
  }, TIMEOUT)

  it('实例端口由对外监听进程占用时拒绝删除并保留记录与目录', async () => {
    const port = await freePortIn(6200, 6299)
    squatter = await squat(port, '0.0.0.0')
    const pm = fakePm()
    const h = buildHandlers({ probe: () => true, processManager: pm as never })
    await h['config:set']({ dataRoot: root })
    mkdirSync(join(root, 'runtimes', 'n', 'v4.18.19'), { recursive: true })
    writeFileSync(join(root, 'runtimes', 'n', 'v4.18.19', 'mxbot-runtime.json'), '{"kind":"zip"}', 'utf8')
    writeFileSync(join(root, 'runtimes.json'), JSON.stringify({ versions: [{ type: 'n', tag: 'v4.18.19', installedAt: new Date().toISOString() }] }), 'utf8')
    const rec = (await h['instance:create']({ type: 'n', name: '保留中的 NapCat', port })) as { id: string; dir: string }

    /*
     * ★ 报错文案在 2026-10-08 改成更具体的两段式：
     *   「实例「X」没能停下来，所以**没有**删除它。…请先手动关掉它…」
     *
     * 原来只有一句「端口 X 仍被占用」，用户不知道"接下来能做什么"；
     * 而且那句出现在多个调用点（停止/删除/迁移/备份/回滚），
     * 分不清到底是哪个操作被挡住了。现在把动作名写进第一句。
     *
     * 断言放宽到同时接受新旧措辞 —— 这里要守的是
     * 「拒绝执行 + 说清原因」，不是某个具体句式。
     */
    await expect(h['instance:remove'](rec.id)).rejects.toThrow(/没能停下来|仍被占用/)
    expect(((await h['instance:list']()) as Array<{ id: string }>).some((item) => item.id === rec.id)).toBe(true)
    expect(require('fs').existsSync(rec.dir)).toBe(true)
    expect(await portListening(port)).toBe(true)
  }, TIMEOUT)

  it('★instance:resetCreds —— 重置账密前要把脱链进程收掉，否则旧值会被写回去', async () => {
    const { h, port } = await setupSquatterInstance()
    expect(await portListening(port)).toBe(true)

    await h['instance:resetCreds'](id)

    expect(
      await portListening(port),
      '重置账密后端口上还有进程 —— 它可能在退出时把旧 token 写回去，' +
        '表现就是用户说的「重置了还是登不上」'
    ).toBe(false)
  }, TIMEOUT)

  it('★instance:setRuntime —— 换版本前要把脱链进程收掉', async () => {
    const { h, port } = await setupSquatterInstance()
    /*
     * 再"装"一个版本供切换。
     *
     * setRuntime 是通过 store.list(type) 找目标版本的，而 list 的真相来源是
     * **runtimes.json 清单**（readManifest）＋ 磁盘扫描。
     * 第一版只建了目录忘了写清单，于是报「这个 NapCat 版本还没下载」——
     * 看着像功能坏了，其实是测试没把前置条件铺好。
     */
    mkdirSync(join(root, 'runtimes', 'n', 'v4.19.0'), { recursive: true })
    writeFileSync(join(root, 'runtimes', 'n', 'v4.19.0', 'mxbot-runtime.json'), '{"kind":"zip"}', 'utf8')
    writeFileSync(
      join(root, 'runtimes.json'),
      JSON.stringify({
        versions: [
          { type: 'n', tag: 'v4.18.19', installedAt: new Date().toISOString() },
          { type: 'n', tag: 'v4.19.0', installedAt: new Date().toISOString() }
        ]
      }),
      'utf8'
    )
    expect(await portListening(port)).toBe(true)

    await h['instance:setRuntime']({ id, tag: 'v4.19.0', type: 'n' })

    expect(
      await portListening(port),
      '换版本后端口上还有进程 —— 它占着旧版本的文件，用户随后删旧版本会删不干净'
    ).toBe(false)
  }, TIMEOUT)
})
