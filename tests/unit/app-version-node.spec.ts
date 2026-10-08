/*
 * `app:version` / `app:checkUpdate` 不能在装配阶段就引用 `app`。
 *
 * 实机报错原文（用户截图里那句）：
 *   Error invoking remote method 'app:checkUpdate':
 *   ReferenceError: app is not defined
 *
 * 根因：ipc.ts 顶层不 import electron（单测跑纯 node），文件里所有用到
 * `app` 的地方都是函数内 `await import('electron')` 懒取。但装配处原来写的是
 *
 *     appVersion: () => app.getVersion(),
 *     downloadsDir: () => app.getPath('downloads'),
 *
 * 这是**对象字面量里的表达式**，在模块装配阶段就会求值 —— 那时 `app`
 * 不在任何作用域里，ReferenceError 当场抛出。
 *
 * 后果不止「检查更新崩」：`app:version` 走的是同一个箭头函数，
 * 所以版本号也拿不到，设置里显示成「MXBot 未知」——
 * 用户报告的第 1 条和第 2 条其实是同一个根因的两个症状。
 *
 * 这个测试在**纯 node**（没有 electron）下跑，正好模拟出问题环境：
 * 只要装配阶段还敢碰 `app`，这里就会红。
 */
import { describe, it, expect } from 'vitest'
import { buildHandlers } from '../../src/main/ipc'
import { testStage } from '../helpers/stage'
import { rmSync } from 'fs'

describe('启动器自身更新 · 纯 node 环境下不能崩', () => {
  it('★不注入 appVersion 时 app:version 也不能抛（懒取 app 的兜底）', async () => {
    const root = testStage('acb-appver-')
    const h = buildHandlers({ probe: () => true, audit: undefined })
    try {
      h['config:set']({ dataRoot: root })
      // 关键：这里**没有**注入 appVersion，走的是生产那条懒取 electron 的实现。
      // 纯 node 下 import('electron') 会失败 —— 但必须是「返回兜底值」，不能抛。
      const v = await h['app:version']()
      expect(typeof v).toBe('string')
      expect(v.length, '版本号不该是空串').toBeGreaterThan(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('★不注入 fetchUpdateManifest 时 app:checkUpdate 要优雅地说「没有更新」', async () => {
    const root = testStage('acb-appchk-')
    const h = buildHandlers({ probe: () => true, audit: undefined, now: () => Date.now() })
    try {
      h['config:set']({ dataRoot: root })
      /*
       * 生产里 fetchUpdateManifest 是注入的；这里不注入，
       * 模拟「通道没就绪」。用户要求：取不到版本就当最新版，
       * **不要**把异常抛到渲染层（那正是那条 ReferenceError 的来源）。
       */
      const r = (await h['app:checkUpdate']({ force: true })) as {
        hasUpdate: boolean
        currentVersion?: string
      }
      expect(r.hasUpdate, '取不到清单时应当当作没有更新').toBe(false)
      expect(typeof r.currentVersion).toBe('string')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('★注入的 appVersion 是异步函数时也要能用（生产就是异步懒取）', async () => {
    const root = testStage('acb-appver2-')
    const h = buildHandlers({
      probe: () => true,
      audit: undefined,
      // 模拟生产：异步返回
      appVersion: async () => '9.9.9',
      fetchUpdateManifest: async () => JSON.stringify({ version: '0.1.1', url: 'http://x/a.exe' })
    })
    try {
      h['config:set']({ dataRoot: root })
      expect(await h['app:version']()).toBe('9.9.9')
      // 9.9.9 比 0.1.1 高 → 没有更新
      const r = (await h['app:checkUpdate']({ force: true })) as {
        hasUpdate: boolean
        currentVersion?: string
      }
      expect(r.currentVersion).toBe('9.9.9')
      expect(r.hasUpdate).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
