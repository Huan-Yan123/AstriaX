// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import App from '../../src/renderer/src/App.vue'
import TitleBar from '../../src/renderer/src/components/TitleBar.vue'
import InstanceCard from '../../src/renderer/src/InstanceCard.vue'
import CreateWizard from '../../src/renderer/src/CreateWizard.vue'

const fakeList = [
  { id: 'a_x1', name: '测试宝', type: 'a' as const, status: 'running', port: 6100, runtimeVersion: '4.28.0' },
  { id: 'n_x1', name: '机器人一号', type: 'n' as const, status: 'stopped', port: 6101, runtimeVersion: '4.18.19' }
]

function injectApi(calls: Record<string, unknown[]>) {
  const w = globalThis as unknown as { window: Record<string, unknown> }
  w.window.launcher = {
    config: { get: async () => ({ dataRoot: 'C:\\x' }), set: async () => undefined },
    instance: {
      list: async () => (calls.list as unknown[]).concat(
        fakeList
      ),
      create: async () => fakeList[0],
      start: async () => calls.start.push(1),
      stop: async () => calls.stop.push(1),
      remove: async () => undefined
    },
    stats: {
      overview: async () => ({
        system: { totalMemMB: 16000, freeMemMB: 8000, totalDiskMB: 500000, freeDiskMB: 100000 },
        perInstance: [
          { id: 'a_x1', memMB: 120, cpuPct: 1.5, status: 'running' }
        ]
      })
    },
    webui: { open: async () => undefined, close: async () => undefined, list: async () => [] },
    // 向导与卡片都要读已装运行时：没版本就不许创建实例
    runtimes: {
      list: async () => [
        { type: 'a' as const, tag: 'v4.28.0', sizeMB: 5.7 },
        { type: 'n' as const, tag: 'v4.18.19', sizeMB: 111.7 }
      ],
      remove: async () => undefined
    },
    // AstrBot 还需要内置 Python 就绪才让创建
    python: { status: async () => ({ ready: true, version: '3.12.10' }) }
  }
}

beforeEach(() => {
  // happy-dom 下重置 launcher 注入点
  (globalThis as unknown as { window: Record<string, unknown> }).window ??= {}
})

afterEach(() => {
  delete ((globalThis as unknown as { window: Record<string, unknown> }).window as Record<string, unknown>).launcher
})

describe('InstanceCard', () => {
  it('渲染名称/类型/状态与端口；已停止记录仍允许尝试 WebUI 探活', () => {
    const w = mount(InstanceCard, {
      props: { inst: fakeList[1] }
    })
    expect(w.text()).toContain('机器人一号')
    expect(w.text()).toContain('NapCat')
    expect(w.text()).toContain('已停止')
    expect(w.text()).toContain('6101')
    const webui = w.find('.ghost')
    // 磁盘状态可能落后于 NapCat 注入到 QQ 后的真实服务状态；
    // 是否能打开由主进程探测端口决定，启动/停止过渡中才禁用。
    expect(webui.classes()).toContain('ready')
    expect((webui.element as HTMLButtonElement).disabled).toBe(false)
  })

  it('卡片显示当前实例版本（读不到就说「版本未知」，不编假的）', () => {
    const w = mount(InstanceCard, { props: { inst: fakeList[1] } })
    expect(w.find('.ver').text()).toBe('v4.18.19')

    const a = mount(InstanceCard, { props: { inst: fakeList[0] } })
    expect(a.find('.ver').text()).toBe('v4.28.0')

    // 读不到版本时：明确说未知，而不是留空或写个假号
    const noVer = mount(InstanceCard, {
      props: { inst: { ...fakeList[1], runtimeVersion: undefined } }
    })
    expect(noVer.find('.ver').text()).toBe('版本未知呢')
  })

  it('更多菜单：菜单项齐全，且已移除的入口不再出现', async () => {
    const w = mount(InstanceCard, { props: { inst: fakeList[1] } })
    expect(w.find('.menu').exists()).toBe(false)
    await w.find('.more').trigger('click')
    const items = w.findAll('.menu button').map((b) => b.text())
    /*
     * 菜单项经过几轮需求变更，现在是这五项：
     *   - 「翻翻日志」「重置Token」「删掉这个实例」：一直都在
     *   - 「换个版本」：用户要求加回版本切换能力
     *     （高版本覆盖低版本，保留数据和配置）
     *   - 「一键更新」：★用户新需求。AstrBot 的 WebUI「一键更新」被官方
     *     主动禁用（它检测到自己是被 `pip install --target` 装出来的，
     *     报 "You are running AstrBot via CLI"），
     *     所以更新入口得由启动器提供。
     *
     * 这条断言原来写的是 ['看日志','重置Token','备份','换新版本','删除实例']。
     * 备份和换新版本已按用户要求移除（「意义不大」）却没同步改测试，
     * 于是一直红着 —— 属于测试陈旧，不是功能坏了。
     * 后来又按萌系语气统一了措辞（看日志→翻翻日志、切换版本→换个版本、
     * 删除实例→删掉这个实例），断言强度不变，仍是逐项全等。
     *
     * 逐项全等是有意的：它能拦住"菜单项顺序被无意打乱"和
     * "某个入口悄悄消失"。所以每加一个入口都必须来这里同步一次，
     * 而不是把它弱化成 toContain。
     */
    expect(items).toEqual(['翻翻日志', '一键更新', '换个版本', '重置Token', '删掉这个实例'])
    // 老文案不该再出现
    expect(w.text()).not.toContain('备份一份')
    // 已经被移除的入口不能悄悄回来
    expect(items).not.toContain('备份')
    expect(items).not.toContain('换新版本')
  })

  it('★「一键更新」在实例运行时禁用（用户要求：必须停下来才能更新）', async () => {
    /*
     * 用户原话：「手动更新必须在 astrbot 没有运行的时候才能更新」。
     *
     * 这里只验**界面**那一层（菜单项 disabled + title 说明原因）；
     * 主进程还会再拦一道（见 tests/unit/instance-update.spec.ts），
     * 因为渲染层可以被绕过，硬约束必须落在主进程。
     */
    const running = { ...fakeList[0], status: 'running' as const }
    const w = mount(InstanceCard, { props: { inst: running } })
    await w.find('.more').trigger('click')

    const btn = w.findAll('.menu button').find((b) => b.text() === '一键更新')!
    expect(btn, '菜单里应当有「一键更新」').toBeTruthy()
    expect(
      (btn.element as HTMLButtonElement).disabled,
      '实例在跑的时候「一键更新」必须点不动'
    ).toBe(true)
    // 禁用时要说明为什么，别让用户对着灰按钮猜
    expect(btn.attributes('title')).toMatch(/停止/)

    // 停止之后就能点了
    const stopped = { ...fakeList[0], status: 'stopped' as const }
    const w2 = mount(InstanceCard, { props: { inst: stopped } })
    await w2.find('.more').trigger('click')
    const btn2 = w2.findAll('.menu button').find((b) => b.text() === '一键更新')!
    expect(
      (btn2.element as HTMLButtonElement).disabled,
      '停止状态下「一键更新」应当可点'
    ).toBe(false)
  })

  it('★点「一键更新」派发 update 事件（不是 version）', async () => {
    /*
     * 这两个入口很容易接错线：都跟"版本"有关。
     *   · 更新   = 装最新版再切过去（要联网、要几分钟）
     *   · 换个版本 = 切到本地已装好的某个版本（瞬时）
     * 接错的话用户点「更新」会跳到版本选择框，功能看着像坏的。
     */
    const stopped = { ...fakeList[0], status: 'stopped' as const }
    const w = mount(InstanceCard, { props: { inst: stopped } })
    await w.find('.more').trigger('click')
    const btn = w.findAll('.menu button').find((b) => b.text() === '一键更新')!
    await btn.trigger('click')

    expect(w.emitted('update'), '要派发 update 事件').toBeTruthy()
    expect(w.emitted('version'), '不能错派成 version').toBeFalsy()
  })

  it('更多菜单：AstrBot 是「重置账密」，NapCat 是「重置Token」（叫法别混）', async () => {
    const a = mount(InstanceCard, { props: { inst: fakeList[0] } })
    await a.find('.more').trigger('click')
    const aItems = a.findAll('.menu button').map((b) => b.text())
    expect(aItems).toContain('重置账密')

    const n = mount(InstanceCard, { props: { inst: fakeList[1] } })
    await n.find('.more').trigger('click')
    const nItems = n.findAll('.menu button').map((b) => b.text())
    // NapCat 用 Token，不该叫「账密」
    expect(nItems).toContain('重置Token')
    expect(nItems.some((t) => t.includes('账密'))).toBe(false)
  })

  it('更多菜单：点菜单项后自动收回并派发事件', async () => {
    const w = mount(InstanceCard, { props: { inst: fakeList[1] } })
    await w.find('.more').trigger('click')
    /*
     * 用「换个版本」来测（备份项已被移除）。
     * 这条原来找的是 `备份` 按钮 —— 那个菜单项删掉后找不到，
     * backupBtn 成了 undefined，下一行 .trigger 直接 TypeError。
     */
    const btn = w.findAll('.menu button').find((b) => b.text() === '换个版本')!
    await btn.trigger('click')
    expect(w.emitted('version'), '要派发 version 事件').toBeTruthy()
    // 选完要收起来，不能一直挂着
    expect(w.find('.menu').exists()).toBe(false)
  })

  it('更多菜单：点卡片以外的地方自动收回', async () => {
    const w = mount(InstanceCard, { props: { inst: fakeList[1] } })
    await w.find('.more').trigger('click')
    expect(w.find('.menu').exists()).toBe(true)
    // 在文档别处按下 → 收回
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(w.find('.menu').exists()).toBe(false)
  })

  it('更多菜单：点菜单内部空白不会误关（只有点外面才关）', async () => {
    const w = mount(InstanceCard, { props: { inst: fakeList[1] } })
    await w.find('.more').trigger('click')
    ;(w.find('.menu').element as HTMLElement).dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await flushPromises()
    expect(w.find('.menu').exists()).toBe(true)
  })

  it('更多菜单向下展开（贴着按钮下沿，不往上顶）', async () => {
    // happy-dom 不解析 scoped 样式，直接查源码里 .menu 的定位方式
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const src = readFileSync(join(process.cwd(), 'src/renderer/src/InstanceCard.vue'), 'utf8')
    const menuRule = src.slice(src.indexOf('.menu {'))
    const block = menuRule.slice(0, menuRule.indexOf('}'))
    // 用 top 贴在按钮下方；不能再用 bottom: 100% 往上弹
    expect(block).toMatch(/top:\s*calc\(100% \+ 6px\)/)
    expect(block).not.toMatch(/bottom:\s*calc\(100% \+ 6px\)/)
  })

  it('实例卡片左侧没有彩色描边（状态已由小圆点表达）', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const src = readFileSync(join(process.cwd(), 'src/renderer/src/InstanceCard.vue'), 'utf8')
    expect(src).not.toContain('border-left: 4px solid transparent')
    expect(src).not.toContain('border-left-color')
  })

  it('WebUI 按钮三态：运行可点 → 点击后显示「收起」，点击再收起', async () => {
    injectApi({ list: [] })
    const w = mount(App, {})
    await flushPromises()
    const card = w.findComponent(InstanceCard)
    const btn = card.find('.ghost')
    // 默认页只有 running 的 A 实例（fakeList[0]）→ WebUI 可用不置灰
    expect(btn.classes()).toContain('ready')
    expect(card.props('webuiOpen')).toBe(false)
    const running = mount(InstanceCard, { props: { inst: fakeList[0], webuiOpen: false } })
    expect(running.text()).toContain('WebUI')
    const open = mount(InstanceCard, { props: { inst: fakeList[0], webuiOpen: true } })
    expect(open.text()).toContain('收起')
    await open.find('.ghost').trigger('click')
    expect(open.emitted('webui')).toHaveLength(1)
  })
})

describe('App 骨架', () => {
  it('实例卡片按仓库数据渲染', async () => {
    injectApi({ list: [] })
    const w = mount(App)
    await flushPromises()
    expect(w.text()).toContain('测试宝')
    expect(w.text()).toContain('运行中')
    /*
     * 卡片上**不再有**「内存 xxx MB」。
     *
     * 那行数据来自每 2 秒一次的 pidusage 采集，而它在 Windows 上要 spawn
     * wmic.exe —— wmic 在新版 Windows 已被移除，每次调用等超时 2.4~5.1 秒，
     * 比轮询间隔还长，导致整个界面卡死。AstrBot/NapCat 自己的 WebUI 都有资源信息。
     */
    expect(w.text(), '不该再有内存行（它来自会卡死界面的采集）').not.toContain('内存 120 MB')
    /*
     * 系统余量（内存/磁盘）整行也**已被用户要求移除**，现在整条链
     * （sys / pullStats / hot / .sysline 样式）都删干净了。
     *
     * 这条原来断言页面上有 '7.8 / 16 GB 可用' 和 '98 / 488 GB 空闲' ——
     * 显示删掉后测试没跟着改，于是一直红着。这里反过来钉住"不该再出现"，
     * 防止哪天有人把这条会拖慢启动的采集链又加回来。
     */
    expect(w.text(), '系统余量行已移除').not.toContain('GB 可用')
    expect(w.text(), '磁盘余量行已移除').not.toContain('GB 空闲')
  })

  it('AstrBot/NapCat 分页：默认 AstrBot 页只显示 A 实例，切 N 页签换内容与标题', async () => {
    injectApi({ list: [] })
    const w = mount(App)
    await flushPromises()
    expect(w.text()).toContain('测试宝')
    expect(w.text()).not.toContain('机器人一号')
    expect(w.text()).toContain('AstrBot 实例')
    const railBtns = w.findAll('.railbtn')
    await railBtns[1].trigger('click') // N 页签
    expect(w.text()).toContain('机器人一号')
    expect(w.text()).not.toContain('测试宝')
    expect(w.text()).toContain('NapCat 实例')
    const create = w.find('.createbtn')
    expect(create.text()).toContain('新建 NapCat 实例')
  })

  it('新建向导锁定页面类型：AstrBot 页打开的向导不出现 NapCat 选项，创建走 a 类型', async () => {
    injectApi({ list: [] })
    const w = mount(App)
    await flushPromises()
    await w.find('.createbtn').trigger('click')
    const wiz = w.findComponent(CreateWizard)
    expect(wiz.exists()).toBe(true)
    expect(wiz.text()).not.toContain('NapCat")') // 标题没有 NapCat
    expect(wiz.text()).toContain('AstrBot')
    // 提交 → create 事件 payload.type 是 'a'
    ;(wiz.find('input').element as HTMLInputElement).value = '测试A'
    await wiz.find('input').trigger('input')
    await wiz.find('.main').trigger('click')
    const evt = wiz.emitted('create')?.[0]?.[0] as { type: string; name: string }
    expect(evt.type).toBe('a')
    expect(evt.name).toBe('测试A')
  })

  /*
   * 创建向导**不再问 QQ 号**（用户要求去掉）。
   *
   * 去掉的理由：它的「多开隔离」作用本来就多余（实例目录各自独立，
   * NapCat 的数据文件天然不打架），而填错反而会把扫码登进去的账号覆盖掉。
   * 免扫码登录可以直接在 NapCat 的 WebUI 里做，不必在创建时强加一步。
   */
  it('创建向导不再有 QQ 号输入（AstrBot 和 NapCat 都没有）', async () => {
    injectApi({ list: [] })
    const w = mount(App)
    await flushPromises()

    // AstrBot 页
    await w.find('.createbtn').trigger('click')
    expect(w.findComponent(CreateWizard).text()).not.toContain('QQ 号')

    // NapCat 页
    await w.findAll('.railbtn')[1].trigger('click')
    await flushPromises()
    await w.find('.createbtn').trigger('click')
    const wiz = w.findComponent(CreateWizard)
    expect(wiz.text(), 'NapCat 向导也不该再问 QQ 号').not.toContain('QQ 号')

    // 向导里只剩实例名一个文本框（端口是 number 型，不算）
    const textInputs = wiz.findAll('input[type="text"]')
    expect(textInputs.length, '只该剩实例名一个文本框').toBe(1)
  })

  it('NapCat 创建事件里不再带 qqAccount 字段', async () => {
    injectApi({ list: [] })
    const w = mount(App)
    await flushPromises()
    await w.findAll('.railbtn')[1].trigger('click')
    await flushPromises()
    await w.find('.createbtn').trigger('click')
    const wiz = w.findComponent(CreateWizard)
    await wiz.find('.main').trigger('click')
    const evt = wiz.emitted('create')?.[0]?.[0] as { type: string; qqAccount?: string }
    if (evt) {
      expect(evt.type).toBe('n')
      expect(evt.qqAccount, '不该再传 qqAccount').toBeUndefined()
    }
  })

  it('自绘标题栏：三窗控按钮调用 window 接口（GUI 全接管，无系统默认栏）', async () => {
    /*
     * ★ 契约变更（主人 2026-10-08）：窗口控制从 App.vue 的**内联标题栏**
     *   改成了独立的 `components/TitleBar.vue` 组件。
     *
     * 变化点：
     *   · 调用入口从 `window.launcher.windowCtl` 改成 `window.electron.window`
     *     （preload 暴露的命名空间变了）
     *   · 类名从 `.winctl` 改成 `.titlebar__controls`
     *
     * 所以这条测试直接挂 **TitleBar 组件**（而不是整个 App）——
     * 它测的就是"三个按钮各调对各的方法"，挂组件更精确、也更快。
     */
    const win = (globalThis as unknown as { window: Record<string, unknown> }).window as Record<string, unknown>
    const calls: string[] = []
    win.electron = {
      window: {
        minimize: async () => calls.push('min'),
        toggleMaximize: async () => calls.push('max'),
        close: async () => calls.push('close'),
        isMaximized: async () => false,
        onMaximizeChange: () => () => undefined
      }
    }
    const w = mount(TitleBar)
    await flushPromises()
    const btns = w.findAll('.titlebar__btn')
    expect(btns.length, '要有最小化/最大化/关闭三个按钮').toBe(3)
    await btns[0].trigger('click')
    await btns[2].trigger('click')
    await flushPromises()
    expect(calls).toEqual(['min', 'close'])
  })
})
