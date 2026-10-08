import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { NAPCAT_DEFAULT_TOKEN } from '../../src/main/constants'
import { scanCredentials, resetCredentials } from '../../src/main/creds/creds'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('acb-cred-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('scanCredentials（实例运行时配置扫描）', () => {
  /*
   * 这一组原来断言 AstrBot 的账密在 `data/config/astrbot_config.json` 的
   * `admin.username` / `admin.password` 下 —— 那是**错的**，测试在给错误行为盖章。
   *
   * 查证方式：解包 astrbot-4.28.0 的 wheel，读它自己的
   * astrbot/cli/commands/cmd_conf.py，那里写得很清楚：
   *   配置路径 = <root>/data/cmd_config.json
   *   字段     = dashboard.username / dashboard.password / dashboard.pbkdf2_password
   * 而且密码是 PBKDF2-HMAC-SHA256(600000 轮) + MD5 双哈希，不是明文。
   *
   * 好消息：AstrBot 的默认密码**就是 astrbot**（DEFAULT_DASHBOARD_PASSWORD）。
   */
  it('AstrBot：从 data/cmd_config.json 的 dashboard.* 读用户名', async () => {
    const dir = join(root, 'instances', 'AstrBot', 'a_x1')
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(
      join(dir, 'data', 'cmd_config.json'),
      JSON.stringify({ dashboard: { username: 'myuser', password: 'deadbeef' } }),
      'utf8'
    )
    const creds = await scanCredentials({ dir, type: 'a' })
    expect(creds.find((c) => c.label === '用户名')?.value).toBe('myuser')
  })

  it('AstrBot：密码是哈希，不能当成明文密码展示给用户', async () => {
    const dir = join(root, 'instances', 'AstrBot', 'a_hash')
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(
      join(dir, 'data', 'cmd_config.json'),
      JSON.stringify({ dashboard: { username: 'u', pbkdf2_password: 'pbkdf2_sha256$600000$ab$cd' } }),
      'utf8'
    )
    const creds = await scanCredentials({ dir, type: 'a' })
    const pw = creds.find((c) => c.label === '密码')
    expect(pw, '有哈希时要给一条说明，而不是沉默').toBeTruthy()
    /*
     * 关键：绝不能把哈希原样显示成「密码」。
     * 用户照着哈希输是登不进去的，那比不显示更让人困惑。
     */
    expect(pw!.value).not.toContain('pbkdf2_sha256')

    /*
     * 断言**意图**而不是某句固定文案。
     *
     * 文案改过两轮：
     *   1. 最初 `toContain('无法查看')`
     *   2. 换成「（只存了哈希，无法反推——请用你改过的密码，或点「重置账密」…）」
     *   3. **现在**（主人 2026-09-27：「这个也是废话」）精简成
     *      「（看不到，点上面的「重置账密」可以重设）」
     *
     * 第 3 轮删掉了：
     *   · "只存了哈希，无法反推" —— **技术细节**，用户不关心哈希是什么
     *   · 教用户"去日志里搜 Initial password" —— 而**我们已经搜过了**，
     *     搜不到才走这条分支，等于让他白跑一趟
     *
     * 所以要钉的意图变成两条，且**不再要求提日志**：
     *   1. 说清"看不到"（看不到 / 无法查看 / 无法反推 —— 任一即可）
     *   2. 给出下一步（重置）
     */
    expect(pw!.value, '要讲清看不到原密码').toMatch(/看不到|无法反推|无法查看|只存了哈希/)
    expect(pw!.value, '要给出下一步怎么办').toMatch(/重置/)

    /*
     * ★ 不该再出现「说明」那一条（主人明确点名它是废话）。
     *
     * 原来有两条：密码 + 说明。说明那句是"教用户去日志里搜 Initial password"——
     * 而我们在**上一分支**已经搜过了（这条分支正是"搜不到"的结果），
     * 再让他去搜一遍是误导。
     */
    const noteRow = creds.find((c) => c.label === '说明')
    expect(
      noteRow,
      '不该再有「说明」条目 —— 它教用户去翻日志，而我们已经翻过了（搜不到才走到这里）'
    ).toBeUndefined()
    expect(
      creds.some((c) => /Initial password/.test(c.value)),
      '不该再让用户去日志里搜 Initial password（那是我们的活，已经做过了）'
    ).toBe(false)
  })

  it('NapCat：onebot 配置里的 token 也能读到（连接机器人用的那个）', async () => {
    const dir = join(root, 'instances', 'NapCat', 'n_x1')
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(
      join(dir, 'config', 'onebot11_abc.json'),
      JSON.stringify({ token: 'nap-token-1', host: '127.0.0.1', port: 3001 }),
      'utf8'
    )
    const creds = await scanCredentials({ dir, type: 'n' })
    const c = creds.find((x) => x.label.includes('OneBot'))
    expect(c, 'onebot11 的 token 要能读到').toBeTruthy()
    expect(c!.value).toBe('nap-token-1')
  })

  it('没有相关文件：NapCat 给一句解释（而不是空数组让用户以为坏了）', async () => {
    await expect(scanCredentials({ dir: join(root, 'nothing'), type: 'a' })).resolves.toEqual([])
    // NapCat 没启动过时 webui.json 还不存在，要说清楚为什么没有
    const n = await scanCredentials({ dir: join(root, 'nothing'), type: 'n' })
    expect(n).toHaveLength(1)
    expect(n[0].value).toContain('还没生成')
  })

  it('JSON 损坏：跳过该文件继续扫描', async () => {
    const dir = join(root, 'a2')
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(join(dir, 'data', 'cmd_config.json'), '{ not json', 'utf8')
    expect(await scanCredentials({ dir, type: 'a' })).toEqual([])
  })
})

describe('重置凭据（固定内容）', () => {
  it('AstrBot：账密都重置为 astrbot，写在 data/cmd_config.json', async () => {
    const dir = join(root, 'ra')
    mkdirSync(join(dir, 'data'), { recursive: true })
    writeFileSync(
      join(dir, 'data', 'cmd_config.json'),
      JSON.stringify({ dashboard: { username: 'old', password: 'old' }, keep: 1 }),
      'utf8'
    )
    const out = resetCredentials({ dir, type: 'a' })
    expect(out).toEqual([
      { label: '用户名', value: 'astrbot' },
      { label: '密码', value: 'astrbot' }
    ])
    const back = JSON.parse(readJson(join(dir, 'data', 'cmd_config.json'))) as {
      dashboard: { username: string; pbkdf2_password: string; password: string }
      keep: number
    }
    expect(back.dashboard.username).toBe('astrbot')
    // 密码是哈希，不是明文（明文存进去 AstrBot 永远验不过）
    expect(back.dashboard.pbkdf2_password).toMatch(/^pbkdf2_sha256\$600000\$/)
    expect(back.dashboard.pbkdf2_password).not.toBe('astrbot')
    expect(back.dashboard.password).toMatch(/^[0-9a-f]{32}$/)
    // 不能碰别的字段
    expect(back.keep, '只该改凭据，别动用户其它配置').toBe(1)
  })

  it('AstrBot：文件不存在 → 写出全新配置并返回固定凭据', async () => {
    const dir = join(root, 'ra2')
    const out = resetCredentials({ dir, type: 'a' })
    expect(out.map((c) => c.value)).toEqual(['astrbot', 'astrbot'])
    expect(existsSync(join(dir, 'data', 'cmd_config.json'))).toBe(true)
    // .astrbot 标记：AstrBot 靠它认定 root，缺了 CLI 会拒绝工作
    expect(existsSync(join(dir, '.astrbot')), 'AstrBot 需要 .astrbot 标记').toBe(true)
  })

  it('NapCat：onebot11 token 重置为内置默认值，其它字段保留', async () => {
    // 详细行为（保留 port/host、不乱造 webui.json）在 napcat-creds.spec.ts 里覆盖，
    // 这里只确认默认值是对的、并且走的是同一个常量。
    const dir = join(root, 'rn')
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'onebot11_x.json'), JSON.stringify({ token: 'old', port: 3000 }), 'utf8')
    const out = resetCredentials({ dir, type: 'n' })
    expect(out).toEqual([{ label: 'WebUI Token', value: NAPCAT_DEFAULT_TOKEN }])
    const back = JSON.parse(readJson(join(dir, 'config', 'onebot11_x.json'))) as {
      token: string
      port: number
    }
    expect(back.token).toBe(NAPCAT_DEFAULT_TOKEN)
    expect(back.port).toBe(3000)
  })
})

function readJson(p: string): string {
  // 故意独立小工具，避免直接 import fs read
  return require0(p)
}
function require0(p: string): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs') as { readFileSync: (p: string, e: string) => string }
  return fs.readFileSync(p, 'utf8')
}
