/*
 * 日志的读取与清理。
 *
 * 两件事各自都有一个「用户能直接感觉到」的后果：
 *
 *   1. **读取**：`instance:log` 原来 `readFileSync` 整个文件再切最后 500 行。
 *      实例日志永不轮转，跑几天的实例轻松上百 MB —— 为了 500 行同步读 300MB，
 *      主进程被独占，界面表现为「点一下看日志，整个软件卡住好几秒」。
 *      正确做法（仓库里 creds 模块早就用对了）：大文件只读头+尾。
 *
 *   2. **清理**：日志从不轮转也从不删除，多开挂机跑一个月能攒几个 GB，
 *      而 app-/audit- 是按天分文件的，用户自己都不容易发现该删什么。
 *
 * 这两条都用真实文件验证（不 mock fs）——要验的正是「真的只读了那么多」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readLogSnippet, readLogTail, instanceLogFile } from '../../src/main/logs/read-snippet'
import { pruneOldLogs } from '../../src/main/logs/prune'
import { testStage } from '../helpers/stage'
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync, statSync } from 'fs'
import { join } from 'path'

let root: string

beforeEach(() => {
  root = testStage('acb-log-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('日志读取 · 大文件不许整个读进内存', () => {
  it('★小文件整个读（不截断，内容一字不少）', () => {
    const f = join(root, 'small.log')
    writeFileSync(f, 'aaa\nbbb\nccc\n', 'utf8')
    const r = readLogSnippet(f)
    expect(r.text).toBe('aaa\nbbb\nccc\n')
    expect(r.truncated).toBe(false)
    expect(r.size).toBe(12)
  })

  it('★文件不存在 → 空文本，不抛', () => {
    expect(() => readLogSnippet(join(root, '没有这个.log'))).not.toThrow()
    const r = readLogSnippet(join(root, '没有这个.log'))
    expect(r.text).toBe('')
    expect(r.truncated).toBe(false)
    expect(r.size).toBe(0)
  })

  it('★超大文件只取头+尾，且**头部内容必须在**（首启密码那段）', () => {
    /*
     * 造一个 3MB 的文件：头尾各放一个标记，中间填垃圾。
     * 头部标记代表「首次启动」，比如 AstrBot 的 Initial password。
     * 只读尾部的话这些就丢了 —— 这正是不能用「只读尾」的原因。
     */
    const f = join(root, 'big.log')
    const head = 'HEAD-MARKER-Initial-password-OJx5hx6Ql9mE\n'
    const tail = 'TAIL-MARKER-刚刚发生了什么\n'
    const middle = 'x'.repeat(3 * 1024 * 1024)
    writeFileSync(f, head + middle + tail, 'utf8')

    const r = readLogSnippet(f)
    expect(r.truncated, '3MB 的文件应当被判定为截断').toBe(true)
    expect(r.text.startsWith(head), '头部内容丢了（首启密码就在那里）').toBe(true)
    expect(r.text.endsWith(tail), '尾部内容丢了（最新日志在那里）').toBe(true)
    /*
     * 这是核心断言：读进来的量必须**远小于**文件本身。
     * 头 512KB + 尾 256KB = 768KB，文件 3MB+ → 不该超过 1MB。
     * 修复前这里是整个 3MB。
     */
    expect(r.text.length, '还是把整个文件读进来了').toBeLessThan(1024 * 1024)
  })

  it('★readLogTail 拿到的确实是**真实末尾**那几行', () => {
    const f = join(root, 'seq.log')
    // 用一个够大、但行都在尾段范围内的文件
    const lines = Array.from({ length: 5000 }, (_, i) => `line-${i}`)
    writeFileSync(f, lines.join('\n') + '\n', 'utf8')

    const r = readLogTail(f, 3)
    const got = r.text.trim().split('\n')
    expect(got).toEqual(['line-4997', 'line-4998', 'line-4999'])
  })

  it('★行数少于请求数时全给（不补齐、不报错）', () => {
    const f = join(root, 'few.log')
    writeFileSync(f, 'only-1\nonly-2\n', 'utf8')
    expect(readLogTail(f, 500).text.trim().split('\n')).toEqual(['only-1', 'only-2'])
  })

  it('★实例日志路径只在一处定义（免得各处自己拼错）', () => {
    expect(instanceLogFile('D:\\data', 'a_abc')).toBe(join('D:\\data', 'logs', 'instances', 'a_abc.log'))
  })
})

describe('日志清理 · 旧的删掉，新的和正在写的绝不碰', () => {
  const DAY = 24 * 60 * 60 * 1000

  /** 造一个日志目录；返回 logs 路径 */
  function makeLogs(): string {
    const logs = join(root, 'logs')
    mkdirSync(join(logs, 'instances'), { recursive: true })
    return logs
  }

  function aged(file: string, daysAgo: number): void {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, 'x', 'utf8')
    const t = (Date.now() - daysAgo * DAY) / 1000
    utimesSync(file, t, t)
  }

  it('★超过保留期的 app-日志删掉', () => {
    const logs = makeLogs()
    const old = join(logs, 'app-2020-01-01.log')
    const fresh = join(logs, `app-${new Date().toISOString().slice(0, 10)}.log`)
    writeFileSync(old, 'x', 'utf8')
    writeFileSync(fresh, 'x', 'utf8')

    const r = pruneOldLogs(root, { keepDays: 30 })
    expect(existsSync(old), '2020 年的日志还在').toBe(false)
    expect(existsSync(fresh), '今天的日志被误删了').toBe(true)
    expect(r.removed).toContain(old)
  })

  it('★超过保留期的 audit-日志也删（它同样按天无限累积）', () => {
    const logs = makeLogs()
    const old = join(logs, 'audit-2019-05-05.log')
    writeFileSync(old, 'x', 'utf8')
    pruneOldLogs(root, { keepDays: 30 })
    expect(existsSync(old)).toBe(false)
  })

  it('★保留期内的日志一个都不能动', () => {
    const logs = makeLogs()
    const files = [1, 5, 29].map((d) => {
      const dt = new Date(Date.now() - d * DAY).toISOString().slice(0, 10)
      const f = join(logs, `app-${dt}.log`)
      writeFileSync(f, 'x', 'utf8')
      return f
    })
    const r = pruneOldLogs(root, { keepDays: 30 })
    for (const f of files) expect(existsSync(f), `${f} 被误删`).toBe(true)
    expect(r.removed).toEqual([])
  })

  it('★很久没写过的实例日志删掉（按 mtime，名字里没有日期）', () => {
    const logs = makeLogs()
    const stale = join(logs, 'instances', 'a_dead.log')
    const active = join(logs, 'instances', 'a_live.log')
    aged(stale, 90)
    // 正在跑的实例：mtime 一直是新的
    writeFileSync(active, 'y', 'utf8')

    pruneOldLogs(root, { keepDays: 30 })
    expect(existsSync(stale), '很久没动的实例日志没清掉').toBe(false)
    expect(existsSync(active), '活跃实例的日志被删了 —— 那是正在写的文件').toBe(true)
  })

  it('★正在写的实例日志 mtime 很新 → 永远不会被清（哪怕它很大）', () => {
    const logs = makeLogs()
    const f = join(logs, 'instances', 'a_big.log')
    writeFileSync(f, 'x'.repeat(1024 * 1024), 'utf8')
    // mtime 就是刚才 → 新鲜
    pruneOldLogs(root, { keepDays: 30 })
    expect(existsSync(f)).toBe(true)
    expect(statSync(f).size).toBe(1024 * 1024)
  })

  it('★logs 目录不存在 → 不抛，返回空结果', () => {
    expect(() => pruneOldLogs(join(root, '根本没有这个目录'))).not.toThrow()
    const r = pruneOldLogs(join(root, '根本没有这个目录'))
    expect(r.removed).toEqual([])
    expect(r.failed).toEqual([])
  })

  it('★文件名认不出日期的，按 mtime 判断（改过名的老日志也是垃圾）', () => {
    const logs = makeLogs()
    const weird = join(logs, 'app-备份改过名.log')
    aged(weird, 200)
    pruneOldLogs(root, { keepDays: 30 })
    expect(existsSync(weird), '认不出日期的老日志被漏掉了').toBe(false)
  })

  it('★日期非法的文件名不许误删（保守优先）', () => {
    const logs = makeLogs()
    // 2026-13-45 不是合法日期；但 mtime 是新的 → 不该删
    const bad = join(logs, 'app-2026-13-45.log')
    writeFileSync(bad, 'x', 'utf8')
    pruneOldLogs(root, { keepDays: 30 })
    expect(existsSync(bad)).toBe(true)
  })
})
