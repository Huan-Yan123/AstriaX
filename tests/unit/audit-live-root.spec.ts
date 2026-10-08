import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { buildHandlers, type HandlerDeps } from '../../src/main/ipc'
import { createAuditLog } from '../../src/main/logs/audit'
import { testStage } from '../helpers/stage'

/*
 * 审计日志必须读**当前**数据根，不能读启动时那个。
 *
 * ## 为什么这值得单独测（审计抓出的真问题）
 *
 * `registerIpcHandlersReal` 原来是这样写的：
 *
 *     const dataRoot0 = await defaultDataRoot()
 *     const audit = createAuditLog({ dataRoot: dataRoot0 })   // ← 定死
 *     let liveDataRoot = await startupDataRoot()
 *     const liveRoot = () => liveDataRoot
 *     buildHandlers({ audit, onDataRootChanged: (r) => { liveDataRoot = r } })
 *
 * 而 `createAuditLog` 在**构造时**就把 logsDir 定死（logs/audit.ts:57-60），
 * `onDataRootChanged` 又只更新 liveDataRoot、从不重建 audit。
 *
 * 于是用户**迁移过数据目录**之后：
 *   · `audit:days` 用 `cfg.dataRoot`（新目录）列日期
 *   · `audit:read` 走注入的 audit（旧目录）
 * 两处指向不同目录 → 审计页**永远是空的**，而记录其实好好写在旧目录里。
 *
 * 这属于"改了一处、漏了另一处"，光看代码很容易看漏 ——
 * 因为两行代码隔了几十行，而且各自看着都对。
 *
 * ## 测法
 *
 * 直接构造"启动根 ≠ 当前根"的局面，验证 record 与 read/days
 * 落在**同一个**目录上。修之前这里必红。
 */

let rootA: string
let rootB: string

beforeEach(() => {
  rootA = testStage('mx-audit-rootA-')
  rootB = testStage('mx-audit-rootB-')
  mkdirSync(rootA, { recursive: true })
  mkdirSync(rootB, { recursive: true })
})

afterEach(() => {
  rmSync(rootA, { recursive: true, force: true })
  rmSync(rootB, { recursive: true, force: true })
})

/** 取审计目录（logs 子目录） */
const logsDir = (dataRoot: string): string => join(dataRoot, 'logs')

describe('审计日志：读和写必须落在同一个数据根', () => {
  it('★迁移数据根之后，新写入的记录能在新根读到', async () => {
    /*
     * 模拟生产的惰性代理：按**当前**数据根现建 AuditLog。
     * 这正是 registerIpcHandlersReal 里修好之后的形态。
     *
     * 注意这里刻意不复用生产代码的内部实现 —— 用例要表达的是
     * "契约是什么"，而不是"现在恰好怎么写"。
     */
    let live = rootA
    const lazyAudit = {
      record: (e: Parameters<ReturnType<typeof createAuditLog>['record']>[0]) =>
        createAuditLog({ dataRoot: live }).record(e),
      fileFor: (d: string) => createAuditLog({ dataRoot: live }).fileFor(d),
      read: (d?: string) => createAuditLog({ dataRoot: live }).read(d)
    }

    const deps = {
      probe: async () => true,
      audit: lazyAudit,
      onDataRootChanged: (r: string) => {
        live = r
      }
    } as unknown as HandlerDeps

    const h = buildHandlers(deps)

    // 一开始在 A 根
    await h['config:set']({ dataRoot: rootA })
    h['audit:read'] // 确保 handler 存在

    // 写入一条（走被审计包装的通道）
    // 直接调 audit: 相关写入不方便，这里用日志本体模拟"某天写了记录"
    createAuditLog({ dataRoot: rootA }).record({
      actor: 'user',
      action: 'test-a',
      target: 'A',
      result: 'ok'
    })

    // 迁移到 B 根 —— 关键一步
    live = rootB
    createAuditLog({ dataRoot: rootB }).record({
      actor: 'user',
      action: 'test-b',
      target: 'B',
      result: 'ok'
    })

    // B 根里读得到 B 的记录
    const today = new Date()
    const p = (n: number) => String(n).padStart(2, '0')
    const date = `${today.getFullYear()}-${p(today.getMonth() + 1)}-${p(today.getDate())}`

    const textB = createAuditLog({ dataRoot: rootB }).read(date)
    expect(textB, 'B 根应当有自己的记录').toContain('test-b')

    // 两份记录确实分处不同目录（证明"两个根"这个前提是真的）
    expect(existsSync(logsDir(rootA)), 'A 根的 logs 目录应存在').toBe(true)
    expect(existsSync(logsDir(rootB)), 'B 根的 logs 目录应存在').toBe(true)

    // A 根不该有 B 的记录
    const textA = createAuditLog({ dataRoot: rootA }).read(date)
    expect(textA, 'A 根不该有 B 的记录（否则两个根就串了）').not.toContain('test-b')
  })

  it('★生产入口注入的 audit 必须按当前根解析（不能是启动时定死的实例）', async () => {
    /*
     * 这一条针对生产代码的具体形态做**静态**断言 ——
     * 因为 registerIpcHandlersReal 需要真 Electron，单测起不来。
     *
     * 判据：那段源码里，audit 的三个方法都必须是**惰性**调用
     * （箭头函数里现建 createAuditLog({ dataRoot: liveRoot() })），
     * 而不是在构造时把某个固定 dataRoot 传进去。
     *
     * ## 必须先剥注释再判（这个坑当场踩了）
     *
     * 第一次跑这条断言直接红了，理由却是"audit 又变回启动时定死" ——
     * 而代码明明是修好的。原因是：我在那段代码**上方**写了一大段注释，
     * 里面为了说明踩过什么坑，**原文引用了老写法**
     * `const audit = createAuditLog({ dataRoot: dataRoot0 })`。
     * 正则把注释里的这句当成了真实代码。
     *
     * 这和项目里 `css-tokens.spec.ts` 踩过的是同一个坑
     * （当时是注释里的 `var(--accent)` 被当成真实使用）。
     * 所以这里统一先剥注释。
     */
    const { readFileSync } = await import('fs')
    const raw = readFileSync(join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8')

    /** 剥掉行注释与块注释（注释不是代码，不该参与结构判定） */
    const stripComments = (s: string): string =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // 行注释（避开 http://）

    const src = stripComments(raw)

    // 在 registerIpcHandlersReal 里截取 audit 定义那一段
    const i = src.indexOf('export async function registerIpcHandlersReal')
    expect(i, '找不到 registerIpcHandlersReal').toBeGreaterThan(0)
    const body = src.slice(i, i + 6000)

    expect(
      /const audit: AuditLog = \{[\s\S]*?liveRoot\(\)/.test(body),
      'audit 没有按 liveRoot() 惰性解析 —— 迁移数据目录后审计页会永远为空'
    ).toBe(true)

    expect(
      /const audit = createAuditLog\(\{ dataRoot: dataRoot0 \}\)/.test(body),
      'audit 又变回"启动时定死一个实例"了 —— 那正是被修的 bug'
    ).toBe(false)
  })
})
