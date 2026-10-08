import { describe, it, expect, beforeEach } from 'vitest'
import { createWebUiManager } from '../../src/main/webui/webui-manager'

interface FakeView {
  url: string
  loaded: string | null
  bounds: { x: number; y: number; width: number; height: number }
  destroyed: boolean
}

function fakeFactory() {
  const views: FakeView[] = []
  const factory = {
    views,
    create: (url: string) => {
      const v: FakeView = { url, loaded: null, bounds: { x: 0, y: 0, width: 0, height: 0 }, destroyed: false }
      // 模拟 setBounds/setURL 行为
      const handle = {
        loadURL: async (u: string) => {
          v.loaded = u
        },
        setBounds: (b: { x: number; y: number; width: number; height: number }) => {
          v.bounds = { ...b }
        },
        destroy: () => {
          v.destroyed = true
        }
      }
      ;(v as unknown as { handle: unknown }).handle = handle
      views.push(v)
      return handle
    }
  }
  return factory
}

describe('WebUI 嵌入管理器（WebContentsView 容器，注入可见性）', () => {
  it('open：创建 View 加载 URL 并按布局 setBounds；重复 open 同实例不重复挂', async () => {
    const f = fakeFactory()
    const attached: unknown[] = []
    const m = createWebUiManager({
      createView: f.create,
      attach: (v, _id) => attached.push(v),
      detach: () => undefined,
      boundsOf: () => ({ x: 212, y: 44, width: 968, height: 716 })
    })
    await m.open('a_1', 'http://127.0.0.1:6100')
    await m.open('a_1', 'http://127.0.0.1:6100')
    expect(f.views).toHaveLength(1)
    expect(attached).toHaveLength(1)
    expect(f.views[0].loaded).toBe('http://127.0.0.1:6100')
    expect(f.views[0].bounds.width).toBeGreaterThan(0)
  })

  it('先加载完再挂上去（用户抱怨「进出 WebUI 卡半天」的根因）', async () => {
    /*
     * 用户报告：「很多操作都会导致无响应……进出 WebUI 的时候也是卡半天才进出」。
     *
     * 原来顺序是 attach → loadURL：先把一个**还没加载**的空视图盖到界面上，
     * 用户看到的是一大块白板持续好几秒。反过来（loadURL → attach）界面
     * 会保持原样直到页面就绪，体感完全不同。
     *
     * 这里用一个「加载要花一会儿」的假 view 把这个顺序钉死：
     * 在 loadURL 还没 resolve 的时候，attach **不该**被调用。
     */
    let releaseLoad: (() => void) | null = null
    const attachedDuringLoad: number[] = []
    let attachCount = 0
    const m = createWebUiManager({
      createView: () => ({
        loadURL: () =>
          new Promise<void>((res) => {
            releaseLoad = res
          }),
        setBounds: () => undefined,
        destroy: () => undefined
      }),
      attach: () => {
        attachCount++
        attachedDuringLoad.push(attachCount)
      },
      detach: () => undefined,
      boundsOf: () => ({ x: 0, y: 0, width: 100, height: 100 })
    })

    const opening = m.open('a_1', 'http://x')
    // 让微任务跑一轮：此时 loadURL 还挂着，attach 必须还没发生
    await Promise.resolve()
    expect(attachCount, '加载没完成就不该挂视图（否则用户看到白板）').toBe(0)

    releaseLoad?.()
    await opening
    expect(attachCount, '加载完成后才挂上去').toBe(1)
  })

  it('加载失败时不留痕：不能变成「已在打开」却什么都没显示', async () => {
    /*
     * 加载失败后如果还把 id 留在 open 集合里，用户再点「WebUI」会被告知
     * 已经打开了（existing 分支直接 return），而实际上屏幕上什么都没有 ——
     * 一个只能靠重启软件才能恢复的死状态。
     */
    let destroyed = 0
    const m = createWebUiManager({
      createView: () => ({
        loadURL: () => Promise.reject(new Error('连不上')),
        setBounds: () => undefined,
        destroy: () => {
          destroyed++
        }
      }),
      attach: () => undefined,
      detach: () => undefined,
      boundsOf: () => ({ x: 0, y: 0, width: 100, height: 100 })
    })

    await expect(m.open('a_1', 'http://x')).rejects.toThrow('连不上')
    expect(m.list(), '失败后不该留下「已打开」的记录').toEqual([])
    expect(destroyed, '半成品视图要销毁，别泄漏').toBe(1)

    // 再点一次必须能重试（而不是被 existing 挡住）
    await expect(m.open('a_1', 'http://x')).rejects.toThrow('连不上')
  })

  it('切换只保留当前 WebUI；关闭后回到启动器', async () => {
    const f = fakeFactory()
    const detached: string[] = []
    const destroyed: unknown[] = []
    const m = createWebUiManager({
      createView: f.create,
      attach: () => undefined,
      detach: (id) => detached.push(id),
      destroy: (v) => destroyed.push(v),
      boundsOf: () => ({ x: 0, y: 0, width: 100, height: 100 })
    })
    await m.open('a_1', 'http://x')
    await m.open('n_1', 'http://y')
    expect(m.list()).toEqual(['n_1'])
    expect(detached).toEqual(['a_1'])
    expect(destroyed).toHaveLength(1)
    m.close('n_1')
    expect(m.list()).toEqual([])
    expect(m.visible()).toBeUndefined()
    expect(detached).toEqual(['a_1', 'n_1'])
    expect(destroyed).toHaveLength(2)
    m.close('n_1') // 幂等
  })

  it('resize：给所有打开的 view 重设 bounds（窗口尺寸触发的跟随）', async () => {
    const f = fakeFactory()
    let bounds = { x: 212, y: 44, width: 968, height: 716 }
    const m = createWebUiManager({
      createView: f.create,
      attach: () => undefined,
      detach: () => undefined,
      boundsOf: () => bounds
    })
    await m.open('a_1', 'http://x')
    f.views.forEach((v) => {
      ;(v as unknown as { handle: { bounds: unknown } }).handle.bounds = v.bounds
    })
    const before = { ...f.views[0].bounds }
    bounds = { x: 300, y: 60, width: 1200, height: 900 }
    m.resize()
    expect(f.views[0].bounds).toEqual(bounds)
    expect(before.width).not.toBe(bounds.width)
  })
})
