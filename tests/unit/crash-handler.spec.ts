import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { createLogger } from '../../src/main/logs/logger'
import { createCrashHandler } from '../../src/main/logs/crash-handler'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('acb-crash-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('createCrashHandler（PCL2 风格独立弹窗）', () => {
  it('崩溃 → 日志落盘 CRASH 行 + zip 同步产出 + PCL2 风格弹窗（**带联系方式**）', () => {
    const shown: Array<{ title: string; content: string }> = []
    const logger = createLogger({
      dataRoot: root,
      dateFor: () => '2026-09-12',
      zipRunnerSync: () => 0
    })
    const handler = createCrashHandler({
      logger,
      dialog: { showErrorBox: (title, content) => shown.push({ title, content }) },
      dataRoot: root
    })
    handler(new TypeError('boom at line 42'))

    const logText = readFileSync(join(root, 'logs', 'app-2026-09-12.log'), 'utf8')
    expect(logText).toContain('[CRASH] [uncaughtException]')
    expect(logText).toContain('TypeError: boom at line 42')

    expect(shown).toHaveLength(1)
    const c = shown[0].content
    expect(c).toContain('崩溃了。已自动生成日志报告')
    expect(c).toContain('原始报错：boom at line 42')
    expect(c).toContain('日志报告在这里')
    expect(c).toContain('.zip')
    /*
     * ★ 契约**反转**了（主人 2026-09-27：「我发现崩溃的窗口没有加联系方式」）
     *
     * 这条原来断言 `not.toMatch(/QQ|微信|TG/)` —— 那是"故意不加联系方式"的旧约定。
     * 他实测崩溃后发现框里没有联系方式，而"软件崩了"恰恰是最需要它的时刻
     *（用户完全不知道该找谁），所以要求加上。
     *
     * 现在反过来断言**必须带**。三处原生框的一致性由
     * `feedback-contact.spec.ts` 统一盯着（防止改一处漏两处）。
     */
    expect(c, '★崩溃框必须带问题反馈 QQ').toContain('2250713669')
    expect(c, '★崩溃框必须带官方群').toContain('1077554004')
    expect(c).toMatch(/问题反馈QQ/)
  })

  it('zip 打包失败也照弹窗：给出原始日志目录兜底文案', () => {
    const shown: Array<{ title: string; content: string }> = []
    const logger = createLogger({
      dataRoot: root,
      zipRunnerSync: () => 1
    })
    const handler = createCrashHandler({
      logger,
      dialog: { showErrorBox: (t, c) => shown.push({ title: t, content: c }) },
      dataRoot: root
    })
    handler(new Error('disk full'))
    expect(shown).toHaveLength(1)
    expect(shown[0].content).toContain('日志报告生成失败')
    expect(shown[0].content).toContain('logs')
    expect(existsSync(join(root, 'logs'))).toBe(true)
  })
})
