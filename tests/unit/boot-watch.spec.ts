/*
 * 启动健康看门狗：软件**起不来时主动介入**（主人 2026-09-26 的要求）。
 *
 * 主人原话：「如果软件无法正常启动或者多次崩溃，日志系统应该主动介入，
 * 收集信息，即使软件无法正常使用，遇到这种无法正常启动/多次崩溃，
 * 也应该主动弹出窗口让用户导出日志」。
 *
 * 随后主人明确了**两个不同的阈值**：
 *   「起不来，一次就弹，起来了但崩溃，三次弹」
 *
 * 为什么区分（本测试钉住的语义）：
 *   · 起不来 = 窗口没建 → 用户**完全没法用**，也没有任何自助入口
 *     （导出按钮在界面里）→ 1 次就介入
 *   · 起来了但崩溃 = 有窗口 → 能重试、能自己导出日志 → 3 次才介入
 *
 * 背景死角：0.1.4 那次"装完启动不了、进程在但界面不出现" ——
 * 窗口根本没建，用户完全无路可走。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import {
  beginBoot,
  markWindowReady,
  markBootOk,
  noteCrash,
  noteBootFailure,
  readBootState,
  shouldAlertBootFailure,
  shouldAlertCrash,
  markBootAlerted,
  markCrashAlerted,
  buildBootFailureMessage,
  BOOT_FAIL_ALERT_THRESHOLD,
  CRASH_ALERT_THRESHOLD
} from '../../src/main/logs/boot-watch'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('bootwatch-')
  mkdirSync(root, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('★阈值：起不来 1 次就弹，连崩 3 次才弹（主人指定）', () => {
  it('★起不来：**第一次**就必须主动介入', () => {
    const st = beginBoot(root)
    expect(st.bootAttempts).toBe(1)
    expect(BOOT_FAIL_ALERT_THRESHOLD, '主人指定：起不来一次就弹').toBe(1)
    expect(
      shouldAlertBootFailure(st),
      '窗口没建 = 用户完全没法用，也没有任何自助入口（导出按钮在界面里），必须立刻介入'
    ).toBe(true)
  })

  it('★连崩：第 1、2 次**不弹**，第 3 次才弹', () => {
    expect(CRASH_ALERT_THRESHOLD, '主人指定：连崩三次才弹').toBe(3)
    const c1 = noteCrash(root, 'x')
    expect(shouldAlertCrash(c1), '崩 1 次不弹 —— 有窗口、能重试').toBe(false)
    const c2 = noteCrash(root, 'x')
    expect(shouldAlertCrash(c2), '崩 2 次不弹').toBe(false)
    const c3 = noteCrash(root, 'x')
    expect(shouldAlertCrash(c3), '崩 3 次必须介入').toBe(true)
  })

  it('★两条线分开计数（建了窗口就不算"起不来"）', () => {
    beginBoot(root)
    beginBoot(root)
    // 窗口建出来了 → 起不来那条线终止
    markWindowReady(root)
    const st = readBootState(root)
    expect(st.bootAttempts, '窗口建出来后连挂计数清零').toBe(0)
    expect(shouldAlertBootFailure(st), '已经能打开界面了，不该再弹"打不开"').toBe(false)
    // 之后是运行期崩溃，走另一条线
    expect(readBootState(root).crashAttempts).toBe(0)
  })
})

describe('★降噪：同一轮连击只弹一次', () => {
  it('起不来：弹过之后不再重复弹', () => {
    beginBoot(root)
    markBootAlerted(root)
    const st = beginBoot(root)
    expect(st.bootAttempts, '次数继续累加').toBe(2)
    expect(shouldAlertBootFailure(st), '这一轮已经提醒过，别再骚扰').toBe(false)
  })

  it('连崩：弹过之后不再重复弹', () => {
    noteCrash(root, 'x')
    noteCrash(root, 'x')
    noteCrash(root, 'x')
    markCrashAlerted(root)
    const st = noteCrash(root, 'x')
    expect(shouldAlertCrash(st)).toBe(false)
  })
})

describe('★成功运行后清零，下次出问题还能再提醒', () => {
  it('markBootOk 把两条线都清零（**稳定运行够久**的前提下）', () => {
    /*
     * 注意这里的 `t0` 与"活够久"的 now —— 因为 markBootOk 现在会看运行时长
     *（见下面那条"活得太短不能清"的用例）。这条测的是"确实稳定"的情形。
     */
    const t0 = new Date('2026-09-26T10:00:00Z')
    beginBoot(root, t0)
    noteCrash(root, 'x', t0)
    noteCrash(root, 'x', t0)
    markBootAlerted(root)
    markBootOk(root, new Date(t0.getTime() + 120_000))
    const st = readBootState(root)
    expect(st.bootAttempts).toBe(0)
    expect(st.crashAttempts).toBe(0)
    expect(st.bootNotified).toBe(false)
    expect(st.crashNotified).toBe(false)
    expect(st.lastOkAt, '要记下"上次正常是什么时候"').toBeTruthy()
  })

  it('★活得太短就退出 → **不能清连崩计数**（复审抓出的真实缺陷）', () => {
    /*
     * ★ 这条守的是"连崩 3 次弹窗"到底会不会触发。
     *
     * 原来 `will-quit` 里**无条件**调 markBootOk 清 crashAttempts。
     * 于是"窗口建出来、还没用就崩"这种场景（托盘/渲染初始化失败很常见）：
     *   每轮崩溃 +1 → 只要有一次正常退出就把计数清 0
     *   → 「连崩 3 次」**永远不触发**，主人指定的功能成了死代码。
     * 复审实测：2 次崩溃 + 1 次正常退出 → crashAttempts = 0。
     *
     * 现在：只有从启动到正常退出**超过 60 秒**才算"稳定运行"。
     */
    const t0 = new Date('2026-09-26T10:00:00Z')
    // 启动 → 崩 → 崩 → 立刻"正常退出"（只活了 5 秒）
    beginBoot(root, t0)
    noteCrash(root, 'boom-1', t0)
    noteCrash(root, 'boom-2', t0)
    const cleared = markBootOk(root, new Date(t0.getTime() + 5_000))
    expect(cleared, '活 5 秒不算稳定，不该清连崩计数').toBe(false)
    const st = readBootState(root)
    expect(st.crashAttempts, '连崩计数必须保留 —— 否则连崩 3 次永远不触发').toBe(2)
    expect(st.bootAttempts, '但"起不来"那条线确实结束了（窗口建出来了）').toBe(0)
  })

  it('★稳定运行超过阈值后，连崩计数才清零', () => {
    const t0 = new Date('2026-09-26T10:00:00Z')
    beginBoot(root, t0)
    noteCrash(root, 'boom-1', t0)
    const cleared = markBootOk(root, new Date(t0.getTime() + 120_000)) // 活了 2 分钟
    expect(cleared, '稳定运行够久才算真的好了').toBe(true)
    const st = readBootState(root)
    expect(st.crashAttempts).toBe(0)
    expect(st.crashNotified, 'notified 也要一起清，下次还能再提醒').toBe(false)
  })

  it('清零后再连崩 3 次，应当能重新介入', () => {
    noteCrash(root, 'x')
    markBootOk(root)
    noteCrash(root, 'x')
    noteCrash(root, 'x')
    const st = noteCrash(root, 'x')
    expect(shouldAlertCrash(st), '新一轮应当能再提醒').toBe(true)
  })
})

describe('原因记录与文案', () => {
  it('★失败原因会被记下来（弹窗里要写出"上次为什么失败"）', () => {
    beginBoot(root)
    noteBootFailure(root, 'TypeError: Cannot read properties of undefined (reading dataRoot)')
    const st = readBootState(root)
    expect(st.lastReason).toContain('dataRoot')
  })

  it('起不来的文案：说次数、说原因、说日志在哪', () => {
    const msg = buildBootFailureMessage({
      state: {
        bootAttempts: 1,
        crashAttempts: 0,
        bootNotified: false,
        crashNotified: false,
        lastReason: '端口被占用',
        lastOkAt: '2026-09-25T10:00:00Z'
      },
      dataRoot: root,
      kind: 'boot'
    })
    expect(msg, '要说清失败了几次').toContain('1')
    expect(msg, '要写出原因').toContain('端口被占用')
    expect(msg, '要说日志在哪').toContain('logs-export')
    expect(msg, '要给出原始日志位置').toContain(join(root, 'logs'))
    expect(msg).toContain('没能正常打开')
  })

  it('连崩的文案：措辞是"崩溃"而不是"打不开"', () => {
    const msg = buildBootFailureMessage({
      state: { bootAttempts: 0, crashAttempts: 3, bootNotified: false, crashNotified: false },
      dataRoot: root,
      kind: 'crash'
    })
    expect(msg).toContain('崩溃了 3 次')
    expect(msg).not.toContain('没能正常打开')
  })

  it('没有原因时文案也要完整（不能出现 undefined）', () => {
    const msg = buildBootFailureMessage({
      state: { bootAttempts: 1, crashAttempts: 0, bootNotified: false, crashNotified: false },
      dataRoot: root
    })
    expect(msg).not.toContain('undefined')
    expect(msg).toContain('logs-export')
  })
})

describe('健壮性', () => {
  it('★状态文件损坏 → 当全新处理，且绝不能抛（它坏了不该拦住启动）', () => {
    writeFileSync(join(root, 'boot-attempts.json'), '{ 这不是 json', 'utf8')
    expect(() => readBootState(root)).not.toThrow()
    const st = readBootState(root)
    expect(st.bootAttempts).toBe(0)
    expect(st.crashAttempts).toBe(0)
    expect(() => beginBoot(root), '损坏也要能继续记').not.toThrow()
  })

  it('★兼容第一版的字段名（attempts/notified/lastFailReason）', () => {
    /*
     * 第一版用的是 attempts / notified / lastFailReason（单条线）。
     * 用户机器上可能已经写出了这种文件 —— 读到它必须能迁移过来，
     * 不能因为改名而把"已经失败过几次"这个信号丢掉。
     */
    writeFileSync(
      join(root, 'boot-attempts.json'),
      JSON.stringify({ attempts: 2, notified: false, lastFailReason: '旧格式的原因' }),
      'utf8'
    )
    const st = readBootState(root)
    expect(st.bootAttempts, '旧 attempts 要迁移到 bootAttempts').toBe(2)
    expect(st.lastReason).toContain('旧格式的原因')
  })

  it('状态文件落在数据根下（用户能找到、也随数据迁移一起走）', () => {
    beginBoot(root)
    const f = join(root, 'boot-attempts.json')
    expect(existsSync(f), '应当写进数据根').toBe(true)
    const raw = JSON.parse(readFileSync(f, 'utf8')) as { bootAttempts: number }
    expect(raw.bootAttempts).toBe(1)
  })
})
