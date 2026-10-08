import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import FirstRunWizard from '../../src/renderer/src/FirstRunWizard.vue'
import App from '../../src/renderer/src/App.vue'

describe('FirstRunWizard（固定数据根告知页）', () => {
  it('展示固定路径并发送 confirm', async () => {
    const paths = { homeDataRoot: 'C:\\Users\\x\\ACB启动器', appDataRoot: 'D:\\ACB\\data' }
    ;(window as any).launcher = {
      paths: { defaults: async () => paths }
    }
    const w = mount(FirstRunWizard)
    await flushPromises()
    expect(w.text()).toContain('D:\\ACB\\data')
    const spy = vi.fn()
    w.vm.$on?.('confirm', spy) ?? w.vm.$emit // Vue 3.4+ no $on
    await w.find('.main').trigger('click')
    expect(w.emitted('confirm')?.[0]).toEqual([paths.appDataRoot])
  })
})

describe('App 首启流程（固定数据根）', () => {
  function injectApi(hasDataRoot: boolean) {
    ;(window as any).launcher = {
      config: {
        get: async () => (hasDataRoot ? { dataRoot: 'D:\\ACB\\data' } : {}),
        set: vi.fn(async () => {})
      },
      instance: { list: async () => [] },
      paths: { defaults: async () => ({ homeDataRoot: 'C:\\x', appDataRoot: 'D:\\ACB\\data' }) }
    }
  }

  it('config.dataRoot 空时展示首启告知，点确认后调 set 并关闭', async () => {
    injectApi(false)
    const app = mount(App)
    await flushPromises()
    expect(app.text()).toContain('数据目录')
    const wizard = app.findComponent(FirstRunWizard)
    wizard.vm.$emit('confirm', 'D:\\ACB\\data')
    await flushPromises()
    expect((window as any).launcher.config.set).toHaveBeenCalledWith({ dataRoot: 'D:\\ACB\\data' })
  })

  it('config.dataRoot 已存在时跳过首启，直接显示实例列表', async () => {
    injectApi(true)
    const app = mount(App)
    await flushPromises()
    expect(app.text()).not.toContain('数据目录')
    expect(app.find('.cards').exists()).toBe(true)
  })

  it('★配置还没读回来时不显示首启遮罩（否则每次启动都会闪一下）', async () => {
    /*
     * ## 这个测试防的是什么（UI 审计抓出的真问题）
     *
     * 原来 `firstRun` 是 `ref(true)`，要等 `onMounted` 里的
     * `config:get` 回来才会被改成 false。于是**每次启动**
     *（包括早就配好 dataRoot 的老用户）都会先渲染一帧
     * `<FirstRunWizard v-if="firstRun">` —— 那是一层全屏 45% 黑遮罩，
     * 用户能看见它闪一下再消失。启动慢时（磁盘/杀软拖累）更明显。
     *
     * 现在 `firstRun` 是三态：`null` = 还不知道 → 什么都不显示。
     *
     * ## 为什么必须在「flushPromises 之前」断言
     *
     * 之前那两个用例都是 `mount(App)` 之后立刻 `await flushPromises()`，
     * 等异步都结束了才看结果 —— 那个时刻 `firstRun` 早就定了，
     * **闪没闪过完全测不出来**。所以这里的关键是：
     * mount 之后**同步地**立刻查一次 DOM（此时 config:get 的 promise
     * 还没 resolve），确认遮罩不在。
     */
    injectApi(true)
    const app = mount(App)

    // 此刻 config:get 尚未 resolve —— firstRun 应为 null
    expect(
      app.findComponent(FirstRunWizard).exists(),
      '配置还没读回来就显示了首启遮罩 → 老用户每次启动都会看到它闪一下'
    ).toBe(false)

    // 等异步走完，确认最终也不会显示（dataRoot 存在）
    await flushPromises()
    expect(app.findComponent(FirstRunWizard).exists()).toBe(false)
    expect(app.find('.cards').exists()).toBe(true)
  })

  it('★确实是首启（没有 dataRoot）时，最终要显示出来', async () => {
    /*
     * 上一条的镜像：三态改法不能把"真首启"也一起漏掉。
     * 真首启用户必须有著作声明页，否则他连数据目录都不会被设置。
     */
    injectApi(false)
    const app = mount(App)
    await flushPromises()
    expect(
      app.findComponent(FirstRunWizard).exists(),
      '真首启却没显示著作声明 —— 用户无从设置数据目录'
    ).toBe(true)
  })
})
