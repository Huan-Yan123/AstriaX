/*
 * ★ 「暂时没信号」时的界面保护
 *
 * 主人的抱怨（第一版）：
 *   进度条显示 "package:..." 看起来在装但不走 → 以为卡死。
 *
 * 主人的抱怨（2026-09-27，第二版）：
 *   「这个正在处理请稍后到底是啥，卡在这里很久，用户看见会以为卡死了，
 *     你也没个进度显示什么的」
 *
 * 第二版指出的是**同一个功能的表达问题**：原来那句
 * 「正在处理，请稍候…」**本身就是"卡住了"的语气** ——
 * 不知道在干什么、还要多久、甚至不知道它还活着。
 *
 * 现在停顿时的文案给三样东西：
 *   ① 它正在干什么（来自 speedText / phase）
 *   ② **已用时**（每秒在涨 —— 数字在动就是"还活着"的最强信号）
 *   ③ 一句"没有新输出是正常的"的说明
 *
 * 所以这条测试钉的**判据变了**：
 *   · 旧：停顿 5 秒后必须出现「正在处理」
 *   · 新：停顿 5 秒后必须出现「已用 N 秒」+ 说明它没死
 *（"必须让用户知道它还活着"这个**意图**没变，
 *  变的是用什么告诉用户 —— 一个会涨的数字比一句"请稍候"有用得多。）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DownloadPage from '../../src/renderer/src/DownloadPage.vue'
import { dlInvalidate } from '../../src/renderer/src/dl-cache'

let onProgress: ((p: Record<string, unknown>) => void) | undefined

function inject(): void {
  const w = globalThis as unknown as { window: Record<string, unknown> }
  w.window.launcher = {
    mirrors: {
      state: async () => ({ mirrors: [], pref: { a: '', n: '' } }),
      test: async () => [],
      pref: async () => ({ mirrors: [], pref: { a: '', n: '' } })
    },
    runtimes: { list: async () => [] },
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

/** 发一条"正在下载"的进度事件（模拟主进程推的 pip 进度） */
function emitProgress(percent: number): void {
  onProgress?.({
    type: 'a',
    tag: 'v4.28.0',
    phase: 'downloading',
    percent,
    got: 0,
    total: undefined,
    bytesPerSec: 0,
    gotText: '依赖收集',
    speedText: 'astrbot',
    done: false,
    label: 'AstrBot v4.28.0'
  })
}

beforeEach(async () => {
  vi.restoreAllMocks()
  /*
   * ★ 假时钟必须在 mount **之前**装（第一版装晚了，测试假红）
   *
   * 组件在收到第一条进度事件时才用 setInterval 起那个 1 秒的 stall 时钟
   *（见 DownloadPage 的 markEvent）。如果先 mount、后用
   * vi.useFakeTimers()，那个 interval 已经挂在**真实**定时器上，
   * vi.advanceTimersByTime 推不动它 → stallTick 不涨 → 模板不重算。
   *
   * 这类"测试环境与实现时序错位"最容易误判成产品 bug，所以记在这儿：
   * 先装时钟，再 mount。
   */
  vi.useFakeTimers()
  dlInvalidate()
  inject()
  onProgress = undefined
})
afterEach(() => {
  vi.useRealTimers()
})

describe('★进度长时间不动时，界面必须让用户知道"它还活着"', () => {
  it('★5 秒没有新事件 → 显示「已用 N 秒」+ 说明没死（而不是含糊的"请稍候"）', async () => {
    const w = mount(DownloadPage)
    await flushPromises()

    emitProgress(24)
    await flushPromises()
    // 刚收到事件：显示的是真实状态（包名），不是停顿文案
    expect(w.text()).toContain('astrbot')

    /*
     * 推进假时钟 5.5 秒：期间**没有任何**进度事件 ——
     * 模拟 pip 正在解压大包 / 构建源码包的那段"静默期"。
     */
    vi.advanceTimersByTime(5500)
    await flushPromises()

    const text = w.text()
    expect(
      text,
      '★静默超过 5 秒却还显示旧的包名 —— 用户会以为卡死了'
    ).toMatch(/已用\s*\d+\s*秒/)
    expect(
      text,
      '★要明确说"没有新输出是正常的"，否则用户照样以为卡死'
    ).toMatch(/没有新输出是正常的|别关软件/)
    expect(
      text,
      '★不许再出现那句"正在处理，请稍候…" —— 它本身就是卡住的语气（主人 2026-09-27）'
    ).not.toContain('正在处理，请稍候')
    w.unmount()
  })

  it('★秒数会随时间增长（"数字在动"就是最强的活着信号）', async () => {
    const w = mount(DownloadPage)
    await flushPromises()
    emitProgress(24)
    await flushPromises()

    vi.advanceTimersByTime(5500)
    await flushPromises()
    const first = /已用\s*(\d+)\s*秒/.exec(w.text())?.[1]

    vi.advanceTimersByTime(3000)
    await flushPromises()
    const second = /已用\s*(\d+)\s*秒/.exec(w.text())?.[1]

    expect(first, '要能读到秒数').toBeTruthy()
    expect(
      Number(second),
      '★秒数必须随时间增长 —— 一个不动的数字和"请稍候"没区别'
    ).toBeGreaterThan(Number(first))
    w.unmount()
  })

  it('结束态（done）不显示停顿文案（已经好啦就别再说在处理）', async () => {
    const w = mount(DownloadPage)
    await flushPromises()
    emitProgress(100)
    onProgress?.({
      type: 'a',
      tag: 'v4.28.0',
      phase: 'done',
      percent: 100,
      got: 0,
      total: undefined,
      bytesPerSec: 0,
      gotText: '完成',
      speedText: '',
      done: true,
      label: 'AstrBot v4.28.0'
    })
    await flushPromises()

    vi.advanceTimersByTime(8000)
    await flushPromises()
    expect(w.text()).not.toMatch(/已用\s*\d+\s*秒/)
    w.unmount()
  })
})
