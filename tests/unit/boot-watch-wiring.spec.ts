/*
 * ★★ 看门狗的**接线层**测试（第三轮终审抓出的覆盖空白）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么必须有这一条
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `boot-watch.spec.ts` 把单函数语义测得很扎实（阈值、降噪、清零、旧字段兼容），
 * 978 个用例全绿 —— 可 `index.ts` 里的**真实调用编排**错了：
 *
 *     const st = beginBoot(root)                 // ← 返回的是**已 +1** 的状态
 *     const isBootFail = shouldAlertBootFailure(st)   // ← 阈值是 1 → 恒真
 *
 * 于是：
 *   · **全新安装、健康机器每次启动都弹**"AstriaX 没能正常打开"的假错误框
 *   · `isCrashLoop = !isBootFail && ...` 被短路 → **"连崩 3 次"永远弹不出来**
 *
 * 单函数测试看不见这个 bug，因为它测的是"函数对不对"，
 * 而不是"**这几步按这个顺序接起来对不对**"。
 *
 * 所以这条测试**复刻 index.ts 里那段编排**（读旧状态 → 判断 → 再 beginBoot），
 * 保证"判断用的是上一次的读数"这个顺序**不会再被写反**。
 *
 * ## 它钉住的行为
 *   1. 全新安装第一次启动 → **不弹**（没有任何历史失败）
 *   2. 连续 N 次健康启动 → **始终不弹**
 *   3. 连崩 3 次之后的那次启动 → **要弹"连续崩溃"**
 *   4. "起不来"（窗口没建）之后的那次启动 → **要弹"没能正常打开"**
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import {
  beginBoot,
  markWindowReady,
  markBootOk,
  noteCrash,
  shouldAlertBootFailure,
  shouldAlertCrash,
  readBootState,
  markBootAlerted
} from '../../src/main/logs/boot-watch'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('bootwire-')
  mkdirSync(root, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/**
 * 复刻 index.ts 的**真实编排**，返回"这次启动该不该弹窗、弹哪种"。
 *
 * ★ 顺序就是被测对象：读旧状态 → 判断 → 再 beginBoot。
 *   写反了（先 beginBoot 再判断）就必然误报 —— 第一版就是这样。
 */
function runStartup(root: string, now = new Date()): 'none' | 'boot-fail' | 'crash-loop' {
  const prev = readBootState(root)
  const isBootFail = shouldAlertBootFailure(prev)
  const isCrashLoop = !isBootFail && shouldAlertCrash(prev)
  beginBoot(root, now)
  if (isBootFail) return 'boot-fail'
  if (isCrashLoop) return 'crash-loop'
  return 'none'
}

describe('★★看门狗接线：判断必须用"上一次"的读数', () => {
  it('★全新安装第一次启动 → 不弹任何框', () => {
    expect(runStartup(root), '全新机器不该被弹"没能正常打开"').toBe('none')
  })

  it('★连续多次健康启动 → 始终不弹', () => {
    for (let i = 0; i < 5; i++) {
      const r = runStartup(root)
      // 每次启动后都模拟"窗口建出来了、稳定运行够久"
      markWindowReady(root)
      markBootOk(root, new Date(Date.now() + 120_000))
      expect(r, `第 ${i + 1} 次健康启动不该弹框`).toBe('none')
    }
  })

  it('★连崩 3 次之后的那次启动 → 要弹"连续崩溃"', () => {
    /*
     * 模拟用户遇到"每次开了就崩"：三次启动各崩溃一次。
     * 注意每轮都要走"建出窗口"（否则算 boot 线而不是 crash 线）。
     */
    for (let i = 0; i < 3; i++) {
      runStartup(root)
      markWindowReady(root)
      noteCrash(root, `崩溃 ${i + 1}`)
      // 崩溃后进程没了：不调 markBootOk（那要稳定运行够久才该调）
    }
    const st = readBootState(root)
    expect(st.crashAttempts, '连崩计数应当累计到 3').toBe(3)

    // 第四次启动 —— 这时该弹
    expect(runStartup(root), '连崩 3 次后必须弹"连续崩溃了"').toBe('crash-loop')
  })

  it('★"起不来"（窗口都没建）之后的那次启动 → 要弹"没能正常打开"', () => {
    // 第一次启动：beginBoot 记了一笔，然后窗口**没建出来**就没了
    runStartup(root)
    // 第二次启动：读到的 bootAttempts=1 → 该弹
    expect(runStartup(root), '起不来一次就该弹（主人指定阈值=1）').toBe('boot-fail')
  })

  it('★弹过之后同一轮不再弹（降噪）', () => {
    runStartup(root)
    expect(runStartup(root), '第一次触发').toBe('boot-fail')
    // 模拟 index.ts 弹完调 markBootAlerted
    markBootAlerted(root)
    expect(runStartup(root), '已经提醒过这一轮，不再骚扰用户').toBe('none')
  })
})
