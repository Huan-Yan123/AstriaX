/*
 * ★★ 安装/导入的**互锁**与**取消**（主人 2026-09-27 的两个要求）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## ① 互锁
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 原话：「安装和导入没有互锁正在进行的同版本」
 *
 * 日志证据（主人给的诊断包）：
 *     [11:42:13] runtimes:importFile 耗时 201619ms   ← 导入跑了 201 秒
 *     [11:43:31] runtime:install :: n:v4.18.28        ← 导入没完，安装又开了
 *     阻塞现场：正在执行：instance:update、runtimes:importFile
 *
 * 根因：锁（`pendingInstalls`）**只有 runtime:install 在用**，
 * 导入完全没参与 —— 两个流程同时写同一个目录。
 *
 * 修法：两者**共用同一个键空间**（`<type>:<tag>`）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## ② 取消
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 原话：「安装/下载一个加入取消，防止卡住了只能重启软件来换更快的
 *        安装/下载源」
 *
 * 修法：`running-tasks` 里每个任务带一个 AbortController，
 * 取消时 abort → 下载的 fetch 与 pip 子进程**一起**被中断。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  beginTask,
  endTask,
  findTask,
  cancelTask,
  taskKey,
  listTasks
} from '../../src/main/update/running-tasks'

/** 每个用例用不同的键，避免互相污染（这是模块级表） */
let n = 0
const freshKey = (): string => taskKey('a', `v9.9.${n++}`)

describe('★★互锁：同一个版本只能有一个任务', () => {
  it('★★同键第二个任务被拒（这就是"互锁"本身）', () => {
    const key = freshKey()
    const c1 = new AbortController()
    const t1 = beginTask({ key, kind: 'install', controller: c1, label: 'x' })
    expect(t1, '第一个应当成功').not.toBeNull()

    const t2 = beginTask({ key, kind: 'import', controller: new AbortController(), label: 'y' })
    expect(
      t2,
      '★同键的第二个任务必须被拒 —— 不管是"安装"还是"导入"\n' +
        '（两个流程同时写同一个目录会互相破坏，主人实测遇到过）'
    ).toBeNull()

    endTask(key, c1)
  })

  it('★★安装 + 导入**共用同一把锁**（跨 kind）', () => {
    const key = freshKey()
    const c = new AbortController()
    /* 先占住（装作是"安装"） */
    beginTask({ key, kind: 'install', controller: c, label: '装' })

    /* 这时"导入"也必须被挡住 —— 这才是主人要的互锁 */
    expect(
      beginTask({ key, kind: 'import', controller: new AbortController(), label: '导' }),
      '★导入必须能看见"安装"占的锁（原来两把锁是两个世界）'
    ).toBeNull()

    endTask(key, c)
  })

  it('★不同版本可以并行（粒度是"同版本"，不是全局串行）', () => {
    const k1 = freshKey()
    const k2 = freshKey()
    const c1 = new AbortController()
    const c2 = new AbortController()
    expect(beginTask({ key: k1, kind: 'install', controller: c1, label: 'a' })).not.toBeNull()
    expect(
      beginTask({ key: k2, kind: 'install', controller: c2, label: 'b' }),
      '★装 AstrBot 的同时装 NapCat 是无害的（写不同目录），不该串行'
    ).not.toBeNull()
    endTask(k1, c1)
    endTask(k2, c2)
  })

  it('★释放后能再次登记（否则那个版本永远开不了新任务）', () => {
    const key = freshKey()
    const c1 = new AbortController()
    beginTask({ key, kind: 'install', controller: c1, label: 'x' })
    endTask(key, c1)
    expect(findTask(key), '释放后应当查不到').toBeUndefined()

    const c2 = new AbortController()
    expect(beginTask({ key, kind: 'install', controller: c2, label: 'y' })).not.toBeNull()
    endTask(key, c2)
  })

  it('★★endTask 传错对象（signal 而不是 controller）时**不释放** —— 记录这个陷阱', () => {
    /*
     * 这是我第一次实现时踩的坑，而且**测试当场抓到了**
     *（`pick-source-real.spec.ts` 同一个 tag 的第二条全红）。
     *
     * `endTask` 内部靠 `cur.controller === controller` 判断
     * "这是不是我那一个"，而 `signal` 只是 controller 的一个属性 ——
     * 传它进去，那句比较永远 false → **永远不释放** →
     * 那个版本永远"正在安装中"。
     *
     * 现在 `endTask` 的参数类型写死成 `AbortController`，
     * 传 signal 时 `tsc` 会报错（类型不同）。这条测试记录这个语义。
     */
    const key = freshKey()
    const c = new AbortController()
    beginTask({ key, kind: 'install', controller: c, label: 'x' })

    /* 传"另一个 controller"（模拟传错对象）→ 不该释放 */
    endTask(key, new AbortController())
    expect(
      findTask(key),
      '★传错的 controller 不该释放别人的登记（否则会误删后一个任务的锁）'
    ).toBeDefined()

    /* 传对的才释放 */
    endTask(key, c)
    expect(findTask(key)).toBeUndefined()
  })
})

describe('★★取消：能中断正在跑的任务', () => {
  it('★★cancelTask 会 abort 那个任务的 signal', () => {
    const key = freshKey()
    const c = new AbortController()
    beginTask({ key, kind: 'install', controller: c, label: 'AstrBot v4.28.1' })

    expect(c.signal.aborted, '一开始不该是已取消').toBe(false)
    const r = cancelTask(key)
    expect(r.ok, '取消应当成功').toBe(true)
    expect(
      c.signal.aborted,
      '★abort 之后 signal.aborted 必须为 true —— 下载的 fetch 与 pip 都靠它'
    ).toBe(true)
    expect(r.task?.label, '返回值带上标签，便于记日志').toBe('AstrBot v4.28.1')

    endTask(key, c)
  })

  it('★取消不存在的任务 → ok:false（界面据此解锁按钮）', () => {
    const r = cancelTask(taskKey('a', 'v0.0.0-not-running'))
    expect(r.ok).toBe(false)
  })

  it('★取消是幂等的（连点两次不报错）', () => {
    const key = freshKey()
    const c = new AbortController()
    beginTask({ key, kind: 'import', controller: c, label: 'x' })
    expect(cancelTask(key).ok).toBe(true)
    expect(cancelTask(key).ok, '第二次仍应返回 ok（已经取消了，不是错误）').toBe(true)
    endTask(key, c)
  })

  it('★listTasks 能列出在跑的任务（界面/诊断用）', () => {
    const key = freshKey()
    const c = new AbortController()
    beginTask({ key, kind: 'install', controller: c, label: 'x' })
    expect(listTasks().some((t) => t.key === key)).toBe(true)
    endTask(key, c)
    expect(listTasks().some((t) => t.key === key)).toBe(false)
  })
})
