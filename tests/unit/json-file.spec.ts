import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { writeFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { readJsonFile, parseJsonLoose } from '../../src/main/util/json-file'
import { testStage } from '../helpers/stage'

/**
 * BOM 是用户真实事故的根因。
 *
 * 用户的 AstrBot 实例里 `data\cmd_config.json` 带 UTF-8 BOM
 * （AstrBot 是 Python 写的，用 utf-8-sig 写文件就有 BOM），
 * 而读取代码是裸 `JSON.parse(readFileSync(f,'utf8'))` ——
 * Node 的 JSON.parse **不认 BOM**，直接抛错，被空 catch 吞掉，
 * 界面就表现为「查看账密一直获取中」。
 *
 * 这里锁死两件事：
 *   1. readJsonFile 能读带 BOM 的 JSON（这是功能本身）
 *   2. 正文里的 U+FEFF 不能被误删（那是合法内容，只该去开头那一个）
 */
let root: string
beforeEach(() => {
  root = testStage('acb-json-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('readJsonFile 要能吃下带 BOM 的文件', () => {
  it('裸 JSON.parse 读 BOM 会失败（这就是当初的 bug）', () => {
    const f = join(root, 'bom.json')
    writeFileSync(f, '\uFEFF' + JSON.stringify({ a: 1 }), 'utf8')
    const raw = require('fs').readFileSync(f, 'utf8') as string
    expect(() => JSON.parse(raw), 'Node 的 JSON.parse 不认 BOM').toThrow()
  })

  it('readJsonFile 能读出带 BOM 的 JSON', () => {
    const f = join(root, 'bom.json')
    const payload = { dashboard: { username: 'astrbot', pbkdf2_password: 'pbkdf2_sha256$x$y' } }
    writeFileSync(f, '\uFEFF' + JSON.stringify(payload), 'utf8')
    expect(readJsonFile(f)).toEqual(payload)
  })

  it('不带 BOM 的照样能读（别为了修 bug 把正常情况弄坏）', () => {
    const f = join(root, 'plain.json')
    writeFileSync(f, JSON.stringify({ a: 1 }), 'utf8')
    expect(readJsonFile(f)).toEqual({ a: 1 })
  })

  it('AstrBot 真实格式（带缩进 + BOM）也能读', () => {
    // 用户的 cmd_config.json 是 2 空格缩进的，BOM + 缩进一起出现
    const f = join(root, 'cmd_config.json')
    writeFileSync(
      f,
      '\uFEFF' + JSON.stringify({ dashboard: { username: 'astrbot' } }, null, 2),
      'utf8'
    )
    const got = readJsonFile<{ dashboard: { username: string } }>(f)
    expect(got.dashboard.username).toBe('astrbot')
  })

  it('只去开头那一个 BOM，正文里的 U+FEFF 要保留', () => {
    // 这是个容易写错的边界：用 replace(/\uFEFF/g,'') 会把正文也删了
    const obj = { note: 'a\uFEFFb' }
    expect(parseJsonLoose('\uFEFF' + JSON.stringify(obj))).toEqual(obj)
    // 正文里的 BOM 原样保留
    const got = parseJsonLoose<{ note: string }>('\uFEFF' + JSON.stringify(obj))
    expect(got.note).toBe('a\uFEFFb')
  })

  it('文件不存在要抛错（由调用方决定怎么处理，不静默返回空对象）', () => {
    expect(() => readJsonFile(join(root, 'nope.json'))).toThrow()
  })

  it('内容损坏要抛错', () => {
    const f = join(root, 'broken.json')
    writeFileSync(f, '\uFEFF{ 这不是 json', 'utf8')
    expect(() => readJsonFile(f)).toThrow()
  })
})

describe('仓库里不该再有裸 JSON.parse(readFileSync(...))', () => {
  it('所有从文件读 JSON 的地方都要走 readJsonFile / parseJsonLoose', async () => {
    /*
     * 这条是**防回归的护栏**：BOM 这个坑不是只在一个文件里，
     * 当初 17 处读取点全是裸 JSON.parse。修一处、漏一处，
     * 用户就还会在另一个地方遇到「读不到」。
     * 所以用测试把整类写法按住，而不是只修当下这几处。
     *
     * ## 为什么改成"自己在 Node 里扫 + 先剥注释"
     *
     * 第一版是丢给 PowerShell 的 Select-String 做裸文本搜索，于是
     * **注释里写出这个写法也会被判违规** —— 我给 crash-logs.ts 写注释
     * 解释"这里为什么要走 readJsonFile"时，括号里顺手写了那个调用形态，
     * 护栏立刻红了。这不是产品的问题，是**尺子没剥注释**。
     * （本项目已经在这上面栽过一次，教训记在 decisions.log。）
     *
     * 现在：读文件 → 去掉行注释与块注释 → 再匹配。
     * 顺带不依赖 PowerShell（跨平台也能跑），并且对空白更宽容。
     */
    const fs = await import('fs')
    const path = await import('path')

    /** 去掉 // 行注释与 块注释（字符串里的 // 可能被误伤，但对本检查无害） */
    function stripComments(src: string): string {
      return src
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split(/\r?\n/)
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n')
    }

    function walk(dir: string, out: string[] = []): string[] {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name)
        if (e.isDirectory()) walk(p, out)
        else if (e.name.endsWith('.ts')) out.push(p)
      }
      return out
    }

    const root = path.join(__dirname, '..', '..')
    const hits: string[] = []
    for (const f of walk(path.join(root, 'src', 'main'))) {
      // json-file.ts 就是这个约定的实现处，它当然要调 readFileSync
      if (f.endsWith('json-file.ts')) continue
      const code = stripComments(fs.readFileSync(f, 'utf8'))
      code.split(/\r?\n/).forEach((line, i) => {
        if (/JSON\.parse\(\s*readFileSync/.test(line)) {
          hits.push(`${path.relative(root, f)}:${i + 1}: ${line.trim()}`)
        }
      })
    }

    expect(
      hits,
      `这些地方还是裸 JSON.parse(readFileSync(...))，遇到带 BOM 的文件（AstrBot 写的就有）会静默失败：\n${hits.join('\n')}`
    ).toEqual([])
  }, 60000)
})
