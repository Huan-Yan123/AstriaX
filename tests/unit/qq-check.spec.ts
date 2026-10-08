import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  checkQQ,
  MIN_QQ_BUILD,
  QQ_DOWNLOAD_URL,
  qqCandidatesFromRegistry,
  readQQVersion
} from '../../src/main/runtime/qq-check'
import { testStage } from '../helpers/stage'

/**
 * QQ 版本检测。
 * NapCat 是注入 QQ 客户端运行的（launcher.bat 里 NapCatWinBootMain.exe QQ.exe ...），
 * 所以没装 QQ 或版本太低必须提前拦住，并引导用户去官网下载。
 * 本机真实布局：E:\QQ\versions\config.json → curVersion "9.9.31-49738"。
 */
describe('QQ 版本检测', () => {
  let root = ''
  beforeEach(() => {
    root = testStage('mxbot-qq-')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** 造一个真机形态的 QQ 安装目录 */
  function seedQQ(
    dir: string,
    opts: { version?: string; buildVersion?: string; withExe?: boolean; withConfig?: boolean } = {}
  ): void {
    const { version = '9.9.31-49738', buildVersion = '49738', withExe = true, withConfig = true } = opts
    mkdirSync(dir, { recursive: true })
    if (withExe) writeFileSync(join(dir, 'QQ.exe'), 'MZ', 'utf8')
    if (withConfig) {
      mkdirSync(join(dir, 'versions'), { recursive: true })
      writeFileSync(
        join(dir, 'versions', 'config.json'),
        JSON.stringify({ baseVersion: version, curVersion: version, buildId: buildVersion }),
        'utf8'
      )
    }
    const appDir = join(dir, 'versions', version, 'resources', 'app')
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: 'qq-chat', version, buildVersion, main: './application.asar/app_launcher/index.js' }),
      'utf8'
    )
  }

  it('从 versions/config.json 读出版本和构建号（本机真实格式）', () => {
    const qq = join(root, 'QQ')
    seedQQ(qq)
    const v = readQQVersion(qq)
    expect(v).toEqual({ version: '9.9.31-49738', build: 49738 })
  })

  it('config.json 缺失时回落到 package.json 的 buildVersion', () => {
    const qq = join(root, 'QQ2')
    seedQQ(qq, { withConfig: false })
    const v = readQQVersion(qq)
    expect(v).toEqual({ version: '9.9.31-49738', build: 49738 })
  })

  it('版本够 → ok，并带出 QQ.exe 路径', () => {
    const qq = join(root, 'QQ3')
    seedQQ(qq)
    const info = checkQQ({ candidates: [qq] })
    expect(info.ok).toBe(true)
    expect(info.installed).toBe(true)
    expect(info.build).toBe(49738)
    expect(info.exe).toBe(join(qq, 'QQ.exe'))
    expect(info.reason).toBeUndefined()
  })

  it('正好等于门槛 40768 → 通过（够用就是够用）', () => {
    const qq = join(root, 'QQ4')
    seedQQ(qq, { version: '9.9.22-40768', buildVersion: '40768' })
    expect(checkQQ({ candidates: [qq] }).ok).toBe(true)
  })

  it('比门槛低 1 → 拦住，原因里说明要求和现状', () => {
    const qq = join(root, 'QQ5')
    seedQQ(qq, { version: '9.9.20-40767', buildVersion: '40767' })
    const info = checkQQ({ candidates: [qq] })
    expect(info.ok).toBe(false)
    expect(info.installed).toBe(true)
    expect(info.build).toBe(40767)
    expect(info.reason).toContain('版本太低')
    expect(info.reason).toContain('40768')
    expect(info.reason).toContain('9.9.20-40767')
  })

  it('完全没装 QQ → 明确说「未安装 QQ」（而不是含糊失败）', () => {
    const info = checkQQ({ candidates: [join(root, '没有这个目录')] })
    expect(info.ok).toBe(false)
    expect(info.installed).toBe(false)
    /*
     * ★ 措辞变更（主人 2026-10-08）：
     *   原来是「没有检测到 QQ」—— 那语气像"探测失败"，
     *   而实际情况是"这台机器没装 QQ"，用户需要知道的是**该去装**。
     *   现在改成「未安装 QQ」，并补一句"怀旧版不支持"
     *   （实测：怀旧版 QQ 也确实检测不到）。
     */
    expect(info.reason).toContain('未安装 QQ')
  })

  it('有 QQ.exe 但版本文件都读不到 → 提示重装（不当成没装）', () => {
    const qq = join(root, 'QQ6')
    mkdirSync(qq, { recursive: true })
    writeFileSync(join(qq, 'QQ.exe'), 'MZ', 'utf8')
    const info = checkQQ({ candidates: [qq] })
    expect(info.ok).toBe(false)
    expect(info.installed).toBe(true)
    expect(info.reason).toContain('读不出')
  })

  it('多个候选时取第一个有效且合格的', () => {
    const oldQq = join(root, 'old')
    const newQq = join(root, 'new')
    seedQQ(oldQq, { version: '9.9.10-30000', buildVersion: '30000' })
    seedQQ(newQq, { version: '9.9.31-49738', buildVersion: '49738' })
    expect(checkQQ({ candidates: [oldQq, newQq] }).ok).toBe(true)
  })

  it('注册表里的 UninstallString 能解析出安装目录（跟 launcher.bat 同一来源）', () => {
    const dirs = qqCandidatesFromRegistry((key, name) => {
      if (key.endsWith('Uninstall\\QQ') && name === 'UninstallString') return '"E:\\QQ\\Uninstall.exe"'
      return undefined
    })
    expect(dirs).toContain('E:\\QQ')
  })

  it('门槛常量与官网链接是定值（界面文案依赖它们）', () => {
    expect(MIN_QQ_BUILD).toBe(40768)
    expect(QQ_DOWNLOAD_URL).toMatch(/^https:\/\/im\.qq\.com\//)
  })
})
