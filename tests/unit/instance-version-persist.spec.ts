/*
 * ★★ 实例的版本号必须在**每次启动后**仍然正确
 *
 * 主人 2026-09-27 实测（原话）：
 *   「只要启动过就会变成版本未知，
 *    但是其实 astrbot 启动日志已经写明了的」
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 根因
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `instance:start` 里每次启动都会重读真实版本并写回记录：
 *
 *     detectInstanceVersion({ type, instanceDir: rec.dir, runtimeDir: spec.cwd })
 *                                                                   ^^^^^^^^^
 * 而 AstrBot 的 `spec.cwd` 是**实例目录**（必须是 —— AstrBot 的
 * `get_astrbot_root()` 取 cwd，`.astrbot` 标记落在实例目录里）。
 *
 * 拿实例目录去读版本 → 读不到 → 每次启动都把 `undefined` 写回记录 →
 * 卡片显示「版本未知呢」。
 *
 * ## 实测证据（本文件就是把它钉下来）
 *
 * 对同一个实例：
 *     传运行时目录 → "4.28.1"   ✔
 *     传实例目录   → undefined  ✘
 *
 * 正确来源是 `spec.env.MXBOT_SITE`（layout.ts 明确写着 `MXBOT_SITE: deps.dir`，
 * 即运行时目录）。
 */
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { testStage } from '../helpers/stage'
import { detectInstanceVersion } from '../../src/main/runtime/instance-version'

describe('★★实例版本号：不能因为启动一次就丢掉', () => {
  it('★传运行时目录能读到版本（正确用法）', () => {
    const root = testStage('ver-rt-')
    try {
      const rtDir = join(root, 'runtimes', 'a', 'v4.28.1')
      mkdirSync(join(rtDir, 'astrbot'), { recursive: true })
      /* 包内权威标识：__init__.py 的 __version__ */
      writeFileSync(
        join(rtDir, 'astrbot', '__init__.py'),
        '__version__ = "4.28.1"\n',
        'utf8'
      )
      const instDir = join(root, 'instances', 'AstrBot', 'a_x')
      mkdirSync(instDir, { recursive: true })
      writeFileSync(
        join(instDir, 'instance.json'),
        JSON.stringify({ id: 'a_x', type: 'a', runtimeTag: 'v4.28.1' }),
        'utf8'
      )

      expect(
        detectInstanceVersion({ type: 'a', instanceDir: instDir, runtimeDir: rtDir }),
        '传对目录时必须读到版本'
      ).toBe('4.28.1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('★★传实例目录也能读到（修好 readJsonFile 导入之后）', () => {
    /*
     * ══════════════════════════════════════════════════════════════════════════
     * ★ 这条测试的语义**被一次修复反转了**（如实记录）
     * ══════════════════════════════════════════════════════════════════════════
     *
     * 我第一版写它时断言的是「传实例目录 → **读不到**」，因为那时确实读不到：
     * `detectInstanceVersion` 的第 ② 层（读 instance.json 的 runtimeTag）
     * 调了 `readJsonFile` 而**那个文件没导入** → 永远抛 ReferenceError →
     * 被静默 catch 吞掉 → 只能退到最不可靠的第 ③ 层（目录名）。
     *
     * 这是第二版排查报告的 C-3，我随后补上了导入。**导入之后第 ② 层活了**，
     * 于是"传实例目录也能读到版本"成立 —— 旧断言自然失效。
     *
     * ## 为什么保留这条（而不是删掉）
     *
     * 它现在守的是**第 ② 层的可用性**：
     * 只要有 `instance.json`，即使 `runtimeDir` 指错了地方（比如传了实例目录），
     * 版本号仍然读得出来 —— 这正是"三层兜底"里第 ② 层的价值。
     *
     * 而第 ① 层（包内标识）此时读不到（实例目录里没有 AstrBot 包），
     * 所以这条顺带证明了"兜底真的会往下走"。
     */
    const root = testStage('ver-inst-')
    try {
      const instDir = join(root, 'instances', 'AstrBot', 'a_x')
      mkdirSync(instDir, { recursive: true })
      writeFileSync(
        join(instDir, 'instance.json'),
        JSON.stringify({ id: 'a_x', type: 'a', runtimeTag: 'v4.28.1' }),
        'utf8'
      )
      /* 实例目录里没有 AstrBot 包（只有 .astrbot / data / instance.json） */
      writeFileSync(join(instDir, '.astrbot'), '', 'utf8')

      expect(
        detectInstanceVersion({ type: 'a', instanceDir: instDir, runtimeDir: instDir }),
        '★只要有 instance.json，第 ② 层就该读出 runtimeTag（v 前缀会被剥掉）。\n' +
          '如果这里变成 undefined，说明 readJsonFile 又没导入 / 第 ② 层又坏了。'
      ).toBe('4.28.1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('★源码守卫：instance:start 不许再用 spec.cwd 当 runtimeDir', () => {
    /*
     * 这是**接线层**的守卫 —— 上面两条测的是函数本身，
     * 而真正的 bug 在"调用方传错参数"。函数测试永远照不出那种错
     *（本项目反复踩过：组件写好了、调用方没绑 prop）。
     */
    const src = require('fs').readFileSync(
      join(process.cwd(), 'src', 'main', 'ipc.ts'),
      'utf8'
    ) as string
    expect(
      /runtimeDir:\s*spec\.cwd/.test(src),
      'instance:start 又用 spec.cwd（实例目录）当 runtimeDir 了 ——\n' +
        '那会让每次启动都把版本号写成 undefined，卡片显示「版本未知呢」。\n' +
        '正确来源是 `spec.env.MXBOT_SITE`（layout.ts 里的运行时目录）。'
    ).toBe(false)
    expect(
      /MXBOT_SITE/.test(src),
      'instance:start 应当从 spec.env.MXBOT_SITE 取运行时目录'
    ).toBe(true)
  })
})
