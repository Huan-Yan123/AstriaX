import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readBuiltinVersion } from '../../src/main/runtime/builtin-version'
import { testStage } from '../helpers/stage'

/**
 * 读运行时**自己带着的**版本标识。
 *
 * 为什么不能只看目录名/tag：目录名是我们下载时起的，用户手动换过包、
 * 或者从别处拷来的目录，名字和内容就可能对不上。运行时的包自己带着权威版本，
 * 以它为准才不会出现「界面写 v4.18.19、实际跑的是别的版本」。
 *
 * 两边的标识位置（都在真实文件里确认过）：
 *
 * NapCat —— napcat.mjs 里烘焙成常量：
 *   const Oj = {}, Vu = typeof Oj < "u" && "4.18.19" || "1.0.0-dev"
 *   并通过 WebUI 的 GET /GetNapCatVersion 暴露。
 *
 * AstrBot —— 官方桌面壳的 version-sync.mjs 认这几处：
 *   pyproject.toml              [project].version
 *   astrbot/__init__.py         __version__ = "..."
 *   astrbot/core/config/default.py   VERSION = __version__
 *   pip 装完后                  astrbot-<ver>.dist-info/METADATA → Version:
 */
describe('读运行时内置版本', () => {
  let root = ''
  beforeEach(() => {
    root = testStage('mxbot-ver-')
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('NapCat：从 napcat.mjs 里挖出烘焙的版本常量', () => {
    const dir = join(root, 'n')
    mkdirSync(dir, { recursive: true })
    // 真实形态（压缩成一行的打包产物）
    writeFileSync(
      join(dir, 'napcat.mjs'),
      'const Oj = {}, Vu = typeof Oj < "u" && "4.18.19" || "1.0.0-dev", Fj = /x/;\n',
      'utf8'
    )
    expect(readBuiltinVersion({ dir, type: 'n' })).toBe('4.18.19')
  })

  it('NapCat：包成别的变量名也认（打包压缩后名字会变）', () => {
    const dir = join(root, 'n2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'napcat.mjs'), 'const zz = {}, Qx = typeof zz < "u" && "4.20.1" || "1.0.0-dev";\n', 'utf8')
    expect(readBuiltinVersion({ dir, type: 'n' })).toBe('4.20.1')
  })

  it('NapCat：读不出来返回 undefined，不编一个假版本', () => {
    const dir = join(root, 'n3')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'napcat.mjs'), 'console.log("no version here");\n', 'utf8')
    expect(readBuiltinVersion({ dir, type: 'n' })).toBeUndefined()
  })

  it('AstrBot：优先读 pip 装完的 dist-info/METADATA（最权威）', () => {
    const dir = join(root, 'a')
    mkdirSync(join(dir, 'astrbot-4.28.0.dist-info'), { recursive: true })
    writeFileSync(
      join(dir, 'astrbot-4.28.0.dist-info', 'METADATA'),
      'Metadata-Version: 2.1\nName: astrbot\nVersion: 4.28.0\n',
      'utf8'
    )
    expect(readBuiltinVersion({ dir, type: 'a' })).toBe('4.28.0')
  })

  it('AstrBot：源码形态读 astrbot/__init__.py 的 __version__', () => {
    const dir = join(root, 'a2')
    mkdirSync(join(dir, 'astrbot'), { recursive: true })
    writeFileSync(join(dir, 'astrbot', '__init__.py'), '__version__ = "4.27.3"\n', 'utf8')
    expect(readBuiltinVersion({ dir, type: 'a' })).toBe('4.27.3')
  })

  it('AstrBot：源码形态没有 __init__ 版本时读 pyproject.toml', () => {
    const dir = join(root, 'a3')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'pyproject.toml'),
      '[project]\nname = "AstrBot"\nversion = "4.26.0"\n',
      'utf8'
    )
    expect(readBuiltinVersion({ dir, type: 'a' })).toBe('4.26.0')
  })

  it('AstrBot：dist-info 的名字带平台后缀也能认', () => {
    const dir = join(root, 'a4')
    mkdirSync(join(dir, 'astrbot-4.28.0-py3-none-any.dist-info'), { recursive: true })
    writeFileSync(
      join(dir, 'astrbot-4.28.0-py3-none-any.dist-info', 'METADATA'),
      'Name: astrbot\nVersion: 4.28.0\n',
      'utf8'
    )
    expect(readBuiltinVersion({ dir, type: 'a' })).toBe('4.28.0')
  })

  it('目录不存在时安静返回 undefined（不抛）', () => {
    expect(readBuiltinVersion({ dir: join(root, 'nope'), type: 'n' })).toBeUndefined()
    expect(readBuiltinVersion({ dir: join(root, 'nope'), type: 'a' })).toBeUndefined()
  })
})
