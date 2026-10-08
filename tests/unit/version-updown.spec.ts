/*
 * ★ 升级 / **降级** 都要能跑通（主人 2026-09-26 的要求：「并测试降级升级」）。
 *
 * ## 为什么要专门测降级
 *
 * 升级是默认预期，降级才是容易出错的那个方向：
 *   · AstrBot 新版本有 bug，用户想退回旧版 —— 这是**正经需求**，
 *     不是"奇怪操作"。他比我们清楚哪个版本能跑。
 *   · 降级时如果代码里有"只许升不许降"的隐含假设（版本比较、缓存 key、
 *     复用已装目录的判断），就会失败或静默换错版本。
 *   · 项目里历史上出现过"低版本覆盖高版本"的安装器问题
 *     （build/installer.nsh 的降级拦截就是这么来的），所以这条值得钉住。
 *
 * ## 测什么
 *
 * `instance:setRuntime` 只改 instance.json 里的指针，运行时的安装/切换
 * 由 `runtimes:*` 负责。所以端到端要覆盖：
 *   1. 同一实例的 runtimeTag 能从低 → 高（升级）
 *   2. 也能从高 → 低（**降级**）
 *   3. 两次都**不碰实例数据**（data/ 与配置一字不动）
 *   4. 版本列表里**同时**包含比当前新的和比当前旧的（用户能自己选方向）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { testStage } from '../helpers/stage'

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 空闲端口常量 —— 别用硬编码的 6100
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 开发机上**真会被占**：6100 常被别的程序用（主人那个 `watch_api.py`
 * 就绑在 6100）。
 *
 * 而测试的实例一旦用了它，`instance:setRuntime` → `stopInstanceHard` 里的
 * `waitPortGone(port, 3000)` 会**等满两次**（≈7 秒）—— 超过 vitest
 * 默认的 5 秒超时，三条用例红得像"功能坏了"，其实只是端口撞车。
 *
 * 模块加载时**同步**挑一个空闲的（`setup` 之类的辅助是同步的，
 * 用不了异步的 `freePortIn`）。
 */
function pickFreeSync(min: number, max: number): number {
  const { execSync } = require('child_process') as typeof import('child_process')
  const busy = new Set<number>()
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8', timeout: 8000 })
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue
      const m = /:(\d+)\s+\S+\s+LISTENING/i.exec(line)
      if (m) busy.add(Number(m[1]))
    }
  } catch {
    /* 拿不到就全当空闲（最多慢一点，不会错） */
  }
  for (let p = min; p <= max; p++) {
    if (!busy.has(p)) return p
  }
  return max
}
const A_FREE_PORT = pickFreeSync(6100, 6199)

let root: string
beforeEach(() => {
  root = testStage('updown-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 造一个"已装好的运行时目录"（只要结构对，内容无所谓） */
function seedRuntime(type: 'a' | 'n', tag: string): string {
  const dir = join(root, 'runtimes', type, tag)
  mkdirSync(dir, { recursive: true })
  if (type === 'a') {
    // PyPI 形态的判据：有 astrbot/cli/__main__.py
    mkdirSync(join(dir, 'astrbot', 'cli'), { recursive: true })
    writeFileSync(join(dir, 'astrbot', 'cli', '__main__.py'), '# entry\n', 'utf8')
  } else {
    writeFileSync(join(dir, 'napcat.mjs'), '// napcat\n', 'utf8')
  }
  return dir
}

/** 造一个实例目录 + instance.json（带 runtimeTag） */
function seedInstance(id: string, type: 'a' | 'n', tag: string): string {
  const dir = join(root, 'instances', type === 'a' ? 'AstrBot' : 'NapCat', id)
  mkdirSync(join(dir, 'data', 'config'), { recursive: true })
  writeFileSync(join(dir, 'instance.json'), JSON.stringify({ id, runtimeTag: tag, port: 6100 }), 'utf8')
  // 用户数据：切换版本后必须**一字不动**
  writeFileSync(join(dir, 'data', 'cmd_config.json'), JSON.stringify({ token: 'KEEP-ME' }), 'utf8')
  writeFileSync(join(dir, 'data', 'config', '人格-梦汐.json'), '{"name":"梦汐"}', 'utf8')
  // 清单（instance:list 的数据源）
  const idx = join(root, 'instances.json')
  const cur = existsSync(idx)
    ? (JSON.parse(readFileSync(idx, 'utf8')) as { instances: unknown[] })
    : { instances: [] }
  cur.instances.push({
    id,
    type,
    name: `测试实例 ${id}`,
    // ★ dir 必须给：真实 instances.json 里每条记录都带实例目录，
    //   而 setRuntime 要读它来定位 instance.json（第一版漏了这个字段，
    //   于是 readInstanceTag(undefined) 抛 TypeError —— 顺带暴露了
    //   生产代码里缺的那个 undefined 守卫，两边都补上了）
    dir,
    /*
     * ★ 端口要**避开被真实程序占着的**，别硬编码 6100。
     *
     * 开发机上 6100 常被别的程序用（主人那个 watch_api.py 就占着）。
     * 一旦撞上，`setRuntime` → `stopInstanceHard` 里的
     * `waitPortGone(port, 3000)` 会**等满两次**（≈7 秒）——
     * 超过 vitest 默认的 5 秒超时，用例红得像"功能坏了"，
     * 而实际只是测试选了个被占的端口。
     *
     * 这里用同步挑出来的空闲端口（`setup` 是同步函数，用不了异步的 freePortIn）。
     */
    port: A_FREE_PORT,
    status: 'stopped',
    runtimeTag: tag
  })
  writeFileSync(idx, JSON.stringify(cur), 'utf8')
  return dir
}

describe('★运行时版本：升级与降级都要能用（主人要求「测试降级升级」）', () => {
  it('★降级：把实例从高版本切回低版本，数据必须原样保留', async () => {
    const { buildHandlers } = await import('../../src/main/ipc')

    // 装两个版本：4.27.0（旧）与 4.28.0（新）
    seedRuntime('a', 'v4.27.0')
    seedRuntime('a', 'v4.28.0')
    // 实例当前用新的
    const instDir = seedInstance('a_down', 'a', 'v4.28.0')

    const h = buildHandlers({ probe: () => Promise.resolve(false) })
    await h['config:set']({ dataRoot: root })

    // ↓ 降级到旧版
    const r = (await h['instance:setRuntime']({ id: 'a_down', tag: 'v4.27.0', type: 'a' })) as {
      changed: boolean
      from?: string
      to: string
    }
    expect(r.changed, '应当真的发生了切换').toBe(true)
    expect(r.from).toBe('v4.28.0')
    expect(r.to).toBe('v4.27.0')

    // 指针已改
    const meta = JSON.parse(readFileSync(join(instDir, 'instance.json'), 'utf8')) as {
      runtimeTag?: string
    }
    expect(meta.runtimeTag, '降级后指针必须是旧版本').toBe('v4.27.0')

    // ★ 数据一个字都不能动
    expect(
      readFileSync(join(instDir, 'data', 'cmd_config.json'), 'utf8'),
      '降级后用户配置必须原样'
    ).toContain('KEEP-ME')
    expect(
      existsSync(join(instDir, 'data', 'config', '人格-梦汐.json')),
      '降级不该碰实例的 data/'
    ).toBe(true)
  })

  it('★升级：低 → 高，数据同样保留', async () => {
    const { buildHandlers } = await import('../../src/main/ipc')
    seedRuntime('a', 'v4.27.0')
    seedRuntime('a', 'v4.28.0')
    const instDir = seedInstance('a_up', 'a', 'v4.27.0')

    const h = buildHandlers({ probe: () => Promise.resolve(false) })
    await h['config:set']({ dataRoot: root })

    const r = (await h['instance:setRuntime']({ id: 'a_up', tag: 'v4.28.0', type: 'a' })) as {
      changed: boolean
      to: string
    }
    expect(r.changed).toBe(true)
    expect(r.to).toBe('v4.28.0')
    expect(readFileSync(join(instDir, 'data', 'cmd_config.json'), 'utf8')).toContain('KEEP-ME')
  })

  it('★来回切换（升→降→升）都稳定，数据始终不动', async () => {
    const { buildHandlers } = await import('../../src/main/ipc')
    seedRuntime('a', 'v4.27.0')
    seedRuntime('a', 'v4.28.0')
    const instDir = seedInstance('a_pingpong', 'a', 'v4.27.0')

    const h = buildHandlers({ probe: () => Promise.resolve(false) })
    await h['config:set']({ dataRoot: root })

    for (const tag of ['v4.28.0', 'v4.27.0', 'v4.28.0']) {
      const r = (await h['instance:setRuntime']({ id: 'a_pingpong', tag, type: 'a' })) as {
        to: string
      }
      expect(r.to).toBe(tag)
      expect(
        readFileSync(join(instDir, 'data', 'cmd_config.json'), 'utf8'),
        `切到 ${tag} 之后数据必须还在`
      ).toContain('KEEP-ME')
    }
  })

  it('★版本列表要同时含"更新的"和"更旧的"（用户才能自己选方向）', async () => {
    /*
     * 这条守的是"用户能自己决定升还是降"这个能力本身：
     * 如果列表只给出比当前新的版本（或只给已装的），降级就无从谈起。
     * 这里直接检查 runtimes:list 会列出**所有**已装版本。
     */
    const { buildHandlers } = await import('../../src/main/ipc')
    seedRuntime('a', 'v4.26.0')
    seedRuntime('a', 'v4.27.0')
    seedRuntime('a', 'v4.28.0')
    seedInstance('a_list', 'a', 'v4.28.0')

    const h = buildHandlers({ probe: () => Promise.resolve(false) })
    await h['config:set']({ dataRoot: root })

    const list = (await h['runtimes:list']()) as Array<{ type: string; tag: string }>
    const tags = list.filter((v) => v.type === 'a').map((v) => v.tag)
    expect(tags, '三个版本都要在列表里（含比当前旧的）').toEqual(
      expect.arrayContaining(['v4.26.0', 'v4.27.0', 'v4.28.0'])
    )
  })

  it('切到**没装过**的版本必须明确报错（不能静默改指针）', async () => {
    const { buildHandlers } = await import('../../src/main/ipc')
    seedRuntime('a', 'v4.27.0')
    seedInstance('a_missing', 'a', 'v4.27.0')

    const h = buildHandlers({ probe: () => Promise.resolve(false) })
    await h['config:set']({ dataRoot: root })

    await expect(
      h['instance:setRuntime']({ id: 'a_missing', tag: 'v9.9.9', type: 'a' }),
      '没装的版本不该被允许 —— 否则实例指向一个不存在的目录，下次启动直接报"结构不对"'
    ).rejects.toThrow()
  })
})
