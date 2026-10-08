/*
 * 「按钮鼠标放上去，文字就看不见了」。
 *
 * 用户原话（问题报告v2 第 8 条）：「某些地方的按钮放上去变色之后会看不见字」。
 *
 * ## 为什么之前查不出来
 *
 * 我一开始是「把颜色配成对算对比度」，算出来全达标 —— 但那是**静态**的。
 * 真正的问题出在 hover 时**只改了背景、没改文字色**（或反过来）：
 * 静止时是「深蓝底白字」，鼠标一放上去背景变浅、文字仍是白的，
 * 就白了。这类问题必须把**静止态和 hover 态的实际计算样式**都量出来比对。
 *
 * ## 这个测试怎么做
 *
 * happy-dom 不做真正的层叠计算，`getComputedStyle` 对 var() 和 :hover
 * 都不可靠。所以这里换成「把两个状态的定义拼起来做一致性检查」：
 *
 *   1. 从组件的 style 里抽出所有含 :hover 的规则
 *   2. 每条规则看它改了哪些**视觉属性**（color / background / opacity / filter）
 *   3. 如果它改了 background 却**没有**同时给 color，而这条选择器对应的
 *      基础规则里 color 依赖一个和 background **亮度接近**的值 —— 就是 bug
 *
 * 另外单独守住一条硬规则：hover 绝对不能让文字变透明或与背景同色。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(vue|css)$/.test(n)) out.push(p)
  }
  return out
}

interface Rule {
  file: string
  sel: string
  body: string
}

/** 抽出所有规则（去掉注释，避免把说明文字当代码） */
function rules(): Rule[] {
  const out: Rule[] = []
  for (const f of walk('src/renderer/src')) {
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    const short = f.replace(/\\/g, '/').split('/').slice(-1)[0]
    for (const m of src.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const sel = m[1].trim().replace(/\s+/g, ' ')
      if (!/^[.#a-zA-Z]/.test(sel)) continue
      out.push({ file: short, sel, body: m[2] })
    }
  }
  return out
}

const decl = (body: string, prop: string): string | undefined =>
  new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`).exec(body)?.[1]?.trim()

const all = rules()
const hoverRules = all.filter((r) => /:hover/.test(r.sel))

describe('hover 态不能让文字消失', () => {
  it('★hover 改了背景就必须让文字色也是确定的（不能只改一半）', () => {
    const problems: string[] = []
    for (const h of hoverRules) {
      const bg = decl(h.body, 'background') ?? decl(h.body, 'background-color')
      const color = decl(h.body, 'color')
      // 只改背景、完全不管文字色 → 文字色仍是基础规则的
      if (bg && !color) {
        /*
         * 这时文字色来自基础规则。只要基础规则的 color 和 hover 的新背景
         * 是「同一个色系里深浅不同」，一般没问题；真正危险的是基础规则里
         * color 是**白色**而 hover 背景是浅色 —— 那就看不见了。
         *
         * 所以这里只报「基础 color 是 #fff/white 且 hover 背景是浅色」。
         */
        const base = h.sel.replace(/:hover(:not\([^)]*\))?/, '')
        const baseRule = all.find((r) => r.sel === base)
        const baseColor = baseRule ? decl(baseRule.body, 'color') : undefined
        if (baseColor && /^#fff(fff)?$/i.test(baseColor.trim())) {
          // 浅色背景 + 白字 → 危险
          const isLightBg = /--primary-soft|--card|--bg|--hairline|#e|#f/i.test(bg)
          if (isLightBg) {
            problems.push(`${h.file}  ${h.sel}\n      hover 背景=${bg}  但文字仍是白色（来自 ${base}）`)
          }
        }
      }
    }
    expect(problems, `hover 只改了背景/没管文字色，白字会消失在浅色背景上：\n${problems.join('\n')}`).toEqual([])
  })

  it('★hover 不能把文字设成透明或完全同色', () => {
    const bad: string[] = []
    for (const h of hoverRules) {
      const color = decl(h.body, 'color')
      const bg = decl(h.body, 'background') ?? decl(h.body, 'background-color')
      if (color && /^(transparent|none)$/i.test(color)) {
        bad.push(`${h.file}  ${h.sel}  → color: ${color}`)
      }
      if (color && bg && color.replace(/\s/g, '') === bg.replace(/\s/g, '')) {
        bad.push(`${h.file}  ${h.sel}  → 文字色和背景色完全相同（${color}）`)
      }
    }
    expect(bad, `hover 让文字消失了：\n${bad.join('\n')}`).toEqual([])
  })

  it('★全局按钮样式：.main/.ghost/.danger 的 hover 不能变成白字浅底', () => {
    const t = readFileSync('src/renderer/src/styles/tokens.css', 'utf8')
    const short = t.replace(/\/\*[\s\S]*?\*\//g, '')
    for (const variant of ['main', 'ghost', 'danger']) {
      const m = new RegExp(`button\\.${variant}:hover[^{]*\\{([^}]*)\\}`).exec(short)
      if (!m) continue
      const bg = decl(m[1], 'background')
      const hoverColor = decl(m[1], 'color')
      // hover 没写 color 时，文字色继承自基础规则 —— 把它取出来一起判断
      const baseM = new RegExp(`button\\.${variant}\\s*\\{([^}]*)\\}`).exec(short)
      const color = hoverColor ?? (baseM ? decl(baseM[1], 'color') : undefined)
      if (!bg || !color) continue
      /*
       * 只要背景是「浅色」（tokens 里的浅色系 / #e..#f 开头 / soft 变量），
       * 文字就不能是白色 —— 那才是真的看不见。
       * 深色背景 + 白字（button.main 的正常形态）完全没问题，不该报。
       */
      const lightBg = /--primary-soft|--card-a|--card-n|--bg\b|--hairline|^\s*#e|^\s*#f/i.test(bg)
      const whiteText = /^#fff(fff)?$/i.test(color.trim())
      expect(
        whiteText && lightBg,
        `button.${variant}:hover 是白字配浅底（背景 ${bg}）—— 文字会消失`
      ).toBe(false)
    }
  })
})
