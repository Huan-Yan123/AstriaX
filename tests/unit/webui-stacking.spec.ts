/*
 * ★★ 多个 WebUI 视图**互相堆叠** —— 用户反馈的真实 bug
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 用户原话（2026-09-26，0.1.4 上实测）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 「在 0.1.4 版本打开 AstrBot 的网页时，却跳转到了 NapCat 的网页
 *  （而且不是同一个 NapCat），两者端口并不一致（AstrBot 6100、NapCat 6200），
 *   且卸载重下后还是这样」。
 *
 * ## 根因：**不是跳转，是两个视图叠在一起**
 *
 * 每个实例打开 WebUI 都会 new 一个 WebContentsView 并 addChildView，
 * 而所有视图拿到的 bounds **完全相同**（x=0, y=78, 全宽全高）——
 * 它们不是并排，而是**一层盖一层**（Electron 里后 add 的在上层）。
 *
 * 复现路径正是用户的场景：
 *   1. 先开 NapCat 的 WebUI（6200）→ 视图 A 铺满
 *   2. 再开 AstrBot 的 WebUI（6100）→ 视图 B 铺满，盖住 A
 *   3. 收起 B（或从卡片收起 AstrBot）→ 剩下的 A 露出来
 *      → **屏幕上就是 NapCat 的页面**，而用户以为自己看的是 AstrBot
 *
 * 「端口对不上、而且不是同一个 NapCat」也对得上 —— 那个 NapCat 是**另一个实例**。
 * 「卸载重装也一样」证明是**逻辑问题**而非残留状态：只要同时开着两个就会复现。
 *
 * ## 修法：同一时刻只显示一个（切谁显示谁），但保留各自的登录态
 */
import { describe, it, expect } from 'vitest'
import { createWebUiManager, type ViewHandle } from '../../src/main/webui/webui-manager'

/** 假视图：记录自己的 URL、bounds 与**可见性** */
function fakeView(url: string) {
  return {
    url,
    bounds: undefined as { x: number; y: number; width: number; height: number } | undefined,
    visible: true, // Electron 里 addChildView 后默认可绘制
    destroyed: false,
    loaded: false
  }
}

function makeManager() {
  const views: Array<ReturnType<typeof fakeView>> = []
  const m = createWebUiManager({
    createView: (url): ViewHandle => {
      const v = fakeView(url)
      views.push(v)
      return {
        loadURL: async () => {
          v.loaded = true
        },
        setBounds: (b) => {
          v.bounds = b
        },
        setVisible: (x) => {
          v.visible = x
        },
        destroy: () => {
          v.destroyed = true
        }
      }
    },
    attach: () => undefined,
    detach: () => undefined,
    boundsOf: () => ({ x: 0, y: 78, width: 1000, height: 700 })
  })
  return { m, views }
}

const visibleOnes = (views: Array<ReturnType<typeof fakeView>>): string[] =>
  views.filter((v) => v.visible && !v.destroyed).map((v) => v.url)

describe('★★同时只显示一个 WebUI（修"点 AstrBot 却看到 NapCat"）', () => {
  it('★先开 NapCat 再开 AstrBot → **只有 AstrBot 可见**', async () => {
    const { m, views } = makeManager()
    await m.open('n_1', 'http://127.0.0.1:6200')
    await m.open('a_1', 'http://127.0.0.1:6100')

    expect(
      visibleOnes(views),
      '两个视图都可见 = 互相堆叠 = 用户会看到下面那个（这就是那个 bug）'
    ).toEqual(['http://127.0.0.1:6100'])
  })

  it('★收起当前 WebUI → 回到启动器，不露出其他实例页面', async () => {
    const { m, views } = makeManager()
    await m.open('n_1', 'http://127.0.0.1:6200')
    await m.open('a_1', 'http://127.0.0.1:6100')
    m.close('a_1')

    expect(visibleOnes(views), '收起后不应露出另一实例的旧页面').toEqual([])
    expect(m.visible()).toBeUndefined()
  })

  it('★同一 WebUI 重复打开不重复建视图；切换回来会创建干净的新视图', async () => {
    const { m, views } = makeManager()
    await m.open('n_1', 'http://127.0.0.1:6200')
    await m.open('n_1', 'http://127.0.0.1:6200')
    expect(views.length, '重复打开当前实例不能重复创建视图').toBe(1)
    await m.open('a_1', 'http://127.0.0.1:6100')
    // 切回之前的 NapCat 时，旧视图已销毁，不能重显它。
    await m.open('n_1', 'http://127.0.0.1:6200')

    expect(views.length, '切回已销毁的实例时创建一个新视图').toBe(3)
    expect(
      visibleOnes(views),
      '点了 NapCat 就该看到 NapCat —— 第一版这里直接 return，屏幕上还是 AstrBot，' +
        '正是"点 A 却看到 B"的又一条复现路径'
    ).toEqual(['http://127.0.0.1:6200'])
  })

  it('★切换实例时销毁旧页面，避免已关闭 WebUI 残留', async () => {
    const { m, views } = makeManager()
    await m.open('n_1', 'http://127.0.0.1:6200')
    await m.open('a_1', 'http://127.0.0.1:6100')
    await m.open('n_1', 'http://127.0.0.1:6200')

    expect(views.every((v) => v.loaded)).toBe(true)
    expect(views.filter((v) => !v.destroyed).length).toBe(1)
    expect(visibleOnes(views)).toEqual(['http://127.0.0.1:6200'])
  })

  it('新视图在**加载完成之前**不可见（避免先糊一块白板）', async () => {
    let sawVisibleWhileLoading: boolean | undefined
    const views: Array<ReturnType<typeof fakeView>> = []
    const m = createWebUiManager({
      createView: (url): ViewHandle => {
        const v = fakeView(url)
        views.push(v)
        return {
          loadURL: async () => {
            // 加载中：此刻它必须还是隐藏的
            sawVisibleWhileLoading = v.visible
            v.loaded = true
          },
          setBounds: (b) => {
            v.bounds = b
          },
          setVisible: (x) => {
            v.visible = x
          },
          destroy: () => {
            v.destroyed = true
          }
        }
      },
      attach: () => undefined,
      detach: () => undefined,
      boundsOf: () => ({ x: 0, y: 78, width: 1000, height: 700 })
    })
    await m.open('a_1', 'http://127.0.0.1:6100')
    expect(sawVisibleWhileLoading, '加载中不该可见（否则用户看到白板）').toBe(false)
    expect(views[0].visible, '加载完成后才显示').toBe(true)
  })

  it('visible() 如实反映当前在看谁', async () => {
    const { m } = makeManager()
    expect(m.visible()).toBeUndefined()
    await m.open('a_1', 'http://127.0.0.1:6100')
    expect(m.visible()).toBe('a_1')
    await m.open('n_1', 'http://127.0.0.1:6200')
    expect(m.visible()).toBe('n_1')
    m.close('n_1')
    expect(m.visible(), '关闭当前页面后应回到启动器').toBeUndefined()
  })

  it('加载失败 → 不留"已打开"记录，也不会有隐藏的幽灵视图', async () => {
    const { m, views } = makeManager()
    // 换成一个会失败的 manager
    const m2 = createWebUiManager({
      createView: (url): ViewHandle => {
        const v = fakeView(url)
        views.push(v)
        return {
          loadURL: async () => {
            throw new Error('连不上')
          },
          setBounds: () => undefined,
          setVisible: (x) => {
            v.visible = x
          },
          destroy: () => {
            v.destroyed = true
          }
        }
      },
      attach: () => undefined,
      detach: () => undefined,
      boundsOf: () => ({ x: 0, y: 78, width: 1000, height: 700 })
    })
    await expect(m2.open('a_1', 'http://x')).rejects.toThrow('连不上')
    expect(m2.list(), '失败后不该留下"已打开"记录').toEqual([])
    expect(views.filter((v) => !v.destroyed).length, '半成品视图要销毁').toBe(0)
    void m
  })
})
