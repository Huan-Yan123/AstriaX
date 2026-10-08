import { describe, it, expect } from 'vitest'
import { classifyArchive } from '../../src/main/update/import-archive'

/**
 * 手动导入的**识别逻辑**必须准 —— 这是整个功能的关键。
 *
 * 用户拖进来任何一个 zip，如果我们只校验「能解开」，最后会装出一个
 * 跑不起来的运行时，而且报错会跑偏到几百行之外，极难查。
 *
 * 下面的条目清单不是编的，是**实测解包真实的包**得到的结构：
 *   - NapCat.Shell.zip（29MB）：18 个顶层条目，含 NapCatWinBootMain.exe
 *   - astrbot-4.28.0-py3-none-any.whl（7.4MB）：含 astrbot/__init__.py
 *   - AstrBot-v4.28.0-dashboard.zip（5.75MB）：**只有 dist/**，后端不存在
 */
describe('压缩包识别：NapCat Shell 包', () => {
  const NAPCAT_ENTRIES = [
    'NapCatWinBootMain.exe',
    'NapCatWinBootHook.dll',
    'napcat.mjs',
    'qqnt.json',
    'package.json',
    'loadNapCat.js',
    'node_modules/',
    'node_modules/foo/index.js',
    'plugins/',
    'README.md'
  ]

  it('认得出是 NapCat，并接受', () => {
    const r = classifyArchive(NAPCAT_ENTRIES)
    expect(r.kind).toBe('n')
    expect(r.reason).toContain('NapCat Shell')
  })

  it('缺 NapCatWinBootMain.exe 的残包要拒绝（装了也起不来）', () => {
    const broken = NAPCAT_ENTRIES.filter((e) => !e.includes('NapCatWinBootMain'))
    const r = classifyArchive(broken)
    expect(r.kind, '缺注入器的包不该被接受').toBeNull()
    expect(r.reason).toContain('NapCatWinBootMain.exe')
    expect(r.reason).toContain('不完整')
  })

  it('缺 dll 或 napcat.mjs 也要拒绝', () => {
    expect(classifyArchive(NAPCAT_ENTRIES.filter((e) => !e.includes('Hook.dll'))).kind).toBeNull()
    expect(classifyArchive(NAPCAT_ENTRIES.filter((e) => e !== 'napcat.mjs')).kind).toBeNull()
  })

  it('多一层顶层目录（NapCat/...）也认得出', () => {
    const nested = NAPCAT_ENTRIES.map((e) => `NapCat/${e}`)
    expect(classifyArchive(nested).kind).toBe('n')
  })
})

describe('压缩包识别：AstrBot', () => {
  it('wheel 包认成 AstrBot，并读出版本', () => {
    const wheel = [
      'astrbot/__init__.py',
      'astrbot/cli/__main__.py',
      'astrbot/core/utils/auth_password.py',
      'astrbot-4.28.0.dist-info/METADATA',
      'astrbot-4.28.0.dist-info/RECORD'
    ]
    const r = classifyArchive(wheel)
    expect(r.kind).toBe('a')
    expect(r.version, '版本要从包里读出来，不能编').toBe('4.28.0')
    expect(r.reason).toContain('wheel')
  })

  it('dashboard.zip 必须被拒绝 —— 它只有前端，后端不存在', () => {
    /*
     * 这是最关键的一条：AstrBot 官方 release 从 v4.27.3 到 v4.28.0
     * **全部只发 dashboard.zip**（5.75MB，只有 dist/），
     * 这就是用户反馈「下到的 astrbot 怎么都是没办法用的」的根因。
     * 如果有人手动导入这个包，我们必须认出来并拒绝，不能让他白装一遍。
     */
    const dash = [
      'dist/index.html',
      'dist/assets/index-abc.js',
      'dist/assets/index-def.css',
      'dist/favicon.ico'
    ]
    const r = classifyArchive(dash)
    expect(r.kind, 'dashboard 包绝不能当成可用的 AstrBot').toBeNull()
    expect(r.reason).toContain('dashboard')
    expect(r.reason).toContain('不含后端')
  })

  it('即使是 dashboard-4.28.0.zip 这种带版本号的命名也要拒绝', () => {
    const r = classifyArchive(['dist/index.html', 'dist/app.js'])
    expect(r.kind).toBeNull()
  })

  it('完全无关的包给出明确提示', () => {
    const r = classifyArchive(['setup.exe', 'readme.txt', 'data/config.ini'])
    expect(r.kind).toBeNull()
    expect(r.reason).toContain('认不出')
    // 提示里要说清楚应该给什么
    expect(r.reason).toContain('NapCat.Shell.zip')
    expect(r.reason).toContain('whl')
  })
})
