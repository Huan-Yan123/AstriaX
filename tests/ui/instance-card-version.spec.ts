// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'fs'
import { join } from 'path'
import InstanceCard from '../../src/renderer/src/InstanceCard.vue'

/**
 * ★ 版本号的位置（主人 2026-10-08 截图反馈：「版本显示的位置怪怪的」）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 现场
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 原来卡片长这样（截图里的实际排版）：
 *
 *     NapCat 实例    [NapCat]              v4.18.33   [启动] [WebUI]
 *     ↑ 名字与徽章                     ↑ 飘在这     ↑ 按钮
 *
 * 版本号孤零零贴在按钮左边，读起来像**按钮的附属标签**（"启动 v4.18.33"？），
 * 而不是"这个实例跑的是哪个版本"。
 *
 * 根因：`.ver` 上有 `margin-left: auto`，本意是"推到 header 最右侧"——
 * 但 header 只是 grid 的第一列，它的右边缘**紧挨着操作按钮**。
 * 于是"推到所属容器最右"= "贴到按钮旁边"。
 *
 * ## 修法与判据
 *
 * 版本跟着**名字 + 类型徽章**那一组走（它们一起回答"这是个什么实例"），
 * 而不是飘到右边缘（那里回答的是"能对它做什么"）。
 *
 * 这条测试从**样式**入手断言（DOM 结构不变，改的是排版意图）：
 *   · `.ver` 不许再有 `margin-left: auto`（那正是把版本推到按钮旁的元凶）
 *   · 名字 `.h3` 必须是**唯一可伸缩**的那项（长名字自己省略，
 *     不能把版本标挤出去）
 */
const CARD = readFileSync(
  join(process.cwd(), 'src', 'renderer', 'src', 'InstanceCard.vue'),
  'utf8'
)

describe('★ 实例卡片：版本号的位置', () => {
  it('★★ `.ver` 不能有 margin-left:auto（那会把它推到按钮旁边）', () => {
    const block = /\.ver\s*\{([\s\S]*?)\}/.exec(CARD)
    expect(block, '找不到 .ver 样式').toBeTruthy()
    expect(
      /margin-left\s*:\s*auto/.test(block![1]),
      '`.ver` 又有 margin-left:auto 了 —— 它会把版本号推到 header 最右侧，\n' +
        '而那里紧挨着「启动/停止」按钮，看起来像按钮的附属标签。\n' +
        '版本应当跟在名字和类型徽章后面（一起说明"这是什么实例"）。'
    ).toBe(false)
  })

  it('★ 版本标紧跟类型徽章（DOM 顺序：名字 → 徽章 → 版本）', () => {
    const wrap = mount(InstanceCard, {
      props: {
        inst: {
          id: 'n_test',
          type: 'n',
          name: 'NapCat 实例',
          status: 'stopped',
          port: 6200,
          runtimeVersion: '4.18.33'
        }
      } as never
    })
    const header = wrap.find('header')
    expect(header.exists(), '卡片应当有 header').toBe(true)

    const children = Array.from(header.element.children).map((el) => el.className)
    const iName = children.findIndex((c) => c === '')
    const iBadge = children.findIndex((c) => c.includes('badge'))
    const iVer = children.findIndex((c) => c.includes('ver'))

    expect(iBadge, '找不到类型徽章').toBeGreaterThan(-1)
    expect(iVer, '找不到版本标').toBeGreaterThan(-1)
    expect(
      iVer,
      '版本标应当在类型徽章**之后**（DOM 顺序：名字 → 徽章 → 版本）'
    ).toBeGreaterThan(iBadge)
    void iName
  })

  it('★ 名字是唯一可伸缩项（长名字自己省略，不挤出版本标）', () => {
    const h3 = /h3\s*\{([\s\S]*?)\}/.exec(CARD)
    expect(h3, '找不到 h3 样式').toBeTruthy()
    expect(
      /flex\s*:\s*1\s+1\s+auto|flex\s*:\s*1(;|\s)/.test(h3![1]),
      'h3 没有设成可伸缩（flex:1 1 auto）——\n' +
        '那样长名字会把版本标挤出可视范围，而不是自己显示省略号'
    ).toBe(true)
    expect(
      /min-width\s*:\s*0/.test(h3![1]),
      'h3 缺 min-width:0 —— flex item 默认 min-width:auto，\n' +
        '会被内容撑开，text-overflow:ellipsis 永远不会生效'
    ).toBe(true)
  })

  it('★ 徽章与版本标都不可伸缩（flex:none），免得被名字压扁', () => {
    for (const sel of ['.badge', '.ver']) {
      const block = new RegExp(`${sel.replace('.', '\\.')}\\s*\\{([\\s\\S]*?)\\}`).exec(CARD)
      expect(block, `找不到 ${sel} 样式`).toBeTruthy()
      expect(
        /flex\s*:\s*none/.test(block![1]),
        `${sel} 应当 flex:none —— 否则名字长的时候它会被压变形`
      ).toBe(true)
    }
  })

  it('★★ header 不能吃满整列（否则会把徽章/版本顶到按钮旁）', () => {
    /*
     * 这是"版本贴到按钮上"的**真正根因**（第二次截图才暴露）：
     *
     *   · header 是 grid 第一列（`minmax(180px, 1fr)`），宽屏上很宽
     *   · header 默认 `justify-self: stretch` → 盒子占满整列
     *   · 内部名字又是 `flex:1`（吃剩余空间）→ 徽章和版本被顶到列右边缘
     *   · 那个边缘紧挨着操作按钮 → 视觉上"粘"在一起
     *
     * 修法是两层：`justify-self: start`（header 只占内容宽度）
     * + 名字改成 `flex: 0 1 auto`（不再吃剩余空间）。
     * 缺任何一层都会退回到"贴在一起"。
     */
    const header = /header\s*\{([\s\S]*?)\}/.exec(CARD)
    expect(header, '找不到 header 样式').toBeTruthy()
    expect(
      /justify-self\s*:\s*start/.test(header![1]),
      'header 缺 `justify-self: start` —— 它会占满整个 grid 列，\n' +
        '把徽章和版本号顶到列的右边缘（紧挨着操作按钮）'
    ).toBe(true)

    const h3 = /h3\s*\{([\s\S]*?)\}/.exec(CARD)
    expect(h3, '找不到 h3 样式').toBeTruthy()
    /*
     * ★ 断言前必须**去掉注释**：我的说明里引用了旧的 `flex: 1 1 auto`
     *（写"为什么不能这样"时自然要提到它），
     * 不剥离的话正则命中的是**注释文字**而不是真实规则 —— 假红。
     */
    const h3Rule = h3![1].replace(/\/\*[\s\S]*?\*\//g, '')
    expect(
      /flex\s*:\s*1\s+1\s+auto/.test(h3Rule),
      'h3 又变成 `flex: 1 1 auto` 了 —— 那会让名字吃光剩余空间，\n' +
        '把徽章和版本推到按钮旁边。应当是 `flex: 0 1 auto`\n' +
        '（允许收缩以显示省略号，但不增长）。'
    ).toBe(false)
    expect(
      /flex\s*:\s*0\s+1\s+auto/.test(h3Rule),
      'h3 应当是 `flex: 0 1 auto`（可收缩、不增长）'
    ).toBe(true)
  })

  it('★★ 信息列与操作列之间必须有间距（不能贴在一起）', () => {
    const card = /\.card\s*\{([\s\S]*?)\}/.exec(CARD)
    expect(card, '找不到 .card 样式').toBeTruthy()
    /*
     * 原来 `display:grid` 只有 `align-items:center`，**没有任何 gap** ——
     * 于是第一列内容一旦顶到右边缘，就和按钮之间连 1px 都不剩。
     * 截图里版本号"粘"在「启动」上就是这个。
     */
    expect(
      /(column-)?gap\s*:\s*\d/.test(card![1]),
      '.card 的 grid 没有设 column-gap —— 信息区会紧贴操作按钮。\n' +
        '版本号粘在「启动」上就是这个原因。'
    ).toBe(true)
  })
})
