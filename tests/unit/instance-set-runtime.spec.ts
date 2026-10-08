/*
 * 实例版本切换（用户要求：「加入版本识别，支持高版本覆盖低版本且保留数据和配置的覆盖更新」）。
 *
 * 这个功能的架构前提（先读懂再改）：
 *
 *   实例**不复制**运行时。创建时只往 <实例目录>\instance.json 写一个 runtimeTag 指针
 *   （writeInstanceMeta），运行时文件始终在 <dataRoot>\runtimes\<type>\<tag>\，
 *   被同类型实例共享。
 *
 *   实例自己的数据（AstrBot 的 data\、NapCat 的 config\、备份）全在实例目录里，
 *   和运行时目录完全分离（runtime/layout.ts 的 workDir / cwd 处理）。
 *
 *   所以「换版本」= 改指针，**数据和配置天然保留**。
 *   下面最重要的那条测试就是钉死这一点：切换过程**不碰实例目录里的数据文件**。
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'
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


const stubProbe = () => Promise.resolve(true)

/** 造一个带真 dataRoot 的环境：一个已安装的运行时 + 一个绑定它的实例 */
function setup(opts: { tags?: string[]; boundTag?: string; instanceType?: 'a' | 'n' } = {}): {
  dataRoot: string
  id: string
  cleanup: () => void
} {
  // testStage 落在项目 data\cache\tmp 下（项目约定：测试别往 C 盘 Temp 扔东西，
  // 以前有 e2e 真装 Python/NapCat，几轮就把 C 盘吃掉几十 GB）
  const dataRoot = testStage('setrt')
  const type = opts.instanceType ?? 'a'
  const tags = opts.tags ?? ['v4.27.1', 'v4.28.0']

  // 运行时目录：runtimes\<type>\<tag>\
  for (const t of tags) {
    const d = join(dataRoot, 'runtimes', type, t)
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'marker.txt'), `runtime-${t}`, 'utf8')
  }
  // 运行时清单（格式是 { versions: [...] }；dir 由 store 自己推导，不存）
  writeFileSync(
    join(dataRoot, 'runtimes.json'),
    JSON.stringify({
      versions: tags.map((t) => ({
        type,
        tag: t,
        installedAt: new Date().toISOString()
      }))
    }),
    'utf8'
  )

  const id = 'a_test0001'
  const instDir = join(dataRoot, 'instances', type === 'a' ? 'AstrBot' : 'NapCat', id)
  mkdirSync(instDir, { recursive: true })
  // 实例自己的数据（换版本时必须原样保留）
  mkdirSync(join(instDir, 'data'), { recursive: true })
  writeFileSync(join(instDir, 'data', 'user-config.json'), '{"my":"settings"}', 'utf8')
  // 指针
  writeFileSync(
    join(instDir, 'instance.json'),
    JSON.stringify({
      id,
      type,
      name: '测试实例',
      runtimeTag: opts.boundTag ?? tags[0],
      port: type === 'a' ? A_FREE_PORT : N_FREE_PORT,
      createdAt: new Date().toISOString()
    }),
    'utf8'
  )
  // 实例索引（真实格式是 { instances: [...] }，不是裸数组）
  writeFileSync(
    join(dataRoot, 'instances.json'),
    JSON.stringify({
      instances: [
        {
          id,
          type,
          name: '测试实例',
          dir: instDir,
          port: type === 'a' ? A_FREE_PORT : N_FREE_PORT,
          status: 'stopped',
          templateVersion: 1,
          createdAt: new Date().toISOString()
        }
      ]
    }),
    'utf8'
  )

  return { dataRoot, id, cleanup: () => rmSync(dataRoot, { recursive: true, force: true }) }
}

async function makeHandlers(dataRoot: string): Promise<ReturnType<typeof buildHandlers>> {
  const h = buildHandlers({
    probe: stubProbe,
    processManager: createProcessManager(),
    // 不注入 commandFor：切换动作本身不需要真的启动
  })
  await h['config:set']({ dataRoot })
  return h
}

describe('instance:setRuntime（切换运行时版本）', () => {
  it('★切换后实例数据和配置原样保留', async () => {
    const s = setup({ tags: ['v4.27.1', 'v4.28.0'], boundTag: 'v4.27.1' })
    try {
      const h = await makeHandlers(s.dataRoot)
      const instDir = join(s.dataRoot, 'instances', 'AstrBot', s.id)
      const dataFile = join(instDir, 'data', 'user-config.json')
      const before = readFileSync(dataFile, 'utf8')

      const r = (await h['instance:setRuntime']({ id: s.id, tag: 'v4.28.0', type: 'a' })) as {
        changed: boolean
        from?: string
        to: string
        dataPreserved: boolean
      }

      expect(r.changed).toBe(true)
      expect(r.from).toBe('v4.27.1')
      expect(r.to).toBe('v4.28.0')
      expect(r.dataPreserved).toBe(true)
      // 这一条是用户需求的核心：数据和配置必须一字不动
      expect(existsSync(dataFile), '数据文件不能消失').toBe(true)
      expect(readFileSync(dataFile, 'utf8'), '内容必须一字不改').toBe(before)
    } finally {
      s.cleanup()
    }
  })

  it('★切换只改指针，不复制运行时文件进实例目录', async () => {
    const s = setup({ tags: ['v4.27.1', 'v4.28.0'], boundTag: 'v4.27.1' })
    try {
      const h = await makeHandlers(s.dataRoot)
      await h['instance:setRuntime']({ id: s.id, tag: 'v4.28.0', type: 'a' })
      const instDir = join(s.dataRoot, 'instances', 'AstrBot', s.id)
      // 实例目录里不该出现 runtime 目录（那是老 instance:update 的模型）
      expect(existsSync(join(instDir, 'runtime')), '不该把运行时复制进实例目录').toBe(false)
      // 指针指向新版本
      const meta = JSON.parse(readFileSync(join(instDir, 'instance.json'), 'utf8')) as {
        runtimeTag: string
      }
      expect(meta.runtimeTag).toBe('v4.28.0')
    } finally {
      s.cleanup()
    }
  })

  it('切到同一个版本 → changed:false，不做无谓动作', async () => {
    const s = setup({ tags: ['v4.28.0'], boundTag: 'v4.28.0' })
    try {
      const h = await makeHandlers(s.dataRoot)
      const r = (await h['instance:setRuntime']({ id: s.id, tag: 'v4.28.0', type: 'a' })) as {
        changed: boolean
      }
      expect(r.changed).toBe(false)
    } finally {
      s.cleanup()
    }
  })

  it('目标版本没装 → 明确报错，不静默改指针', async () => {
    const s = setup({ tags: ['v4.27.1'], boundTag: 'v4.27.1' })
    try {
      const h = await makeHandlers(s.dataRoot)
      /*
       * ★ 报错必须"可执行"，不能只说"还没下载"（主人 2026-09-26 的新交互）
       *
       * 现在「换个版本」的列表是**从源上列**的（AstrBot 走 PyPI），
       * 所以用户完全可能选到"源上有、本机还没装"的版本。这时他需要知道
       * **去哪装**，而不是一句技术性的拒绝 —— 所以断言里带上"下载页"。
       */
      await expect(h['instance:setRuntime']({ id: s.id, tag: 'v9.9.9', type: 'a' })).rejects.toThrow(
        /没有下载到本机[\s\S]*下载.*页/
      )
      // 指针不能被改坏
      const meta = JSON.parse(
        readFileSync(join(s.dataRoot, 'instances', 'AstrBot', s.id, 'instance.json'), 'utf8')
      ) as { runtimeTag: string }
      expect(meta.runtimeTag).toBe('v4.27.1')
    } finally {
      s.cleanup()
    }
  })

  it('实例不存在 → 报错', async () => {
    const s = setup()
    try {
      const h = await makeHandlers(s.dataRoot)
      await expect(h['instance:setRuntime']({ id: 'nope', tag: 'v4.28.0', type: 'a' })).rejects.toThrow(
        /实例不存在/
      )
    } finally {
      s.cleanup()
    }
  })

  it('★版本号比较用 cmpVersion 而不是 versionNumOf（4.10 要比 4.9 新）', async () => {
    /*
     * versionNumOf 是**有损指纹**（v4.2.10 和 v4.21.0 都会变成 4210），
     * 拿它判"哪个更新"会把降级当升级。这里用 v4.9.9 → v4.10.0 验证
     * 切换是正常执行的（真按数字指纹比会得出相同值、误判成"没变化"）。
     */
    const s = setup({ tags: ['v4.9.9', 'v4.10.0'], boundTag: 'v4.9.9' })
    try {
      const h = await makeHandlers(s.dataRoot)
      const r = (await h['instance:setRuntime']({ id: s.id, tag: 'v4.10.0', type: 'a' })) as {
        changed: boolean
        from?: string
        to: string
      }
      expect(r.changed, 'v4.9.9 → v4.10.0 是真实变化，不能判成相同').toBe(true)
      expect(r.from).toBe('v4.9.9')
      expect(r.to).toBe('v4.10.0')
    } finally {
      s.cleanup()
    }
  })

  it('类型不匹配 → 报错（不能拿 NapCat 版本喂给 AstrBot 实例）', async () => {
    const s = setup({ tags: ['v4.28.0'], boundTag: 'v4.28.0', instanceType: 'a' })
    try {
      const h = await makeHandlers(s.dataRoot)
      await expect(
        h['instance:setRuntime']({ id: s.id, tag: 'v4.28.0', type: 'n' })
      ).rejects.toThrow()
    } finally {
      s.cleanup()
    }
  })
})

/*
 * 附带修掉的既存 bug。
 *
 * 下载页删版本时要提示「有 N 个实例正在用这个版本」，判断是
 * `i.runtimeTag === tag`。但 instance:list 返回的 InstanceRecord
 * **没有 runtimeTag 字段**（真实绑定存在 instance.json 里），
 * 于是那个过滤恒为空 —— 确认框永远说「没有实例在使用」，
 * 用户就会放心删掉一个正在被使用的运行时。
 */
describe('★instance:list 必须带上 runtimeTag（否则删版本提示恒为空）', () => {
  it('列表里每个实例都带 runtimeTag', async () => {
    const s = setup({ tags: ['v4.27.1', 'v4.28.0'], boundTag: 'v4.27.1' })
    try {
      const h = await makeHandlers(s.dataRoot)
      const list = (await h['instance:list']()) as Array<{ id: string; runtimeTag?: string }>
      expect(list.length).toBe(1)
      expect(list[0].runtimeTag, '必须有 runtimeTag，否则前端过滤恒为空').toBe('v4.27.1')
    } finally {
      s.cleanup()
    }
  })

  it('切换版本后列表里的 runtimeTag 跟着变', async () => {
    const s = setup({ tags: ['v4.27.1', 'v4.28.0'], boundTag: 'v4.27.1' })
    try {
      const h = await makeHandlers(s.dataRoot)
      await h['instance:setRuntime']({ id: s.id, tag: 'v4.28.0', type: 'a' })
      const list = (await h['instance:list']()) as Array<{ runtimeTag?: string }>
      expect(list[0].runtimeTag).toBe('v4.28.0')
    } finally {
      s.cleanup()
    }
  })
})
