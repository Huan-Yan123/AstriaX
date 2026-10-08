import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'
import { getTemplates, instantiateFromTemplate, verifyArchive, ensureTemplate } from '../../src/main/update/templates'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('acb-tpl-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('模板注册表 / 实例化 / 校验', () => {
  it('模板未就绪：ready=false', () => {
    const t = getTemplates({ templatesRoot: join(root, 'templates') })
    expect(t.a.ready).toBe(false)
    expect(t.n.ready).toBe(false)
  })

  it('标记文件存在即 ready，version 读自 manifest.json', () => {
    const troot = join(root, 'templates')
    mkdirSync(join(troot, 'astrbot'), { recursive: true })
    mkdirSync(join(troot, 'napcat'), { recursive: true })
    writeFileSync(join(troot, 'astrbot', '.mx-ready'), '1', 'utf8')
    writeFileSync(join(troot, 'astrbot', 'manifest.json'), JSON.stringify({ version: 2 }), 'utf8')
    writeFileSync(join(troot, 'napcat', '.mx-ready'), '1', 'utf8')
    const t = getTemplates({ templatesRoot: troot })
    expect(t.a.ready).toBe(true)
    expect(t.a.version).toBe(2)
    expect(t.n.ready).toBe(true)
  })

  it('instantiateFromTemplate：只建实例骨架，不复制运行时（省下几百 MB）', () => {
    /*
     * 这条断言盯的是一个真 bug 的修复。
     *
     * 原来 instantiateFromTemplate 把共享运行时整树复制进实例目录。多版本改造后
     * 运行时已经搬到 <dataRoot>\runtimes\<type>\<tag>\ 且同类实例共享，
     * 启动读的也是运行时目录 —— 复制出来那份**没有任何代码读它**。
     * 实测代价：AstrBot v4.28.0 有 565.4 MB / 49133 个文件，
     * 建一个实例就白复制这么多，建 5 个就是 2.8 GB。
     *
     * 实测证明副本不必要：NapCat 用完全空的工作目录能正常启动
     * （端口通，只生成 config\webui.json 和二维码）。
     * 所以现在只建目录 + 写标记，大文件绝不能被拷进来。
     */
    const src = join(root, 'tpl-a')
    mkdirSync(join(src, 'data'), { recursive: true })
    mkdirSync(join(src, 'astrbot'), { recursive: true })
    writeFileSync(join(src, 'main.py'), 'print(1)', 'utf8')
    writeFileSync(join(src, 'data', 'cfg.json'), '{}', 'utf8')
    // 放一个体积明显的文件，确保它不会被搬过去
    writeFileSync(join(src, 'napcat.mjs'), 'x'.repeat(2 * 1024 * 1024), 'utf8')

    const dest = join(root, 'inst')
    instantiateFromTemplate({ src, dest })

    // 运行时的大文件一律不复制
    expect(existsSync(join(dest, 'main.py'))).toBe(false)
    expect(existsSync(join(dest, 'napcat.mjs'))).toBe(false)
    expect(existsSync(join(dest, 'astrbot'))).toBe(false)
    // 模板里的用户数据也不该被搬进新实例（新实例应是干净的）
    expect(existsSync(join(dest, 'data', 'cfg.json'))).toBe(false)
    // 但实例目录要存在，并有自证标记
    expect(existsSync(dest)).toBe(true)
    expect(existsSync(join(dest, '.mx-ready'))).toBe(true)
  })

  it('verifyArchive：sha256 匹配 true / 不匹配 false', () => {
    const f = join(root, 'a.bin')
    writeFileSync(f, 'hello', 'utf8')
    const good = createHash('sha256').update('hello').digest('hex')
    expect(verifyArchive(f, good)).toBe(true)
    expect(verifyArchive(f, 'deadbeef')).toBe(false)
  })

  it('ensureTemplate：给模板目录补 .mx-ready 标记 + manifest(指定版本)', () => {
    const src = join(root, 'tpl-n')
    mkdirSync(src, { recursive: true })
    const t = ensureTemplate({ src, version: 3 })
    expect(t.ready).toBe(true)
    expect(t.version).toBe(3)
  })
})
