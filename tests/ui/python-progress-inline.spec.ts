// @vitest-environment happy-dom
/*
 * 内置 Python 的安装进度必须画在「运行环境」卡片的原按钮位置。
 *
 * 之前进度条只出现在顶部「正在进行」区块，卡片里那个按钮一直写「安装中」，
 * 用户看不到百分比 —— 这条测试钉住"替换"这件事本身：
 *   · 点「安装」后，按钮消失，卡片里出现进度条
 *   · 主进程推来的 percent / speedText 要真的上屏
 *   · 顶部任务条不再重复列一份 Python
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DownloadPage from '../../src/renderer/src/DownloadPage.vue'
import { dlInvalidate } from '../../src/renderer/src/dl-cache'

let onProgress: ((p: Record<string, unknown>) => void) | undefined
let finishInstall: (() => void) | undefined

function inject(): void {
  const w = globalThis as unknown as { window: Record<string, unknown> }
  w.window.launcher = {
    mirrors: {
      state: async () => ({ mirrors: [], pref: { a: '', n: '' } }),
      test: async () => [],
      pref: async () => ({ mirrors: [], pref: { a: '', n: '' } })
    },
    runtimes: { list: async () => [] },
    versions: { list: async () => [] },
    app: { qqStatus: async () => ({ ok: true, installed: true, version: '9', minBuild: '8' }) },
    python: {
      status: async () => ({ ready: false, version: '3.12.10' }),
      /* 挂住不返回：让 pyBusy 保持 true，模拟"正在装" */
      install: () =>
        new Promise((resolve) => {
          finishInstall = () => resolve({ ready: true, version: '3.12.10' })
        })
    },
    onDownloadProgress: (cb: (p: Record<string, unknown>) => void) => {
      onProgress = cb
      return () => {
        onProgress = undefined
      }
    }
  }
}

function emitPy(percent: number): void {
  onProgress?.({
    type: 'a',
    tag: 'Python 3.12.10',
    phase: 'downloading',
    percent,
    gotText: '4 MB',
    speedText: '3.6 MB/s',
    done: false
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  dlInvalidate()
  onProgress = undefined
  finishInstall = undefined
  inject()
})

describe('运行环境卡片的 Python 安装进度', () => {
  it('点安装后按钮被进度条替换，并显示真实百分比与速度', async () => {
    const w = mount(DownloadPage)
    await flushPromises()

    const installBtn = w.findAll('button').find((b) => b.text() === '安装')
    expect(installBtn, '未安装时应有一个「安装」按钮').toBeTruthy()
    await installBtn!.trigger('click')
    await flushPromises()

    expect(w.find('.env-track').exists(), '安装中必须在卡片里出现进度条').toBe(true)
    expect(w.text()).not.toContain('安装中')

    emitPy(42)
    await flushPromises()

    const bar = w.find('.env-bar')
    expect(bar.attributes('style'), '填充宽度必须跟随真实进度').toContain('width: 42%')
    expect(w.find('.env-percent').text()).toBe('42%')
    expect(w.find('.env-speed').text()).toContain('3.6 MB/s')

    /* 顶部「正在进行」不再重复列 Python（它已经在卡片里了） */
    expect(w.find('.task-strip').exists(), 'Python 未开始下载前不该出现顶部任务条').toBe(false)

    finishInstall?.()
    await flushPromises()
  })

  it('切页回来时（pyBusy 已重置）只要有活跃进度，仍显示进度条而不是「安装」按钮', async () => {
    const w = mount(DownloadPage)
    await flushPromises()

    /* 模拟挂载时 downloadSessions 恢复的进度快照：没在本组件点过安装 */
    emitPy(18)
    await flushPromises()

    expect(w.find('.env-track').exists(), '恢复的进度必须继续显示').toBe(true)
    expect(
      w.findAll('button').some((b) => b.text() === '安装'),
      '正在装的时候不该再给一个「安装」按钮'
    ).toBe(false)
  })
})
