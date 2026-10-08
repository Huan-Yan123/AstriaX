/*
 * ★ 联系方式必须**处处一致、且原生错误框也有**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么需要这条（主人 2026-09-27 指出的遗漏）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 他要求「在报错弹窗和设置里附上联系方式」，我第一版只加在了**自研弹窗**
 *（`App.vue`）和**设置页**（`SettingsPanel.vue`）—— 而**系统原生错误框**
 *（`dialog.showErrorBox`）漏了：
 *   · `crash-handler.ts`  —— 「AstriaX 崩溃了」
 *   · `boot-watch.ts`     —— 「没能正常打开 / 连续崩溃了」
 *   · `index.ts`          —— 「启动失败」（窗口都没创建出来）
 *
 * 他实测崩溃时看到的正是那个原生框，里面**没有联系方式** ——
 * 而"软件崩了/打不开"恰恰是最需要找人帮忙的时刻。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 2026-10-08：渠道收敛为**只有官方群**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人原话：「去掉这个，去掉全部个人 QQ 号，必要的地方替换成群号」
 *          「更换成群号之后，关联的文案也要优化」
 *
 * 所以这条测试现在多守一件事：**个人 QQ 不许出现在任何地方**。
 * 那不只是"换个号"—— 个人号写进软件里，等于把一个可能需要长期
 * 维护的联系方式绑死在一个人身上；而群是"一群人"，不会因为某个人
 * 不在线就失效，答案也能被后来的人搜到。
 *
 * ## 这条测试钉什么
 *
 *   ① 主进程和渲染层**几份常量值一致**（它们是不同打包域，故意的重复）
 *   ② 三处原生错误框**都带上了联系方式**
 *   ③ **个人 QQ 号彻底不存在**（防止谁又把它加回来）
 *   ④ 文案是**群的语境**（不能还是"加我 QQ 找我"那种单人表述）
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { OFFICIAL_GROUP, FEEDBACK_LINES } from '../../src/main/feedback'

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8')

/**
 * 已被废弃的个人 QQ。
 *
 * 写在这里而不是"删掉就忘了"：它是这条测试要**主动搜索**的字符串 ——
 * 只要它在任何源文件里出现（哪怕是被谁不小心粘回来），测试就红。
 */
const REMOVED_PERSONAL_QQ = '2250713669'

/** 需要检查的全部源文件（这些里面都不许有个人号） */
const SOURCE_FILES = [
  ['src', 'main', 'feedback.ts'],
  ['src', 'main', 'logs', 'crash-handler.ts'],
  ['src', 'main', 'logs', 'boot-watch.ts'],
  ['src', 'main', 'index.ts'],
  ['src', 'renderer', 'src', 'App.vue'],
  ['src', 'renderer', 'src', 'SettingsPanel.vue'],
  ['src', 'renderer', 'src', 'DownloadPage.vue'],
  ['src', 'renderer', 'src', 'stores', 'dialog.ts']
]

describe('★联系方式：处处一致', () => {
  it('主进程常量：只有群号，且文案用群的语境', () => {
    expect(OFFICIAL_GROUP).toBe('1077554004')
    expect(FEEDBACK_LINES, '原生框那行要含群号').toContain(OFFICIAL_GROUP)
    expect(
      FEEDBACK_LINES.includes('加我') || FEEDBACK_LINES.includes('找我'),
      '文案不能还是"加我/找我"—— 换成群之后那个主语不成立了，\n' +
        '群里是互相帮忙，不是找客服。应当写"去群里问"。'
    ).toBe(false)
  })

  it('★★ 个人 QQ 号必须**彻底不存在**（防止被加回来）', () => {
    const offenders: string[] = []
    for (const f of SOURCE_FILES) {
      let src = ''
      try {
        src = read(...f)
      } catch {
        continue /* 文件可能不存在（比如 boot-watch 被合并过） */
      }
      /*
       * 只在**代码**里找，跳过注释 —— 注释里可能正在记录
       * "原来这里有个个人号，现已移除"，那是合理的历史说明。
       *
       * ★ 必须处理**跨行**块注释。
       *
       * 我第一版用的正则不跨行，于是 `dialog.ts` 顶部那段多行注释里
       * 提到的号被当成"代码残留"，报了一个假红。下面这个正则用
       * `[\s\S]` 才能跨行匹配。
       */
      const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '')
      const codeOnly = noBlockComments
        .split('\n')
        .map((l) => l.replace(/\/\/.*$/, ''))
        .join('\n')
      if (codeOnly.includes(REMOVED_PERSONAL_QQ)) offenders.push(f.join('/'))
    }
    expect(
      offenders,
      `这些文件的**代码**里还有个人 QQ ${REMOVED_PERSONAL_QQ}：\n` +
        `  ${offenders.join('\n  ')}\n` +
        '请改成官方群（OFFICIAL_GROUP），文案同步改成群的语境。'
    ).toEqual([])
  })

  it('★渲染层的几份常量与主进程一致（不同打包域，值不能漂移）', () => {
    const app = read('src', 'renderer', 'src', 'App.vue')
    const settings = read('src', 'renderer', 'src', 'SettingsPanel.vue')
    const dialog = read('src', 'renderer', 'src', 'stores', 'dialog.ts')
    const download = read('src', 'renderer', 'src', 'DownloadPage.vue')

    const pick = (src: string, name: string): string | undefined =>
      new RegExp(`const ${name} = '(\\d+)'`).exec(src)?.[1]

    const pairs: Array<[string, string | undefined]> = [
      ['App.vue', pick(app, 'OFFICIAL_GROUP')],
      ['SettingsPanel.vue', pick(settings, 'OFFICIAL_GROUP')],
      ['stores/dialog.ts', pick(dialog, 'OFFICIAL_GROUP')],
      ['DownloadPage.vue', pick(download, 'OFFICIAL_GROUP')]
    ]
    for (const [file, val] of pairs) {
      expect(val, `${file} 里找不到 OFFICIAL_GROUP`).toBeTruthy()
      expect(val, `★${file} 的群号与主进程不一致（用户照着它会加不进去）`).toBe(OFFICIAL_GROUP)
    }
  })

  it('★★三处**原生**错误框都带上了联系方式', () => {
    /*
     * 原生框（dialog.showErrorBox）在主进程里，崩溃时渲染层可能已经没了，
     * 所以它必须自己带上联系方式 —— 这正是第一版漏掉的地方。
     */
    const crash = read('src', 'main', 'logs', 'crash-handler.ts')
    expect(
      crash.includes('FEEDBACK_LINES'),
      '★崩溃框（AstriaX 崩溃了）没带联系方式 ——\n' +
        '那是用户最需要联系方式的时刻（软件崩了，不知道该找谁）'
    ).toBe(true)

    const boot = read('src', 'main', 'logs', 'boot-watch.ts')
    expect(
      boot.includes('FEEDBACK_LINES'),
      '★「没能正常打开 / 连续崩溃」的框没带联系方式'
    ).toBe(true)

    const index = read('src', 'main', 'index.ts')
    expect(
      index.includes('FEEDBACK_LINES'),
      '★「启动失败」的框没带联系方式（窗口都没创建出来，用户更懵）'
    ).toBe(true)
  })

  it('★自研弹窗（App.vue）也带着 —— 那是"当下出问题"的主场景', () => {
    const app = read('src', 'renderer', 'src', 'App.vue')
    expect(
      /OFFICIAL_GROUP/.test(app) && /FEEDBACK_LINE/.test(app),
      'App.vue 的弹窗文案里要带群号（主人第一版就要求的地方）'
    ).toBe(true)
  })

  it('★设置页的反馈文案是群的语境（不是"加我 QQ 找我"）', () => {
    const settings = read('src', 'renderer', 'src', 'SettingsPanel.vue')
    /*
     * ★ 切片必须**卡在 </template>**，不能从 <template> 一路取到文件末尾
     *（那会把 <style> 和后面的内容也算进来）。
     *
     * 我第一版就是没卡右边界，于是断言扫到了模板之外 —— 而
     * `expect(tpl.includes('找我'))` 在样式里恰好命中了某个词，
     * 报了一个和文案无关的假红。
     */
    const start = settings.indexOf('<template>')
    const end = settings.indexOf('</template>')
    expect(start, '找不到 <template>').toBeGreaterThan(-1)
    expect(end, '找不到 </template>').toBeGreaterThan(start)
    /*
     * ★ 还要去掉 **HTML 注释**（`<!-- ... -->`）。
     *
     * Vue 的 `<template>` 里可以有 HTML 注释，而它们**保留在文件里** ——
     * 我在那段反馈区块上方写了一段解释"为什么改成群的语境"的注释，
     * 里面自然引用了旧措辞「加这个 QQ 找我」。第一版测试因此报假红：
     * 它扫到了**解释文案的注释**，而不是真正的界面文案。
     */
    const tpl = settings.slice(start, end).replace(/<!--[\s\S]*?-->/g, '')

    expect(tpl, '设置页要展示群号').toContain('OFFICIAL_GROUP')
    expect(
      tpl.includes('加这个 QQ') || tpl.includes('找我'),
      '设置页还留着"加这个 QQ / 找我"的旧文案 —— 换成群之后要重写'
    ).toBe(false)
    expect(tpl, '文案里应当讲清群的好处（可能有人遇到过）').toMatch(/群里/)
  })
})
