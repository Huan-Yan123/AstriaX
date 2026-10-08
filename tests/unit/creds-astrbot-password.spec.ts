/*
 * @vitest-environment node
 *
 * ★ 必须用 node 环境（不是全局默认的 happy-dom）——踩过的坑：
 *
 * `astrobotPasswordFromLog` 用**回调版 pbkdf2**（因为 60 万轮同步会冻主进程
 * 256ms）。而 happy-dom 环境下 `crypto.pbkdf2` 的回调**永远不触发**：
 * 实测 `[DBG3]` 打印了（candidates 有值），但循环体内的 `[DBG4]` 一次都没出现 ——
 * 函数卡在 await 上，既不抛错也不返回，整个测试 273ms 后失败。
 *
 * 症状极具误导性：报的是"密码必须是真的能用那个，不能是占位说明"，
 * 看起来像业务逻辑错了，实际是测试环境不支持那个 API。
 * 项目里已有同类先例（真实网络 e2e 也要 @vitest-environment node）。
 */
/*
 * 「看账密」要尽量给出**能用的**密码，而不是一句「加密存储，无法查看」。
 *
 * ## 用户原话
 *
 *   「那个看账密功能，日志里明明有个随机生成的 astrbot 密码，
 *     它却告诉我加密存储无法查看，那我要它干啥」
 *
 * ## 真实机制（读 AstrBot 4.28.0 源码确认）
 *
 * AstrBot 首次运行时自己生成一个 24 位强密码（大小写+数字各至少一位），
 * 把哈希写进 `data/cmd_config.json` 的 `dashboard.pbkdf2_password`，
 * 然后把**明文**在启动日志里打印一次：
 *
 *     ➜  Initial username: astrbot
 *     ➜  Initial password: OJx5hx6Ql9mEdekljXrzxJLb
 *     ➜  Change it after logging in
 *
 * 打完就从内存里抹掉（`_generated_dashboard_password = None`），磁盘只剩哈希。
 *
 * 所以那句明文**是 AstrBot 主动告诉使用者的**，就在用户自己的日志里。
 * 我们把它读出来摆在界面上完全正当，不是破解。
 *
 * ## 但必须校验
 *
 * 光按 `Initial password:` 抓一行是危险的：那行可能是**过期的**。
 * 实测主人机器上就是这种情况 —— 日志里那句 `OJx5hx6Ql9mEdekljXrzxJLb`
 * 和当前 `cmd_config.json` 里的哈希**对不上**（配置在日志之后被重写过）。
 * 若不加校验直接显示，用户照着输会登不进去，比不显示更糟。
 *
 * 所以规则是：拿当前哈希的 salt/iterations 现算一遍，
 * **对上了才显示**；对不上就退回到「说实话 + 给下一步」。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { scanCredentials, astrbotHashPassword } from '../../src/main/creds/creds'
import { testStage } from '../helpers/stage'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'

let root: string
let instDir: string
const ID = 'a_deadbeef01'

beforeEach(() => {
  root = testStage('acb-creds-')
  instDir = join(root, 'instances', 'AstrBot', ID)
  mkdirSync(join(instDir, 'data'), { recursive: true })
  mkdirSync(join(root, 'logs', 'instances'), { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** 写一份 AstrBot 配置，返回它用的明文密码 */
function writeCfg(password: string | null, username = 'astrbot'): string {
  const dash: Record<string, unknown> = { username }
  if (password !== null) dash.pbkdf2_password = astrbotHashPassword(password)
  writeFileSync(join(instDir, 'data', 'cmd_config.json'), JSON.stringify({ dashboard: dash }, null, 2), 'utf8')
  return password ?? ''
}

function writeLog(text: string): void {
  writeFileSync(join(root, 'logs', 'instances', `${ID}.log`), text, 'utf8')
}

const scan = (): Array<{ label: string; value: string }> =>
  scanCredentials({ dir: instDir, type: 'a', id: ID, dataRoot: root })

describe('看账密 · AstrBot 初始密码', () => {
  it('★日志里的初始密码和当前哈希对得上 → 要显示真密码', async () => {
    const pwd = writeCfg('Xk9mQ2wLp7Zr4Tn8Bh5Yv3Cd')
    writeLog(
      '[09:32:14][out] Dashboard is bundled with the package\n' +
        '[09:32:16][out]    ➜  Initial username: astrbot\n' +
        `[09:32:16][out]    ➜  Initial password: ${pwd}\n` +
        '[09:32:16][out]    ➜  Change it after logging in\n'
    )
    const got = await scan()
    const pw = got.find((c) => c.label === '密码')
    expect(pw, '没给出密码项').toBeTruthy()
    expect(pw!.value, '密码必须是真的能用那个，不能是占位说明').toBe(pwd)
  })

  it('★日志里的密码是过期的（哈希已变）→ 绝不能显示那个旧密码', async () => {
    // 先用旧密码写日志，再把配置换成新密码 —— 模拟用户改过密码
    const oldPwd = 'OldOldOldOldOldOldOldOl'
    writeCfg('NewNewNewNewNewNewNewNew')
    writeLog(`   ➜  Initial password: ${oldPwd}\n`)

    const got = await scan()
    const pw = got.find((c) => c.label === '密码')
    expect(pw, '应该有一条密码说明').toBeTruthy()
    expect(pw!.value, '显示了一个登不进去的旧密码 —— 比不显示更糟').not.toContain(oldPwd)
    expect(pw!.value, '要让用户知道该怎么办').toMatch(/重置账密/)
  })

  it('★日志里完全没有密码 → 给出**可操作**的一步（不是一堆解释）', async () => {
    writeCfg('SomePassword12345678')
    writeLog('[09:00:00][out] 普通日志，没有密码行\n')
    const got = await scan()
    const pw = got.find((c) => c.label === '密码')
    expect(pw).toBeTruthy()
    /*
     * ★ 文案精简后（主人 2026-09-27：「这个也是废话」），判据也变了：
     *
     * 原文是两条 ——「只存了哈希，无法反推…」+「说明：如果这是第一次运行…」。
     * 后者教用户"去日志里搜 Initial password"，而**我们本来就已经搜过了**
     *（搜不到才走这条分支），等于让他白跑一趟。
     *
     * 现在只要求一句：**告诉他能重置**（那是此刻唯一能做的事）。
     * 不再要求提"日志"，因为提了是误导。
     */
    expect(pw!.value, '要给出一条可操作的路（重置）').toMatch(/重置账密/)
    expect(pw!.value, '不该再教用户去翻日志 —— 我们已经翻过了').not.toMatch(
      /Initial password/
    )
    // 用户名照常要有
    expect(got.find((c) => c.label === '用户名')?.value).toBe('astrbot')
  })

  it('★★重置账密之后，查看时应当显示 astrbot（主人实测的 bug）', async () => {
    /*
     * 主人原话：「我重置密码之后这里应该显示 astrbot」。
     *
     * ## 这是个真 bug，根因清楚
     *
     * 重置（resetAstrBotConfig）把密码设成 `astrbot`（常量），
     * 而**重置不会往实例日志里写任何东西** —— 日志里只有**首次启动**的随机密码。
     *
     * 于是重置后来查看：
     *   日志候选（那个随机密码）对不上新哈希 → 落到"看不到密码"分支
     *   → 用户刚重置完、明明知道是 astrbot，界面却说不知道
     *
     * 修法：把默认密码也当**候选**去验一次 ——
     * 如果当前哈希确实来自"重置"，就一定能验出 astrbot。
     */
    // 日志里放着**旧的随机密码**（首次启动留下的），配置已被重置成 astrbot
    writeCfg('astrbot')
    writeLog(
      '[09:32:14][out] Dashboard is bundled with the package\n' +
        '[09:32:16][out]    ➜  Initial password: OldRandomPassword1234\n'
    )
    const got = await scan()
    const pw = got.find((c) => c.label === '密码')
    expect(pw, '重置后必须有密码项').toBeTruthy()
    expect(
      pw!.value,
      '★重置后的密码就是 astrbot，界面必须显示它 ——\n' +
        '原来会显示"只存了哈希无法反推"（用户刚重置完却被告知不知道密码）。'
    ).toBe('astrbot')
  })

  it('★多次启动的日志：要挑出**能对上**的那一条，而不是盲取最后一条', async () => {
    const good = 'GoodGoodGoodGoodGood12'
    // 日志里先有一条过期密码，后面才是当前有效的
    writeCfg(good)
    writeLog(
      '   ➜  Initial password: StaleStaleStaleStale1\n' +
        '[重启]\n' +
        `   ➜  Initial password: ${good}\n`
    )
    const pw = (await scan()).find((c) => c.label === '密码')
    expect(pw!.value, '应该挑出能校验通过的那条').toBe(good)
  })

  it('★没配置过密码（只有用户名）→ 不该瞎报一条密码', async () => {
    writeCfg(null)
    writeLog('   ➜  Initial password: WhateverWhatever1234\n')
    const got = await scan()
    // 没有哈希就没法校验，绝不能凭日志显示
    expect(got.find((c) => c.label === '密码')).toBeFalsy()
    expect(got.find((c) => c.label === '用户名')?.value).toBe('astrbot')
  })

  it('★日志不存在也不能崩（新实例还没启动过）', async () => {
    writeCfg('NoLogNoLogNoLogNoLog12')
    // 不写日志文件
    expect(() => scan()).not.toThrow()
    const pw = (await scan()).find((c) => c.label === '密码')
    expect(pw!.value).toMatch(/重置账密/)
  })

  it('★大日志（首次密码在开头、后面被顶走）也要能读到', async () => {
    const pwd = 'HeadHeadHeadHeadHead12'
    writeCfg(pwd)
    // 造一个 >768KB 的日志：密码在第一行，后面全是填充
    const filler = 'x'.repeat(1024 * 1024)
    writeLog(`   ➜  Initial password: ${pwd}\n${filler}\n`)
    const pw = (await scan()).find((c) => c.label === '密码')
    expect(pw!.value, '大日志把开头的密码漏掉了').toBe(pwd)
  })
})
