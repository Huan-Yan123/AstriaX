import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const SRC = join(process.cwd(), 'src/renderer/src')

function vueFiles(): string[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith('.vue'))
    .map((f) => join(SRC, f))
}

const tokens = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8')

/**
 * 弹窗按钮的「原生 UI 回归」守护。
 *
 * 真实教训：弹窗外壳被各组件各写一遍，某个组件用了 class="main"/"ghost"
 * 却没在 scoped 样式里定义，按钮就退回浏览器默认外观 —— 用户看到的就是
 * 「很多按钮还是原生UI」。这里保证全局兜底始终存在，且弹窗都在用这套类。
 */
describe('弹窗样式统一性', () => {
  it('全局 tokens.css 里备好了 .main/.ghost/.danger 的按钮基线', () => {
    for (const cls of ['button.main', 'button.ghost', 'button.danger']) {
      expect(tokens).toContain(cls)
    }
    // 至少要有圆角和内边距，否则看着就是原生方块
    expect(tokens).toMatch(/button\.main[\s\S]{0,200}border-radius/)
    expect(tokens).toMatch(/button\.main[\s\S]{0,200}padding/)
  })

  it('全局也备好弹窗外壳（.mask/.dlg）基线，组件漏写也不至于裸奔', () => {
    expect(tokens).toMatch(/\.mask\s*\{/)
    expect(tokens).toMatch(/\.dlg\s*\{/)
    expect(tokens).toMatch(/\.dlg \.row\s*\{/)
  })

  it('用到 .main/.ghost 的组件不会因为「全局没基线」而裸奔', () => {
    // 全局基线覆盖 button.main / button.ghost / button.danger，
    // 所以只要模板里的按钮真带了这些类，外观一定有人管。
    // 这里只验证真问题：模板用了类，但既没有全局基线、也没有任何选择器命中它。
    const offenders: string[] = []
    for (const file of vueFiles()) {
      const src = readFileSync(file, 'utf8')
      const styleStart = src.indexOf('<style')
      const tpl = styleStart > 0 ? src.slice(0, styleStart) : src
      const style = styleStart > 0 ? src.slice(styleStart) : ''

      // 抓出 <button ... class="..."> 里的类名
      const classAttrs = [...tpl.matchAll(/<button[^>]*class="([^"]+)"/g)].map((m) => m[1])
      const used = new Set<string>()
      for (const attr of classAttrs) {
        for (const c of ['main', 'ghost', 'danger']) {
          if (new RegExp(`\\b${c}\\b`).test(attr)) used.add(c)
        }
      }
      for (const c of used) {
        const globalCovered = new RegExp(`button\\.${c}\\b`).test(tokens)
        // 组件自己有没有任何选择器能让这个类生效（做后代/复合都算）
        const localCovered = new RegExp(`[.\\s>]${c}\\s*[,{]|\\.${c}\\s*[,{]`).test(style)
        if (!globalCovered && !localCovered) {
          offenders.push(`${file.split(/[\\/]/).pop()} 用了 .${c} 但没人给它样式`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('没有组件再自造第三套弹窗外壳类名（.modal/.popup 之类各自为政）', () => {
    const stray: string[] = []
    for (const file of vueFiles()) {
      const src = readFileSync(file, 'utf8')
      // 允许已有的 .dlg/.mask；不允许再发明新的全屏遮罩类
      for (const bad of ['.modal', '.popup', '.overlay', '.dialog-mask']) {
        if (new RegExp(`\\${bad}\\s*\\{`).test(src)) stray.push(`${file.split(/[\\/]/).pop()} 自定义了 ${bad}`)
      }
    }
    expect(stray).toEqual([])
  })
})
