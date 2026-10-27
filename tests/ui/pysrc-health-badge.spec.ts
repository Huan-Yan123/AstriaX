// @vitest-environment happy-dom
/*
 * AstrBot 那一栏的 Python 源必须显示「可用 xxx ms」徽章。
 *
 * 主人 2026-10-25 的截图：NapCat 那一栏每个源都有徽章，
 * 而 AstrBot（Python 源）那一栏三个源**一个徽章都没有**。
 * 这条测试钉住渲染链路：pysrc.test 返回的行必须变成徽章。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DownloadPage from '../../src/renderer/src/DownloadPage.vue'
import { dlInvalidate } from '../../src/renderer/src/dl-cache'

const SOURCES = [
  { label: 'Python源', indexUrl: 'https://pypi.org/simple/', builtin: true },
  { label: '腾讯源', indexUrl: 'https://mirrors.cloud.tencent.com/pypi/simple/', builtin: true },
  { label: '清华源', indexUrl: 'https://pypi.tuna.tsinghua.edu.cn/simple/', builtin: true }
]

function inject(): void {
  const w = globalThis as unknown as { window: Record<string, unknown> }
  w.window.launcher = {
    mirrors: {
      state: async () => ({ mirrors: [], pref: { a: '', n: '' } }),
      test: async () => [],
      pref: async () => undefined
    },
    pysrc: {
      state: async () => ({ sources: SOURCES, pref: 'Python源' }),
      test: async () =>
        SOURCES.map((s, i) => ({ indexUrl: s.indexUrl, label: s.label, status: 'ok', ms: 100 + i * 50 }))
    },
    versions: { list: async () => [] },
    runtime: { install: async () => undefined },
    runtimes: { list: async () => [] },
    python: { status: async () => ({ ready: true, version: '3.12.10' }) },
    app: { qqStatus: async () => ({ ok: true, installed: true, version: '9', minBuild: '8' }) },
    onDownloadProgress: () => () => undefined
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  dlInvalidate()
  inject()
})

describe('Python 源的可用性徽章', () => {
  it('每个 Python 源都要显示「可用 Nms」，与 NapCat 那栏一致', async () => {
    const w = mount(DownloadPage)
    await flushPromises()

    const pyBlock = w.findAll('.source-block').find((b) => b.text().includes('AstrBot'))!
    expect(pyBlock, '先确认 AstrBot 分区在').toBeTruthy()

    const badges = pyBlock.findAll('.health')
    expect(badges.length, '三个 Python 源都要有徽章').toBe(3)
    expect(badges[0].text()).toContain('可用')
    expect(badges[0].text()).toContain('100ms')
  })

  it('徽章还没出来时，下载按钮的位置不能变（槽位必须常驻）', async () => {
    /* 让探测挂住不返回，模拟"延迟还没加载出来" */
    let release: (() => void) | undefined
    const w0 = globalThis as unknown as {
      window: { launcher: { pysrc: { test: () => Promise<unknown[]> } } }
    }
    w0.window.launcher.pysrc.test = () =>
      new Promise((resolve) => {
        release = () => resolve([])
      })

    const w = mount(DownloadPage)
    await flushPromises()

    const rows = w.findAll('.source-row')
    const pyRows = rows.filter((r) => r.text().includes('pypi.org') || r.text().includes('tencent') || r.text().includes('tuna'))
    expect(pyRows.length, '先确认三个 Python 源行都在').toBe(3)

    /* 每行都必须有 health 槽位与 danger 槽位，即使里面是空的 */
    for (const r of pyRows) {
      expect(r.find('.health-slot').exists(), '徽章槽位必须常驻').toBe(true)
      expect(r.find('.danger-slot').exists(), '删除按钮槽位必须常驻').toBe(true)
    }
    /* 探测中时给的是占位文案，不是空白 */
    expect(pyRows[0].find('.health').text(), '探测中要有明确占位').toContain('检测中')

    release?.()
    await flushPromises()
  })
})
