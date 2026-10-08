import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { resetCredentials, scanCredentials, astrbotHashPassword, astrbotHashMd5 } from '../../src/main/creds/creds'
import { ASTRBOT_DEFAULT_PASSWORD, ASTRBOT_DEFAULT_USER } from '../../src/main/constants'
import { testStage } from '../helpers/stage'

/**
 * AstrBot 账密重置必须真的生效。
 *
 * 背景（用户反馈「astrbot 加入重置账密功能」）：原来的实现往
 * `data/config/astrbot_config.json` 写 `{admin:{username,password}}`，
 * 但 **AstrBot 根本不用这个文件存凭据** —— 它读的是
 * `data/cmd_config.json` 的 `dashboard.*`，而且密码是
 * PBKDF2-HMAC-SHA256 + MD5 双哈希（不是明文）。
 * 所以原实现「写进去了、也返回了凭据」，但用户拿那个密码**永远登不进去**。
 *
 * 这些测试盯的就是「写对了地方、写对了格式」。
 */
let root: string

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function makeInstance(): string {
  root = testStage('creds-')
  const dir = join(root, 'inst')
  mkdirSync(join(dir, 'data'), { recursive: true })
  return dir
}

describe('AstrBot 重置账密：写对文件和字段', () => {
  it('写入 data/cmd_config.json（不是 config/astrbot_config.json）', async () => {
    const dir = makeInstance()
    resetCredentials({ dir, type: 'a' })

    expect(
      existsSync(join(dir, 'data', 'cmd_config.json')),
      'AstrBot 读的是 data/cmd_config.json —— 写到别处等于没写'
    ).toBe(true)
    expect(
      existsSync(join(dir, 'data', 'config', 'astrbot_config.json')),
      '不该再写那个 AstrBot 不读的旧路径'
    ).toBe(false)
  })

  it('字段用 dashboard.username / dashboard.pbkdf2_password', async () => {
    const dir = makeInstance()
    resetCredentials({ dir, type: 'a' })
    const cfg = JSON.parse(readFileSync(join(dir, 'data', 'cmd_config.json'), 'utf8'))

    expect(cfg.dashboard.username).toBe(ASTRBOT_DEFAULT_USER)
    expect(cfg.dashboard.username).toBe('astrbot')
    expect(cfg.dashboard.pbkdf2_password, '当前校验用的是 pbkdf2_password').toBeTruthy()
    // 兼容字段：旧版读 dashboard.password（MD5）
    expect(cfg.dashboard.password).toBe(astrbotHashMd5(ASTRBOT_DEFAULT_PASSWORD))
    expect(cfg.dashboard.password_storage_upgraded).toBe(true)
    /*
     * password_change_required 必须是 false —— 否则用户重置完登录进去，
     * 会被 AstrBot 强制跳转到改密页，看起来像「重置没成功」。
     */
    expect(cfg.dashboard.password_change_required).toBe(false)
  })

  it('密码存的是哈希，绝不是明文', async () => {
    const dir = makeInstance()
    resetCredentials({ dir, type: 'a' })
    const cfg = JSON.parse(readFileSync(join(dir, 'data', 'cmd_config.json'), 'utf8'))
    /*
     * 注意：用户名**就是** astrbot（用户要求账密都重置成 astrbot），
     * 所以不能拿「文件里不该出现 astrbot」当判据 —— 那会把用户名也误判成明文密码。
     * 要盯的是密码字段本身：它必须是 pbkdf2 哈希，不能等于明文。
     */
    expect(cfg.dashboard.pbkdf2_password, '密码字段必须是哈希').toMatch(/^pbkdf2_sha256\$/)
    expect(cfg.dashboard.pbkdf2_password).not.toBe(ASTRBOT_DEFAULT_PASSWORD)
    expect(cfg.dashboard.password, 'MD5 兼容字段也必须是 32 位哈希').toMatch(/^[0-9a-f]{32}$/)
    expect(cfg.dashboard.password).not.toBe(ASTRBOT_DEFAULT_PASSWORD)
  })

  it('补上 .astrbot 标记（AstrBot 认定 root 的依据）', async () => {
    const dir = makeInstance()
    resetCredentials({ dir, type: 'a' })
    expect(
      existsSync(join(dir, '.astrbot')),
      '没有 .astrbot 时 AstrBot 会报 not a valid AstrBot root directory'
    ).toBe(true)
  })

  it('已有配置时只改凭据字段，不动别的内容', async () => {
    const dir = makeInstance()
    const f = join(dir, 'data', 'cmd_config.json')
    writeFileSync(
      f,
      JSON.stringify({
        timezone: 'Asia/Shanghai',
        dashboard: { port: 6180, username: 'someone', password: 'oldhash' },
        provider: [{ id: 'x', key: 'secret-key-keep-me' }]
      }),
      'utf8'
    )
    resetCredentials({ dir, type: 'a' })
    const cfg = JSON.parse(readFileSync(f, 'utf8'))
    expect(cfg.timezone, '不该动时区').toBe('Asia/Shanghai')
    expect(cfg.dashboard.port, '不该动端口').toBe(6180)
    expect(cfg.provider[0].key, '不该动用户的模型配置').toBe('secret-key-keep-me')
    expect(cfg.dashboard.username).toBe('astrbot')
  })
})

describe('AstrBot 哈希格式与官方 verify 兼容', () => {
  it('格式是 pbkdf2_sha256$迭代次数$salt$digest 四段', async () => {
    const h = astrbotHashPassword('astrbot')
    const parts = h.split('$')
    expect(parts.length, 'AstrBot 的 verify 会 split("$") 成 4 段，段数不对直接判失败').toBe(4)
    expect(parts[0]).toBe('pbkdf2_sha256')
    expect(parts[1]).toBe('600000')
    expect(parts[2]).toMatch(/^[0-9a-f]{32}$/) // 16 字节 salt → 32 hex
    expect(parts[3]).toMatch(/^[0-9a-f]{64}$/) // sha256 → 64 hex
  })

  it('用自己的算法重算一遍能对上（等价于 AstrBot 的 verify_dashboard_password）', async () => {
    const h = astrbotHashPassword('astrbot')
    const [, iterS, salt, digest] = h.split('$')
    // 复刻 astrbot/core/utils/auth_password.py 的 verify_dashboard_password
    const { pbkdf2Sync } = require('crypto')
    const recalc = pbkdf2Sync('astrbot', Buffer.from(salt, 'hex'), Number(iterS), 32, 'sha256').toString('hex')
    expect(recalc, '哈希必须能用 AstrBot 的规则验证通过').toBe(digest)
  })

  it('同一个密码两次哈希不同（salt 随机）', async () => {
    expect(astrbotHashPassword('astrbot')).not.toBe(astrbotHashPassword('astrbot'))
  })
})

describe('AstrBot 凭据扫描：不能把哈希当密码给用户', () => {
  it('报用户名，密码说明是加密存储', async () => {
    const dir = makeInstance()
    resetCredentials({ dir, type: 'a' })
    const got = await scanCredentials({ dir, type: 'a' })
    expect(got.find((c) => c.label === '用户名')?.value).toBe('astrbot')
    const pw = got.find((c) => c.label === '密码')
    expect(pw, '应给出密码说明条目').toBeTruthy()
    /*
     * 关键：绝不能把 pbkdf2 哈希当成密码显示出来。
     * 用户照着哈希输是登不进去的，那比不显示更糟。
     */
    expect(pw!.value, '不能把哈希当密码展示').not.toMatch(/^pbkdf2_sha256\$/)
    /*
     * 断言**意图**，不钉死文案。
     *
     * 文案改过两轮：
     *   1. 最初 `toContain('无法查看')`
     *   2. 「（只存了哈希，无法反推——请用你改过的密码，或点「重置账密」…）」
     *   3. **现在**（主人 2026-09-27：「这个也是废话」）精简成
     *      「（看不到，点上面的「重置账密」可以重设）」
     *
     * 第 3 轮删掉了"只存了哈希，无法反推"（技术细节）和
     * "去日志里搜 Initial password"（我们已经搜过了，搜不到才走这条分支）。
     * 所以判据变成：说清"看不到" + 给出"重置"这条可操作的路。
     */
    expect(pw!.value, '要讲清看不到原密码').toMatch(/看不到|无法反推|无法查看|只存了哈希/)
    expect(pw!.value, '要给出下一步怎么办').toMatch(/重置/)
  })

  it('没有配置文件时不乱报凭据', async () => {
    const dir = makeInstance()
    expect(await scanCredentials({ dir, type: 'a' })).toEqual([])
  })
})
