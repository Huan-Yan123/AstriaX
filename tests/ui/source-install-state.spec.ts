// @vitest-environment happy-dom
/*
 * 下载资源页 · 源行状态（用户要求 2026-10-25）：
 *   · 实际安装来源显示浅色「已安装」
 *   · 同组其它源的「下载」灰掉、不可点击
 *   · 有新版本时，实际来源显示「更新」
 *   · 下载详情里，已装版本右侧有红色「卸载」
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DownloadPage from '../../src/renderer/src/DownloadPage.vue'
import { dlInvalidate } from '../../src/renderer/src/dl-cache'

function inject(opts: {
  installedA?: string
  installedAFrom?: string
  installedASourceKey?: string
  installedN?: string
  installedNFrom?: string
  installedNSourceKey?: string
  latestA?: string
  latestN?: string
  latestByBase?: Record<string, string>
  pyLabels?: [string, string]
  removed?: Array<{ type: 'a' | 'n'; tag: string }>
} = {}): void {
  const w = globalThis as unknown as { window: Record<string, unknown> }
  const runtimes = [
    ...(opts.installedA
      ? [{
          type: 'a',
          tag: opts.installedA,
          from: opts.installedAFrom ?? 'Python源',
          sourceKey: opts.installedASourceKey
        }]
      : []),
    ...(opts.installedN
      ? [{
          type: 'n',
          tag: opts.installedN,
          from: opts.installedNFrom ?? 'gh-proxy.com',
          sourceKey: opts.installedNSourceKey
        }]
      : [])
  ]
  w.window.launcher = {
    mirrors: {
      state: async () => ({
        mirrors: [
          { label: 'GitHub 直连', base: '', mode: 'proxy', builtin: true },
          { label: 'gh-proxy.com', base: 'https://gh-proxy.com/', mode: 'proxy', builtin: true },
          { label: 'cors.isteed.cc', base: 'https://cors.isteed.cc/', mode: 'proxy', builtin: true }
        ],
        pref: { a: '', n: '' }
      }),
      test: async () => [
        { base: '', label: 'GitHub 直连', ms: 120, status: 'ok' },
        { base: 'https://gh-proxy.com/', label: 'gh-proxy.com', ms: 40, status: 'ok' }
      ],
      pref: async () => undefined
    },
    pysrc: {
      state: async () => ({
        sources: [
          { label: opts.pyLabels?.[0] ?? 'Python源', indexUrl: 'https://pypi.org/simple/', builtin: true },
          { label: opts.pyLabels?.[1] ?? '腾讯源', indexUrl: 'https://mirrors.cloud.tencent.com/pypi/simple/', builtin: true }
        ],
        pref: ''
      }),
      test: async () => [
        { indexUrl: 'https://pypi.org/simple/', label: 'Python源', ms: 120, status: 'ok' },
        { indexUrl: 'https://mirrors.cloud.tencent.com/pypi/simple/', label: '腾讯源', ms: 50, status: 'ok' }
      ]
    },
    versions: {
      list: async (p: { type: 'a' | 'n'; base?: string }) => {
        const tag =
          p.type === 'a'
            ? opts.latestA
            : p.base
              ? (opts.latestByBase?.[p.base] ?? opts.latestN)
              : opts.latestN
        return tag ? [{ tag, assetName: 'x', from: 'x', base: 'x' }] : []
      }
    },
    runtimes: {
      list: async () => runtimes,
      remove: async (p: { type: 'a' | 'n'; tag: string }) => {
        opts.removed?.push(p)
        const i = runtimes.findIndex((r) => r.type === p.type && r.tag === p.tag)
        if (i >= 0) runtimes.splice(i, 1)
      }
    },
    python: { status: async () => ({ ready: true, version: '3.12.10' }) },
    instance: { list: async () => [] },
    app: { qqStatus: async () => ({ ok: true, installed: true, version: '9', minBuild: '8' }) },
    stats: { overview: async () => ({ system: {} }) },
    onDownloadProgress: () => () => undefined
  }
}

function rowOf(w: ReturnType<typeof mount>, label: string) {
  const row = w.findAll('.source-row').find((r) => r.text().includes(label))
  expect(row, `找不到源「${label}」`).toBeTruthy()
  return row!
}

beforeEach(() => {
  vi.restoreAllMocks()
  dlInvalidate()
})

describe('源行安装状态', () => {
  it('已装且最新 → 实际来源浅色「已安装」，其它源灰禁下载', async () => {
    inject({ installedA: 'v4.29.3', latestA: 'v4.29.3', installedAFrom: 'Python源' })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    const installed = rowOf(w, 'Python源').find('button')
    expect(installed.text()).toBe('已安装')
    expect(installed.classes()).toContain('installed')
    expect(installed.attributes('disabled')).toBeUndefined()

    const blocked = rowOf(w, '腾讯源').find('button')
    expect(blocked.text()).toBe('下载')
    expect(blocked.classes()).toContain('blocked')
    expect(blocked.attributes('disabled')).toBeDefined()
  })

  it('有新版本 → 实际来源「更新」，其它源仍灰禁', async () => {
    inject({ installedA: 'v4.29.0', latestA: 'v4.29.3', installedAFrom: 'Python源' })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()
    expect(rowOf(w, 'Python源').find('button').text()).toBe('更新')
    expect(rowOf(w, '腾讯源').find('button').attributes('disabled')).toBeDefined()
  })

  it('下载详情里已装版本右侧有红色「卸载」，确认后调用卸载', async () => {
    const removed: Array<{ type: 'a' | 'n'; tag: string }> = []
    inject({ installedA: 'v4.29.3', latestA: 'v4.29.3', installedAFrom: 'Python源', removed })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    await rowOf(w, 'Python源').find('button').trigger('click')
    await flushPromises()
    const uninstall = w.find('.vitem .uninstall-btn')
    expect(uninstall.exists(), '已装版本行必须有卸载按钮').toBe(true)
    expect(uninstall.text()).toBe('卸载')

    await uninstall.trigger('click')
    await flushPromises()
    const dlg = w.find('.dlg.small')
    expect(dlg.text()).toContain('v4.29.3')
    expect(dlg.text()).toContain('Python源')

    await dlg.findAll('button').find((b) => b.text() === '卸载')!.trigger('click')
    await flushPromises()
    expect(removed).toEqual([{ type: 'a', tag: 'v4.29.3' }])
  })

  it('版本查询失败时，只有实际安装来源显示「已安装」', async () => {
    /*
     * 用户实测：NapCat 实际从 gh-proxy.com 安装，版本查询失败后
     * 三个 GitHub 源全显示「已安装」。来源必须来自 runtimes[].from，
     * 不能仅凭“这一类有已装版本”。
     */
    inject({ installedN: 'v4.18.41' })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    expect(rowOf(w, 'GitHub 直连').find('button').text()).toBe('下载')
    expect(rowOf(w, 'gh-proxy.com').find('button').text()).toBe('已安装')
    expect(rowOf(w, 'cors.isteed.cc').find('button').text()).toBe('下载')
    expect(rowOf(w, 'GitHub 直连').find('button').attributes('disabled')).toBeDefined()
    expect(rowOf(w, 'cors.isteed.cc').find('button').attributes('disabled')).toBeDefined()
  })

  it('最新版相同：实际来源「已安装」，其余源全部灰禁', async () => {
    inject({ installedN: 'v4.18.41', latestN: 'v4.18.41' })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    expect(rowOf(w, 'GitHub 直连').find('button').text()).toBe('下载')
    expect(rowOf(w, 'gh-proxy.com').find('button').text()).toBe('已安装')
    expect(rowOf(w, 'cors.isteed.cc').find('button').text()).toBe('下载')
    expect(rowOf(w, 'GitHub 直连').find('button').attributes('disabled')).toBeDefined()
    expect(rowOf(w, 'cors.isteed.cc').find('button').attributes('disabled')).toBeDefined()
  })

  it('已装来源已不在列表里（用户删了那个源）→ 不能灰禁整页，必须还能打开弹窗卸载', async () => {
    /*
     * 灰禁的代价是 `openPick` 进不去，而卸载入口就在版本弹窗里。
     * 老记录的 sourceKey 指向一个已经不存在的源时，原来每一行都会变灰 ——
     * 用户被锁在列表上，卸载和换源都点不到。
     */
    inject({
      installedA: 'v4.29.3',
      latestA: 'v4.29.3',
      installedAFrom: '早就删掉的源',
      installedASourceKey: 'https://removed.example/simple/'
    })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    const btn = rowOf(w, 'Python源').find('button')
    expect(btn.text()).toBe('下载')
    expect(btn.attributes('disabled')).toBeUndefined()

    await btn.trigger('click')
    await flushPromises()
    expect(w.find('.vitem .uninstall-btn').exists(), '必须能进弹窗，卸载入口才在').toBe(true)
  })

  it('NapCat 同理：老记录只有来源标签、且该源已删 → 行仍可点', async () => {
    inject({
      installedN: 'v4.18.41',
      latestN: 'v4.18.41',
      installedNFrom: '早就删掉的源',
      installedNSourceKey: 'https://removed.example/'
    })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    const btn = rowOf(w, 'GitHub 直连').find('button')
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    await flushPromises()
    expect(w.find('.vitem .uninstall-btn').exists()).toBe(true)
  })

  it('同名 Python 源按 sourceKey 判断，不能把同 label 的另一个源标成已安装', async () => {
    inject({
      installedA: 'v4.29.3',
      latestA: 'v4.29.3',
      installedAFrom: '同名源',
      installedASourceKey: 'https://mirrors.cloud.tencent.com/pypi/simple/',
      pyLabels: ['同名源', '同名源']
    })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    const aGroup = w.findAll('.source-block').find((s) => s.text().includes('AstrBot'))!
    const rows = aGroup.findAll('.source-row')
    expect(rows[0].find('.source-url').text()).toContain('pypi.org')
    expect(rows[0].find('button').text()).toBe('下载')
    expect(rows[0].find('button').classes()).toContain('blocked')
    expect(rows[0].find('button').attributes('disabled')).toBeDefined()
    expect(rows[1].find('.source-url').text()).toContain('tencent.com')
    expect(rows[1].find('button').text()).toBe('已安装')
    expect(rows[1].find('button').attributes('disabled')).toBeUndefined()
  })

  it('实际安装来源离线时，已安装按钮仍可进入详情和卸载', async () => {
    inject({
      installedN: 'v4.18.41',
      installedNSourceKey: 'https://gh-proxy.com/',
      latestByBase: { 'https://gh-proxy.com/': 'v4.18.41' }
    })
    const win = (globalThis as unknown as { window: Record<string, unknown> }).window
    const mirrors = (win.launcher as Record<string, unknown>).mirrors as Record<string, unknown>
    mirrors.test = async () => [
      { base: '', label: 'GitHub 直连', ms: 120, status: 'ok' },
      {
        base: 'https://gh-proxy.com/',
        label: 'gh-proxy.com',
        ms: null,
        status: 'unreachable',
        reason: '超时'
      }
    ]
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    const installed = rowOf(w, 'gh-proxy.com').find('button')
    expect(installed.text()).toBe('已安装')
    expect(installed.attributes('disabled')).toBeUndefined()
    expect(installed.attributes('title')).toContain('仍可查看/卸载')

    await installed.trigger('click')
    await flushPromises()
    expect(w.find('.vitem .uninstall-btn').exists()).toBe(true)
  })

  it('NapCat 最新版按安装来源判断，别的源更高也不能误报更新', async () => {
    inject({
      installedN: 'v4.18.41',
      installedNSourceKey: 'https://gh-proxy.com/',
      latestByBase: {
        'https://gh-proxy.com/': 'v4.18.41',
        'https://cors.isteed.cc/': 'v4.19.0'
      }
    })
    const w = mount(DownloadPage)
    await flushPromises()
    await flushPromises()

    expect(rowOf(w, 'gh-proxy.com').find('button').text()).toBe('已安装')
    expect(rowOf(w, 'cors.isteed.cc').find('button').text()).toBe('下载')
    expect(rowOf(w, 'cors.isteed.cc').find('button').attributes('disabled')).toBeDefined()
  })
})
