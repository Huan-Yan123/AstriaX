/*
 * 应用内自更新（electron-updater 封装）的单测。
 *
 * ## 这里守的是什么
 *
 * 1. **两条硬约束**（主人的明确要求：「更新只能是用户运行更新版本的安装包」）：
 *    `autoDownload=false`、`autoInstallOnAppQuit=false`。
 *    electron-updater 最省事的路子（下载完退出时静默安装）**正好违反它** ——
 *    所以必须由测试盯着，而不是靠注释承诺。
 * 2. **监听器不许累积**：electron-updater 的 on() 是累加的，反复下载会
 *    攒出一串回调（进度乱跳 + 挂住无用闭包）。本项目在别处踩过同类坑。
 * 3. **回调形状要对**：进度映射成界面认的 {percent, got, total}；
 *    下载完成要把安装包拷到用户下载目录（界面文案承诺了"保存在…双击"）。
 * 4. 开发态（未打包）与出错时**不能抛出去**：调用方要能安静回落到老路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { createAppUpdater, type UpdaterLike } from '../../src/main/update/app-updater'
import { testStage } from '../helpers/stage'

let root: string

/** 一个可编程的假 autoUpdater（记录事件订阅与调用） */
function fakeUpdater(opts: { checkResult?: unknown; checkThrows?: boolean } = {}): {
  up: UpdaterLike
  listeners: Map<string, Array<(...a: unknown[]) => void>>
  emit: (event: string, ...args: unknown[]) => void
  onCount: (event: string) => number
} {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
  const up: UpdaterLike = {
    autoDownload: true, // 故意先设成 true，验证封装会把它按下去
    autoInstallOnAppQuit: true, // 同上：这条最危险（退出时静默安装）
    on(event, cb) {
      const arr = listeners.get(event) ?? []
      arr.push(cb)
      listeners.set(event, arr)
    },
    removeListener(event, cb) {
      const arr = listeners.get(event) ?? []
      listeners.set(
        event,
        arr.filter((x) => x !== cb)
      )
    },
    async checkForUpdates() {
      if (opts.checkThrows) throw new Error('网络失败')
      /*
       * 注意这里不能用 `opts.checkResult ?? 默认值`：
       * `null` 在 ?? 里算"没传"，于是"没有新版（null）"那条用例会被
       * 静默当成"默认有新版"，断言就红了 —— 又是"探针自己坏了"。
       * 用 `in` 判断有没有显式传。
       */
      return 'checkResult' in opts ? opts.checkResult : { updateInfo: { version: '0.1.4' } }
    },
    async downloadUpdate() {
      return undefined
    }
  }
  return {
    up,
    listeners,
    emit: (event, ...args) => {
      for (const cb of [...(listeners.get(event) ?? [])]) cb(...args)
    },
    onCount: (event) => (listeners.get(event) ?? []).length
  }
}

const deps = (up: UpdaterLike, extra: Record<string, unknown> = {}) =>
  ({
    log: () => undefined,
    isPackaged: true,
    downloadDir: async () => join(root, 'Downloads'),
    updater: up,
    ...extra
  }) as never

beforeEach(() => {
  root = testStage('app-updater-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('★electron-updater 封装：硬约束', () => {
  it('★构造时就把 autoDownload / autoInstallOnAppQuit 按成 false', () => {
    const f = fakeUpdater()
    createAppUpdater(deps(f.up))
    /*
     * 这两条是主人的明确要求。第一条防"偷偷占带宽"，
     * 第二条防"退出时静默安装" —— 后者一旦为 true，
     * 用户点一次"以后再说"也可能在关软件时被装上，正是被否掉的行为。
     */
    expect(f.up.autoDownload, 'autoDownload 必须是 false（下载要用户点）').toBe(false)
    expect(
      f.up.autoInstallOnAppQuit,
      'autoInstallOnAppQuit 必须是 false（绝不许退出时静默安装）'
    ).toBe(false)
  })

  it('开发态（未打包）不检查，直接说"不检查"让调用方回落', async () => {
    const f = fakeUpdater()
    const up = createAppUpdater(deps(f.up, { isPackaged: false }))
    const r = await up.check()
    expect(r.hasUpdate).toBe(false)
    expect(r.reason).toBe('dev')
  })
})

describe('检查更新', () => {
  it('有新版 → hasUpdate + 版本号', async () => {
    const f = fakeUpdater({ checkResult: { updateInfo: { version: '0.1.4' } } })
    const up = createAppUpdater(deps(f.up))
    expect(await up.check()).toEqual({ hasUpdate: true, version: '0.1.4' })
  })

  it('没有新版 → hasUpdate:false（不抛）', async () => {
    const f = fakeUpdater({ checkResult: null })
    const up = createAppUpdater(deps(f.up))
    expect((await up.check()).hasUpdate).toBe(false)
  })

  it('★检查出错不抛出去（调用方要能安静回落到手写检查）', async () => {
    const f = fakeUpdater({ checkThrows: true })
    const up = createAppUpdater(deps(f.up))
    const r = await up.check()
    expect(r.hasUpdate).toBe(false)
    expect(r.reason, '要把失败原因带回去，便于日志归因').toContain('网络失败')
  })
})

describe('下载更新', () => {
  it('进度事件映射成界面认的形状（percent/got/total）', async () => {
    const f = fakeUpdater()
    const seen: Array<{ percent: number; got: number; total?: number }> = []
    const up = createAppUpdater(deps(f.up, { onProgress: (p: never) => seen.push(p) }))

    const p = up.download()
    // 模拟 electron-updater 的进度事件（它的字段名是 transferred/total/percent）
    f.emit('download-progress', { percent: 42.6, transferred: 1024, total: 4096 })
    f.emit('download-progress', { percent: 100, transferred: 4096, total: 4096 })
    // 完成事件要带上文件路径（真实实现里是 downloadedFile）
    const dlFile = join(root, 'pending', 'AstriaX-Setup-0.1.4.exe')
    mkdirSync(dirname(dlFile), { recursive: true })
    writeFileSync(dlFile, 'fake-installer', 'utf8')
    f.emit('update-downloaded', { downloadedFile: dlFile, version: '0.1.4' })

    const r = await p
    expect(seen[0], 'percent 要取整').toEqual({ percent: 43, got: 1024, total: 4096 })
    expect(seen[1].percent).toBe(100)

    // ★ 拷到用户下载目录（界面文案承诺"保存在…双击即可完成更新"）
    expect(r.file.startsWith(join(root, 'Downloads')), `返回的路径应指向下载目录：${r.file}`).toBe(true)
    expect(existsSync(r.file), '安装包必须真的落到下载目录').toBe(true)
    expect(readFileSync(r.file, 'utf8')).toBe('fake-installer')
  })

  it('★监听器不累积：连续下两次，download-progress 订阅数仍为 0', async () => {
    const f = fakeUpdater()
    const up = createAppUpdater(deps(f.up))
    for (let i = 0; i < 2; i++) {
      const p = up.download()
      const dlFile = join(root, `pending-${i}`, `AstriaX-Setup-0.1.4.exe`)
      mkdirSync(dirname(dlFile), { recursive: true })
      writeFileSync(dlFile, 'x', 'utf8')
      f.emit('download-progress', { percent: 10, transferred: 1, total: 10 })
      f.emit('update-downloaded', { downloadedFile: dlFile })
      await p
    }
    /*
     * 每轮都要退订。否则用户反复点下载会攒出一串回调：
     * 进度被调用 N 次（界面乱跳），闭包也一直挂着。
     */
    expect(f.onCount('download-progress'), 'download-progress 监听器泄漏了').toBe(0)
    expect(f.onCount('error'), 'error 监听器泄漏了').toBe(0)
  })

  it('完成事件没给路径 → 明确报错（不要返回一个假路径）', async () => {
    const f = fakeUpdater()
    const up = createAppUpdater(deps(f.up))
    const p = up.download()
    f.emit('update-downloaded', {})
    await expect(p).rejects.toThrow(/没给文件路径/)
  })

  it('下载出错 → reject（调用方据此回落到手写下载）', async () => {
    const f = fakeUpdater()
    const up = createAppUpdater(deps(f.up))
    const p = up.download()
    f.emit('error', new Error('磁盘满'))
    await expect(p).rejects.toThrow(/磁盘满/)
  })
})
