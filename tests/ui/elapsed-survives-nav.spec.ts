/*
 * ★★ 「已用 N 秒」必须**跨页面切换**保持
 *
 * 主人 2026-09-27 实测（原话）：
 *   「正在安装依赖 · 已用 3 秒 —— 切换到其他页面回来，计时又刷新了」
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么会重置
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 计时原来完全由**渲染层自己记**（下载页组件里的一个 Map）：
 * 切走页面 → 组件卸载 → Map 没了 → 切回来首次收到事件时又 `Date.now()`
 * → 从 0 开始读。
 *
 * 这与本项目反复出现的**同一类病**：长任务的"进行中"状态只活在
 * 组件生命周期里（`logs:exportBusy`、`download:sessions` 都是它）。
 *
 * ## 修法
 *
 * 主进程在快照里维护 `startedAt`（第一次见到该任务时定下，之后每个事件
 * 都带上它），界面优先用它 —— 于是切多少次页面，算出来都准。
 *
 * 组件内的 Map 保留作**回落**（主进程没发这个字段时）。
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

/** 发一条安装中的进度事件（可带主进程给的 startedAt） */
function emit(percent: number, startedAt?: number): void {
  onProgress?.({
    type: 'a',
    tag: 'v4.28.0',
    phase: 'unpack',
    percent,
    got: 0,
    total: undefined,
    bytesPerSec: 0,
    gotText: 'aiodocker, mcp, dashscope',
    speedText: '正在安装依赖',
    done: false,
    label: 'AstrBot v4.28.0',
    ...(startedAt === undefined ? {} : { startedAt })
  })
}

const elapsedOf = (text: string): number =>
  Number(/已用\s*(\d+)\s*秒/.exec(text)?.[1] ?? -1)

beforeEach(() => {
  vi.restoreAllMocks()
  vi.useFakeTimers()
  dlInvalidate()
  inject()
  onProgress = undefined
})
afterEach(() => {
  vi.useRealTimers()
})

describe('★★计时跨页面切换不重置', () => {
  it('★★主进程给了 startedAt → 切走再切回来，秒数**接着算**而不是从 0', async () => {
    /*
     * 模拟"58 秒前开始的一个任务"：主进程在事件里带着它的真实起点。
     */
    const now = Date.now()
    const startedAt = now - 58_000

    const w1 = mount(DownloadPage)
    await flushPromises()
    emit(62, startedAt)
    await flushPromises()

    const first = elapsedOf(w1.text())
    expect(first, '第一次显示应当约 58 秒（不是 0）').toBeGreaterThanOrEqual(57)
    w1.unmount() // ← 切走页面（组件卸载）

    /* 过 5 秒后切回来 */
    vi.advanceTimersByTime(5000)
    const w2 = mount(DownloadPage)
    await flushPromises()
    emit(63, startedAt)
    await flushPromises()

    const second = elapsedOf(w2.text())
    expect(
      second,
      '★切回来必须接着算（约 63 秒）—— 重置到 0 就是主人报的那个 bug'
    ).toBeGreaterThanOrEqual(60)
    w2.unmount()
  })

  it('主进程没给 startedAt 时回落到"首次见到自己记"（不算错）', async () => {
    const w = mount(DownloadPage)
    await flushPromises()
    emit(62)
    await flushPromises()

    vi.advanceTimersByTime(7000)
    await flushPromises()

    const s = elapsedOf(w.text())
    expect(s, '回落路径下也要能正常涨').toBeGreaterThanOrEqual(6)
    w.unmount()
  })
})
