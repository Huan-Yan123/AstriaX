import { readFileSync, rmSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuditLog } from '../../src/main/logs/audit'
import { testStage } from '../helpers/stage'

/**
 * 操作审计日志：**用户和软件做的任何事都留痕**。
 *
 * 为什么要单独一条轨（而不是塞进 app-<date>.log）：
 * app 日志是给「出故障时排查」用的，混杂着进度、重试、探测这些噪声；
 * 而审计要回答的是「**谁在什么时候干了什么**」——  用户点了启动、改了端口、
 * 删了实例，软件自动备份了、重启了、更新了。两者的读者和保留期都不一样。
 *
 * 所以单独写 logs/audit-<日期>.log，格式固定、一行一条、便于 grep 和导出。
 * 界面上用户能看、出问题时也能连同 app 日志一起打包给开发者。
 */
describe('操作审计日志', () => {
  let root = ''
  beforeEach(() => {
    root = testStage('mxbot-audit-')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('记一条操作：谁、做什么、结果', () => {
    const fixed = new Date('2026-09-13T10:20:30')
    const audit = createAuditLog({ dataRoot: root, now: () => fixed })
    audit.record({
      actor: 'user',
      action: 'instance.start',
      target: 'NapCat 实例',
      result: 'ok',
      detail: '端口 6200'
    })
    const f = join(root, 'logs', 'audit-2026-09-13.log')
    expect(existsSync(f)).toBe(true)
    const text = readFileSync(f, 'utf8')
    // 人能读、机器也好解析：时间 + 谁 + 动作 + 对象 + 结果 + 细节
    expect(text).toContain('2026-09-13 10:20:30')
    expect(text).toContain('[用户]')
    expect(text).toContain('instance.start')
    expect(text).toContain('NapCat 实例')
    expect(text).toContain('成功')
    expect(text).toContain('端口 6200')
    // 一条一行
    expect(text.trim().split('\n')).toHaveLength(1)
  })

  it('软件自己的动作也要记（actor=软件），不能只记用户的', () => {
    const audit = createAuditLog({ dataRoot: root, now: () => new Date('2026-09-13T10:00:00') })
    audit.record({ actor: 'system', action: 'backup.auto', target: 'AstrBot 实例', result: 'ok' })
    const text = readFileSync(join(root, 'logs', 'audit-2026-09-13.log'), 'utf8')
    expect(text).toContain('[软件]')
    expect(text).toContain('backup.auto')
  })

  it('失败的操作也要记，并带上原因（这才是最该查的）', () => {
    const audit = createAuditLog({ dataRoot: root, now: () => new Date('2026-09-13T10:00:00') })
    audit.record({
      actor: 'user',
      action: 'instance.start',
      target: '实例1',
      result: 'fail',
      detail: '端口 6101 一直没起来'
    })
    const text = readFileSync(join(root, 'logs', 'audit-2026-09-13.log'), 'utf8')
    expect(text).toContain('失败')
    expect(text).toContain('端口 6101 一直没起来')
  })

  it('按天分文件：跨天写到各自的文件里', () => {
    let day = '2026-09-13T23:59:59'
    const audit = createAuditLog({ dataRoot: root, now: () => new Date(day) })
    audit.record({ actor: 'user', action: 'a', target: 't', result: 'ok' })
    day = '2026-09-14T00:00:01'
    audit.record({ actor: 'user', action: 'b', target: 't', result: 'ok' })
    const files = readdirSync(join(root, 'logs')).sort()
    expect(files).toEqual(['audit-2026-09-13.log', 'audit-2026-09-14.log'])
  })

  it('明细里的换行会被压成一行（保证「一条一行」的约定不被破坏）', () => {
    const audit = createAuditLog({ dataRoot: root, now: () => new Date('2026-09-13T10:00:00') })
    audit.record({
      actor: 'user',
      action: 'instance.start',
      target: '实例',
      result: 'fail',
      detail: '第一行\n第二行\t带制表符'
    })
    const text = readFileSync(join(root, 'logs', 'audit-2026-09-13.log'), 'utf8')
    expect(text.trim().split('\n')).toHaveLength(1)
    expect(text).toContain('第一行 第二行 带制表符')
  })

  it('写盘失败不能把调用方拖崩（审计是旁路，不能影响主流程）', () => {
    const audit = createAuditLog({
      dataRoot: join(root, 'nope'),
      // 故意让目录建不出来：给一个已存在的文件当父目录
      ensureDir: () => {
        throw new Error('boom')
      }
    })
    expect(() =>
      audit.record({ actor: 'user', action: 'x', target: 'y', result: 'ok' })
    ).not.toThrow()
  })
})
