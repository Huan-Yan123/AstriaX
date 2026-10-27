// @vitest-environment happy-dom
/*
 * 版本行右侧的下载进度条（真实链路）。
 *
 * 要求（主人 2026-10-25）：点「下载」后，**版本号右边**出现进度条，
 * AstrBot 和 NapCat 的版本列表都要如此。
 * 进度数据必须来自主进程推的 download:progress 事件：
 *   · 点下载后该行出现进度条，按钮消失
 *   · 主进程推来的 percent / speedText 真的上屏
 *   · 安装结束后进度条收掉
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DownloadPage from '../../src/renderer/src/DownloadPage.vue'
import { dlInvalidate } from '../../src/renderer/src/dl-cache'

let onProgress: ((p: Record<string, unknown>) => void) | undefined
let finishInstall: (() => void) | undefined

function inject(opts: { sessions?: Array<Record<string, unknown>> } = {}): void {
  const w = globalThis as unknown as { window: Record<string, unknown> }
  w.window.launcher = {
    mirrors: {
      state: async () => ({
        mirrors: [
          { label: 'gh-proxy.com', base: 'https://gh-proxy.com/', mode: 'proxy', builtin: true }
        ],
        pref: { a: 'https://gh-proxy.com/', n: 'https://gh-proxy.com/' }
      }),
      test: async () => [],
      pref: async () => undefined
    },
    versions: {
      list: async () => [
        { tag: 'v4.29.3', assetName: 'x.zip', from: 'gh-proxy.com', base: 'https://gh-proxy.com/', publishedAt: '2026-10-24T00:00:00Z' }
      ]
    },
    runtime: {
      /* 挂住不返回，模拟"正在下载" */
      install: () =>
        new Promise((resolve) => {
          finishInstall = () => resolve({ tag: 'v4.29.3' })
        })
    },
    runtimes: { list: async () => [] },
    pysrc: {
      state: async () => ({
        sources: [{ label: 'Python源', indexUrl: 'https://pypi.org/simple/', builtin: true }],
        pref: 'Python源'
      }),
      test: async () => []
    },
    python: { status: async () => ({ ready: true, version: '3.12.10' }) },
    app: { qqStatus: async () => ({ ok: true, installed: true, version: '9', minBuild: '8' }) },
    onDownloadProgress: (cb: (p: Record<string, unknown>) => void) => {
      onProgress = cb
      return () => {
        onProgress = undefined
      }
    },
    downloadSessions: async () => opts.sessions ?? []
  }
}

function emitRow(percent: number, speed: string): void {
  onProgress?.({
    type: 'a',
    tag: 'v4.29.3',
    phase: 'downloading',
    percent,
    gotText: '10 MB',
    speedText: speed,
    done: false
  })
}

function emitDone(): void {
  onProgress?.({
    type: 'a',
    tag: 'v4.29.3',
    phase: 'done',
    percent: 100,
    gotText: '10 MB',
    speedText: '完成',
    done: true
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  dlInvalidate()
  onProgress = undefined
  finishInstall = undefined
  inject()
})

describe('版本行右侧的下载进度条', () => {
  it('点下载后版本号右边出现进度条，显示真实百分比与速度，结束后收掉', async () => {
    const w = mount(DownloadPage)
    await flushPromises()

    /* 从 AstrBot 分组打开版本弹窗 */
    const aGroup = w.findAll('.source-block').find((s) => s.text().includes('AstrBot'))!
    await aGroup.findAll('.source-row button').find((b) => b.text() === '下载')!.trigger('click')
    await flushPromises()

    const row = w.find('.vitem')
    expect(row.text(), '先确认版本行本身在').toContain('v4.29.3')
    await row.findAll('button').find((b) => b.text() === '下载')!.trigger('click')
    await flushPromises()

    expect(w.find('.row-track').exists(), '点下载后版本行右侧必须出现进度条').toBe(true)
    expect(
      w.findAll('.vitem button').some((b) => b.text() === '下载'),
      '按钮应被进度条替换'
    ).toBe(false)

    emitRow(37, '4.2 MB/s')
    await flushPromises()
    expect(w.find('.row-percent').text()).toBe('37%')
    expect(w.find('.row-speed').text()).toContain('4.2 MB/s')
    /* 下载中日期必须让位：那一栏只放进度条，日期挤掉速度就是这次要修的问题 */
    expect(w.find('.vitem .meta').exists(), '下载中不应再显示发布日期').toBe(false)

    /* 安装结束：busy 解除，进度条收掉 */
    finishInstall?.()
    emitDone()
    await flushPromises()
    expect(w.find('.row-track').exists(), '完成后进度条应消失').toBe(false)
  })

  it('安装中关闭版本弹窗后，任务回到顶部条并保留取消入口', async () => {
    const w = mount(DownloadPage)
    await flushPromises()
    const aGroup = w.findAll('.source-block').find((s) => s.text().includes('AstrBot'))!
    await aGroup.findAll('.source-row button').find((b) => b.text() === '下载')!.trigger('click')
    await flushPromises()
    await w.findAll('.vitem button').find((b) => b.text() === '下载')!.trigger('click')
    await flushPromises()
    emitRow(24, '2.1 MB/s')
    await flushPromises()
    expect(w.find('.row-track').exists()).toBe(true)

    await w.find('.dhead .x').trigger('click')
    await flushPromises()

    expect(w.find('.row-track').exists(), '弹窗关了，行内进度也必须一起消失').toBe(false)
    expect(w.find('.task-strip').exists(), '任务应回落到顶部进行中区域').toBe(true)
    expect(w.find('.task-strip .cancelbtn').text()).toBe('取消')
  })

  it('切页恢复的活跃进度，在重新打开版本列表后回到对应行', async () => {
    inject({
      sessions: [
        {
          type: 'a',
          tag: 'v4.29.3',
          phase: 'downloading',
          percent: 31,
          gotText: '3 MB',
          speedText: '1.7 MB/s',
          done: false
        }
      ]
    })
    const w = mount(DownloadPage)
    await flushPromises()

    expect(w.find('.task-strip').exists(), '未打开版本列表时应先显示在顶部').toBe(true)
    const aGroup = w.findAll('.source-block').find((s) => s.text().includes('AstrBot'))!
    await aGroup.findAll('.source-row button').find((b) => b.text() === '下载')!.trigger('click')
    await flushPromises()

    expect(w.find('.row-track').exists(), '恢复的进度应画在对应版本行').toBe(true)
    expect(w.find('.row-percent').text()).toBe('31%')
    expect(
      w.findAll('.vitem button').some((b) => b.text() === '下载'),
      '同一任务不能同时给进度和下载按钮'
    ).toBe(false)
    expect(w.find('.task-strip').exists(), '行内可见时顶部不重复').toBe(false)
  })
})
