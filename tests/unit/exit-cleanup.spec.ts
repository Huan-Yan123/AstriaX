/*
 * 退出软件时必须把实例收干净。
 *
 * ## 为什么专门测这个
 *
 * process-manager 只知道我们 spawn 出来的进程树。NapCat 是**注入进 QQ.exe**
 * 跑的：注入器干完活就退出，真正干活的 QQ 早已脱离我们的父子链，
 * 所以 `taskkill /T`（按父子关系递归）**杀不到它**。
 *
 * 后果很隐蔽：用户点托盘「退出（停止全部实例）」，窗口消失了，
 * 但 NapCat 还在后台连着 QQ 继续收发消息、端口还占着。
 * 用户以为关掉了；下次启动时端口被占，新实例分到别的端口，
 * 而旧的还在跑 —— 看起来就像「多出来一个我控制不了的实例」。
 *
 * 所以退出路径必须**按端口**再清一遍。端口是每个实例的身份
 * （端口段按类型分配：AstrBot 6100-6199 / NapCat 6200-6299），
 * 拿它找 listener 是安全的，不会误伤用户自己开的 QQ。
 */
import { describe, it, expect, vi } from 'vitest'
import { buildHandlers, EXIT_CLEANUP } from '../../src/main/ipc'
import type { InstanceRecord } from '../../src/main/store/instance-repo'
import { testStage } from '../helpers/stage'
import { rmSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

function rec(over: Partial<InstanceRecord>): InstanceRecord {
  return {
    id: 'n_abc123',
    type: 'n',
    name: 'N',
    templateVersion: 1,
    port: 6200,
    dir: 'D:\\x',
    status: 'stopped',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

/** 造一个真实的 dataRoot（config:set 会往里写 config.json） */
function stageWithInstances(recs: InstanceRecord[]): string {
  const root = testStage('acb-exit-kill-')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'instances.json'), JSON.stringify({ instances: recs }), 'utf8')
  for (const r of recs) mkdirSync(r.dir, { recursive: true })
  return root
}

/** 一个什么都不做的进程管理器 */
function fakePm() {
  return {
    start: vi.fn(),
    killTreeSync: vi.fn(),
    killAllSync: vi.fn(),
    statusOf: () => undefined,
    pidsOf: () => new Map(),
    onStatus: () => () => undefined,
    tailOf: () => ''
  }
}

/**
 * 取退出清理入口。
 *
 * 它挂在 handler 表的 **Symbol 键**上（`EXIT_CLEANUP`），不是普通字符串键 ——
 * 这样 registerIpcHandlersReal 的 `Object.entries` 遍历不到它，
 * 它就不会变成渲染层能 invoke 的通道。测试里直接从返回对象上取。
 */
const cleanupOf = (h: unknown): (() => void) | undefined =>
  (h as Record<symbol, () => void>)[EXIT_CLEANUP]

describe('退出时清理实例', () => {
  it('★killEverythingForExit 会调 killAllSync 收自己的进程树', async () => {
    const root = stageWithInstances([])
    const pm = fakePm()
    const h = buildHandlers({ probe: () => true, processManager: pm, audit: undefined })
    h['config:set']({ dataRoot: root })

    const cleanup = cleanupOf(h)
    expect(typeof cleanup, '主进程必须能拿到退出清理入口').toBe('function')
    cleanup?.()

    expect(pm.killAllSync, '退出时必须收掉自己 spawn 的进程').toHaveBeenCalled()
    rmSync(root, { recursive: true, force: true })
  })

  it('★没有实例时也不会抛（退出路径绝不能因为清理失败而卡住）', async () => {
    const root = stageWithInstances([])
    const h = buildHandlers({ probe: () => true, processManager: fakePm() })
    h['config:set']({ dataRoot: root })

    expect(() => cleanupOf(h)?.()).not.toThrow()
    rmSync(root, { recursive: true, force: true })
  })

  it('★config:set 之前就调用也不能抛（用户可能没配过数据目录就退出）', () => {
    // 真实场景：首次打开、还没过首启向导，用户直接点 ✕ 退出
    const h = buildHandlers({ probe: () => true, processManager: fakePm() })
    expect(() => cleanupOf(h)?.()).not.toThrow()
  })

  it('★有实例时 killAllSync 照样被调到（按端口清理那条路不能被跳过）', async () => {
    const base = testStage('acb-exit-rec-')
    const dir1 = join(base, 'inst1')
    const dir2 = join(base, 'inst2')
    mkdirSync(dir1, { recursive: true })
    mkdirSync(dir2, { recursive: true })
    writeFileSync(join(dir1, 'instance.json'), JSON.stringify({ runtimeTag: 'v1' }), 'utf8')
    const root = stageWithInstances([
      rec({ id: 'n_1', port: 6231, dir: dir1 }),
      rec({ id: 'a_1', type: 'a', port: 6131, dir: dir2 })
    ])

    const pm = fakePm()
    // 按端口清理走的是真 netstat；这里只要求整条路径不抛、且进程树照收
    const h = buildHandlers({ probe: () => true, processManager: pm })
    h['config:set']({ dataRoot: root })
    expect(() => cleanupOf(h)?.()).not.toThrow()
    expect(pm.killAllSync).toHaveBeenCalled()

    rmSync(root, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  })
})
