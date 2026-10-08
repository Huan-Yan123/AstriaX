import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  beginTask,
  endTask,
  findTask,
  cancelTask,
  taskKey,
  listTasks
} from '../../src/main/update/running-tasks'
import { makeStage, removeDirAsync } from '../../src/main/util/workdir'
import { testStage } from '../helpers/stage'

/**
 * 暴力测试：并发 + 乱序 + 异常输入。
 *
 * 主人 2026-10-08：
 *   「现在跑暴力测试」
 *   「你永远不知道用户能干些什么，而且是并发测试，看看会不会因为这个
 *     东西在运行导致另一个东西异常」
 *
 * 这里不测"正常流程"（那由各功能自己的 spec 覆盖），
 * 专门打**用户真会干但没人测**的那一类。
 */

let root = ''
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  // 每个用例后清空注册表，避免用例之间串味（模块级单例）
  for (const t of listTasks()) endTask(t.key, t.controller)
})

describe('暴力：并发与竞态', () => {
  it('并发登记同键：只允许一个成功（用户狂点下载同一个版本）', () => {
    const key = taskKey('a', 'v4.28.0')
    /* 模拟 50 次"几乎同时"的点按 */
    const results = Array.from({ length: 50 }, () =>
      beginTask({ key, kind: 'install', controller: new AbortController(), label: 'AstrBot v4.28.0' })
    )
    const succeeded = results.filter((r) => r !== null)
    expect(succeeded, '同键只能成功一次').toHaveLength(1)
    expect(listTasks().filter((t) => t.key === key), '注册表里只该有一条').toHaveLength(1)
  })

  it('并发取消：两个任务同时取消，互不影响（不能误删对方的登记）', () => {
    const k1 = taskKey('a', 'v4.28.0')
    const k2 = taskKey('n', 'v4.18.33')
    const c1 = new AbortController()
    const c2 = new AbortController()
    beginTask({ key: k1, kind: 'install', controller: c1, label: 'A' })
    beginTask({ key: k2, kind: 'install', controller: c2, label: 'N' })

    /* 同时取消两个：注册表里的键是不同对象，各自必须精确命中 */
    const r1 = cancelTask(k1)
    const r2 = cancelTask(k2)
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(c1.signal.aborted, '第一个任务的信号被 abort').toBe(true)
    expect(c2.signal.aborted, '第二个任务的信号也要被 abort').toBe(true)

    /* 释放第一个不能把第二个也删掉 */
    endTask(k1, c1)
    expect(findTask(k1)).toBeUndefined()
    expect(findTask(k2), '释放 k1 不能误删 k2').toBeDefined()
  })

  it('不同键并发：装 AstrBot 的同时装 NapCat 互不干扰', () => {
    const a = beginTask({
      key: taskKey('a', 'v4.28.0'),
      kind: 'install',
      controller: new AbortController(),
      label: 'AstrBot'
    })
    const n = beginTask({
      key: taskKey('n', 'v4.18.33'),
      kind: 'install',
      controller: new AbortController(),
      label: 'NapCat'
    })
    expect(a).not.toBeNull()
    expect(n, '不同版本/类型必须能并行（否则用户要白等）').not.toBeNull()
    expect(listTasks()).toHaveLength(2)
  })

  it('取消后立刻重装：旧登记必须已经释放（否则用户被永久挡住）', () => {
    const key = taskKey('a', 'v4.28.0')
    const c = new AbortController()
    const t = beginTask({ key, kind: 'install', controller: c, label: 'A' })
    expect(t).not.toBeNull()

    /* 用户点取消 */
    cancelTask(key)
    /* 装任务的收尾（模拟 finally） */
    endTask(key, c)

    /* 立刻又点一次安装：必须能开起来 */
    const again = beginTask({
      key,
      kind: 'install',
      controller: new AbortController(),
      label: 'A'
    })
    expect(again, '取消后立刻重装必须可行 —— 否则用户只能重启软件').not.toBeNull()
  })

  it('结束登记：endTask 传错 controller 时不能删掉别人的登记', () => {
    const key = taskKey('a', 'v4.28.0')
    const real = new AbortController()
    beginTask({ key, kind: 'install', controller: real, label: 'A' })

    /* 传一个不相干的 controller —— 绝不能因此把真登记删掉 */
    endTask(key, new AbortController())
    expect(findTask(key), '错误 controller 不该删掉有效登记').toBeDefined()

    /* 传对的才释放 */
    endTask(key, real)
    expect(findTask(key)).toBeUndefined()
  })

  it('海量并发：1000 次登记+释放不泄漏（长会话反复安装）', () => {
    for (let i = 0; i < 1000; i++) {
      const key = taskKey('a', `v${i}`)
      const c = new AbortController()
      const t = beginTask({ key, kind: 'install', controller: c, label: `v${i}` })
      expect(t).not.toBeNull()
      endTask(key, c)
    }
    expect(listTasks(), '全部释放后注册表必须为空（不能无界增长）').toHaveLength(0)
  })

  it('重复取消：同一任务连点取消不抛错（用户会疯狂点）', () => {
    const key = taskKey('a', 'v4.28.0')
    const c = new AbortController()
    beginTask({ key, kind: 'install', controller: c, label: 'A' })
    for (let i = 0; i < 30; i++) {
      expect(() => cancelTask(key)).not.toThrow()
    }
    /* 取消一个根本不存在的任务也不该抛 */
    expect(() => cancelTask(taskKey('a', 'never-existed'))).not.toThrow()
    expect(cancelTask(taskKey('a', 'never-existed')).ok).toBe(false)
  })
})

describe('暴力：取消后的清理', () => {
  it('取消后暂存目录被清理（否则重装撞上残缺目录）', async () => {
    root = testStage('stress-cleanup-')
    const stage = makeStage(root, 'py')
    /* 造出"下了一半"的现场 */
    mkdirSync(join(stage, 'nested'), { recursive: true })
    writeFileSync(join(stage, 'python.zip.part'), 'x'.repeat(1024), 'utf8')
    writeFileSync(join(stage, 'nested', 'file'), 'y', 'utf8')
    expect(existsSync(stage)).toBe(true)

    await removeDirAsync(stage)
    expect(existsSync(stage), '取消后暂存目录必须清掉').toBe(false)
  })

  it('并发清理同一目录：重复删不抛错（finally 与启动清扫可能都碰它）', async () => {
    root = testStage('stress-cleanup2-')
    const stage = makeStage(root, 'rt')
    writeFileSync(join(stage, 'a'), '1', 'utf8')
    /* 同时发起多次删除 —— 用户取消的同时软件可能正在启动清扫 */
    await Promise.all([
      removeDirAsync(stage),
      removeDirAsync(stage),
      removeDirAsync(stage)
    ])
    expect(existsSync(stage)).toBe(false)
  })

  it('清理不影响同目录下的其它任务（并发安装不能互删暂存）', async () => {
    root = testStage('stress-cleanup3-')
    const mine = makeStage(root, 'py')
    const other = makeStage(root, 'rt')
    writeFileSync(join(mine, 'x'), '1', 'utf8')
    writeFileSync(join(other, 'y'), '2', 'utf8')

    await removeDirAsync(mine)
    expect(existsSync(mine), '自己的被删').toBe(false)
    expect(existsSync(other), '别人的必须留着（并发安装互不干扰）').toBe(true)
  })
})
