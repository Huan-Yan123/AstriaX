import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetCredentials, scanCredentials } from '../../src/main/creds/creds'
import { testStage } from '../helpers/stage'

/**
 * NapCat 的 WebUI 配置不能整个覆盖。
 *
 * 真 bug：resetCredentials 原来无脑 `writeFileSync(webui.json, {token})`，
 * 把 NapCat 自己生成的 port / host / prefix / loginRate 等等**全抹掉了**，
 * 于是 WebUI 要么打不开、要么端口跑回默认 6099。
 * NapCat 其实自己就会读 NAPCAT_WEBUI_SECRET_KEY 把 token 写进配置，
 * 我们只需要保证已有文件里的 token 字段是对的、别破坏其它字段。
 */
describe('NapCat 凭据处理', () => {
  let dir = ''
  beforeEach(() => {
    dir = testStage('mxbot-creds-')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('改 token 时保留 webui.json 里的其它字段（port/host/prefix 不能被抹掉）', async () => {
    const cfg = join(dir, 'config')
    mkdirSync(cfg, { recursive: true })
    // NapCat 真实生成出来的样子
    writeFileSync(
      join(cfg, 'webui.json'),
      JSON.stringify({
        host: '::',
        port: 6200,
        prefix: '',
        token: 'napcat-自己生成的随机值',
        loginRate: 3,
        theme: 'light',
        disableWebUI: false
      }),
      'utf8'
    )

    resetCredentials({ dir, type: 'n' })

    const after = JSON.parse(readFileSync(join(cfg, 'webui.json'), 'utf8')) as Record<string, unknown>
    expect(after.token).toBe('114514')
    // 这几个字段一个都不能少
    expect(after.port).toBe(6200)
    expect(after.host).toBe('::')
    expect(after.prefix).toBe('')
    expect(after.loginRate).toBe(3)
    expect(after.theme).toBe('light')
    expect(after.disableWebUI).toBe(false)
  })

  it('onebot11_*.json 的 token 也会被重置，其它字段保留', async () => {
    const cfg = join(dir, 'config')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(
      join(cfg, 'onebot11_123456.json'),
      JSON.stringify({ network: { httpServers: [{ port: 3000 }] }, token: 'old' }),
      'utf8'
    )

    resetCredentials({ dir, type: 'n' })

    const after = JSON.parse(readFileSync(join(cfg, 'onebot11_123456.json'), 'utf8')) as {
      token: string
      network: { httpServers: Array<{ port: number }> }
    }
    expect(after.token).toBe('114514')
    expect(after.network.httpServers[0].port).toBe(3000)
  })

  it('没有任何配置文件时不凭空造 webui.json（NapCat 启动后会自己写）', async () => {
    // 关键：我们造的 webui.json 会缺 NapCat 需要的字段，反而害了它。
    // 正确做法是留给 NapCat 自己生成，token 由 NAPCAT_WEBUI_SECRET_KEY 环境变量给。
    mkdirSync(join(dir, 'config'), { recursive: true })
    resetCredentials({ dir, type: 'n' })
    const { existsSync } = require('fs') as typeof import('fs')
    expect(existsSync(join(dir, 'config', 'webui.json'))).toBe(false)
  })

  it('返回的凭据是 token，标签要说清是让用户填进 WebUI 的', async () => {
    mkdirSync(join(dir, 'config'), { recursive: true })
    writeFileSync(join(dir, 'config', 'webui.json'), JSON.stringify({ port: 6200, token: 'x' }), 'utf8')
    const creds = resetCredentials({ dir, type: 'n' })
    expect(creds).toHaveLength(1)
    expect(creds[0].value).toBe('114514')
    expect(creds[0].label).toMatch(/Token/i)
  })

  it('损坏的 json 不炸，跳过就好', async () => {
    const cfg = join(dir, 'config')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'webui.json'), '{ 这不是合法 json', 'utf8')
    expect(() => resetCredentials({ dir, type: 'n' })).not.toThrow()
  })
})

/**
 * 「看 Token」要能真的看到用户要的那个。
 *
 * 真 bug：scanCredentials 只读 onebot11_*.json，而用户打开 NapCat 面板
 * 登录时填的是 **webui.json 里的 token** —— 完全是两个东西。
 * 于是点「看 Token」看不到自己想登面板的那个（用户反馈
 * 「napcat 的 token 没办法查看」），而且没配过连接时 onebot11 根本不生成，
 * 结果是空的。
 */
describe('NapCat：看 Token 要能看到 WebUI 登录用的那个', () => {
  let dir = ''
  beforeEach(() => {
    dir = testStage('mxbot-scan-')
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('webui.json 里的 token 要能读到（这才是登录面板用的）', async () => {
    const cfg = join(dir, 'config')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'webui.json'), JSON.stringify({ port: 6200, token: 'webui-secret' }), 'utf8')
    const creds = await scanCredentials({ dir, type: 'n' })
    const w = creds.find((c) => c.label.includes('WebUI'))
    expect(w, '要能读到 webui.json 的 token').toBeTruthy()
    expect(w!.value).toBe('webui-secret')
  })

  it('两个 token 要分开标注，别让用户填错地方', async () => {
    const cfg = join(dir, 'config')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'webui.json'), JSON.stringify({ token: 'panel-token' }), 'utf8')
    writeFileSync(join(cfg, 'onebot11_12345.json'), JSON.stringify({ token: 'bot-token' }), 'utf8')
    const creds = await scanCredentials({ dir, type: 'n' })
    const labels = creds.map((c) => c.label).join(' | ')
    expect(labels).toContain('WebUI')
    expect(labels).toContain('OneBot')
    expect(creds.find((c) => c.label.includes('WebUI'))!.value).toBe('panel-token')
    expect(creds.find((c) => c.label.includes('OneBot'))!.value).toBe('bot-token')
  })

  it('只有 onebot11（还没启动过）也不该空手而归 —— 要说明还没生成', async () => {
    const cfg = join(dir, 'config')
    mkdirSync(cfg, { recursive: true })
    const creds = await scanCredentials({ dir, type: 'n' })
    expect(creds).toHaveLength(1)
    expect(creds[0].value, '要告诉用户为什么没有，而不是空白').toContain('还没生成')
  })
})
