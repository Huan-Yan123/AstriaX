import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import {
  readCachedVersions,
  writeCachedVersions,
  invalidateVersionCache,
  listVersions,
  VERSION_CACHE_TTL_MS
} from '../../src/main/update/version-catalog'
import { testStage } from '../helpers/stage'

/**
 * 版本列表的持久化缓存。
 *
 * 用户报告：「为什么很多地方都不做持久化保存，比如已经获取的文件包列表，
 * 每次打开都要重新获取」。
 *
 * 原来每进一次下载页、每点一个镜像源都要把所有源打一遍网络
 * （每个源超时 15 秒）。网慢的时候界面就在转圈，用户体感是卡死。
 * 版本列表几分钟内不会变，缓存起来完全够。
 */

let root: string
beforeEach(() => {
  root = testStage('mx-vcache-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const items = [
  { tag: 'v4.28.0', type: 'a' as const },
  { tag: 'v4.27.1', type: 'a' as const }
]

describe('版本列表缓存', () => {
  it('写进去能读出来（同一 type + base）', () => {
    writeCachedVersions(root, 'a', 'http://x/', items)
    expect(readCachedVersions(root, 'a', 'http://x/')?.map((v) => v.tag)).toEqual([
      'v4.28.0',
      'v4.27.1'
    ])
  })

  it('不同 base 互不干扰', () => {
    writeCachedVersions(root, 'a', 'http://x/', items)
    writeCachedVersions(root, 'a', 'http://y/', [{ tag: 'v9.9.9', type: 'a' as const }])
    expect(readCachedVersions(root, 'a', 'http://x/')?.length).toBe(2)
    expect(readCachedVersions(root, 'a', 'http://y/')?.map((v) => v.tag)).toEqual(['v9.9.9'])
  })

  it('不同 type 互不干扰', () => {
    writeCachedVersions(root, 'a', undefined, items)
    writeCachedVersions(root, 'n', undefined, [{ tag: 'v4.18.19', type: 'n' as const }])
    expect(readCachedVersions(root, 'n', undefined)?.map((v) => v.tag)).toEqual(['v4.18.19'])
    expect(readCachedVersions(root, 'a', undefined)?.length).toBe(2)
  })

  it('没过期就能读到', () => {
    writeCachedVersions(root, 'a', undefined, items)
    const now = Date.now() + VERSION_CACHE_TTL_MS - 1000
    expect(readCachedVersions(root, 'a', undefined, { now })?.length).toBe(2)
  })

  it('过期就读不到了（freshOnly 默认开）', () => {
    writeCachedVersions(root, 'a', undefined, items)
    const now = Date.now() + VERSION_CACHE_TTL_MS + 1
    expect(readCachedVersions(root, 'a', undefined, { now })).toBeUndefined()
  })

  it('过期了仍可用 freshOnly:false 拿到（离线兜底用）', () => {
    writeCachedVersions(root, 'a', undefined, items)
    const now = Date.now() + VERSION_CACHE_TTL_MS * 100
    expect(readCachedVersions(root, 'a', undefined, { now, freshOnly: false })?.length).toBe(2)
  })

  it('作废之后读不到（下载/删除这类更新操作要调用它）', () => {
    writeCachedVersions(root, 'a', undefined, items)
    expect(readCachedVersions(root, 'a', undefined)).toBeDefined()
    invalidateVersionCache(root)
    expect(readCachedVersions(root, 'a', undefined)).toBeUndefined()
  })

  it('缓存文件坏了不该抛错，只当没有缓存（它只是加速用的）', () => {
    mkdirSync(join(root, 'cache'), { recursive: true })
    writeFileSync(join(root, 'cache', 'versions-cache.json'), '{ 这不是 json', 'utf8')
    expect(() => readCachedVersions(root, 'a', undefined)).not.toThrow()
    expect(readCachedVersions(root, 'a', undefined)).toBeUndefined()
  })

  it('cache 目录不存在时写入会自己建（首次运行）', () => {
    expect(existsSync(join(root, 'cache'))).toBe(false)
    writeCachedVersions(root, 'a', undefined, items)
    expect(existsSync(join(root, 'cache', 'versions-cache.json'))).toBe(true)
  })

  it('再写一次只更新同一个键，不会堆出一串重复条目', () => {
    writeCachedVersions(root, 'a', undefined, items)
    writeCachedVersions(root, 'a', undefined, [{ tag: 'v4.29.0', type: 'a' as const }])
    expect(readCachedVersions(root, 'a', undefined)?.map((v) => v.tag)).toEqual(['v4.29.0'])
  })
})

describe('listVersions 的缓存行为', () => {
  it('有新鲜缓存就直接返回，**完全不碰网络**（用户要的核心效果）', async () => {
    /*
     * 这是决定性的一条：不注入 fetchJson（即走真实的 defaultFetchJson），
     * 只靠预置的缓存。
     *
     * 证明方式：把首选源指向一个**必定连不上**的地址（127.0.0.1:1），
     * 并让 maxSources=1 只探这一个源。如果代码真去打了网络，这个调用就得
     * 等连接失败/超时；读到缓存则会**立刻**返回预置内容。
     * 用「内容正确 + 耗时极短」双重确认。
     */
    const { saveMirrors } = await import('../../src/main/update/mirror-store')
    saveMirrors(root, { pref: { a: 'http://127.0.0.1:1/', n: 'http://127.0.0.1:1/' } })
    writeCachedVersions(root, 'a', undefined, items)

    const t0 = Date.now()
    const out = await listVersions({ dataRoot: root, type: 'a', maxSources: 1 })
    const spent = Date.now() - t0

    expect(out.map((v) => v.tag), '应当直接拿到缓存里的内容').toEqual(['v4.28.0', 'v4.27.1'])
    expect(spent, '读缓存应该是毫秒级，不该等网络超时').toBeLessThan(2000)
  })

  it('注入了 fetchJson 时按契约绕过缓存（测试要能验解析逻辑）', async () => {
    writeCachedVersions(root, 'a', undefined, items)
    let calls = 0
    const fetchJson = async (): Promise<string> => {
      calls++
      return JSON.stringify([])
    }
    await listVersions({ dataRoot: root, type: 'a', fetchJson })
    expect(calls, '注入 fetchJson 说明调用方要验解析，不能被缓存短路').toBeGreaterThan(0)
  })

  it('noCache=true 时明确要求走网络（用户点「刷新」）', async () => {
    writeCachedVersions(root, 'a', undefined, items)
    let calls = 0
    const fetchJson = async (): Promise<string> => {
      calls++
      return JSON.stringify({ tag_name: 'v4.28.0', assets: [] })
    }
    await listVersions({ dataRoot: root, type: 'a', noCache: true, fetchJson })
    expect(calls).toBeGreaterThan(0)
  })
})
