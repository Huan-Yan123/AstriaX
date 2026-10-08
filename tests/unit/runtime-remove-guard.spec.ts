/*
 * 删除运行时版本时，**正在运行**的实例必须拦住。
 *
 * ## 实机现场（主人机器上真实发生的）
 *
 * 他在 AstrBot 实例运行中删了 v4.27.0，结果那个版本目录被**删了一半**：
 *
 *   runtimes\a\v4.27.0.deleting-mu0knsw0\
 *     aiohttp/ anthropic/ numpy/ ...   ← 依赖还在
 *     astrbot/                          ← **整个空掉了**
 *
 * 正在跑的 python 把 `astrbot\` 下的模块文件锁住了，异步删除删不动它们，
 * 但已经把能删的都删了。连锁后果正是用户报告的那几条：
 *
 *   - 实例卡片显示「版本未知」（包内版本标识被删了，读不到）
 *   - `.deleting-*` 目录永远删不掉（文件被锁），成永久垃圾
 *   - 实例运行中代码被抽走，当场半死
 *
 * 用户还问了「为什么删了就不能启动，创建实例时不是复制一份吗」——
 * 答案：运行时是**同类实例共享**的一份，不是每个实例各拷一份。
 * 所以删共享运行时就是在动活人的代码。
 *
 * ## 判据必须是「真的在跑」
 *
 *   - 实例只是**引用**这个版本（没在跑）→ 允许删。下次启动会给出明确报错，
 *     用户可以重装或换版本。这正是产品里确认弹窗承诺的语义。
 *   - 实例**正在这个版本上运行** → 拒绝，让用户先停。
 *
 * ## 测试怎么做才可信
 *
 * liveStatusOf 的判据是「进程管理器说在跑 + 端口真的通」，两样都要。
 * 所以这里：
 *   1. 用 net 起一个**真实监听**的端口（不是 mock 掉探测）
 *   2. 注入一个假的 processManager，让 statusOf 报 running
 * 这样走的是和生产完全相同的判定链路，不是把探测绕过去。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildHandlers } from '../../src/main/ipc'
import { testStage } from '../helpers/stage'
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import net from 'net'
import type { Server } from 'net'

let root: string
let runtimeDir: string
let instDir: string
let server: Server | undefined

const TAG = 'v4.27.0'
const PORT = 6198
const ID = 'a_test0001'

/** 起一个真实监听的端口，让 probePort 能连上 */
function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(port, '127.0.0.1', () => resolve(s))
  })
}

/** 假的进程管理器：只回答「谁在跑」 */
function fakePm(running: string[]) {
  return {
    statusOf: (id: string) => (running.includes(id) ? ('running' as const) : ('stopped' as const))
  }
}

beforeEach(() => {
  root = testStage('acb-rmruntime-')
  runtimeDir = join(root, 'runtimes', 'a', TAG)
  instDir = join(root, 'instances', 'AstrBot', ID)
  // 造一个像样的 AstrBot 运行时：有包本体 + 我们的 pypi 标记
  mkdirSync(join(runtimeDir, 'astrbot'), { recursive: true })
  writeFileSync(join(runtimeDir, 'astrbot', '__init__.py'), '__version__ = "4.27.0"\n', 'utf8')
  writeFileSync(join(runtimeDir, 'mxbot-runtime.json'), JSON.stringify({ kind: 'pypi' }), 'utf8')
  mkdirSync(instDir, { recursive: true })
  mkdirSync(join(root, 'logs'), { recursive: true })
})

afterEach(async () => {
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()))
    server = undefined
  }
  rmSync(root, { recursive: true, force: true })
})

/** 写实例记录 + instance.json（绑定到 TAG） */
function makeInstance(): void {
  writeFileSync(
    join(instDir, 'instance.json'),
    JSON.stringify({ id: ID, type: 'a', name: 'AstrBot 实例', runtimeTag: TAG, port: PORT }),
    'utf8'
  )
  writeFileSync(
    join(root, 'instances.json'),
    JSON.stringify({
      instances: [
        {
          id: ID,
          type: 'a',
          name: 'AstrBot 实例',
          templateVersion: 4270,
          port: PORT,
          dir: instDir,
          status: 'running',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]
    }),
    'utf8'
  )
  writeFileSync(
    join(root, 'runtimes.json'),
    JSON.stringify({ versions: [{ type: 'a', tag: TAG }] }),
    'utf8'
  )
}

/** runtimes\a 下现在还剩什么名字 */
const leftInRuntimes = (): string[] => {
  try {
    return readdirSync(join(root, 'runtimes', 'a'))
  } catch {
    return []
  }
}

describe('删除运行时 · 运行中的实例必须拦住', () => {
  it('★实例在跑 → 抛错，且包本体一个文件都不许动', async () => {
    makeInstance()
    server = await listen(PORT) // 端口真的通
    const h = buildHandlers({
      probe: () => true,
      audit: undefined,
      processManager: fakePm([ID]) as never
    })
    h['config:set']({ dataRoot: root })

    await expect(
      h['runtimes:remove']({ type: 'a', tag: TAG }),
      '运行中还能删 —— 实例的代码会被抽走，正是「版本未知」的成因'
    ).rejects.toThrow(/先把它们停掉再删/)

    // 关键：运行时目录必须**原封不动**
    expect(existsSync(join(runtimeDir, 'astrbot', '__init__.py')), '包本体被删了').toBe(true)
    expect(leftInRuntimes(), '目录被改名藏起来了（等于已经开始删）').toEqual([TAG])
  })

  it('★实例只是引用但没在跑 → 允许删，并把引用它的实例名字带回来', async () => {
    makeInstance()
    const h = buildHandlers({
      probe: () => true,
      audit: undefined,
      // 进程没在跑；端口也没人听（server 没起）
      processManager: fakePm([]) as never
    })
    h['config:set']({ dataRoot: root })

    const r = (await h['runtimes:remove']({ type: 'a', tag: TAG })) as { usedBy: string[] }
    expect(r.usedBy, '应该告诉界面哪些实例还指着它').toContain('AstrBot 实例')
    /*
     * 目录会被**同步改名**成 `<tag>.deleting-<stamp>`（这是刻意的：
     * 让列表立刻干净），真正的文件由后台异步删。
     * 所以这里不能断言「目录已消失」—— 只断言「原来的名字不再是可用版本」。
     */
    const left = leftInRuntimes()
    expect(left.includes(TAG), '原名字还在，列表里会看到它没被删掉').toBe(false)
    expect(left.length, '应当只剩一个 .deleting-* 垃圾目录').toBeLessThanOrEqual(1)
  })

  it('★跑的是**别的**实例时，删这个版本不该被拦', async () => {
    makeInstance()
    const other = join(root, 'runtimes', 'a', 'v9.9.9')
    mkdirSync(join(other, 'astrbot'), { recursive: true })
    writeFileSync(join(other, 'astrbot', '__init__.py'), '', 'utf8')

    server = await listen(PORT)
    const h = buildHandlers({
      probe: () => true,
      audit: undefined,
      processManager: fakePm([ID]) as never
    })
    h['config:set']({ dataRoot: root })

    await expect(h['runtimes:remove']({ type: 'a', tag: 'v9.9.9' })).resolves.toBeTruthy()
    // 正在被使用的那个必须完好
    expect(existsSync(join(runtimeDir, 'astrbot', '__init__.py'))).toBe(true)
  })

  /*
   * ==========================================================================
   * 进程活着但端口没通 —— 必须拦（这条原来断言反了）
   * ==========================================================================
   *
   * ## 这条测试原来自己和自己矛盾
   *
   * 标题写的是「★进程在跑但端口没通（服务还没起来）→ **也要拦**」，
   * 函数体却断言 `await expect(...).resolves.toBeTruthy()` —— **允许删**。
   * 注释还写着「所以这条**不该**被拦 —— 记录住这个语义」。
   *
   * 标题和断言互相打脸，说明写的时候就知道这里不对，只是把它"记录成现状"。
   * 现状确实是放行，因为 liveStatusOf 的显示语义是：
   *
   *     进程在跑 + 端口通   → running  （服务就绪）
   *     进程在跑 + 端口不通 → stopped  （进程活着但服务没起来）
   *
   * 而删除守卫原来只看 `status === 'running'`。可是**"服务没就绪"和
   * "可以安全删掉它正在读的代码"完全是两件事**：
   *
   *   - 显示想让用户看到「还没起来」（所以叫 stopped）——合理
   *   - 删除守卫要问的是「有没有进程正在用这些文件」—— 有！进程明明活着
   *
   * 把显示语义直接拿来做安全判据，就是这个洞的来源。AstrBot 冷启动的
   * 几十秒里正好处于「进程活着 + 端口不通」，此时删版本就会把
   * 正在 import 的代码抽走 —— 正是用户报告过的「版本未知、实例半死」。
   *
   * ## 现在改成拦
   *
   * 判据补上 `pm.statusOf(id) === 'running'`（进程管理器的原始事实），
   * 于是这条转成 `rejects`。标题终于和断言一致了。
   *
   * ## 为什么这不算"把闸门焊死"
   *
   * `pm.statusOf` 只在**我们 spawn 出去的子进程真的活着**时返回 running：
   * 进程退出时 exit 回调必然把它置成 'error' 或 'stopped'
   * （见 process-manager.ts:230-239）。所以不会出现"进程早没了却一直拦着"。
   * 下面还有一条「启动失败回落成 stopped 且进程不在 → 允许删」守这个方向。
   */
  it('★进程在跑但端口没通（服务还没起来）→ 也要拦', async () => {
    makeInstance()
    // 故意不 listen：端口不通。但进程管理器说这个实例在跑。
    const h = buildHandlers({
      probe: () => true,
      audit: undefined,
      processManager: fakePm([ID]) as never
    })
    h['config:set']({ dataRoot: root })

    await expect(
      h['runtimes:remove']({ type: 'a', tag: TAG }),
      '进程活着就可能在读这些文件，端口通不通是"服务就绪度"，不是"能不能删"'
    ).rejects.toThrow(/先把它们停掉再删/)
    expect(existsSync(join(runtimeDir, 'astrbot', '__init__.py')), '包本体被删了').toBe(true)
  })

  /*
   * ==========================================================================
   * 冷启动窗口：status === 'starting' 时**也必须拦**
   * ==========================================================================
   *
   * ## 洞在哪
   *
   * 删除守卫的判据是 `liveBound.filter(i => i.status === 'running')`。
   * 而 liveStatusOf 的**第一行**是：
   *
   *     if (rec.status === 'starting') return rec      // 原样返回，不探端口
   *
   * 也就是说实例处于 `starting` 期间，liveStatusOf 直接把它**原样**返回，
   * status 保持 `'starting'` —— 既不等于 `'running'`，也不去探端口。
   * 于是守卫的 `=== 'running'` 过滤**看不见它**，直接放行删除。
   *
   * ## 为什么这个窗口真实存在且危险
   *
   * instance:start 的流程是：updateStatus(id,'starting') → spawn →
   * 等就绪（waitForReady，AstrBot 冷启动要**几十秒**：解压、装依赖、
   * 起 web 服务）→ updateStatus(id,'running')。
   *
   * 在那几十秒里用户如果去「下载」页把这个版本删掉：
   *   - 守卫认为"没有 running 的实例"
   *   - `store.remove()` 同步 rename 成 `.deleting-*`（列表立刻干净）
   *   - 后台 removeDirAsync 开始**抽走正在被 import 的代码**
   *
   * 结果正是用户报告过的那一幕：`runtimes\a\v4.27.0.deleting-*` 里
   * `astrbot\` 整个空掉，实例「版本未知」、当场半死。
   * 区别只在于触发时机是**启动瞬间**而不是运行中 —— 一样致命，
   * 而且用户更不容易意识到（他刚点了启动，转头去点删除）。
   *
   * ## 为什么 `starting` 就足以判定"别删"
   *
   * 不需要证明它一定启动成功。`starting` 意味着**进程可能已经在读这些文件**，
   * 而这正是我们要保护的东西。谨慎的方向永远是"先别动"：让用户等一下，
   * 启动完成后它自然会变成 `running`，那时守卫会明确拦住。
   * 误拦的代价是用户多点一次；漏拦的代价是实例当场半死 + 永久垃圾目录。
   *
   * 判据上要同时认三种：`starting` / `running`，以及
   * **进程管理器说这个 id 在跑**（`pm.statusOf(id) === 'running'`）——
   * 第三种是兜底：即使记录状态又脏回去了（比如被 updateStatus 写成别的值），
   * 只要进程真的在跑就不许删它的代码。
   */
  it('★冷启动中（status=starting）→ 必须拦，不能把正在加载的代码抽走', async () => {
    makeInstance()
    // 把记录状态改成 starting，模拟"刚点启动、还在等就绪"
    const repoFile = join(root, 'instances.json')
    const j = JSON.parse(readFileSync(repoFile, 'utf8')) as {
      instances: Array<Record<string, unknown>>
    }
    j.instances[0].status = 'starting'
    writeFileSync(repoFile, JSON.stringify(j), 'utf8')

    // 进程管理器说它已经在跑（spawn 出去了）
    const h = buildHandlers({
      probe: () => true,
      audit: undefined,
      processManager: fakePm([ID]) as never
    })
    h['config:set']({ dataRoot: root })

    await expect(
      h['runtimes:remove']({ type: 'a', tag: TAG }),
      '启动中的实例没被拦住 —— 它的代码会被当场抽走，正是「版本未知」的成因'
    ).rejects.toThrow(/先把它们停掉再删/)

    expect(existsSync(join(runtimeDir, 'astrbot', '__init__.py')), '包本体被删了').toBe(true)
    expect(leftInRuntimes(), '目录被改名藏起来了（等于已经开始删）').toEqual([TAG])
  })

  it('★记录说 stopped，但进程管理器说这个 id 在跑 → 也要拦（状态脏了也不许删）', async () => {
    makeInstance()
    // 记录里是 stopped（比如崩溃后没来得及更新），但进程确实活着
    const repoFile = join(root, 'instances.json')
    const j = JSON.parse(readFileSync(repoFile, 'utf8')) as {
      instances: Array<Record<string, unknown>>
    }
    j.instances[0].status = 'stopped'
    writeFileSync(repoFile, JSON.stringify(j), 'utf8')

    const h = buildHandlers({
      probe: () => true,
      audit: undefined,
      processManager: fakePm([ID]) as never
    })
    h['config:set']({ dataRoot: root })

    await expect(
      h['runtimes:remove']({ type: 'a', tag: TAG }),
      '进程真的在跑却放行删除 —— 只信记录状态不够，必须问进程管理器'
    ).rejects.toThrow(/先把它们停掉再删/)
    expect(existsSync(join(runtimeDir, 'astrbot', '__init__.py'))).toBe(true)
  })

  it('启动已失败回落成 stopped 且进程不在 → 允许删（别把闸门焊死）', async () => {
    makeInstance()
    const repoFile = join(root, 'instances.json')
    const j = JSON.parse(readFileSync(repoFile, 'utf8')) as {
      instances: Array<Record<string, unknown>>
    }
    j.instances[0].status = 'stopped'
    writeFileSync(repoFile, JSON.stringify(j), 'utf8')

    // 进程管理器说没在跑，端口也没人听
    const h = buildHandlers({
      probe: () => true,
      audit: undefined,
      processManager: fakePm([]) as never
    })
    h['config:set']({ dataRoot: root })

    await expect(h['runtimes:remove']({ type: 'a', tag: TAG })).resolves.toBeTruthy()
  })
})
