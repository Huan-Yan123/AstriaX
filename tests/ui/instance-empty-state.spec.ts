import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../../src/renderer/src/App.vue'

/**
 * 实例页的空态必须能分辨两种情况。
 *
 * 背景：原来两种情况都是同一句话「还没有 AstrBot 实例——点右上角按钮创建第一个」。
 * 但**运行时还没下载**时，右上角的创建按钮根本建不了（向导里会拦住你要版本），
 * 用户照着提示点一圈，只会困惑「为什么建不了」。
 *
 * 所以缺运行时的时候要直说缺什么，并给一个「前往安装」的按钮送到下载页。
 */
const root = 'G:/isolated-ui-fixture'

/** 造一个最小可用的 window.launcher：实例列表为空，运行时状态可控 */
function mountApp(deps: { templateReady: { a: boolean; n: boolean } }) {
  const launcher = {
    // 注意是 instance（单数）—— App.vue 里 `const api = () => window.launcher!.instance`
    instance: {
      list: async () => [],
      status: async () => []
    },
    // 空态的判据来自 runtimes.list（有哪些装好的运行时），不是 templates.status
    runtimes: {
      list: async () => [
        ...(deps.templateReady.a ? [{ type: 'a' as const, tag: 'v4.28.0' }] : []),
        ...(deps.templateReady.n ? [{ type: 'n' as const, tag: 'v4.18.19' }] : [])
      ]
    },
    templates: {
      status: async () => ({
        a: { version: 1, ready: deps.templateReady.a },
        n: { version: 1, ready: deps.templateReady.n }
      })
    },
    mirrors: { state: async () => ({ mirrors: [], pref: { a: '', n: '' } }) },
    sys: { info: async () => ({ freeMemMB: 8000, totalMemMB: 16000, freeDiskMB: 100000, totalDiskMB: 500000 }) },
    config: { get: async () => ({ dataRoot: root }), set: async () => ({}) },
    webui: { list: async () => [], onClosed: () => () => {} },
    onDownloadProgress: () => {},
    onStatus: () => {}
  }
  ;(window as unknown as { launcher: unknown }).launcher = launcher
  return mount(App, { attachTo: document.body })
}

describe('实例页空态：区分「缺运行时」和「缺实例」', () => {
  it('运行时没下载时：说明缺什么，并给「前往安装」按钮', async () => {
    const w = mountApp({ templateReady: { a: false, n: true } })
    await new Promise((r) => setTimeout(r, 30))
    await w.vm.$nextTick()

    const text = w.text()
    expect(text, '应说明缺的是运行时文件').toContain('运行时文件')
    expect(text, '不该只说「点右上角创建」让用户白跑').not.toContain('点右上角按钮创建第一个')
    // 按钮存在且文案指向 AstrBot
    const btn = w.find('.emptygo')
    expect(btn.exists(), '缺运行时时要给「前往安装」按钮').toBe(true)
    expect(btn.text()).toContain('前往安装')
    /*
     * ★ 文案变更（主人 2026-10-08）：
     *   「前往安装 AstrBot / NapCat」→「前往安装运行文件」。
     *
     * 理由：这里缺的是**运行时文件**（不是那个软件本身），
     * 而"AstrBot"这个词在页面标题里已经写明当前是哪一类 ——
     * 按钮里再重复一遍既是废话，也让 A/N 两页的按钮文案不一致。
     */
    expect(btn.text()).toContain('运行文件')
  })

  it('运行时已就绪、只是没建实例：直说没有实例', async () => {
    const w = mountApp({ templateReady: { a: true, n: true } })
    await new Promise((r) => setTimeout(r, 30))
    await w.vm.$nextTick()

    const text = w.text()
    expect(text, '已有运行时就不该再喊缺文件').not.toContain('运行时文件')
    expect(text).toContain('这里还空着')
    expect(text).toContain('创建一个 AstrBot 实例')
    /*
     * 「——点右上角按钮创建第一个」这句按用户要求去掉了
     * （「软件内禁止任何口语化和废话」）：创建按钮就在眼前，
     * 写指路的话是在教用户点按钮。
     */
    expect(text, '不该再有指路式废话').not.toContain('点右上角')
    expect(w.find('.emptygo').text(), '已有运行时应显示创建入口，而不是前往安装').toContain('新建 AstrBot 实例')
    expect(w.find('.emptygo').text()).not.toContain('前往安装')
  })

  it('点「前往安装」会切到下载页', async () => {
    const w = mountApp({ templateReady: { a: false, n: true } })
    await new Promise((r) => setTimeout(r, 30))
    await w.vm.$nextTick()

    await w.find('.emptygo').trigger('click')
    await w.vm.$nextTick()
    // 切到下载页后，实例页的空态就不该在了
    expect(w.find('.emptygo').exists(), '已经离开实例页了').toBe(false)
  })
})
