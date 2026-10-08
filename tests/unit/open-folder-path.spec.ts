import { describe, expect, it } from 'vitest'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'
import { testStage } from '../helpers/stage'
import { mkdirSync } from 'fs'
import { join, resolve } from 'path'

/**
 * `backup:openFolder` 的路径校验 —— 这个入参最终会进 `shell.openPath`。
 *
 * 这条测试守的是两个很容易写错的点：
 *   1) **目录边界**：`backups-evil` 也以 `backups` 开头，光用 startsWith 会放行
 *      「长得像但其实是隔壁」的目录；
 *   2) **路径规范化**：`backups\..\..\Windows` 字面上带着合法前缀，
 *      解析之后却已经在数据根外面了 —— 不比规范路径就拦不住。
 *
 * 这类校验的意义是**纵深防御**：即使渲染层被 XSS 之类的手段影响，
 * 主进程也不该变成"打开任意路径"的工具。
 */
describe('backup:openFolder 路径校验', () => {
  /** 造一个能用的 handler 集合，并把 openPath 换成记录器 */
  async function setup(): Promise<{
    root: string
    opened: string[]
    call: (folder: string) => Promise<unknown>
  }> {
    const root = testStage('open-folder-')
    mkdirSync(join(root, 'runtimes', 'a', 'v4.28.0'), { recursive: true })
    const opened: string[] = []
    const h = buildHandlers({
      probe: async () => true,
      processManager: createProcessManager(),
      openPath: async (p: string) => {
        opened.push(p)
        return ''
      }
    })
    await h['config:set']({ dataRoot: root })
    return { root, opened, call: (folder: string) => h['backup:openFolder'](folder) }
  }

  it('数据根下的备份目录：允许打开', async () => {
    const { root, opened, call } = await setup()
    // 注意：backupsFolderFor 返回的是 data\instances（每实例的 backups 都在它下面），
    // 不是 data\backups —— 我一开始按后者写，测试直接把「合法路径」判成了非法。
    const base = join(root, 'instances')
    await call(base)
    expect(opened, '正常的备份目录应该被放行').toHaveLength(1)
    expect(opened[0]).toBe(resolve(base))
  })

  it('备份目录的子目录（某实例的 backups）：允许打开', async () => {
    const { root, opened, call } = await setup()
    const sub = join(root, 'instances', 'NapCat', 'n_abc123', 'backups')
    await call(sub)
    expect(opened).toHaveLength(1)
  })

  it('同前缀的兄弟目录（instances-evil）：拒绝', async () => {
    /*
     * 这是最容易漏的一种。`E:\...\data\instances-evil`.startsWith(`E:\...\data\instances`)
     * 是 true —— 光靠 startsWith 就会放行。
     */
    const { root, opened, call } = await setup()
    await expect(call(join(root, 'instances-evil'))).rejects.toThrow(/不允许/)
    expect(opened, '不该真的去打开它').toHaveLength(0)
  })

  it('用 .. 穿越出数据根：拒绝', async () => {
    const { root, opened, call } = await setup()
    // 字面上以 instances 开头，规范化后跑到数据根外面
    await expect(call(join(root, 'instances', '..', '..', 'Windows'))).rejects.toThrow(/不允许/)
    expect(opened).toHaveLength(0)
  })

  it('数据根本身：拒绝（不是备份目录）', async () => {
    const { root, opened, call } = await setup()
    await expect(call(root)).rejects.toThrow(/不允许/)
    expect(opened).toHaveLength(0)
  })
})
