import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { createInstanceRepo } from '../../src/main/store/instance-repo'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('acb-repo-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('JSON InstanceRepo', () => {
  it('create 生成 {} 前缀 id、分配端口、默认 stopped，并落盘 instances.json', () => {
    const repo = createInstanceRepo({ dataRoot: root })
    const i = repo.create({ type: 'a', name: '测试机' })
    expect(i.id).toMatch(/^a_/)
    expect(i.port).toBeGreaterThanOrEqual(6100)
    expect(i.status).toBe('stopped')
    expect(repo.list().length).toBe(1)
    const disk = JSON.parse(readFileSync(join(root, 'instances.json'), 'utf8'))
    expect(disk.instances.map((x: { id: string }) => x.id)).toContain(i.id)
  })

  it('同类型第二个实例分配不同端口', () => {
    const repo = createInstanceRepo({ dataRoot: root })
    const a = repo.create({ type: 'n', name: '一号' })
    const b = repo.create({ type: 'n', name: '二号' })
    expect(b.port).not.toBe(a.port)
  })

  it('get/updateStatus/remove 闭环', () => {
    const repo = createInstanceRepo({ dataRoot: root })
    const i = repo.create({ type: 'a', name: 'x' })
    expect(repo.get(i.id)?.name).toBe('x')
    repo.updateStatus(i.id, 'running')
    expect(repo.get(i.id)?.status).toBe('running')
    expect(repo.get(i.id)?.name).toBe('x') // updateStatus 不改名字
    expect(repo.get(i.id)!.updatedAt >= repo.get(i.id)!.createdAt).toBe(true)
    repo.remove(i.id)
    expect(repo.get(i.id)).toBeUndefined()
    expect(repo.list().length).toBe(0)
  })

  it('崩溃数据兼容：磁盘上已有 instances.json 会被读回', () => {
    const repo1 = createInstanceRepo({ dataRoot: root })
    const i = repo1.create({ type: 'n', name: '持久' })
    const repo2 = createInstanceRepo({ dataRoot: root })
    expect(repo2.get(i.id)?.name).toBe('持久')
  })

  it('remove 不存在的 id 不抛异常（幂等）', () => {
    const repo = createInstanceRepo({ dataRoot: root })
    expect(() => repo.remove('n_nope')).not.toThrow()
  })

  it('分段端口：AstrBot 落 6100-6199，NapCat 落 6200-6299', () => {
    const repo = createInstanceRepo({ dataRoot: root })
    const a = repo.create({ type: 'a', name: '甲' })
    const n = repo.create({ type: 'n', name: '乙' })
    expect(a.port).toBeGreaterThanOrEqual(6100)
    expect(a.port).toBeLessThanOrEqual(6199)
    expect(a.port).toBe(6100) // 首个 AstrBot 实例=段首
    expect(n.port).toBeGreaterThanOrEqual(6200)
    expect(n.port).toBeLessThanOrEqual(6299)
    expect(n.port).toBe(6200) // 首个 NapCat 实例=段首
  })

  it('同类默认分配：接着同类上一个端口往后走', () => {
    const repo = createInstanceRepo({ dataRoot: root })
    repo.create({ type: 'a', name: 'A1' })
    repo.create({ type: 'a', name: 'A2' })
    repo.create({ type: 'n', name: 'N1' })
    const list = repo.list()
    const aPorts = list.filter((x) => x.type === 'a').map((x) => x.port)
    const nPorts = list.filter((x) => x.type === 'n').map((x) => x.port)
    expect(aPorts.sort((m, n2) => m - n2)).toEqual([6100, 6101])
    expect(nPorts[0]).toBe(6200)
  })

  it('实例名全局唯一：A/N 之间也不许重名', () => {
    const repo = createInstanceRepo({ dataRoot: root })
    repo.create({ type: 'a', name: '重名机' })
    expect(() => repo.create({ type: 'n', name: '重名机' })).toThrow(/已存在/)
  })

  it('★updatePort 能把归零的端口真正修好（并落盘）', () => {
    /*
     * ## 为什么需要这个方法（审计抓出的真问题）
     *
     * `readAll` 会把越界端口"修"成 0（让记录本身变良性 —— 那个设计是对的），
     * 而**那次修会随 writeAll 一起落盘**。也就是说 0 是我们自己写进去的。
     *
     * 而 `instance-repo.ts` 当时的注释写着「用户点启动时 start 会走 allocate
     * 重新分配一个合法端口」—— 但全文件 grep：`allocate()` 只在
     * `instance:create` 里调过一次，`instance:start` 从来没用过它。
     *
     * 于是端口被归零的实例**永远修不好**：每次启动都拿 0 去 spawn、去探端口，
     * 白等满 90 秒，AstrBot 还会被传 `--port 0`，而用户没有任何自助修复入口。
     *
     * updatePort 的存在就是为了让 start 能把这个值写回去。
     */
    const repo = createInstanceRepo({ dataRoot: root })
    const i = repo.create({ type: 'a', name: '端口坏了' })

    repo.updatePort(i.id, 6123)
    expect(repo.get(i.id)?.port, '内存里应当是新值').toBe(6123)

    // 关键：要**落盘**，否则下次启动读到的还是坏值
    const repo2 = createInstanceRepo({ dataRoot: root })
    expect(repo2.get(i.id)?.port, '重新读盘后必须还是新值（写回了）').toBe(6123)
  })

  it('updatePort 拒绝非法值、对不存在的 id 幂等（不抛）', () => {
    const repo = createInstanceRepo({ dataRoot: root })
    const i = repo.create({ type: 'a', name: '合法值守护' })
    const before = repo.get(i.id)?.port

    // 非法值一律不采纳（0 / 越界 / 小数 / 负数）
    for (const bad of [0, -1, 65536, 1.5, Number.NaN]) {
      repo.updatePort(i.id, bad)
      expect(repo.get(i.id)?.port, `不该接受非法端口 ${bad}`).toBe(before)
    }

    // 实例可能刚被删 —— 幂等返回而不是抛（启动流程里抛错很难处理）
    expect(() => repo.updatePort('a_nope', 6111)).not.toThrow()
  })

  it('目录按类型分流：AstrBot 进 instances\\AstrBot，NapCat 进 instances\\NapCat', () => {
    const repo = createInstanceRepo({ dataRoot: root })
    const a = repo.create({ type: 'a', name: '甲' })
    const n = repo.create({ type: 'n', name: '乙' })
    expect(a.dir).toContain(join('instances', 'AstrBot'))
    expect(n.dir).toContain(join('instances', 'NapCat'))
  })

  it('remove 只摘记录、不删目录（文件由调用方异步删，避免卡死主进程）', async () => {
    const { mkdirSync, writeFileSync, existsSync } = require('fs') as typeof import('fs')
    const repo = createInstanceRepo({ dataRoot: root })
    const i = repo.create({ type: 'a', name: '占地盘' })
    mkdirSync(join(i.dir, 'data'), { recursive: true })
    writeFileSync(join(i.dir, 'data', 'x.db'), 'payload', 'utf8')

    repo.remove(i.id)
    expect(repo.get(i.id), '记录要立即消失（界面马上少一张卡）').toBeUndefined()
    expect(repo.list().map((x) => x.id), '列表读的是 instances.json，所以立刻就干净了').not.toContain(i.id)
    /*
     * 目录此刻**还在**，这是有意的：
     * 实例目录可能几万文件，同步 rmSync 会把主进程独占住，
     * 界面在此期间点什么都无响应（用户反馈「删个文件就无响应」）。
     * 现在由 ipc 层的 instance:remove 用 removeDirAsync 异步删。
     */
    expect(existsSync(i.dir), 'remove 不再同步删文件').toBe(true)

    const { removeDirAsync } = await import('../../src/main/util/workdir')
    await removeDirAsync(i.dir)
    expect(existsSync(i.dir), '异步删完之后才真的没了').toBe(false)
  })
})
