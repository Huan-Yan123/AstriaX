import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { createAuditLog } from '../../src/main/logs/audit'
import { testStage } from '../helpers/stage'

/*
 * 审计日志的日期参数必须收敛成"一个日期"，不能变成路径。
 *
 * ## 为什么这值得测
 *
 * `createAuditLog().read(date)` 内部是
 *     const f = join(logsDir, `audit-${date}.log`)
 *     return readFileSync(f, 'utf8')
 *
 * `date` 直接来自渲染层（IPC `audit:read`）。传
 *     date = "..\\..\\..\\..\\Windows\\win.ini"`
 * 就会拼出 logs 目录**之外**的路径，把任意文件内容读回给界面。
 *
 * 单看"只是读"好像不严重，但：
 *   1. 这是**管理员权限**进程（NapCat 注入 QQ 要提权）；
 *   2. 读回来的内容会显示在界面上，等于给了一个任意文件读取原语；
 *   3. 更隐蔽的一层：`fileFor(date)` 是导出的，写路径也用它 ——
 *      如果 `record()` 哪天接受外部日期，同一处缺陷就变成**任意写**。
 *
 * ## 修法
 *
 * 日期只可能是 `YYYY-MM-DD`。直接在入口按这个形状校验，
 * 不符合就当"那天没有审计"返回空串（读接口，不抛错更好用）。
 * 注意**不能**只靠 `listAuditDays` 的过滤 —— 那是列目录时的过滤，
 * 挡不住直接调 read("..\..") 的调用方。
 */

let root: string

beforeEach(() => {
  root = testStage('mx-audit-path-')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('审计日志：日期参数不能被当成路径', () => {
  it('正常日期能读回自己写的记录', () => {
    const a = createAuditLog({ dataRoot: root })
    const today = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    const date = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`
    a.record({ actor: 'user', action: 'test:ok', ok: true })
    expect(a.read(date)).toContain('test:ok')
  })

  it('read 传 .. 逃逸路径时读不到仓库外的文件（返回空）', () => {
    const a = createAuditLog({ dataRoot: root })

    // 造一个"仓库外的机密文件"
    const secret = join(root, '..', `secret-${Date.now().toString(36)}.txt`)
    writeFileSync(secret, 'TOP-SECRET-MUST-NOT-LEAK', 'utf8')
    const secretBase = secret.split(/[\\/]/).pop() as string
    const secretNoExt = secretBase.replace(/\.txt$/, '')

    try {
      // 让 join(logsDir, `audit-${date}.log`) 指到 secret
      // logsDir = <root>\logs → 需要往上两级到 <root>\..，
      // 再把文件名凑成 secret 的名字
      const evil = join('..', '..', secretNoExt.replace(/^secret-/, 'secret-'))
      const out = a.read(evil)
      expect(out).not.toContain('TOP-SECRET')
      expect(out).toBe('')
    } finally {
      rmSync(secret, { force: true })
    }
  })

  it('read 传绝对路径时返回空（不能读任意文件）', () => {
    const a = createAuditLog({ dataRoot: root })
    // win.ini 一定存在，用它当探针
    const out = a.read('C:\\Windows\\win.ini')
    expect(out).toBe('')
  })

  it('read 传带分隔符的日期返回空', () => {
    const a = createAuditLog({ dataRoot: root })
    for (const bad of ['../x', '..\\x', 'a/b', 'a\\b', '', '   ', 'x:y']) {
      expect(a.read(bad)).toBe('')
    }
  })

  it('read 接受不存在的正常日期（返回空串，不抛错）', () => {
    const a = createAuditLog({ dataRoot: root })
    expect(a.read('1999-01-01')).toBe('')
  })

  it('read 不传参数时仍返回今天（默认行为不能坏）', () => {
    const a = createAuditLog({ dataRoot: root })
    a.record({ actor: 'user', action: 'default-day', ok: true })
    expect(a.read()).toContain('default-day')
  })

  it('fileFor 对非法日期也拒绝（写路径共用它，必须一起挡）', () => {
    const a = createAuditLog({ dataRoot: root })
    expect(() => a.fileFor('..\\..\\evil')).toThrow()
  })

  it('fileFor 对合法日期给出 logs 下的正常路径', () => {
    const a = createAuditLog({ dataRoot: root })
    const f = a.fileFor('2026-01-02')
    expect(f).toBe(join(root, 'logs', 'audit-2026-01-02.log'))
  })
})
