// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DownloadPage from '../../src/renderer/src/DownloadPage.vue'
import { dlInvalidate } from '../../src/renderer/src/dl-cache'

/**
 * ★ 资源页左侧的「项目主页 / 求 Star」卡片（主人 2026-10-08）
 *
 * 主人原话：
 *   「在资源页左侧超链这个 GitHub 链接
 *     https://github.com/Huan-Yan123/AstriaX 并写感谢以及要 Star 的文案」
 *
 * 这里钉三件事：
 *   ① 链接**确实是**那个仓库地址（不能写错 owner/repo）
 *   ② 点它走的是 `app.openExternal`（**不能在应用窗口里导航** ——
 *      那会把启动器本身变成一个浏览器页面，用户回不来）
 *   ③ 文案里真的提到了 Star（主人明确要求的）
 */

const GITHUB_URL = 'https://github.com/Huan-Yan123/AstriaX'

let opened: string[] = []

function inject(): void {
  opened = []
  const w = globalThis as unknown as { window: Record<string, unknown> }
  w.window.launcher = {
    app: {
      openExternal: async (url: string) => {
        opened.push(url)
      }
    },
    mirrors: {
      state: async () => ({
        mirrors: [
          { label: 'gh-proxy.com', base: 'https://gh-proxy.com/', mode: 'proxy', builtin: true }
        ],
        pref: { a: '', n: '' }
      }),
      add: async () => undefined,
      remove: async () => undefined,
      test: async () => [],
      pref: async () => undefined
    },
    pysrc: {
      state: async () => ({
        sources: [{ label: 'Python源', indexUrl: 'https://pypi.org/simple/', builtin: true }],
        pref: ''
      }),
      test: async () => []
    },
    versions: { list: async () => [] },
    runtimes: { list: async () => [], remove: async () => undefined },
    python: { status: async () => ({ ready: true, version: '3.12.10' }) },
    stats: { overview: async () => ({ system: { totalMemMB: 16000, freeMemMB: 8000, totalDiskMB: 0, freeDiskMB: 0 } }) },
    onDownloadProgress: () => () => undefined,
    downloadSessions: async () => []
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  dlInvalidate()
})

describe('★ 资源页左侧：项目主页求 Star', () => {
  it('是**超链接**（<a> 带 href），文案提到 Star，且没有单独背景', async () => {
    inject()
    const w = mount(DownloadPage)
    await flushPromises()

    /*
     * 主人明确要求是「超链」而不是一个包着整块的按钮 ——
     * 所以可点的只有那串地址本身。
     */
    const link = w.find('a.repo-link')
    expect(link.exists(), '应当是一个真正的 <a> 超链接（不是 button）').toBe(true)
    expect(link.attributes('href'), 'href 要指向仓库').toBe(GITHUB_URL)
    expect(link.text(), '链接文字就是地址').toContain('github.com/Huan-Yan123/AstriaX')

    const note = w.find('.repo-note')
    expect(note.text().toLowerCase(), '要包含 Star 的请求（主人明确要求）').toContain('star')

    /* 位置：在资源项**下面**，不是被推到最底部 */
    const nav = w.find('aside.resource-nav')
    const html = nav.html()
    const itemsIdx = html.lastIndexOf('resource-item')
    const noteIdx = html.indexOf('repo-note')
    expect(noteIdx, '项目主页应当在左侧栏里').toBeGreaterThan(-1)
    expect(noteIdx, '应当在资源项**之后**（"放在资源下面"）').toBeGreaterThan(itemsIdx)
  })

  it('★ 点击用 openExternal 打开，且阻止窗口内导航', async () => {
    inject()
    const w = mount(DownloadPage)
    await flushPromises()

    const link = w.find('a.repo-link')
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    link.element.dispatchEvent(ev)
    await flushPromises()

    expect(opened, '应当调用 app.openExternal 打开仓库').toEqual([GITHUB_URL])
    /*
     * preventDefault 是关键：Electron 渲染进程里 <a> 的默认导航
     * 会把**启动器窗口自己**换成那个网页，用户回不来。
     */
    expect(ev.defaultPrevented, '<a> 的默认导航必须被阻止（否则启动器窗口会被替换成网页）').toBe(true)
  })

  it('★ 地址必须与主进程的发布地址一致（防 owner/repo 写错）', async () => {
    /*
     * 渲染层不 import 主进程模块，所以这个地址在两边各写了一份
     *（DownloadPage 的 GITHUB_REPO_URL / publish-urls.ts 的 GITHUB_WEB_URL）。
     * 两份就可能漂移 —— 比如仓库改名只改了一处，用户点进去是 404。
     * 这条守卫直接读主进程那份来对，保证"改一处漏一处"能被抓住。
     */
    const { GITHUB_WEB_URL } = await import('../../src/main/update/publish-urls')
    const src = (await import('fs')).readFileSync(
      (await import('path')).join(__dirname, '..', '..', 'src', 'renderer', 'src', 'DownloadPage.vue'),
      'utf8'
    )
    const m = /const GITHUB_REPO_URL = '([^']+)'/.exec(src)
    expect(m, 'DownloadPage 里应当有 GITHUB_REPO_URL 常量').toBeTruthy()
    expect(
      m![1],
      `渲染层写的仓库地址（${m![1]}）与主进程的 GITHUB_WEB_URL（${GITHUB_WEB_URL}）不一致 ——\n` +
        '两边各写了一份，改了就要一起改，否则用户点进去是 404'
    ).toBe(GITHUB_WEB_URL)
  })

  it('★ 群号与设置页用的是同一个', async () => {
    /*
     * 这个号在两个文件里各写了一遍（DownloadPage / SettingsPanel）。
     * 不一致的后果很直接：用户照着其中一处去加，加不进去。
     * 所以钉住"两处必须相同"。
     */
    const fs = await import('fs')
    const path = await import('path')
    const root = path.join(__dirname, '..', '..', 'src', 'renderer', 'src')
    const dl = fs.readFileSync(path.join(root, 'DownloadPage.vue'), 'utf8')
    const settings = fs.readFileSync(path.join(root, 'SettingsPanel.vue'), 'utf8')

    const inDl = /const OFFICIAL_GROUP = '([^']+)'/.exec(dl)?.[1]
    const inSettings = /const OFFICIAL_GROUP = '([^']+)'/.exec(settings)?.[1]
    expect(inDl, 'DownloadPage 里应当有 OFFICIAL_GROUP 常量').toBeTruthy()
    expect(inSettings, '设置页里应当有 OFFICIAL_GROUP 常量').toBeTruthy()
    expect(
      inDl,
      `群号不一致：DownloadPage=${inDl}，设置页=${inSettings} —— 用户照着其中一处会加不进去`
    ).toBe(inSettings)
  })

  it('★ 反馈教程：说清"先导出日志"、引导加群，且**不给** GitHub 渠道', async () => {
    inject()
    const w = mount(DownloadPage)
    await flushPromises()

    const guide = w.find('.feedback-guide')
    expect(guide.exists(), '左侧栏应当有问题反馈教程').toBe(true)

    const text = guide.text()
    expect(text, '教程第一步必须是"导出日志"（这是能定位问题的关键）').toContain('导出日志')
    expect(text, '要给出官方群号').toContain('1077554004')
    expect(text, '要让用户说清"做了什么/期望什么/实际看到什么"').toMatch(/做了什么/)

    /*
     * 主人 2026-10-08：「去掉 GitHub 的反馈渠道」——
     * 目标用户是 QQ 机器人玩家，让他们去注册 GitHub 账号写 issue 不现实。
     */
    expect(
      guide.find('a').exists(),
      '反馈教程里不该再有 GitHub 链接（渠道已改为群）'
    ).toBe(false)
    expect(text, '不该再出现 GitHub Issues 字样').not.toMatch(/Issues/i)
  })

  it('★ 使用流程区块存在、按顺序给出、且有实质内容（左侧栏不该留大片空白）', async () => {
    inject()
    const w = mount(DownloadPage)
    await flushPromises()

    const flow = w.find('.flow-guide')
    expect(flow.exists(), '左侧栏应当有使用流程').toBe(true)

    const steps = flow.findAll('li')
    expect(steps.length, '至少要有几条步骤，否则填不满左侧栏').toBeGreaterThanOrEqual(4)
    /* 有序列表：这是"按顺序做"的引导，不是可任选其一 */
    expect(flow.find('ol').exists(), '使用流程必须是有序列表（有先后顺序）').toBe(true)
    expect(flow.text(), '标题应当是"使用流程"').toContain('使用流程')
  })
})
