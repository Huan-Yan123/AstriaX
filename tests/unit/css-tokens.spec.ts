/*
 * 守住「CSS 变量必须真实存在」这条线。
 *
 * 为什么需要这个测试：写错变量名是**完全静默**的失败 ——
 * 浏览器不报错、构建不报错、测试也不报错，只是那个颜色没了。
 * 这一轮就真抓到两处：新建实例向导和实例页空状态的按钮用了
 * var(--accent)（按钮背景透明、看着像没上样式），
 * 实例卡片的运行中状态点用了 var(--ok)（**正在运行的实例显示不出绿点**，
 * 核心状态信息丢失），而这两个变量 tokens.css 里都没定义。
 *
 * 光修这两处不够 —— 下次还会有人写错。所以直接在测试里扫源码。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'

const RENDERER = join(__dirname, '..', '..', 'src', 'renderer')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|css)$/.test(e)) out.push(p)
  }
  return out
}

/**
 * 去掉注释再扫。
 *
 * 必须做这一步的原因很实在：修这个 bug 时我顺手在注释里写了
 * 「原来写的是 var(--accent)」，结果测试立刻红了 —— 正则把注释里的
 * 变量名也当成了真实使用。注释里的东西不会生效，不该参与检查；
 * 反过来，如果哪天有人在注释里「保留」一段旧代码，
 * 也不该因此让测试误报。
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // /* ... */ 与 <!-- --> 内部
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // 行注释（避开 http://）
}

describe('CSS 变量一致性（写错变量名是静默失败）', () => {
  const files = walk(RENDERER)
  const tokensCss = readFileSync(join(RENDERER, 'src', 'styles', 'tokens.css'), 'utf8')

  /** tokens.css 里定义的变量名 */
  const defined = new Set<string>()
  for (const m of stripComments(tokensCss).matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)) {
    defined.add(m[1])
  }

  it('tokens.css 本身要能解析出变量（防止解析逻辑失效后测试假绿）', () => {
    // 如果哪天 tokens.css 换了写法导致一条都抠不出来，
    // 下面「所有变量都有定义」会因为集合为空而永远通过 —— 这里先卡死
    expect(defined.size, '至少应该定义十几个基础变量').toBeGreaterThan(10)
    expect(defined.has('--primary')).toBe(true)
    expect(defined.has('--ink')).toBe(true)
  })

  it('组件里用到的每个 var(--x) 都必须在 tokens.css 里定义过', () => {
    const broken: string[] = []
    for (const f of files) {
      if (basename(f) === 'tokens.css') continue
      const raw = readFileSync(f, 'utf8')
      const src = stripComments(raw)
      for (const m of src.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)) {
        if (!defined.has(m[1])) {
          // 行号按**原始文件**算，方便直接跳过去改
          const idx = raw.indexOf(m[0])
          const line = idx >= 0 ? raw.slice(0, idx).split('\n').length : 0
          broken.push(`${basename(f)}:${line} 用了未定义的 ${m[1]}`)
        }
      }
    }
    expect(broken, `这些变量没定义，颜色会失效：\n${broken.join('\n')}`).toEqual([])
  })

  it('没有留下「同义重复」的绿色变量（曾经 --ok / --mint / --ribbon-run 三个重名）', () => {
    /*
     * 曾经的状态：--mint 和 --ribbon-run 都是 #34a67c，而代码里用的
     * 是根本不存在的 --ok。三者语义重叠导致「该用哪个」全靠猜，
     * 猜错就是静默失效。现在统一：状态点用 --mint，丝带用 --ribbon-run。
     */
    expect(defined.has('--ok'), '--ok 不该存在（会被误用）,请用 --mint').toBe(false)
    expect(defined.has('--accent'), '--accent 不该存在（会被误用）,请用 --primary').toBe(false)
  })
})
