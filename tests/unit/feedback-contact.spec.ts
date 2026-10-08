/*
 * ★ 联系方式必须**处处一致、且原生错误框也有**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么需要这条（主人 2026-09-27 指出的遗漏）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 他的要求是「在报错弹窗和设置里附上联系方式 2250713669，标注问题反馈QQ」，
 * 后来加了「设置的问题反馈加入官方群 1077554004」。
 *
 * 我第一版只加在了**自研弹窗**（`App.vue`）和**设置页**（`SettingsPanel.vue`）——
 * 而**系统原生错误框**（`dialog.showErrorBox`）漏了：
 *   · `crash-handler.ts`  —— 「AstriaX 崩溃了」
 *   · `boot-watch.ts`     —— 「没能正常打开 / 连续崩溃了」
 *   · `index.ts`          —— 「启动失败」（窗口都没创建出来）
 *
 * 他实测崩溃时看到的正是那个原生框，里面**没有联系方式** ——
 * 而"软件崩了/打不开"恰恰是最需要联系人帮忙的时刻。
 *
 * ## 这条测试钉什么
 *
 *   ① 主进程和渲染层**两份常量值一致**（它们是两个打包域，故意的重复）
 *   ② 三处原生错误框**都带上了联系方式**
 *   ③ 联系方式**不能只在一个地方**
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { FEEDBACK_QQ, OFFICIAL_GROUP, FEEDBACK_LINES } from '../../src/main/feedback'

const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8')

describe('★联系方式：处处一致', () => {
  it('主进程常量本身正确', () => {
    expect(FEEDBACK_QQ).toBe('2250713669')
    expect(OFFICIAL_GROUP).toBe('1077554004')
    expect(FEEDBACK_LINES, '原生框用的那两行要含 QQ 和群号').toContain(FEEDBACK_QQ)
    expect(FEEDBACK_LINES).toContain(OFFICIAL_GROUP)
  })

  it('★渲染层的两份常量与主进程一致（两个打包域，值不能漂移）', () => {
    const app = read('src', 'renderer', 'src', 'App.vue')
    const settings = read('src', 'renderer', 'src', 'SettingsPanel.vue')

    /* App.vue 的 FEEDBACK_QQ */
    const m1 = /const FEEDBACK_QQ = '(\d+)'/.exec(app)
    expect(m1, 'App.vue 里找不到 FEEDBACK_QQ').toBeTruthy()
    expect(m1![1], '★App.vue 的 QQ 与主进程不一致').toBe(FEEDBACK_QQ)

    /* SettingsPanel.vue 的 FEEDBACK_QQ 与 OFFICIAL_GROUP */
    const m2 = /const FEEDBACK_QQ = '(\d+)'/.exec(settings)
    expect(m2, 'SettingsPanel 里找不到 FEEDBACK_QQ').toBeTruthy()
    expect(m2![1], '★设置页的 QQ 与主进程不一致').toBe(FEEDBACK_QQ)

    const m3 = /const OFFICIAL_GROUP = '(\d+)'/.exec(settings)
    expect(m3, '设置页里找不到 OFFICIAL_GROUP').toBeTruthy()
    expect(m3![1], '★设置页的群号与主进程不一致').toBe(OFFICIAL_GROUP)
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
      /FEEDBACK_QQ/.test(app) && /FEEDBACK_LINE/.test(app),
      'App.vue 的弹窗文案里要带联系方式（主人第一版就要求的地方）'
    ).toBe(true)
  })
})
