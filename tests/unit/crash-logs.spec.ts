/*
 * 崩溃诊断（第三层 + 异常退出判据）的单测
 *
 * 主人的问题（指导书 3.1）：软件崩溃闪退，日志里什么都没有、不弹窗，
 * 完全不知道发生了什么。这里验三件事：
 *   1. running.lock：能可靠判断"上次是否异常退出"（进程被杀时唯一证据）
 *   2. WER LocalDumps：注册表**真的写对了**，而且**回读验证过**
 *      （只写不验 = 可能静默失效 —— 项目在 cron @reboot 上吃过这个亏）
 *   3. 幂等：已经配好就不重复写（每次启动都跑 reg.exe 是浪费）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  beginRun,
  checkPreviousRun,
  dumpsDirOf,
  endRun,
  installWerLocalDumps,
  readLastRunReport,
  systemInfoText,
  writeLastRunReport,
  type RunCmd
} from '../../src/main/util/crash-logs'
import { testStage } from '../helpers/stage'

let root: string
const logs: string[] = []
/**
 * 构造 deps。
 *
 * `appVersion` 是运行锁里的**版本戳** —— 用来区分"覆盖更新残留的锁"与
 * "真崩溃"。默认给一个版本，测版本不一致的用例时显式传另一个。
 */
const deps = (o: { v?: string } = {}): { dataRoot: string; appVersion?: string; log: never } =>
  ({
    dataRoot: root,
    appVersion: o.v ?? '0.1.3',
    log: (lv: string, ch: string, msg: string) => {
      logs.push(`${lv}|${ch}|${msg}`)
    }
  }) as never

beforeEach(() => {
  root = testStage('crash-logs-')
  logs.length = 0
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('running.lock：判断上次是否异常退出', () => {
  it('没有锁文件 → 上次是正常退出', () => {
    expect(checkPreviousRun(deps())).toEqual({ crashed: false })
  })

  it('★锁文件还在 → 上次异常退出（进程被杀时唯一的证据）', () => {
    beginRun(deps())
    const r = checkPreviousRun(deps())
    expect(r.crashed, '启动了却没清理锁 = 上次没走完正常退出流程').toBe(true)
    expect(typeof r.startedAt, '要能读出上次启动时刻（用于"活了多久"）').toBe('number')
  })

  it('正常退出清锁 → 下次不再误报崩溃', () => {
    beginRun(deps())
    endRun(deps())
    expect(existsSync(join(root, 'running.lock'))).toBe(false)
    expect(checkPreviousRun(deps()).crashed).toBe(false)
  })

  it('锁文件内容坏了也算异常退出（文件在就是没清理）', () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'running.lock'), 'garbage', 'utf8')
    const r = checkPreviousRun(deps())
    expect(r.crashed).toBe(true)
    expect(r.startedAt).toBeUndefined()
  })

  it('★老格式（纯时间戳）的锁仍按崩溃处理 —— 兼容旧版本留下的锁', () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'running.lock'), String(Date.now()), 'utf8')
    const r = checkPreviousRun(deps())
    expect(r.crashed, '老格式没有版本戳，只能按崩溃处理').toBe(true)
    expect(typeof r.startedAt).toBe('number')
  })

  it('★覆盖更新留下的锁不算崩溃（版本戳不同）', () => {
    /*
     * 四厂商审计抓出的真问题：安装器覆盖更新会把整个数据目录（含
     * running.lock）搬个来回，并用 taskkill /F 结束旧进程 —— will-quit
     * 不跑、锁没删。若按崩溃处理，**每次更新完第一次启动都会误报**
     * 并弹"要导出诊断日志吗"，久了用户就再也不看这个提示了。
     *
     * 判据：锁里记的版本 ≠ 当前版本 → 是更新，不是崩溃。
     */
    const old = deps({ v: '0.1.2' })
    beginRun(old)
    const r = checkPreviousRun(deps({ v: '0.1.3' }))
    expect(r.crashed, '版本不同 = 覆盖更新，不该当崩溃').toBe(false)
    expect(r.updated, '要能区分"更新"与"崩溃"').toBe(true)
    expect(typeof r.startedAt, '仍然能读出上次启动时刻').toBe('number')
  })

  it('同版本留下的锁仍然算崩溃（别把真崩溃当成更新放过）', () => {
    const d = deps({ v: '0.1.3' })
    beginRun(d)
    const r = checkPreviousRun(d)
    expect(r.crashed).toBe(true)
    expect(r.updated).toBeUndefined()
  })
})

describe('last-run.json：启动时判一次、导出时读结论', () => {
  it('★导出诊断包不能现场读锁（否则永远误报"异常退出"）', () => {
    /*
     * 第一版 logger 在导出时直接调 checkPreviousRun —— 而导出发生在
     * **运行期间**，running.lock 正在（本次启动写的，退出才删），
     * 于是结论 100% 是"上次异常退出"，连"上次启动时刻"都是本次的。
     *
     * 现在：启动时把结论写进 last-run.json，导出时只读文件。
     * 这条测试钉住"写 → 读"的往返，以及**运行中的锁不会污染结论**。
     */
    const d = deps({ v: '0.1.3' })
    const verdict = checkPreviousRun(d) // 没有锁 → 正常
    writeLastRunReport(d, verdict)
    beginRun(d) // 模拟"本次运行中"：锁存在

    const read = readLastRunReport(root)
    expect(read, '导出时应当能读到启动时写下的结论').toBeTruthy()
    expect(read!.crashed, '运行中的锁不能被算成"上次崩溃"').toBe(false)
  })

  it('崩溃结论会被如实记下（crashed=true + 启动时刻）', () => {
    const d = deps()
    const at = Date.now() - 60_000
    writeLastRunReport(d, { crashed: true, startedAt: at })
    const read = readLastRunReport(root)
    expect(read!.crashed).toBe(true)
    expect(read!.startedAt).toBe(at)
  })

  it('没有结论文件时返回 undefined（导出包里写"未知"，不猜）', () => {
    expect(readLastRunReport(root)).toBeUndefined()
  })
})

describe('WER LocalDumps 注册（必须 HKLM）', () => {
  /** 假 reg.exe：记录调用并按"写入的内容"回答 query */
  function fakeReg(): { run: RunCmd; calls: string[][]; written: Record<string, string> } {
    const calls: string[][] = []
    const written: Record<string, string> = {}
    const run: RunCmd = async (_cmd, args) => {
      calls.push(args)
      if (args[0] === 'add') {
        // args: add <key> /v <name> /t <type> /d <value> /f
        const vIdx = args.indexOf('/v')
        const dIdx = args.indexOf('/d')
        written[args[vIdx + 1]] = args[dIdx + 1]
        return { status: 0, stdout: 'The operation completed successfully.', stderr: '' }
      }
      // query：把写过的东西拼成 reg query 的输出形态
      /*
       * query 的假输出要**按真实写入的值**拼（第一版写死 0x2，
       * 于是把 DumpType 改成 1（迷你）之后回读判据就对不上了）。
       * 假对象要跟着真实格式走，否则测试验的是假世界。
       */
      const body = Object.entries(written)
        .map(([k, v]) => `    ${k}    REG_DWORD    0x${v === '1' ? '1' : '2'}`)
        .join('\n')
      const folder = written.DumpFolder ? `    DumpFolder    REG_EXPAND_SZ    ${written.DumpFolder}\n` : ''
      return { status: written.DumpType ? 0 : 1, stdout: body ? `HKEY...\n${body}\n${folder}` : '', stderr: '' }
    }
    return { run, calls, written }
  }

  /** 仅 Windows 才真的执行（POSIX 上函数直接返回 false，属设计如此） */
  const onWin = process.platform === 'win32'

  it('★键必须落在 HKLM —— HKCU 的 LocalDumps 系统根本不读（假成功陷阱）', async () => {
    if (!onWin) return
    const { run, calls } = fakeReg()
    await installWerLocalDumps({ ...deps(), run })
    /*
     * 我第一版写 HKCU，回读"通过"就打印了"已配置"，
     * 但微软文档明确说 LocalDumps 不支持 HKEY_CURRENT_USER ——
     * 原生崩溃根本不落 dump，而日志宣称配好了。
     * 这条断言把"必须 HKLM"钉死。
     */
    const keys = calls.filter((a) => a[0] === 'add' || a[0] === 'query').map((a) => a[1] ?? '')
    expect(keys.length, '应当有 reg 调用').toBeGreaterThan(0)
    for (const k of keys) {
      expect(k, `WER LocalDumps 的键必须在 HKLM，实际是 ${k}`).toMatch(/^HKLM\\/i)
      expect(k, '不允许写 HKCU（系统不读，只会制造假成功）').not.toMatch(/^HKCU\\/i)
    }
  })

  it('写入 DumpType/DumpCount/DumpFolder 三个值，并回读验证', async () => {
    if (!onWin) return
    const { run, calls, written } = fakeReg()
    const ok = await installWerLocalDumps({ ...deps(), run })
    expect(ok, '回读一致才算成功').toBe(true)

    expect(written.DumpType, '迷你转储（0x1）：完整转储单个能到 GB 级，会把用户磁盘撑爆').toBe('1')
    expect(written.DumpCount, '只留 3 份，反复崩溃时不会堆成灾难').toBe('3')
    expect(written.DumpFolder).toBe(dumpsDirOf(root))

    // 必须有回读动作（只写不验 = 可能静默失效）
    const queries = calls.filter((a) => a[0] === 'query').length
    expect(queries, '写了之后必须 reg query 回读验证').toBeGreaterThan(0)
  })

  it('★已经配好就不重复写（幂等，别每次启动都跑 reg.exe）', async () => {
    if (!onWin) return
    const { run, calls, written } = fakeReg()
    await installWerLocalDumps({ ...deps(), run })
    const addsBefore = calls.filter((a) => a[0] === 'add').length
    // 再跑一次：这次 query 应当命中"已配置"
    written.DumpType = '1'
    written.DumpFolder = dumpsDirOf(root)
    calls.length = 0
    await installWerLocalDumps({ ...deps(), run })
    expect(
      calls.filter((a) => a[0] === 'add').length,
      '已配置还重复写 = 每次启动白跑 reg.exe'
    ).toBe(0)
    expect(addsBefore).toBeGreaterThan(0)
  })

  it('注册失败要**如实报出来**，不静默', async () => {
    if (!onWin) return
    const run: RunCmd = async () => ({ status: 1, stdout: '', stderr: '拒绝访问' })
    const ok = await installWerLocalDumps({ ...deps(), run })
    expect(ok).toBe(false)
    expect(
      logs.some((l) => l.includes('WER') && l.startsWith('WARN')),
      '失败必须留下 WARN 日志（否则"崩溃时没有 dump"永远查不出原因）'
    ).toBe(true)
  })

  it('没注入命令执行器时如实跳过（而不是假装成功）', async () => {
    if (!onWin) return
    const ok = await installWerLocalDumps(deps())
    expect(ok).toBe(false)
    expect(logs.some((l) => l.includes('跳过 WER'))).toBe(true)
  })
})

describe('系统信息（导出诊断包时必带）', () => {
  it('包含版本、平台、数据目录、运行时版本', () => {
    const t = systemInfoText({ dataRoot: root, appVersion: '0.1.3' })
    expect(t).toContain('0.1.3')
    expect(t).toContain(process.platform)
    expect(t).toContain(root)
    expect(t).toContain(`Node: ${process.versions.node}`)
  })
})
