/*
 * 指导书 P0 自检 5：快速切换页面 10 次，不崩溃、数据不乱、**不泄漏定时器**。
 *
 * ## 为什么单独立一条
 *
 * 下载页在 0.1.3 里加了三样"有生命周期的东西"：
 *   · SWR 缓存（module 级，跨挂载存活 —— 故意的）
 *   · 探测节流时刻（同上）
 *   · "5 秒无动静"的 stall 时钟（组件级 setInterval，**必须**随卸载清掉）
 *   · 延时清理进度条的定时器 Set（同样必须清）
 *
 * 这些东西只要有一处不对称，用户"来回点几次标签"就会攒下定时器和
 * 幽灵回调 —— 表现是越用越卡、或者切回来时看到过期的"正在处理"。
 * 这类问题在单次挂载的测试里**永远发现不了**，所以专门写一条快速切换的。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DownloadPage from '../../src/renderer/src/DownloadPage.vue'
import { dlInvalidate } from '../../src/renderer/src/dl-cache'

let listCalls = 0
let mirrorTestCalls = 0
/** 主进程推进度用的回调（由 onDownloadProgress 捕获） */
let onProgress: ((p: Record<string, unknown>) => void) | undefined

/** 发一条"正在下载"的进度事件（这是 stall 时钟唯一的启动方式） */
function emitProgress(): void {
  onProgress?.({
    type: 'a',
    tag: 'v4.28.0',
    phase: 'downloading',
    percent: 24,
    got: 0,
    total: undefined,
    bytesPerSec: 0,
    gotText: '依赖收集',
    speedText: 'astrbot',
    done: false,
    label: 'AstrBot v4.28.0'
  })
}

function inject(): void {
  const w = globalThis as unknown as { window: Record<string, unknown> }
  w.window.launcher = {
    mirrors: {
      state: async () => ({
        mirrors: [{ label: 'GitHub 直连', base: '', mode: 'proxy', builtin: true }],
        pref: { a: '', n: '' }
      }),
      test: async () => {
        mirrorTestCalls++
        return [{ base: '', label: 'GitHub 直连', status: 'ok', ms: 120 }]
      },
      pref: async (p: unknown) => ({ mirrors: [], pref: p })
    },
    runtimes: {
      list: async () => {
        listCalls++
        /*
         * ★ 用 `a`（AstrBot）—— 页面默认停在 AstrBot 标签页
         *   （主人 2026-10-08 改成"点左侧资源切换、右侧只显示当前那一类"）。
         *   原来给的是 NapCat，于是挂载后看不到它 —— 不是产品坏了。
         */
        return [{ type: 'a' as const, tag: 'v4.18.19', sizeMB: 28.1 }]
      }
    },
    python: { status: async () => ({ ready: true, version: '3.12.10' }) },
    versions: { list: async () => [] },
    app: { qqStatus: async () => ({ ok: true, installed: true, version: '9', minBuild: '8' }) },
    onDownloadProgress: (cb: (p: Record<string, unknown>) => void) => {
      onProgress = cb
      return () => {
        onProgress = undefined
      }
    }
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  dlInvalidate()
  listCalls = 0
  mirrorTestCalls = 0
  inject()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('★快速切换下载页 10 次', () => {
  it('不报错、数据一致、且**定时器不泄漏**', async () => {
    /*
     * 统计 setInterval / clearInterval 的配对情况。
     * 下载页里唯一用 setInterval 的地方就是 stall 时钟；
     * 只要挂载/卸载 10 次之后"活的定时器"回到 0，就说明清理是对称的。
     */
    const liveIntervals = new Set<ReturnType<typeof setInterval>>()
    const realSet = globalThis.setInterval
    const realClear = globalThis.clearInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: never, ms: never) => {
      const id = realSet(fn, ms)
      liveIntervals.add(id)
      return id
    }) as never)
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id: never) => {
      liveIntervals.delete(id)
      realClear(id)
    }) as never)

    const errors: unknown[] = []
    for (let i = 0; i < 10; i++) {
      const w = mount(DownloadPage, {
        global: { config: { errorHandler: (e: unknown) => errors.push(e) } }
      })
      await flushPromises()

      /*
       * ★ 关键：必须**真的推一条进度**，否则 stall 时钟根本不会被创建，
       * 那句"切换 10 次后没有定时器活着"就变成了**恒真的空断言**
       *（我第一版就是这样 —— 于是它什么都没验）。
       * 有了这一句，下面的"时钟活着"才有意义，随后的"清零"才是真验收。
       */
      emitProgress()
      await flushPromises()
      expect(
        liveIntervals.size,
        `第 ${i + 1} 次：收到进度后 stall 时钟应当起来了（否则本用例是空转）`
      ).toBeGreaterThan(0)

      // 每次挂载都应当能看到已装版本（数据一致，不因切换而丢失）
      expect(w.text(), `第 ${i + 1} 次挂载看不到已装版本`).toContain('v4.18.19')
      w.unmount()
      await flushPromises()
      expect(
        liveIntervals.size,
        `第 ${i + 1} 次卸载后还有 ${liveIntervals.size} 个定时器活着 —— 卸载时没清干净`
      ).toBe(0)
    }

    expect(errors, '快速切换过程中出现了组件错误').toEqual([])
    expect(
      liveIntervals.size,
      `切换 10 次后还有 ${liveIntervals.size} 个定时器活着 —— 卸载时没有清干净` +
        `（用户来回点标签会越攒越多，表现为越用越卡）`
    ).toBe(0)

    /*
     * 请求也要有界：第一次挂载会真拉一次数据，之后 9 次应当由 SWR 缓存兜住。
     * 上限给 3 是留了余量（reload 是每次挂载都会做的后台刷新，
     * 但**镜像探测**会被 60s 节流挡住，那一项才是"每次点进去都要等"的元凶）。
     */
    expect(
      mirrorTestCalls,
      `切换 10 次触发了 ${mirrorTestCalls} 次全量镜像探测 —— 节流没生效`
    ).toBeLessThanOrEqual(1)
    expect(listCalls, '已装版本查询次数应当有界（缓存兜住大部分）').toBeLessThanOrEqual(10)
  })
})
