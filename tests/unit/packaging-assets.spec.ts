/*
 * 打包产物必须带图标。
 *
 * 用户报告：「托盘还是没图标」。
 *
 * 根因有两层，缺一层都还是没图标：
 *   1. 图标压根没被打进安装包 —— electron-builder.yml 的 files 只有
 *      out/** 和 package.json，而 build/icon.png 不在其中。
 *   2. 就算加进 files，它会被塞进 **app.asar**（归档包），而
 *      nativeImage.createFromPath() **读不了 asar 内部的文件** ——
 *      路径 existsSync 得到，createFromPath 却返回 empty image。
 *
 * 所以正确做法是 extraResources（复制到 asar 外面的 resources\ 下），
 * 运行时用 process.resourcesPath 读取。这个测试把这两点都钉住。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

const ROOT = join(__dirname, '..', '..')
const YML = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
const TRAY = readFileSync(join(ROOT, 'src/main/tray/tray.ts'), 'utf8')
const INDEX = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')

describe('图标必须真的出现在安装后的程序里', () => {
  it('build/icon.png 存在且是个真 PNG', () => {
    const p = join(ROOT, 'build', 'icon.png')
    expect(existsSync(p), '图标源文件不见了').toBe(true)
    const b = readFileSync(p)
    // PNG magic: 89 50 4E 47
    expect(b[0]).toBe(0x89)
    expect(b.toString('latin1', 1, 4)).toBe('PNG')
    // 宽高（IHDR 从偏移 16 开始，两个大端 u32）
    const w = b.readUInt32BE(16)
    const h = b.readUInt32BE(20)
    expect(w, 'Windows 图标至少要 256 宽才清晰').toBeGreaterThanOrEqual(256)
    expect(h).toBeGreaterThanOrEqual(256)
  })

  it('★图标走 extraResources（asar 外面），不能只放在 files 里', () => {
    /*
     * 这是最容易搞错的一处：把 build/icon.png 加进 files 看起来"打包了"，
     * 但它进的是 app.asar，nativeImage 读不到，结果还是没图标。
     */
    expect(YML, '必须有 extraResources 段').toContain('extraResources')
    const i = YML.indexOf('extraResources')
    const tail = YML.slice(i)
    // extraResources 里要包含 icon 的 from/to
    const section = tail.split(/^win:/m)[0]
    expect(section, 'extraResources 里要放 icon.png').toMatch(/from:\s*build\/icon\.png/)
    expect(section, '要复制到 resources 根下（名字 icon.png）').toMatch(/to:\s*icon\.png/)
  })

  it('win.icon 指向真实存在的图标（exe/安装包图标）', () => {
    expect(YML, 'win.icon 要设上，否则 exe 是默认图标').toMatch(/^\s*icon:\s*build\/icon\.png/m)
  })

  it('托盘与窗口图标都会去 process.resourcesPath 找', () => {
    // 打包后图标就在 <安装目录>\resources\icon.png
    expect(TRAY, '托盘图标要认 process.resourcesPath').toContain('resourcesPath')
    expect(INDEX, '窗口图标要认 process.resourcesPath').toContain('resourcesPath')
    // 而且要拼上 icon.png
    expect(TRAY).toMatch(/join\(resourcesPath,\s*'icon\.png'\)/)
    expect(INDEX).toMatch(/join\(resourcesPath,\s*'icon\.png'\)/)
  })

  it('找不到图标时会记日志，而不是静默变空白', () => {
    /*
     * 原来图标找不到是**完全静默**的：默默用一个 32px 色块，
     * 日志里一个字都没有，排查只能靠猜。现在必须报出来。
     */
    expect(TRAY, 'loadIconImage 要有 fallback 回调').toContain('onIconFallback')
    expect(TRAY, '兜底时要把找过的路径说清楚').toMatch(/托盘图标没找到/)
    expect(INDEX, 'index.ts 要把 fallback 接到 logger 上').toMatch(
      /onIconFallback:\s*\(why\)\s*=>\s*logger\.log/
    )
  })

  it('不许再依赖 asar 内部路径找图标（那是读不到的）', () => {
    /*
     * 反面断言：如果哪天有人又改回 resources\app\build\icon.png，
     * 表面上"路径更对了"，实际上 nativeImage 读 asar 内部会返回空图。
     */
    expect(
      /resources',\s*'app',\s*'build'/.test(TRAY),
      '不要去找 app.asar 内部的图标，那条路读不到'
    ).toBe(false)
  })
})
