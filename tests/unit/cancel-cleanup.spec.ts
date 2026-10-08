import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { makeStage } from '../../src/main/util/workdir'
import { testStage } from '../helpers/stage'

let root = ''
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

/**
 * 主人 2026-10-08：
 *   「确保取消安装任务会清理掉这些没用的文件」
 *
 * ## 为什么这件事必须成立
 *
 * 取消一个装到一半的任务，会留下：
 *   · 下了一半的 zip（几十上百 MB）
 *   · 解压到一半的目录（上万个文件）
 *
 * 不清理的后果不只是占空间 —— 更实际的是：
 *   **用户取消后立刻重装，会撞上一个残缺的目录**，
 *   于是重装失败，而报错完全指不到"这是上次取消留下的"。
 *
 * ## 契约
 *
 *   · 正常完成 → 暂存目录必须没了
 *   · 中途失败/取消 → 暂存目录**也必须**没了
 *   · 无论哪条路径，都不许把暂存目录留在磁盘上
 *
 * 这靠 `finally { removeDirAsync(stage) }` 保证 —— 这个测试就是钉住
 * "清理挂在 finally 上"这个事实：如果在 try 里清，取消路径（throw 出去）
 * 会直接跳过清理。
 */
describe('★ 安装暂存目录必须被清理（含取消路径）', () => {
  it('makeStage 建出的目录在项目 data 下，且可被清理函数删除', async () => {
    root = testStage('cancel-cleanup-')
    const stage = makeStage(root, 'py')
    // 造点内容，模拟"下了一半的包"
    mkdirSync(join(stage, 'sub'), { recursive: true })
    writeFileSync(join(stage, 'python.zip'), 'partial', 'utf8')
    expect(existsSync(stage)).toBe(true)

    const { removeDirAsync } = await import('../../src/main/util/workdir')
    await removeDirAsync(stage)
    expect(existsSync(stage), '清理后暂存目录必须消失').toBe(false)
  })

  it('清理是幂等的：目录已经没了也不报错（取消与 finally 可能都调一次）', async () => {
    root = testStage('cancel-cleanup2-')
    const stage = makeStage(root, 'py')
    const { removeDirAsync } = await import('../../src/main/util/workdir')
    await removeDirAsync(stage)
    // 第二次不该抛
    await expect(removeDirAsync(stage)).resolves.not.toThrow()
  })

  it('源码守卫：python:install 的清理必须写在 finally 里', () => {
    /*
     * 为什么查源码形状：这是**控制流**约束，运行时测不出来 ——
     * 用假的 run 无法区分"取消时执行了清理"还是"取消时跳过了清理"。
     * 把清理写在 try 里的话，catch 里 throw e 会直接跳过它。
     */
    const { readFileSync } = require('fs') as typeof import('fs')
    const { join: pjoin } = require('path') as typeof import('path')
    const src = readFileSync(pjoin(__dirname, '..', '..', 'src', 'main', 'ipc.ts'), 'utf8')
    const start = src.indexOf("'python:install'")
    expect(start, '找不到 python:install').toBeGreaterThan(0)
    const body = src.slice(start, start + 9000)
    const finallyIdx = body.indexOf('} finally {')
    const cleanupIdx = body.indexOf('removeDirAsync(stage)')
    expect(finallyIdx, '必须有 finally 块').toBeGreaterThan(0)
    expect(cleanupIdx, '必须有清理调用').toBeGreaterThan(0)
    expect(
      cleanupIdx > finallyIdx,
      '清理必须放在 finally 里 —— 放 try 里的话取消时会跳过，半成品目录就留下了'
    ).toBe(true)
  })
})
