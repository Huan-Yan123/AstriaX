/*
 * ★ 守卫：已经没有调用点的渲染层函数 / 变量不该留在文件里
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么需要它
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 这个项目里"定义了但没人调用"反复出现，而且每次都有实际代价：
 *
 *   · `metadataSourceFor`     —— 定义了、有测试、零生产调用（死抽象）
 *   · `onSourceTried`         —— 实现了、调用方不传（下载失败查不出原因）
 *   · `loadPySources`         —— 写好了、忘了在 onMounted 调（Python 源不显示）
 *   · `switchPickType`        —— 切换器删了、函数还在
 *   · `setPySource`           —— 「用这个」删了、函数还在
 *   · `choiceList` prop       —— 组件写好了、调用方没绑（界面毫无变化）
 *
 * 前三个是"忘了接线"，后三个是"拆了没清干净"。**两者都会误导下一个人**：
 * 看到 `setPySource` 还在，会以为"界面还能设首选源"。
 *
 * 所以扫一遍：**函数/常量定义了、但全文件只有定义那一处引用** → 报出来。
 *
 * ## 为什么不直接上 ESLint 的 no-unused-vars
 *
 * 项目里 `vue-tsc`/`tsc --noEmit` 有大量既存报错（不是门禁），
 * 而 ESLint 未配置。挂一个新的 lint 工具链进来风险大于收益。
 * 这里用**极窄的启发式**：只查 `function xxx` / `const xxx = ref(` 形状，
 * 且只查渲染层三个大文件 —— 宁可漏报，不要误报（误报会让人开始无视它）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

/** 去掉注释（行注释 / 块注释），避免"注释里提到"被当成引用 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
}

const FILES = [
  'src/renderer/src/DownloadPage.vue',
  'src/renderer/src/SettingsPanel.vue',
  'src/renderer/src/App.vue'
]

describe('★渲染层：没有调用点的函数/变量不该留着', () => {
  it('三个大文件里没有"定义了却只有定义处引用"的函数', () => {
    const offenders: string[] = []

    for (const rel of FILES) {
      const src = stripComments(readFileSync(join(process.cwd(), rel), 'utf8'))

      /*
       * 只查这几种形状（渲染层的函数都会命中其中之一）：
       *   function xxx(
       *   const xxx = ref(
       *   const xxx = computed(
       *   async function xxx(
       */
      const re = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|(?:^|\n)\s*const\s+(\w+)\s*=\s*(?:ref|computed)\s*[<(]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        const name = m[1] ?? m[2]
        if (!name) continue
        /* 数整个文件里这个名字出现几次（单词边界，避免 xxx2 命中） */
        const uses = (src.match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length
        if (uses <= 1) {
          offenders.push(`${rel}: ${name}（全文件只出现 ${uses} 次 = 只有定义）`)
        }
      }
    }

    expect(
      offenders,
      '这些函数/变量**定义了却没有调用点** ——\n' +
        '留着它们会误导下一个人（看到 `setPySource` 还在，会以为界面还能设首选源）。\n' +
        '要么接上调用，要么删掉。\n  ' +
        offenders.join('\n  ')
    ).toEqual([])
  })
})
