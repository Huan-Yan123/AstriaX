// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DownloadPage from '../../src/renderer/src/DownloadPage.vue'

// 模拟旧数据中的已停用来源，验证当前页面不会将其显示。
const MX_OFFICIAL_BASE = 'https://retired-source.example/'

interface Calls {
  installed: Array<{ type: 'a' | 'n'; tag: string }>
  removed: Array<{ type: 'a' | 'n'; tag: string }>
  installedRuntimes: Array<{ type: 'a' | 'n'; tag: string; base?: string }>
  pref: Array<{ a?: string; n?: string }>
}

function inject(opts: { runtimes?: Array<{ type: 'a' | 'n'; tag: string; sizeMB?: number }>; versions?: Array<Record<string, unknown>> } = {}): Calls {
  const calls: Calls = { installed: [], removed: [], installedRuntimes: [], pref: [] }
  const runtimes = opts.runtimes ?? []
  /** Python 是否已装（install 之后要真的变 true，见下面 python 段的注释） */
  let pyReady = false
  const w = globalThis as unknown as { window: Record<string, unknown> }
  w.window.launcher = {
    mirrors: {
      state: async () => ({
        mirrors: [
          { label: 'GitHub 直连', base: '', mode: 'proxy', builtin: true },
          { label: 'gh-proxy.com', base: 'https://gh-proxy.com/', mode: 'proxy', builtin: true },
          { label: 'AstriaX官方源', base: `${MX_OFFICIAL_BASE}files/`, mode: 'files', builtin: true, hideBase: true },
          // 用户自己加的坏源：应出现在「连不上」清理提示里
          { label: '坏掉的源', base: 'https://dead.example/', mode: 'proxy' }
        ],
        pref: { a: 'https://gh-proxy.com/', n: '' }
      }),
      add: async () => undefined,
      remove: async () => undefined,
      // 探测：gh-proxy 最快；坏源不通；还有一个「连得上但源上没文件」的
      test: async () => [
        { base: '', label: 'GitHub 直连', ms: 180, status: 'ok' },
        { base: 'https://gh-proxy.com/', label: 'gh-proxy.com', ms: 12, status: 'ok' },
        { base: `${MX_OFFICIAL_BASE}files/`, label: 'AstriaX官方源', ms: 40, status: 'ok' },
        {
          base: 'https://dead.example/',
          label: '坏掉的源',
          ms: null,
          status: 'unreachable',
          reason: 'HTTP 403'
        }
      ],
      pref: async (p: { a?: string; n?: string }) => {
        calls.pref.push(p)
        return undefined
      }
    },
    versions: {
      list: async () =>
        opts.versions ?? [
          { tag: 'v4.18.19', assetName: 'NapCat.Shell.Windows.Node.zip', sizeMB: 111.7, from: 'gh-proxy.com', base: 'https://gh-proxy.com/', publishedAt: '2026-09-01T00:00:00Z' },
          { tag: 'v4.18.10', assetName: 'NapCat.Shell.Windows.Node.zip', sizeMB: 110.2, from: 'gh-proxy.com', base: 'https://gh-proxy.com/' }
        ]
    },
    runtime: {
      install: async (p: { type: 'a' | 'n'; tag: string; base?: string }) => {
        calls.installedRuntimes.push(p)
        return { tag: p.tag, from: 'gh-proxy.com' }
      }
    },
    runtimes: {
      list: async () => runtimes,
      remove: async (p: { type: 'a' | 'n'; tag: string }) => {
        calls.removed.push(p)
      }
    },
    python: {
      /*
       * ★ 装完之后 status 必须真的变成 ready（mock 要像真实世界）
       *
       * 我第一版这里 status 恒返回 ready:false —— 而 0.1.3 给「装 Python」
       * 加了写后 `reload()`（审计要求：装完要失效缓存并重新拉状态），
       * 于是装完 reload 一问，mock 又说"没装"，界面退回「未安装」，
       * 测试就红了。那不是产品的错，是 mock 停在旧世界：
       * 真实主进程装完 Python 之后 status 当然报 ready。
       */
      status: async () => ({ ready: pyReady, version: '3.12.10' }),
      install: async () => {
        pyReady = true
        return { ready: true, version: '3.12.10' }
      }
    },
    /*
     * AstrBot 的 Python 源（pip 索引）—— 下载页的「AstrBot 下载」分区要读它。
     *
     * 主人 2026-09-27：「AstrBot 下载，下面是 python 源和官方源」。
     * 这两条内置源就是 python-source.ts 内置表的真实形态（label + 说明）。
     */
    pysrc: {
      state: async () => ({
        sources: [
          {
            label: 'PyPI 官方（推荐）',
            indexUrl: 'https://pypi.org/simple/',
            note: '三项实测全通',
            builtin: true
          },
          {
            label: '腾讯云（仅安装加速）',
            indexUrl: 'https://mirrors.cloud.tencent.com/pypi/simple/',
            note: '索引可用；没有元数据接口',
            builtin: true
          }
        ],
        pref: '',
        active: {
          label: 'PyPI 官方（推荐）',
          indexUrl: 'https://pypi.org/simple/',
          builtin: true
        }
      }),
      pref: async (label: string) => ({ sources: [], pref: label, active: { label, indexUrl: '' } }),
      remove: async () => ({ sources: [], pref: '', active: undefined })
    },
    onDownloadProgress: () => () => undefined
  }
  return calls
}

beforeEach(async () => {
  vi.restoreAllMocks()
  /*
   * ★ 清掉页面级的 SWR / 探测节流缓存
   *
   * 下载页的缓存与"刚探测过"的时刻是**模块级**的（跨挂载存活，这是
   * 刻意的：主人抱怨过"每次点进去都重新加载"）。副作用是它会跨**测试用例**
   * 残留 —— 上一个用例刚探测过，下一个用例的自动探测就被 60s 节流挡掉，
   * 于是断言"进页面会探测"的那两条会莫名其妙地红。
   *
   * 这不是产品的错，是测试需要自己清理模块级状态（和清 mock 一个道理）。
   */
  const { dlInvalidate } = await import('../../src/renderer/src/dl-cache')
  dlInvalidate()
})

describe('下载页', () => {
  it('列出镜像源，且不暴露服务器 IP（官方源条目已按用户要求移除）', async () => {
    inject()
    const w = mount(DownloadPage)
    await flushPromises()
    const text = w.text()
    expect(text).toContain('GitHub 直连')
    /*
     * ★ 契约变更（主人 2026-10-08）：「去掉官方源」。
     * 原来是断言"官方源要显示"，现在反过来 —— 它不该再出现在列表里。
     */
    expect(text, '官方源条目已移除').not.toContain('AstriaX官方源')
    // 隐藏真实地址：UI 里绝不出现发布主机的地址
    expect(text).not.toContain(new URL(MX_OFFICIAL_BASE).hostname)
  })

  it('★源按类型**分两块**：AstrBot（Python 源）+ NapCat（GitHub 源）', async () => {
    /*
     * 主人 2026-09-27：
     *   「你为啥不直接在下载页分类，NapCat 下载，下面是 github 源，
     *     AstrBot 下载，下面是 python 源」
     *
     * ★ 2026-10-08 更新：区块标题从「AstrBot 下载 / NapCat 下载」
     *   简化为「AstrBot / NapCat」（小标题放大加粗），
     *   所在的父区块从「下载来源」改名为「下载资源」。
     */
    inject()
    const w = mount(DownloadPage)
    await flushPromises()

    const text = w.text()
    expect(text, '要有下载资源区块').toContain('下载资源')
    expect(text, '要列出 AstrBot 的源').toContain('AstrBot')
    expect(text, '要列出 NapCat 的源').toContain('NapCat')

    /*
     * 结构性断言：GitHub 系源（反代）**不该出现在 AstrBot 那一组里**。
     * 这是主人那条"为什么 github 源打开还是有 astrbot"的直接验收。
     */
    const groups = w.findAll('.source-block')
    const astrbotGroup = groups.find((s) => s.text().includes('AstrBot'))
    const napcatGroup = groups.find((s) => s.text().includes('NapCat'))
    expect(astrbotGroup, '找得到 AstrBot 分组').toBeTruthy()
    expect(napcatGroup, '找得到 NapCat 分组').toBeTruthy()

    const aText = astrbotGroup!.text()
    expect(aText, 'AstrBot 分组里不该有 GitHub 反代源').not.toContain('gh-proxy.com')
    expect(aText, 'AstrBot 分组里不该有 GitHub 反代源').not.toContain('cors.isteed.cc')
  })

  it('★点源 → 弹出该源版本列表，且**弹窗里没有类型切换器**', async () => {
    /*
     * ★ 契约变更（主人 2026-09-27）：
     *   「napcat 源列表点下载里面有 astrbot，astrbot 源点下载里面有 napcat
     *     是什么情况」
     *
     * 根因是弹窗里那个 `.seg` 的 AstrBot/NapCat 切换器 ——
     * 无论从哪个源点进来都能切到另一类，**直接推翻了下载页的分类**。
     *
     * 现在：从哪一类进来就只列哪一类，弹窗里没有类型切换器。
     *
     * 另外「展开的下载列表不要标注文件大小」—— 各版本大小几乎一样，
     * 是纯噪音（原来这里断言过 '111.7 MB'，现在反过来断言它不出现）。
     */
    inject()
    const w = mount(DownloadPage)
    await flushPromises()
    /*
     * 源列表现在是表格行（.source-row）。
     *
     * ★ 必须从 **NapCat 分组**点进去（主人 2026-10-08）。
     *   原来只点"第一个下载按钮"，而 AstrBot 组在前、
     *   且新加了 Python 前置检查 —— 于是弹出的是「要先装 Python 呀」，
     *   根本到不了版本列表。那不是 bug，是产品按新契约在正确工作。
     */
    const groups = w.findAll('.source-block')
    const napcatGroup = groups.find((s) => s.text().includes('NapCat'))!
    const openBtn = napcatGroup.findAll('.source-row button').find((b) => b.text() === '下载')!
    expect(openBtn, 'NapCat 分组里要有可点的下载按钮').toBeTruthy()
    await openBtn.trigger('click')
    /*
     * ★ 需要**两轮** flush：点开弹窗后组件内部还有一次
     *   `loadVersions()` 的异步取版本 —— 单轮 flush 只让弹窗挂上，
     *   版本内容还没进来。
     */
    await flushPromises()
    await flushPromises()

    // 弹窗里出现版本
    expect(w.find('.dlg').exists(), '应当弹出弹窗').toBe(true)
    expect(w.find('.dlg').text()).toContain('v4.18.19')

    // ★ 不许有类型切换器
    expect(
      w.findAll('.seg button').length,
      '弹窗里又有 AstrBot/NapCat 切换器了 —— 那会让"点哪个源都能看到另一类"，\n' +
        '与下载页的分类直接矛盾。'
    ).toBe(0)

    // ★ 版本列表里不该出现文件大小
    const vlist = w.find('.vlist')
    if (vlist.exists()) {
      expect(
        vlist.text(),
        '版本列表里又标注文件大小了 —— 各版本大小几乎一样，是噪音'
      ).not.toMatch(/\d+(\.\d+)?\s*MB/)
    }
  })

  it('已安装的版本按钮变成「已安装」且不可点', async () => {
    inject({ runtimes: [{ type: 'n', tag: 'v4.18.19', sizeMB: 111.7 }] })
    const w = mount(DownloadPage)
    await flushPromises()
    /*
     * 从 **NapCat 分组**进入弹窗（弹窗里已无类型切换器，见上一条的说明）。
     *
     * ★ 2026-10-08：选择器从 `section.card` + `.mrow button`
     *   改成 `.source-block` + `.source-row button`
     *   —— 页面重写后源列表是表格行，不再是卡片。
     */
    const groups = w.findAll('.source-block')
    const napcatGroup = groups.find((s) => s.text().includes('NapCat'))!
    expect(napcatGroup, '找得到 NapCat 分组').toBeTruthy()
    const openBtn = napcatGroup.findAll('.source-row button').find((b) => b.text() === '下载')!
    await openBtn.trigger('click')
    await flushPromises()
    const done = w.findAll('button').find((b) => b.text() === '已安装')
    expect(done).toBeTruthy()
    expect((done!.element as HTMLButtonElement).disabled).toBe(true)
    // 未装的还是「下载」
    expect(w.findAll('.vitem button').some((b) => b.text() === '下载')).toBe(true)
  })

  it('未装时点「下载」→ 调 runtime.install 并带上类型/版本/源', async () => {
    const calls = inject()
    const w = mount(DownloadPage)
    await flushPromises()
    /*
     * ★ 从 **NapCat 分组**点「下载」（主人 2026-09-27 之后弹窗不再有类型切换器）
     *
     * 弹窗的类型由"从哪个分组点进来"决定，所以要先定位到 NapCat 分组。
     */
    const groups = w.findAll('.source-block')
    const napcatGroup = groups.find((s) => s.text().includes('NapCat'))!
    expect(napcatGroup, '找得到 NapCat 分组').toBeTruthy()
    const openBtn = napcatGroup.findAll('.source-row button').find((b) => b.text() === '下载')!
    await openBtn.trigger('click')
    await flushPromises()
    const dl = w.findAll('.vitem button').find((b) => b.text() === '下载')!
    await dl.trigger('click')
    await flushPromises()
    expect(calls.installedRuntimes).toHaveLength(1)
    expect(calls.installedRuntimes[0].type).toBe('n')
    expect(calls.installedRuntimes[0].tag).toBe('v4.18.19')
  })

  it('已装版本可按资源切换查看，可删除指定版本', async () => {
    const calls = inject({
      runtimes: [
        { type: 'a', tag: 'v4.28.0', sizeMB: 5.7 },
        { type: 'n', tag: 'v4.18.19', sizeMB: 111.7 }
      ]
    })
    const w = mount(DownloadPage)
    await flushPromises()
    /*
     * ★ 契约变更（主人 2026-10-08）：
     *   「资源的 astrbot 和 napcat 加入点击切换对应内容，加入翻页」
     *
     * 原来是 A/N 两栏**同时**显示；现在是"点左侧资源切换、右侧只显示
     * 当前那一类"，并且一页最多 5 条。所以不能再用 `w.text()` 断言
     * 两个版本号同时出现 —— 要先切到 NapCat 才看得到 v4.18.19。
     */
    expect(w.text(), '默认显示 AstrBot，能看到它的版本').toContain('v4.28.0')

    // 切到 NapCat
    const navBtns = w.findAll('.resource-item')
    const napcatNav = navBtns.find((b) => b.text().includes('NapCat'))!
    await napcatNav.trigger('click')
    await flushPromises()
    expect(w.text(), '切到 NapCat 后显示它的版本').toContain('v4.18.19')

    // 删掉当前显示的这个版本（NapCat v4.18.19）
    const del = w.findAll('.version-row button').find((b) => b.text() === '删除')!
    await del.trigger('click')
    await flushPromises()
    // 确认弹窗 → 删除
    const confirm = w.findAll('.dlg button').find((b) => b.text() === '删除')!
    await confirm.trigger('click')
    await flushPromises()
    expect(calls.removed).toHaveLength(1)
    expect(calls.removed[0]).toEqual({ type: 'n', tag: 'v4.18.19' })
  })

  it('Python 未装时给安装入口，装完显示具体版本', async () => {
    inject()
    const w = mount(DownloadPage)
    /*
     * ★ 环境格的内容来自 `loadEnvironment()`，它要经 `stats:overview`
     *   走一次异步 —— 单轮 flushPromises 常常还没回来（实测环境格是空的）。
     *   多等一轮，避免把"数据还没到"当成"功能坏了"。
     */
    await flushPromises()
    await flushPromises()
    expect(w.text()).toContain('未安装')
    const b = w.findAll('button').find((x) => x.text() === '下载独立 Python')!
    await b.trigger('click')
    await flushPromises()
    await flushPromises()
    /*
     * ★ 文案变更（2026-10-08）：装完之后环境区那一格显示的是
     *   **具体版本号**（`Python 3.12.10`），而不是笼统的「已安装」。
     *   版本号比"已安装"信息量大：用户能一眼看出装的是哪个版本。
     */
    expect(w.text()).toContain('3.12.10')
  })

  it('进入页面自动探测各源，只有「通了且源上有文件」才标可用', async () => {
    inject()
    const w = mount(DownloadPage)
    await flushPromises()
    const text = w.text()
    /*
     * ★ 文案变更（2026-10-08）：延迟标注从「可用 12 ms」改成
     *   「可用 12ms」（去掉了数字与单位之间的空格，为了在表格里更紧凑）。
     */
    expect(text).toContain('可用 12ms')
    expect(text).toContain('可用 180ms')
    // 连不上的源标「不可用」
    expect(text).toContain('不可用')
    expect(text).not.toContain('连不上')
  })

  it('连得上但源上没有文件 → 也算不可用（不能标成可用骗用户点下载）', async () => {
    inject()
    const w = mount(DownloadPage)
    // 换一份「源活着但没货」的探测结果
    const win = (globalThis as unknown as { window: Record<string, unknown> }).window
    const m = (win.launcher as Record<string, unknown>).mirrors as Record<string, unknown>
    m.test = async () => [
      { base: '', label: 'GitHub 直连', ms: 20, status: 'ok' },
      {
        base: 'https://gh-proxy.com/',
        label: 'gh-proxy.com',
        ms: null,
        status: 'empty',
        reason: '源上没有文件'
      }
    ]
    // 重新挂载以触发自动探测
    const w2 = mount(DownloadPage)
    await flushPromises()
    const text = w2.text()
    expect(text).toContain('不可用')
    // 「有货」的那个才是可用
    expect(text).toContain('可用 20ms')
    void w
  })

  it('设置里不再出现「A 用 / N 用」，首选源自动挑', async () => {
    inject()
    const w = mount(DownloadPage)
    await flushPromises()
    const btns = w.findAll('button').map((b) => b.text())
    expect(btns.filter((t) => t === 'A 用').length).toBe(0)
    expect(btns.filter((t) => t === 'N 用').length).toBe(0)
  })
})
