/*
 * 手动导入时版本号必须能从包里**真的读出来**。
 *
 * ## 原来错在哪
 *
 * classifyArchive 里认 NapCat 版本的那段是：
 *
 *     const pkg = entries.find((e) => /(^|\/)package\.json$/i.test(e))
 *     const m = /(\d+\.\d+\.\d+)/.exec(pkg ?? '')
 *
 * `entries` 是**路径名字符串数组**，所以 `pkg` 拿到的是字面量
 * `"package.json"` 或者 `"node_modules/express/package.json"` ——
 * 里面一个数字都没有，正则永远匹配不上，`version` 恒为空串。
 * 注释写着「版本从 package.json 或文件名里找」，但实际从没打开过那个文件。
 *
 * ## 后果（不是"版本显示不好看"那么轻）
 *
 * ipc.ts 的 runtimes:importFile 里 tag 的取法是：
 *     version ? `v${version}` : `imported-${Date.now().toString(36)}`
 * 于是手动导入一个 NapCat 包，会装成一个叫 `imported-mf3k2a` 的目录，
 * 而**版本列表里显示的就是这串随机字符**。用户没法把它和真实版本对上，
 * 也看不出自己导的是 v4.18.19 还是别的。
 *
 * 而 NapCat 恰恰**只能**手动导入（版本清单里它没有 pypi 来源那种自动路径），
 * 所以这条路径是主路径，不是边角。
 *
 * ## AstrBot 为什么没这个问题
 *
 * 它的版本是从**文件名**里读的（astrbot-4.28.0-py3-none-any.whl），
 * 文件名里就有数字，所以一直正常。这也解释了为什么这个 bug 能活这么久 ——
 * 测 AstrBot 的时候一切正常，只有 NapCat 是坏的。
 *
 * ## 为什么 entry 名里也可能有版本
 *
 * NapCat 官方包顶层就是 `package.json`（没有版本），但第三方重新打包时
 * 常见的形态是 `NapCat-v4.18.19/package.json`，或者干脆
 * `NapCat.Shell.4.18.19.zip`。所以：**能读到内容就优先用内容**，
 * 读不到再退回从路径里正则 —— 两条路都留着，但顺序不能反。
 */
import { describe, it, expect } from 'vitest'
import { classifyArchive } from '../../src/main/update/import-archive'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { testStage } from '../helpers/stage'

const NAPCAT_FILES = [
  'NapCatWinBootMain.exe',
  'NapCatWinBootHook.dll',
  'napcat.mjs',
  'package.json',
  'qqnt.json'
]

/** 把「条目名 → 内容」的普通对象包成 readEntry 函数 */
function readerOf(files: Record<string, string>): (name: string) => string | undefined {
  return (name) => files[name.replace(/\\/g, '/')]
}

/** 造一个真 zip（用 PowerShell 的 Compress-Archive，避免引入第三方库） */
function makeZip(dir: string, out: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${dir}\\*' -DestinationPath '${out}' -Force`
  ])
}

describe('手动导入：NapCat 版本号要真的从包里读出来', () => {
  it('★package.json 里的占位符 0.0.1 必须丢掉（那是源码仓库的，不是真版本）', () => {
    /*
     * 实测官方 NapCat.Shell.zip 的 package.json 就是：
     *   { "name":"napcat", "private":true, "type":"module", "version":"0.0.1" }
     * 真版本 4.18.19 **不在里面**，只在 napcat.mjs 的构建注入里。
     *
     * 读到 0.0.1 比读不到更糟：读不到会老实退化成 imported-xxx，
     * 而假版本 v0.0.1 看起来像真的。
     */
    const r = classifyArchive(
      [...NAPCAT_FILES],
      readerOf({ 'package.json': JSON.stringify({ name: 'napcat', private: true, version: '0.0.1' }) })
    )
    expect(r.kind).toBe('n')
    expect(r.version, '占位符被当成真版本了').toBe('')
  })

  it('★napcat.mjs 的构建注入版本要优先（真包就是靠这个）', () => {
    const napcatJs = 'x();const Oj = {}, Vu = typeof Oj < "u" && "4.18.19" || "1.0.0-dev";more()'
    const r = classifyArchive(
      [...NAPCAT_FILES],
      readerOf({
        'napcat.mjs': napcatJs,
        // package.json 里是假版本，不该盖过注入的真版本
        'package.json': JSON.stringify({ name: 'napcat', version: '0.0.1' })
      })
    )
    expect(r.version, '没能从 napcat.mjs 读到构建注入版本').toBe('4.18.19')
  })

  it('★不能从 napcat.mjs 里随便抓一个版本号（里面一堆依赖版本）', () => {
    // 满文件都是别的版本号，但没有注入模式 —— 这时**不该**给出任何版本
    const noisy = 'a="1.0.0";b="3.2.12";c="6.9.53";d="9.9.15";e="9.9.22"'
    const r = classifyArchive(
      [...NAPCAT_FILES],
      readerOf({ 'napcat.mjs': noisy, 'package.json': JSON.stringify({ name: 'napcat', version: '0.0.1' }) })
    )
    expect(r.version, '抓到依赖版本号了，那比读不到更糟').toBe('')
  })

  it('读不到 package.json 内容时，退回从路径名里正则（老行为要保住）', () => {
    const r = classifyArchive(['NapCat-v4.18.19/package.json', ...NAPCAT_FILES.slice(0, 3)])
    expect(r.kind).toBe('n')
    expect(r.version).toBe('4.18.19')
  })

  it('包里没有版本信息时不编造，留空（上层会用 imported-xxx 兜底）', () => {
    const r = classifyArchive([...NAPCAT_FILES], readerOf({ 'package.json': JSON.stringify({ name: 'napcat' }) }))
    expect(r.kind).toBe('n')
    expect(r.version).toBe('')
  })

  it('package.json 里是正常版本号时能用（不是占位符就用）', () => {
    const r = classifyArchive([...NAPCAT_FILES], readerOf({
      'package.json': JSON.stringify({ version: '4.19.0-beta.1' })
    }))
    expect(r.version).toBe('4.19.0')
  })

  it('★端到端：造一个真 zip，probeArchive 要读出 4.18.19', async () => {
    const { probeArchive } = await import('../../src/main/update/import-archive')
    const stage = testStage('acb-napcat-ver-')
    const build = join(stage, 'build')
    mkdirSync(build, { recursive: true })
    const zip = join(stage, 'NapCat.Shell.zip')
    try {
      makeZip(build, zip, {
        'NapCatWinBootMain.exe': 'x',
        'NapCatWinBootHook.dll': 'x',
        'napcat.mjs': 'x',
        'package.json': JSON.stringify({ name: 'napcat', version: '4.18.19' })
      })
      const p = await probeArchive(zip)
      expect(p.kind).toBe('n')
      expect(p.version, '手动导入 NapCat 会拿到随机 tag').toBe('4.18.19')
    } finally {
      rmSync(stage, { recursive: true, force: true })
    }
  })
})
