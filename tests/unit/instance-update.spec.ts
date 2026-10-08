/*
 * 「手动更新」（用户新需求）。
 *
 * ## 为什么需要这个功能（用户的实测报错）
 *
 * 用户在 AstrBot 的 WebUI 里点「一键更新」，报：
 *
 *     Exception: Error: You are running AstrBot via CLI,
 *     please use `pip` or `uv tool upgrade` to update AstrBot.
 *
 * 那是 AstrBot 的**主动设计**：它检测到自己是被 `pip install --target`
 * 装出来的（我们运行时就是这个形态），于是禁用 WebUI 自更新。
 * 所以更新入口必须由启动器提供 —— 就是实例「更多」里的「更新」。
 *
 * ## 这个功能做什么
 *
 * 找出该类运行时的最新版 → 没装就装 → 切实例的 tag 指针（数据天然保留）。
 * 复用已有的 `runtime:install` 和 `instance:setRuntime`，
 * 不重新发明安装链路（pip 负责解依赖、装完校验本体、失败清目录，都已验证过）。
 *
 * ## 最硬的一条约束
 *
 * 用户明确要求：「手动更新必须在 astrbot 没有运行的时候才能更新」。
 * 下面第一条用例就是钉死它 —— 而且**主进程也要拦**，不能只靠界面禁用按钮
 * （界面可以被绕过）。
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager, type ProcessManager } from '../../src/main/proc/process-manager'
import { testStage } from '../helpers/stage'
/*
 * ══════════════════════════════════════════════════════════════════════════
 * 空闲端口常量 —— 别用硬编码的 6100 / 6200
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 开发机上**真会被占**：6100 常被别的程序用（主人那个 watch_api.py 就占着），
 * 6200-6202 被 NapCat 注入的 QQ 占着。
 *
 * 而测试的实例一旦用了这些端口，stopInstanceHard 里的
 * waitPortGone(port, 3000) 就会**等满两次**（≈7 秒）——
 * 撞上 vitest 默认 5 秒超时，一堆用例红得像"功能坏了"。
 *
 * 这两个常量在**模块加载时同步**挑出空闲端口（辅助函数多是同步的，
 * 用不了异步的 freePortIn）。
 */
function pickFreeSync(min: number, max: number, avoid: Set<number>): number {
  const { execSync } = require('child_process') as typeof import('child_process')
  /* 一次性拿到"哪些端口在监听"，比逐个 listen 探测快得多（而且同步） */
  const busy = new Set<number>()
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', timeout: 8000 })
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue
      const m = /:(\d+)\s+\S+\s+LISTENING/i.exec(line)
      if (m) busy.add(Number(m[1]))
    }
  } catch {
    /* 拿不到就全当空闲（测试最多慢一点，不会错） */
  }
  for (let p = min; p <= max; p++) {
    if (!busy.has(p) && !avoid.has(p)) return p
  }
  return max
}
const __AVOID = new Set<number>()
const A_FREE_PORT = pickFreeSync(6100, 6199, __AVOID)
__AVOID.add(A_FREE_PORT)
const N_FREE_PORT = pickFreeSync(6200, 6299, __AVOID)
__AVOID.add(N_FREE_PORT)


/**
 * PyPI 清单样本。
 *
 * AstrBot 的后端只在 PyPI（官方六个 release 只发 dashboard.zip，
 * 里面只有前端 dist/，没有后端 —— 见 template-source.ts:19-24）。
 * 所以"最新版从哪来"这个问题的答案就在这个清单里。
 */
const pypiPayload = {
  info: { version: '4.29.0' },
  releases: {
    '4.29.0': [
      {
        filename: 'astrbot-4.29.0-py3-none-any.whl',
        url: 'https://files.pythonhosted.org/packages/aa/astrbot-4.29.0-py3-none-any.whl',
        size: 23000000,
        upload_time_iso_8601: '2026-09-10T10:00:00Z',
        digests: { sha256: 'aa11' }
      }
    ],
    /* 预发布：更新是常规动作，**不该**把 beta 推给用户 */
    '4.30.0b1': [
      {
        filename: 'astrbot-4.30.0b1-py3-none-any.whl',
        url: 'https://files.pythonhosted.org/packages/cc/astrbot-4.30.0b1-py3-none-any.whl',
        size: 23100000,
        digests: { sha256: 'cc33' }
      }
    ],
    '4.28.0': [
      {
        filename: 'astrbot-4.28.0-py3-none-any.whl',
        url: 'https://files.pythonhosted.org/packages/bb/astrbot-4.28.0-py3-none-any.whl',
        size: 22500000,
        digests: { sha256: 'bb22' }
      }
    ]
  }
}

/**
 * 造现场：已装若干运行时 + 一个绑定其中某个的实例。
 *
 * 关键点：把 tag 写进 `runtimes.json` 清单，`store.list()` 才会认它们
 * （只 mkdirSync 出来的空目录会被 hasSubstance 过滤掉，那是"半个空壳"的防护）。
 */
function setup(opts: { tags?: string[]; boundTag?: string } = {}): {
  dataRoot: string
  id: string
  cleanup: () => void
} {
  const dataRoot = testStage('inst-update-')
  const tags = opts.tags ?? ['v4.27.1', 'v4.29.0']

  for (const t of tags) {
    mkdirSync(join(dataRoot, 'runtimes', 'a', t), { recursive: true })
  }
  writeFileSync(
    join(dataRoot, 'runtimes.json'),
    JSON.stringify({
      versions: tags.map((t) => ({ type: 'a', tag: t, installedAt: new Date().toISOString() }))
    }),
    'utf8'
  )

  const id = 'a_upd0001'
  const instDir = join(dataRoot, 'instances', 'AstrBot', id)
  mkdirSync(join(instDir, 'data'), { recursive: true })
  // 实例自己的数据：更新时必须原样保留
  writeFileSync(join(instDir, 'data', 'user-config.json'), '{"my":"settings"}', 'utf8')
  writeFileSync(
    join(instDir, 'instance.json'),
    JSON.stringify({
      id,
      type: 'a',
      name: '更新测试',
      runtimeTag: opts.boundTag ?? tags[0],
      /*
       * ══════════════════════════════════════════════════════════════════════
       * ★★ 端口必须**避开会被真实程序占用**的那些
       *   （主人 2026-09-27 实测：这几条用例突然各要 7 秒，卡到超时）
       * ══════════════════════════════════════════════════════════════════════
       *
       * 原来是硬编码的 `port: A_FREE_PORT`。而**开发机上真有个程序占着 6100**
       *（主人那个 `python watch_api.py 7200`，实测就绑在 6100）。
       *
       * 后果是一条**很隐蔽的慢链**：
       *   · `instance:setRuntime` → `stopInstanceHard`
       *   · → `waitPortGone(6100, 3000)` 发现**端口一直通**（被 python 占着）
       *   · → **等满 3 秒**才放弃，然后走补杀（又两次子进程调用）
       *   · `setRuntime` 里这样的等待**有两次** → 累计 ≈ 7 秒
       *   · 三条用例各 7 秒 → **撞上 vitest 默认 5 秒超时 → 全红**
       *
       * 看起来像"功能坏了"，其实只是测试选了个被占的端口。
       *
       * ## 为什么用 6199 而不是"探测一个空闲的"
       *
       * `setup()` 是**同步函数**（被 11 条用例共用），而可用的探测工具
       * `freePortIn` 是异步的 —— 为了一个端口把它改成 async 会牵动所有
       * 调用点。
       *
       * AstrBot 的段是 6100-6199，而**实际会被占的通常是段首那几个**
       *（6100 这种"顺手用"的位置）。取**段末 6199** 撞上的概率极低，
       * 而且这个值的语义清楚（就是"该段最后一个"）。
       *
       * 这是个**已知的取舍**：真要彻底稳妥，得让 setup 变异步、
       * 用 `freePortIn(6100, 6199)`。等哪天真撞上了再改。
       */
      port: A_FREE_PORT,
      createdAt: new Date().toISOString()
    }),
    'utf8'
  )
  putIndex(dataRoot, id, instDir, 'stopped')

  return { dataRoot, id, cleanup: () => rmSync(dataRoot, { recursive: true, force: true }) }
}

/** 写 instances.json（抽出来是因为"运行中"的用例需要改状态后重写） */
function putIndex(dataRoot: string, id: string, instDir: string, status: string): void {
  writeFileSync(
    join(dataRoot, 'instances.json'),
    JSON.stringify({
      instances: [
        {
          id,
          type: 'a',
          name: '更新测试',
          dir: instDir,
          /*
           * ★ 端口必须与 `instance.json` 里那个**一致**，而且避开被占的。
           *
           * 我第一版只改了 instance.json（那里的 `port: A_FREE_PORT` → 6199），
           * **漏了这一处** —— 而主进程实际读的是**这份 instances.json**。
           * 于是实例还是 6100 → 那个端口被开发机上的程序占着
           * → `stopInstanceHard` 的 `waitPortGone(3000)` 等满两次 ≈ 7 秒
           * → 三条用例撞 5 秒超时全红。
           *
           * 教训：**同一个值写在两个地方**时，改一处等于没改。
           *（这里本该只写一处 —— 但测试里两份文件都要造，
           *  所以至少要让它们保持一致，并记住"哪份才是主进程读的"。）
           */
          port: A_FREE_PORT,
          status,
          templateVersion: 1,
          createdAt: new Date().toISOString()
        }
      ]
    }),
    'utf8'
  )
}

/**
 * 一个"看起来真的在跑"的进程管理器。
 *
 * ## 为什么不能只在 instances.json 里写 status:'running'（这里踩过）
 *
 * 我第一版就是这么写的，结果"运行中拒绝更新"那三条**全都不通过** ——
 * 现象是 handler 返回了 `{updated:true}`。
 *
 * 原因是（读代码 + 跑 `_dbg-store-list.cjs` 确认的）：
 *   1. `liveStatusOf` 的判据是**先问进程管理器、再回落端口探测**，
 *      而不是读 instances.json 里那个字段 —— 那个字段本来就不可信
 *      （`config:set` 的重启恢复会把 running 无条件归位成 stopped）。
 *   2. 我的假 probe 恒返回 true（表示"端口通"），但进程管理器里没有记录，
 *      `startedInThisRun` 也是空的 → 判成"没在跑"。
 *
 * 这其实**证明了实现是对的**：它没有被盘上的假状态骗到。
 * 所以测试必须提供一个真在跑的 pm 假实现（照抄 instance-status.spec.ts 的形态）。
 */
function runningPm(): ProcessManager {
  return {
    start: async () => ({
      status: 'running' as const,
      pid: () => 12345,
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

/** 注入假版本目录（不联网）；pm 决定"实例在不在跑" */
async function makeHandlers(
  dataRoot: string,
  over: { failNetwork?: boolean; pm?: ProcessManager } = {}
): Promise<ReturnType<typeof buildHandlers>> {
  const h = buildHandlers({
    /*
     * probe 恒 true + runningPm：这两个凑起来才是"真的在运行"。
     * （instance-status.spec.ts 里那种"盘上 running 但端口不通 → 报已停止"
     *  的用例用的是 probe=false，方向相反。）
     */
    probe: () => Promise.resolve(true),
    processManager: over.pm ?? createProcessManager(),
    fetchVersionJson: async (url: string) => {
      if (over.failNetwork) throw new Error('network down')
      // AstrBot 的版本只在 PyPI
      if (url.includes('pypi')) return JSON.stringify(pypiPayload)
      throw new Error('404')
    }
  })
  await h['config:set']({ dataRoot })
  return h
}

const meta = (dataRoot: string, id: string): { runtimeTag?: string } =>
  JSON.parse(
    readFileSync(join(dataRoot, 'instances', 'AstrBot', id, 'instance.json'), 'utf8')
  ) as { runtimeTag?: string }

describe('instance:update（手动更新到最新版）', () => {
  it('★运行中的实例拒绝更新（用户明确要求：必须停下来才能更新）', async () => {
    /*
     * 用户原话：「手动更新必须在 astrbot 没有运行的时候才能更新」。
     *
     * 界面上那个菜单项会 disabled，但**主进程必须也拦** ——
     * 渲染层可以被绕过，而这条约束是用户的硬要求。
     *
     * 注意这里用 runningPm（真在跑），不是只写盘上的 status ——
     * 理由见 runningPm 的注释：判据是**实际**运行状态。
     */
    const s = setup()
    try {
      const h = await makeHandlers(s.dataRoot, { pm: runningPm() })
      await expect(
        h['instance:update']({ id: s.id }),
        '运行中的实例绝不能被更新'
      ).rejects.toThrow(/正在运行/)
    } finally {
      s.cleanup()
    }
  })

  it('★启动中（starting）也拒绝', async () => {
    /*
     * starting 也算"在跑"。不能只拦 running —— 启动中的实例同样
     * 正在往旧版本目录里写东西，也不该被换掉。
     */
    const s = setup()
    try {
      // 进程管理器报 starting
      const pm = { ...runningPm(), statusOf: () => 'starting' as const }
      const h = await makeHandlers(s.dataRoot, { pm })
      await expect(h['instance:update']({ id: s.id })).rejects.toThrow(/正在运行/)
    } finally {
      s.cleanup()
    }
  })

  it('★被拒绝时不能改动任何东西（指针还是旧值）', async () => {
    /*
     * 光"抛错"不够 —— 要确认拒绝之前**没做任何副作用**。
     * 尤其是不能因为走到了后面某一步而把版本指针改了。
     */
    const s = setup({ boundTag: 'v4.27.1' })
    try {
      const h = await makeHandlers(s.dataRoot, { pm: runningPm() })
      await expect(h['instance:update']({ id: s.id })).rejects.toThrow()
      expect(meta(s.dataRoot, s.id).runtimeTag, '被拒绝后指针必须原封不动').toBe('v4.27.1')
    } finally {
      s.cleanup()
    }
  })

  it('实例不存在 → 报错', async () => {
    const s = setup()
    try {
      const h = await makeHandlers(s.dataRoot)
      await expect(h['instance:update']({ id: 'nope' })).rejects.toThrow(/实例不存在/)
    } finally {
      s.cleanup()
    }
  })

  it('★有新版本且已装好 → 切指针 + 数据一字不改', async () => {
    /*
     * 主路径：最新版（v4.29.0）已经在本地装好了（tags 里有），
     * 实例绑的是 v4.27.1 → 应该直接切过去，不用再装。
     *
     * 数据保留是用户最在意的（他之前的实例里有真实配置和登录状态）。
     */
    const s = setup({ tags: ['v4.27.1', 'v4.29.0'], boundTag: 'v4.27.1' })
    try {
      const h = await makeHandlers(s.dataRoot)
      const dataFile = join(s.dataRoot, 'instances', 'AstrBot', s.id, 'data', 'user-config.json')
      const before = readFileSync(dataFile, 'utf8')

      const r = (await h['instance:update']({ id: s.id })) as {
        updated: boolean
        from?: string
        to?: string
      }

      expect(r.updated, '应当更新成功').toBe(true)
      expect(r.from).toBe('v4.27.1')
      expect(r.to).toBe('v4.29.0')
      expect(meta(s.dataRoot, s.id).runtimeTag, '指针要指向新版本').toBe('v4.29.0')
      expect(existsSync(dataFile), '数据文件不能消失').toBe(true)
      expect(readFileSync(dataFile, 'utf8'), '数据内容必须一字不改').toBe(before)
    } finally {
      s.cleanup()
    }
  })

  it('★已经是最新版 → updated:false，并说清原因（不是报错）', async () => {
    const s = setup({ tags: ['v4.29.0'], boundTag: 'v4.29.0' })
    try {
      const h = await makeHandlers(s.dataRoot)
      const r = (await h['instance:update']({ id: s.id })) as {
        updated: boolean
        reason?: string
      }
      expect(r.updated).toBe(false)
      expect(r.reason, '要告诉用户为什么没更新（是"已最新"而不是失败）').toContain('最新')
      expect(meta(s.dataRoot, s.id).runtimeTag).toBe('v4.29.0')
    } finally {
      s.cleanup()
    }
  })

  it('★预发布版不会被当作"最新版"推给用户', async () => {
    /*
     * 假清单里有 v4.30.0b1（比 v4.29.0 "新"），但更新是常规动作，
     * 不该把 beta 推给用户 —— 那是安装页让用户**显式挑**的事，性质不同。
     *
     * 判据不能用 versionNumOf（有损指纹），所以这条也顺带守住
     * "必须用 cmpVersion"这件事。
     */
    const s = setup({ tags: ['v4.27.1', 'v4.29.0'], boundTag: 'v4.27.1' })
    try {
      const h = await makeHandlers(s.dataRoot)
      const r = (await h['instance:update']({ id: s.id })) as { to?: string }
      expect(r.to, '不该更新到 4.30.0b1 这个预发布版').toBe('v4.29.0')
      expect(r.to).not.toContain('b1')
    } finally {
      s.cleanup()
    }
  })

  it('★最新版还没装 → 会走安装流程（而不是静默跳过）', async () => {
    /*
     * 现场只装了 v4.27.1，而最新是 v4.29.0 —— 必须触发安装。
     *
     * 怎么断言"确实走了安装"：测试环境里没有内置 Python，
     * 所以 `runtime:install` 会抛「还没装内置 Python」。
     * **看到这个错误恰恰证明它进了安装分支** —— 而不是静默返回
     * "更新好了"（那会是更坏的 bug：指针指向一个不存在的版本）。
     *
     * ## 为什么给 15 秒超时（原来 5 秒不够，超时了）
     *
     * 真实原因：`runtime:install` 在检查 Python **之前**会先走一遍
     * `listVersions`（找 p.tag 对应的下载信息），而它会去探所有镜像源。
     * 我注入的 fetchJson 对非 PyPI 的 URL 抛错，但**源有很多个**
     * （官方源 + 各种加速前缀），每个都要走一次失败的 fetch。
     * 这条链加起来超过了 vitest 默认的 5000ms。
     *
     * 这不是产品慢（生产里 fetchJson 是真实网络，且有缓存），
     * 是"一堆必然失败的假 fetch 串起来"的测试开销。
     * 所以给足超时，而不是去改被测代码来迁就测试。
     */
    const s = setup({ tags: ['v4.27.1'], boundTag: 'v4.27.1' })
    try {
      const h = await makeHandlers(s.dataRoot)
      await expect(
        h['instance:update']({ id: s.id }),
        '最新版没装就该去装，而不是假装更新成功'
      ).rejects.toThrow(/Python|pip|下载|安装/i)

      // 失败之后指针不能被动过
      expect(meta(s.dataRoot, s.id).runtimeTag, '装失败就不该改指针').toBe('v4.27.1')
    } finally {
      s.cleanup()
    }
  }, 30000)

  it('取不到版本列表（网络不通）→ 明确报错，不假装已最新', async () => {
    /*
     * 这一条很重要：如果网络失败被当成"没有更新"，用户会以为
     * 自己已经是最新版了 —— 而他其实只是没连上网。
     * 必须如实说"取列表失败"。
     */
    const s = setup({ tags: ['v4.27.1'], boundTag: 'v4.27.1' })
    try {
      const h = await makeHandlers(s.dataRoot, { failNetwork: true })
      await expect(
        h['instance:update']({ id: s.id }),
        '网络失败必须报错，不能被当成"已是最新"'
      ).rejects.toThrow(/取版本列表失败|没取到/)
    } finally {
      s.cleanup()
    }
  })

  it('当前版本比最新还新（用户手动装过更高版）→ 不降级', async () => {
    /*
     * 用户可能自己导入了比官方最新还高的版本。此时"更新"绝不该
     * 把它降回去 —— 那会毁掉他手动装的东西。
     *
     * 判据同样依赖 cmpVersion（逐个比大小），不是有损指纹。
     */
    const s = setup({ tags: ['v9.9.9'], boundTag: 'v9.9.9' })
    try {
      const h = await makeHandlers(s.dataRoot)
      const r = (await h['instance:update']({ id: s.id })) as {
        updated: boolean
        from?: string
        to?: string
      }
      expect(r.updated, '不能把比最新还新的版本"更新"回旧版').toBe(false)
      expect(meta(s.dataRoot, s.id).runtimeTag, '指针必须还是 v9.9.9').toBe('v9.9.9')
    } finally {
      s.cleanup()
    }
  })

  it('★更新链路不能把运行时复制进实例目录（架构约束）', async () => {
    /*
     * 这个架构里运行时是**共享**的：实例只在 instance.json 里存一个 tag 指针，
     * 运行时文件始终在 `<dataRoot>\runtimes\<type>\<tag>\`。
     *
     * 老式的 `instance:update`（已被 setRuntime 取代的那个）会把运行时
     * 复制进实例目录 —— 那会让每个实例多占几百 MB，而且更新/删除
     * 都会变得难以收拾。更新功能必须守住这条。
     */
    const s = setup({ tags: ['v4.27.1', 'v4.29.0'], boundTag: 'v4.27.1' })
    try {
      const h = await makeHandlers(s.dataRoot)
      await h['instance:update']({ id: s.id })
      const instDir = join(s.dataRoot, 'instances', 'AstrBot', s.id)
      expect(
        existsSync(join(instDir, 'runtime')),
        '不许把运行时复制进实例目录（那是共享的）'
      ).toBe(false)
    } finally {
      s.cleanup()
    }
  })
})
