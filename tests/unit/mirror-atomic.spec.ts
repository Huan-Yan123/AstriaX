/*
 * Bug F：mirrors.json 必须原子写
 * ========================================================================
 *
 * ## 坏在哪 —— 一次写坏 = 用户自定义的源全没
 *
 * `saveMirrors()` 原来是直接 `writeFileSync(fileOf(dataRoot), json)`。
 * 而 `loadMirrors()` 对损坏是**静默降级**的：
 *
 *     try { raw = readJsonFile(fileOf(dataRoot)) } catch { raw = {} }
 *
 * 于是"文件坏了" → `raw = {}` → `custom = []` → **用户自己加过的所有
 * 镜像源凭空消失**，首选源也一起没了，而且界面上没有任何提示。
 *
 * 从用户视角看就是「这软件把我配的镜像源吃了」——
 * 最难查的一类 bug，因为它没有任何报错，只在下次打开页面时才显形。
 *
 * ## 为什么这里特别不能忍
 *
 * mirrors.json 是**纯粹的"用户资产"**：内置源写在代码里，这个文件里
 * 装的全是用户手输的东西。别的小状态文件坏了顶多重来一遍，
 * 这个坏了是**永久丢失用户的输入**（他没地方再找回来）。
 *
 * ## 判据
 *
 * 行为上很难直接观测"写了一半"（要注入失败）。所以用结构性判据：
 * 断言 saveMirrors 走的是 `writeJsonAtomic`（即 tmp+rename）。
 * 在这个场景里 **"用 tmp+rename" 就是原子性的定义本身** ——
 * 直接 writeFileSync 无论加什么参数都不可能原子。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { testStage } from '../helpers/stage'
import { readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import {
  loadMirrors,
  saveMirrors,
  addCustomMirror,
  removeCustomMirror
} from '../../src/main/update/mirror-store'

let root: string
beforeEach(() => {
  root = testStage('acb-mirror-atomic-')
  mkdirSync(root, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Bug F：mirrors.json 原子写', () => {
  it('★saveMirrors 必须走原子写（tmp+rename），不能直接 writeFileSync 目标文件', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'main', 'update', 'mirror-store.ts'),
      'utf8'
    )
    // 取出 saveMirrors 的函数体（大括号配平，避免被后面的函数干扰）
    const i = src.indexOf('export function saveMirrors(')
    expect(i, '找不到 saveMirrors').toBeGreaterThan(0)
    const open = src.indexOf('{', i)
    let depth = 0
    let end = -1
    for (let k = open; k < src.length; k++) {
      if (src[k] === '{') depth++
      else if (src[k] === '}') {
        depth--
        if (depth === 0) {
          end = k + 1
          break
        }
      }
    }
    const body = src.slice(i, end)

    expect(
      /writeJsonAtomic|writeFileAtomic|renameSync\s*\(/.test(body),
      'saveMirrors 没有原子写 —— 一次写坏（截断）就会让 loadMirrors 的\n' +
        'catch 把它当成 {} ，于是**用户自己加的所有镜像源全部消失**，\n' +
        '而且没有任何报错。mirrors.json 里装的全是用户手输的东西，\n' +
        '坏了就是永久丢失。'
    ).toBe(true)

    // 不允许出现"直接往目标文件写"的形态
    expect(
      /writeFileSync\s*\(\s*fileOf\s*\(/.test(body),
      'saveMirrors 仍然直接 writeFileSync 到 mirrors.json —— 非原子'
    ).toBe(false)
  })

  it('保存后内容完整、无 .tmp 残留', () => {
    saveMirrors(root, {
      custom: [{ label: '我的源', base: 'https://example.com/x/', mode: 'proxy' }],
      pref: { a: 'https://example.com/x/' }
    })
    const f = join(root, 'mirrors.json')
    expect(() => JSON.parse(readFileSync(f, 'utf8'))).not.toThrow()

    const leftovers = readdirSync(root).filter((n) => n.includes('.tmp'))
    expect(leftovers, `留下了临时文件：${leftovers.join('、')}`).toEqual([])
  })

  it('★损坏的 mirrors.json 不该被静默当成「没有自定义源」', () => {
    /*
     * 这条钉住**损坏时的行为**，而不只是写入路径。
     *
     * 现在 loadMirrors 对损坏是 catch → {} → 用户的源全没。
     * 修好原子写之后正常路径不会产生损坏文件，但**已经损坏的**
     * （老版本留下的、或者手工改坏的）依然存在。
     *
     * 期望：至少不能**静默**吞掉。做法是把坏文件留证（改名成 .corrupt-*），
     * 这样用户/我们能看出"文件曾经坏过"，而不是毫无痕迹地少了一堆源。
     */
    const f = join(root, 'mirrors.json')
    writeFileSync(f, '{"custom":[{"label":"半截', 'utf8')

    const st = loadMirrors(root)
    // 不能因此崩溃，内置源要在
    expect(st.mirrors.length, '内置源必须还在（否则用户连官方源都没了）').toBeGreaterThan(0)

    // 坏文件必须被留证（否则这次损坏完全无迹可查）
    const quarantined = readdirSync(root).filter((n) => n.includes('corrupt') || n.includes('.bad'))
    expect(
      quarantined.length,
      '损坏的 mirrors.json 被静默丢弃了 —— 用户会以为"我配的源自己没了"，\n' +
        '而且我们事后也查不出曾经坏过。应该像 instances.json 那样留证。'
    ).toBeGreaterThan(0)
  })

  it('加/删自定义源后能完整读回（回归）', () => {
    addCustomMirror(root, { label: '甲', base: 'https://a.example/', mode: 'proxy' })
    addCustomMirror(root, { label: '乙', base: 'https://b.example/', mode: 'proxy' })
    let st = loadMirrors(root)
    const custom = st.mirrors.filter((m) => !m.builtin)
    expect(custom.map((m) => m.base).sort()).toEqual([
      'https://a.example/',
      'https://b.example/'
    ])

    removeCustomMirror(root, 'https://a.example/')
    st = loadMirrors(root)
    expect(st.mirrors.filter((m) => !m.builtin).map((m) => m.base)).toEqual(['https://b.example/'])
    // 删完也不该留 tmp
    expect(readdirSync(root).filter((n) => n.includes('.tmp'))).toEqual([])
  })
})
