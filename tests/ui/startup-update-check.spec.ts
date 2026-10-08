/*
 * 启动时自动检查更新（用户要求）：
 *
 *   「软件只有在每次启动的时候会检测一次更新，一天会推送一次，
 *     用户可以选择跳过此版本，再下个版本更新的时候再弹窗」
 *   「如果从服务器获取版本失败则显示最新版」
 *
 * 分成两层，这一份测的是**渲染层的行为**（主进程的节流/跳过逻辑在
 * app-update.spec.ts 里覆盖）：
 *   - 有新版 → 弹窗问要不要下载
 *   - 没新版 / 检查失败 → 完全不打扰（一个弹窗都不出）
 *   - 「以后再说」→ 不下载（但也别把版本记成已跳过，那要用户明确点跳过）
 *
 * 为什么要专门测「不打扰」：启动路径上多一个弹窗，用户每天开软件都要被烦一次。
 * 静默检查写错成「失败也弹窗」的话，没网的用户每次开机都会被弹一脸。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import App from '../../src/renderer/src/App.vue'

/*
 * 弹窗是 <Teleport to="body"> 渲染的，**不在 wrapper 的子树里** ——
 * 用 w.text() 断言弹窗内容会永远看不到（我第一版就是这么写错的）。
 * 必须看 document.body。
 */
const bodyText = (): string => document.body.textContent ?? ''

/** 弹窗里的按钮文案（知道能点什么） */
const bodyButtons = (): string[] =>
  [...document.body.querySelectorAll('button')].map((b) => b.textContent ?? '')

/** 收集所有弹窗标题，以及被点掉的按钮文案 */
interface Spy {
  dlCalls: Array<{ url: string; version: string }>
}

function injectApp(over: Record<string, unknown> = {}): Spy {
  const spy: Spy = { dlCalls: [] }
  const app = {
    version: async () => '0.1.0',
    checkUpdate: async () => ({ hasUpdate: false, currentVersion: '0.1.0' }),
    downloadUpdate: async (p: { url: string; version: string }) => {
      spy.dlCalls.push(p)
      return 'C:\\Users\\x\\Downloads\\AstriaX-Setup-0.1.1.exe'
    },
    skipVersion: async () => undefined,
    ...over
  }
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.launcher = {
    config: {
      get: async () => ({ dataRoot: 'D:\\ACB\\data' }),
      set: async () => undefined
    },
    instance: { list: async () => [] },
    runtimes: { list: async () => [] },
    versions: { prewarm: async () => undefined },
    webui: { list: async () => [] },
    app
  }
  return spy
}

beforeEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('启动时检查更新', () => {
  it('★有新版 → 弹窗提示，并带上网址与版本号', async () => {
    const spy = injectApp({
      checkUpdate: async () => ({
        hasUpdate: true,
        currentVersion: '0.1.0',
        latestVersion: '0.1.1',
        url: 'http://47.109.177.13/mxbot/AstriaX-Setup-0.1.1.exe',
        sizeMB: 80
      })
    })

    mount(App, { attachTo: document.body })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 20))

    const text = bodyText()
    expect(text, '要告诉用户发现了新版本').toContain('0.1.1')
    expect(text, '要说明当前版本').toContain('0.1.0')
    // 弹窗要给出「下载」这个动作
    expect(bodyButtons()).toContain('下载')
    expect(spy.dlCalls, '只是提示，用户没点之前不该开始下载').toHaveLength(0)
  })

  it('★没有新版 → 一个弹窗都不出（不能打扰用户）', async () => {
    injectApp({ checkUpdate: async () => ({ hasUpdate: false, currentVersion: '0.1.0' }) })

    mount(App, { attachTo: document.body })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 20))

    expect(bodyText(), '没更新就不该有任何更新弹窗').not.toContain('新版本')
    expect(bodyText()).not.toContain('0.1.1')
  })

  it('★检查失败（没网/服务器挂了）→ 也不能弹窗（用户要求当作最新版）', async () => {
    injectApp({
      checkUpdate: async () => {
        throw new Error('fetch failed')
      }
    })

    mount(App, { attachTo: document.body })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 20))

    expect(bodyText(), '检查失败是常态（没网），不该弹窗吓用户').not.toContain('新版本')
    expect(bodyText()).not.toContain('更新失败')
  })

  it('★checkUpdate 抛错不会把启动搞崩（界面照样渲染实例页）', async () => {
    injectApp({
      checkUpdate: async () => {
        throw new Error('boom')
      }
    })

    const w = mount(App, { attachTo: document.body })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 20))

    // 启动没被拖垮：主界面该有的东西都在
    expect(w.text()).toContain('AstrBot')
    expect(w.text()).not.toContain('读取配置失败')
  })

  it('界面不直接调 skipVersion（跳过要用户明确点，不能自动跳过）', async () => {
    const skip = vi.fn(async () => undefined)
    injectApp({
      checkUpdate: async () => ({
        hasUpdate: true,
        currentVersion: '0.1.0',
        latestVersion: '0.1.1',
        url: 'http://x/y.exe'
      }),
      skipVersion: skip
    })

    mount(App, { attachTo: document.body })
    await flushPromises()
    await new Promise((r) => setTimeout(r, 20))

    expect(skip, '光弹窗不该等于跳过这个版本').not.toHaveBeenCalled()
  })
})
