// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import CreateWizard from '../../src/renderer/src/CreateWizard.vue'

function inject(opts: { runtimes?: Array<{ type: 'a' | 'n'; tag: string }>; pyReady?: boolean } = {}) {
  const w = globalThis as unknown as { window: Record<string, unknown> }
  w.window.launcher = {
    runtimes: { list: async () => opts.runtimes ?? [] },
    instance: { list: async () => [] },
    python: { status: async () => ({ ready: opts.pyReady ?? true }) },
    config: { get: async () => ({ dataRoot: 'E:\\x' }) }
  }
}

beforeEach(() => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window ??= {}
})

describe('创建实例向导：前置条件必须先满足', () => {
  it('AstrBot 有版本但没装 Python → 拦住创建并给出「去下载页」', async () => {
    inject({ runtimes: [{ type: 'a', tag: 'v4.28.0' }], pyReady: false })
    const w = mount(CreateWizard, { props: { defaultType: 'a' } })
    await flushPromises()

    // 明确告知原因（语气改萌系，但「需要先安装 Python 才能运行」这个事实不变）
    expect(w.text()).toContain('AstrBot 需要可用的 Python 3.12 或更高版本')
    // 创建按钮不可点
    const main = w.find('.main')
    expect((main.element as HTMLButtonElement).disabled).toBe(true)
    // 有前往下载入口
    const go = w.findAll('button').filter((b) => b.text() === '去下载页')
    expect(go.length).toBeGreaterThan(0)

    // 点了要发出 goto 事件（跳到下载页）并关掉向导
    await go[0].trigger('click')
    expect(w.emitted('goto')?.[0]).toEqual(['download'])
    expect(w.emitted('close')).toBeTruthy()
    // 没被创建
    expect(w.emitted('create')).toBeFalsy()
  })

  it('AstrBot 没版本 → 也是拦住 + 去下载页', async () => {
    inject({ runtimes: [], pyReady: true })
    const w = mount(CreateWizard, { props: { defaultType: 'a' } })
    await flushPromises()
    expect(w.text()).toContain('还没有下载任何版本呢')
    expect((w.find('.main').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('Python 和版本都齐了 → 可以创建，payload 正确', async () => {
    inject({ runtimes: [{ type: 'a', tag: 'v4.28.0' }], pyReady: true })
    const w = mount(CreateWizard, { props: { defaultType: 'a' } })
    await flushPromises()
    expect((w.find('.main').element as HTMLButtonElement).disabled).toBe(false)
    await w.find('input').setValue('我的机器人')
    await w.find('.main').trigger('click')
    const evt = w.emitted('create')?.[0]?.[0] as { type: string; name: string; tag: string }
    expect(evt.type).toBe('a')
    expect(evt.name).toBe('我的机器人')
    expect(evt.tag).toBe('v4.28.0')
  })

  it('NapCat 不依赖 Python：没装 Python 也能创建', async () => {
    inject({ runtimes: [{ type: 'n', tag: 'v4.18.19' }], pyReady: false })
    const w = mount(CreateWizard, { props: { defaultType: 'n' } })
    await flushPromises()
    // 不该出现 Python 相关的拦截
    expect(w.text()).not.toContain('Python')
    expect((w.find('.main').element as HTMLButtonElement).disabled).toBe(false)
    await w.find('.main').trigger('click')
    expect(w.emitted('create')?.[0]?.[0]).toMatchObject({ type: 'n', tag: 'v4.18.19' })
  })

  it('名字留空也能创建（自动取名）', async () => {
    inject({ runtimes: [{ type: 'a', tag: 'v4.28.0' }], pyReady: true })
    const w = mount(CreateWizard, { props: { defaultType: 'a' } })
    await flushPromises()
    await w.find('.main').trigger('click')
    const evt = w.emitted('create')?.[0]?.[0] as { name: string }
    expect(evt.name).toBe('')
  })
})

describe('★创建失败后按钮必须能再点（不能永久灰掉）', () => {
  /*
   * ## 这个测试防的是什么（UI 审计抓出的真 bug）
   *
   * 向导原来自己持有 `busy = ref(false)`，submit 里 `busy.value = true`
   * 之后**没有任何地方复位**（全文件只有 3 处出现：声明、置 true、用在
   * `:disabled`）。
   *
   * 而父组件 App.vue 的 create() 在失败时只弹一个说明、
   * **向导并不关闭**（重名 / 端口占用 / QQ 环境不满足都走这条路）。
   * 于是「创建」按钮永久灰着 —— 用户改完名字也点不动，
   * 只能把向导关掉重开。重名是最常见的失败原因，
   * 所以第一次用就很可能撞上。
   *
   * ## 修法与判据
   *
   * 把 busy 的所有权交给父组件（`:busy` prop），
   * 父组件在 `finally` 里复位。所以这里要验的是：
   *   · 没传 busy（或传 false）时按钮可点
   *   · 传 busy=true 时按钮禁用（防重复提交）
   *   · **传回 false 后按钮又能点** ← 这条就是防"永久灰掉"
   */
  it('busy=false 时按钮可点，busy=true 时禁用，复位后又能点', async () => {
    inject({ runtimes: [{ type: 'a', tag: 'v4.28.0' }], pyReady: true })
    const w = mount(CreateWizard, { props: { defaultType: 'a', busy: false } })
    await flushPromises()

    const main = () => w.find('.main').element as HTMLButtonElement
    expect(main().disabled, '前置条件都满足，按钮应可点').toBe(false)

    // 父组件开始创建 → 禁用（防重复点击）
    await w.setProps({ busy: true })
    expect(main().disabled, '创建中应禁用，防重复提交').toBe(true)

    // 父组件失败后复位 → **必须**又能点（否则就是这个 bug 复现了）
    await w.setProps({ busy: false })
    expect(
      main().disabled,
      '父组件已复位 busy，按钮却还是禁用 —— 用户改完名字也点不动了'
    ).toBe(false)

    // 真的能发起第二次创建
    await w.find('.main').trigger('click')
    expect(w.emitted('create')?.length, '复位后应能再次发起创建').toBe(1)
  })

  it('向导自己不持有 busy（所有权归父组件，避免两边各管一半）', async () => {
    /*
     * 如果哪天有人又在向导内部加回 `const busy = ref(false)`，
     * 就会重新出现"向导置 true、父组件复位的是另一个变量"的错配。
     * 这里从行为上钉死：**只**接受 props.busy 控制禁用态。
     */
    inject({ runtimes: [{ type: 'a', tag: 'v4.28.0' }], pyReady: true })
    const w = mount(CreateWizard, { props: { defaultType: 'a' } })
    await flushPromises()
    // 不传 busy：点一次后按钮**不该**自己变成禁用（它没有自己的 busy）
    await w.find('.main').trigger('click')
    await flushPromises()
    expect(
      (w.find('.main').element as HTMLButtonElement).disabled,
      '向导自己把自己禁用了 —— busy 所有权又跑到向导内部去了'
    ).toBe(false)
  })
})
