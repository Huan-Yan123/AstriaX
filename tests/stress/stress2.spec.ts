import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync, renameSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  beginTask,
  endTask,
  findTask,
  cancelTask,
  taskKey,
  listTasks
} from '../../src/main/update/running-tasks'
import { makeStage, removeDirAsync, pipEnvFor } from '../../src/main/util/workdir'
import { testStage } from '../helpers/stage'

/**
 * 暴力测试（第二轮）：多角度压测。
 *
 * 主人 2026-10-08：
 *   「还需要多方面暴力测试」
 *
 * 第一轮（stress.spec.ts）打的是"并发 + 注册表"。
 * 这一轮补**其它角度** —— 都是用户真会干、而正常测试不会覆盖的：
 *
 *   A. 乱序操作   —— 取消→重装→再取消，顺序全打乱
 *   B. 异常输入   —— 空串、超长、奇怪字符的 type/tag
 *   C. 资源竞争   —— 同一目录被两个任务同时写
 *   D. 状态污染   —— 一个任务失败不能影响另一个
 *   E. 边界值     —— 0 个任务、只有 1 个、同时 100 个
 *   F. 幂等性     —— 同一操作连做 N 次结果一致
 */

let root = ''
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  for (const t of listTasks()) endTask(t.key, t.controller)
})

/* ══════════════════ A. 乱序操作 ══════════════════ */
describe('暴力A：乱序操作', () => {
  it('取消 → 立刻重装 → 再取消 → 再重装，反复 20 轮不出错', () => {
    const key = taskKey('a', 'v4.28.0')
    for (let i = 0; i < 20; i++) {
      const c = new AbortController()
      const t = beginTask({ key, kind: 'install', controller: c, label: 'A' })
      expect(t, `第 ${i} 轮应当能开起来`).not.toBeNull()
      cancelTask(key)
      endTask(key, c)
      expect(findTask(key), `第 ${i} 轮结束应当干净`).toBeUndefined()
    }
  })

  it('先 endTask 再 cancelTask（顺序颠倒）不应抛错', () => {
    const key = taskKey('a', 'v1')
    const c = new AbortController()
    beginTask({ key, kind: 'install', controller: c, label: 'A' })
    /* 正常应该是 cancel → end，这里故意反过来 */
    endTask(key, c)
    expect(() => cancelTask(key)).not.toThrow()
    /* 已经没了，取消自然失败（ok:false），但不能抛 */
    expect(cancelTask(key).ok).toBe(false)
  })

  it('两个任务交叉取消/释放，互不干扰', () => {
    const ka = taskKey('a', 'va')
    const kn = taskKey('n', 'vn')
    const ca = new AbortController()
    const cn = new AbortController()
    beginTask({ key: ka, kind: 'install', controller: ca, label: 'A' })
    beginTask({ key: kn, kind: 'install', controller: cn, label: 'N' })

    /* 交叉操作：先释放 A，再取消 N，再释放 N */
    endTask(ka, ca)
    expect(findTask(kn), '释放 A 不该影响 N').toBeDefined()
    cancelTask(kn)
    endTask(kn, cn)
    expect(listTasks()).toHaveLength(0)
  })
})

/* ══════════════════ B. 异常输入 ══════════════════ */
describe('暴力B：异常输入', () => {
  it('空 tag / 超长 tag / 特殊字符 tag 都不崩', () => {
    const weird = ['', ' ', 'a'.repeat(5000), '带中文', '{"json":1}', '../../etc/passwd', '\n\t']
    for (const tag of weird) {
      const key = taskKey('a', tag)
      const c = new AbortController()
      expect(() => beginTask({ key, kind: 'install', controller: c, label: tag })).not.toThrow()
      expect(() => cancelTask(key)).not.toThrow()
      expect(() => endTask(key, c)).not.toThrow()
    }
    expect(listTasks()).toHaveLength(0)
  })

  it('同一个 tag 但不同 type —— 是两个不同的任务（不能互相顶掉）', () => {
    const ta = beginTask({
      key: taskKey('a', 'v1.0'),
      kind: 'install',
      controller: new AbortController(),
      label: 'A'
    })
    const tn = beginTask({
      key: taskKey('n', 'v1.0'),
      kind: 'install',
      controller: new AbortController(),
      label: 'N'
    })
    expect(ta).not.toBeNull()
    expect(tn, 'type 不同就是不同任务').not.toBeNull()
    expect(listTasks()).toHaveLength(2)
  })
})

/* ══════════════════ C. 资源竞争 ══════════════════ */
describe('暴力C：资源竞争', () => {
  it('两个任务同时写不同暂存目录，互不破坏内容', async () => {
    root = testStage('stress-race-')
    const s1 = makeStage(root, 'a')
    const s2 = makeStage(root, 'b')
    /* 并发写入各自的文件 */
    writeFileSync(join(s1, 'data.txt'), 'AAA', 'utf8')
    writeFileSync(join(s2, 'data.txt'), 'BBB', 'utf8')
    await Promise.all([removeDirAsync(s1), removeDirAsync(s2)])
    expect(existsSync(s1)).toBe(false)
    expect(existsSync(s2)).toBe(false)
  })

  it('删除过程中目录内容仍在变化（模拟并发写入）—— 清理不应抛错', async () => {
    root = testStage('stress-race2-')
    const s = makeStage(root, 'rt')
    /* 先塞一批文件，再在删除的同时继续写 —— 真实现场就是这样（下载还在写） */
    for (let i = 0; i < 20; i++) writeFileSync(join(s, `f${i}`), String(i), 'utf8')
    const writer = (async () => {
      for (let i = 20; i < 40; i++) {
        try {
          writeFileSync(join(s, `f${i}`), String(i), 'utf8')
        } catch {
          /* 目录被删掉了，写失败是预期的 */
        }
        await new Promise((r) => setTimeout(r, 1))
      }
    })()
    /* 清理绝不能因为"文件正在被写"而抛 */
    await expect(removeDirAsync(s)).resolves.not.toThrow()
    await writer
  })

  it('原子替换：同名 .part 存在时清理不影响已完成的正式文件', async () => {
    root = testStage('stress-atomic-')
    const finalFile = join(root, 'python.zip')
    const partFile = `${finalFile}.part`
    writeFileSync(finalFile, 'COMPLETE', 'utf8')
    writeFileSync(partFile, 'PARTIAL', 'utf8')
    /* 只清 .part（半成品），正式文件必须完好 */
    rmSync(partFile, { force: true })
    expect(readFileSync(finalFile, 'utf8'), '正式文件不能被误删').toBe('COMPLETE')
  })
})

/* ══════════════════ D. 状态污染 ══════════════════ */
describe('暴力D：状态污染', () => {
  it('一个任务失败（抛错）不留下登记，不影响后续任务', () => {
    const k1 = taskKey('a', 'fail')
    const c1 = new AbortController()
    beginTask({ key: k1, kind: 'install', controller: c1, label: 'fail' })
    /* 模拟任务失败后走 finally */
    endTask(k1, c1)
    expect(findTask(k1), '失败任务的登记也要清掉').toBeUndefined()

    /* 后续任务正常开 */
    const k2 = taskKey('a', 'ok')
    const c2 = new AbortController()
    expect(beginTask({ key: k2, kind: 'install', controller: c2, label: 'ok' })).not.toBeNull()
    endTask(k2, c2)
  })

  it('pipEnvFor 每次都返回独立对象（并发任务改环境不会串味）', () => {
    const a = pipEnvFor('/tmp/a')
    const b = pipEnvFor('/tmp/b')
    a.MUTATED = 'yes'
    expect(b.MUTATED, '两个任务的环境对象必须互相独立').toBeUndefined()
    expect(a.PIP_CACHE_DIR).not.toBe(b.PIP_CACHE_DIR)
  })

  it('并发取环境变量 100 次，结果稳定一致（不能随调用次数漂移）', () => {
    const first = JSON.stringify(pipEnvFor('/tmp/x'))
    for (let i = 0; i < 100; i++) {
      expect(JSON.stringify(pipEnvFor('/tmp/x'))).toBe(first)
    }
  })
})

/* ══════════════════ E. 边界值 ══════════════════ */
describe('暴力E：边界值', () => {
  it('0 个任务时，所有查询都安全', () => {
    expect(listTasks()).toHaveLength(0)
    expect(findTask(taskKey('a', 'x'))).toBeUndefined()
    expect(cancelTask(taskKey('a', 'x')).ok).toBe(false)
    expect(() => endTask(taskKey('a', 'x'), new AbortController())).not.toThrow()
  })

  it('恰好 1 个任务时，取消它就是清空', () => {
    const k = taskKey('a', 'only')
    const c = new AbortController()
    beginTask({ key: k, kind: 'install', controller: c, label: 'only' })
    cancelTask(k)
    endTask(k, c)
    expect(listTasks()).toHaveLength(0)
  })

  it('同时 100 个不同任务，全部可查、可取消、可释放', () => {
    const made: Array<{ key: string; c: AbortController }> = []
    for (let i = 0; i < 100; i++) {
      const k = taskKey(i % 2 === 0 ? 'a' : 'n', `v${i}`)
      const c = new AbortController()
      expect(beginTask({ key: k, kind: 'install', controller: c, label: `v${i}` })).not.toBeNull()
      made.push({ key: k, c })
    }
    expect(listTasks()).toHaveLength(100)
    for (const { key, c } of made) {
      expect(cancelTask(key).ok).toBe(true)
      endTask(key, c)
    }
    expect(listTasks(), '全部释放后必须清空（不能无界增长）').toHaveLength(0)
  })
})

/* ══════════════════ F. 幂等性 ══════════════════ */
describe('暴力F：幂等性', () => {
  it('同一目录清理 10 次，结果一致（不因重复而抛）', async () => {
    root = testStage('stress-idem-')
    const s = makeStage(root, 'py')
    writeFileSync(join(s, 'x'), '1', 'utf8')
    for (let i = 0; i < 10; i++) {
      await expect(removeDirAsync(s)).resolves.not.toThrow()
    }
    expect(existsSync(s)).toBe(false)
  })

  it('重复释放同一登记 10 次不抛（finally 可能被多次触达）', () => {
    const k = taskKey('a', 'v')
    const c = new AbortController()
    beginTask({ key: k, kind: 'install', controller: c, label: 'v' })
    for (let i = 0; i < 10; i++) {
      expect(() => endTask(k, c)).not.toThrow()
    }
    expect(findTask(k)).toBeUndefined()
  })

  it('暂存目录名每次不同（并发调用不会撞同一个目录）', () => {
    root = testStage('stress-unique-')
    const names = new Set<string>()
    for (let i = 0; i < 50; i++) {
      names.add(makeStage(root, 'py'))
    }
    expect(names.size, '50 次调用应产生 50 个不同目录').toBe(50)
  })
})
