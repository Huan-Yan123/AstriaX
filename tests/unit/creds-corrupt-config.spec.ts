/*
 * Bug H：重置账密时**不能把损坏的 cmd_config.json 抹成空配置**
 * ========================================================================
 *
 * ## 坏在哪
 *
 * `resetAstrBotConfig()` 读 `data/cmd_config.json`：
 *
 *     let obj: Record<string, unknown> = {}
 *     if (existsSync(cfgFile)) {
 *       try { obj = readJsonFile(cfgFile) } catch { /* 损坏 → 用空配置重建 *\/ }
 *     }
 *     ...
 *     obj.dashboard.username = ...
 *     writeFileSync(cfgFile, JSON.stringify(obj, null, 2))
 *
 * 那个 catch 里的注释——**「损坏 → 用空配置重建（总比写不进去强）」**——
 * 正是这个 bug 的自我辩护，而它是错的。
 *
 * 因为 `cmd_config.json` **不只是存账密**。它是 AstrBot 的主配置：
 * 用哪个模型服务商、API key、哪些插件启用、人格设定、消息平台适配器…
 * 用户可能花很久才配好。
 *
 * 一旦这个文件损坏（掉电、被别的程序写坏、手工编辑出错），
 * 用户点「重置账密」的动作会把整个文件**替换成只有 dashboard 字段的空壳**：
 *
 *   - 用户的模型配置、插件开关、人格全部消失
 *   - 而界面返回的是"用户名 admin / 密码 xxx"，看起来一切正常
 *   - 用户要等到**下次启动 AstrBot 去聊天**才会发现"配置怎么全没了"
 *
 * 「总比写不进去强」这个理由站不住：写不进去只是重置失败（用户再试一次），
 * 而抹掉配置是**不可逆的数据损失**。宁可失败也不能静默毁数据。
 *
 * ## 正确行为
 *
 * 损坏时：
 *   1. 把坏文件**留证**（改名成 `cmd_config.json.corrupt-<时间>`），
 *      用户/我们能看出发生过什么，也还有机会手工抢救
 *   2. 再写一份只含 dashboard 的新配置（重置仍然成功，功能不瘸）
 *   3. 在返回值/日志里**明确告诉用户"原配置损坏已备份"**，
 *      而不是让他以为一切正常
 *
 * 也就是说：既要保住功能（能重置），又要保住数据（留证 + 告知）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testStage } from '../helpers/stage'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { resetCredentials, scanCredentials } from '../../src/main/creds/creds'

let inst: string
beforeEach(() => {
  inst = testStage('acb-creds-corrupt-')
  mkdirSync(join(inst, 'data'), { recursive: true })
})
afterEach(() => {
  rmSync(inst, { recursive: true, force: true })
})

describe('Bug H：重置账密不能毁掉损坏的配置', () => {
  it('★配置损坏时必须留证，不能静默抹成空配置', async () => {
    const cfg = join(inst, 'data', 'cmd_config.json')
    // 坏文件（截断），但里面其实是用户的重要配置
    const original = '{"dashboard":{"username":"me"},"provider_settings":{"openai":{"api_key":"sk-SECRET"'
    writeFileSync(cfg, original, 'utf8')

    resetCredentials({ dir: inst, type: 'a' })

    /*
     * 留证：坏文件必须被改名保存，内容原封不动。
     *
     * 这样用户还能手工从里面把 api_key 捞出来 —— 那可能是他唯一的副本。
     */
    const quarantined = readdirSync(join(inst, 'data')).filter((n) => n.includes('corrupt'))
    expect(
      quarantined.length,
      '配置损坏时被**静默**当成空配置重建了 —— 用户的模型/插件/人格配置\n' +
        '（含 API key）会全部消失，而界面只会显示"重置成功"，\n' +
        '用户要到下次用 AstrBot 聊天时才发现配置没了。\n' +
        '应该先把坏文件改名留证，再写新配置。'
    ).toBeGreaterThan(0)

    // 留证的内容必须和原来一模一样（否则"抢救"就无从谈起）
    const saved = readFileSync(join(inst, 'data', quarantined[0]), 'utf8')
    expect(saved, '留证的文件内容被改动了').toBe(original)

    // 而重置本身仍然要成功（不能因为文件坏就整个失败）
    const creds = await scanCredentials({ dir: inst, type: 'a' })
    expect(creds.some((c) => c.label === '用户名'), '重置之后应该能读到新的用户名').toBe(true)
    // 新配置里要有 dashboard
    const now = JSON.parse(readFileSync(cfg, 'utf8')) as { dashboard?: { username?: string } }
    expect(now.dashboard?.username).toBeTruthy()
  })

  it('★配置正常时不能留 corrupt 文件（别把好文件也备份了）', async () => {
    const cfg = join(inst, 'data', 'cmd_config.json')
    writeFileSync(
      cfg,
      JSON.stringify({ dashboard: { username: 'old' }, provider_settings: { keep: 'me' } }),
      'utf8'
    )

    resetCredentials({ dir: inst, type: 'a' })

    const quarantined = readdirSync(join(inst, 'data')).filter((n) => n.includes('corrupt'))
    expect(quarantined, '正常配置也被当成损坏备份了').toEqual([])

    // 关键：**其它配置必须原样保留**（这是重置账密不是重置配置）
    const now = JSON.parse(readFileSync(cfg, 'utf8')) as {
      provider_settings?: { keep?: string }
      dashboard?: { username?: string }
    }
    expect(
      now.provider_settings?.keep,
      '重置账密把用户的其它配置弄丢了 —— 它应该只改 dashboard.*'
    ).toBe('me')
    expect(now.dashboard?.username).toBeTruthy()
  })

  it('文件不存在时也能正常建出配置（首次使用）', async () => {
    resetCredentials({ dir: inst, type: 'a' })
    const cfg = join(inst, 'data', 'cmd_config.json')
    expect(existsSync(cfg)).toBe(true)
    expect(existsSync(join(inst, '.astrbot')), 'AstrBot 的 root 标记要建出来').toBe(true)
    const now = JSON.parse(readFileSync(cfg, 'utf8')) as { dashboard?: { username?: string } }
    expect(now.dashboard?.username).toBeTruthy()
  })
})
