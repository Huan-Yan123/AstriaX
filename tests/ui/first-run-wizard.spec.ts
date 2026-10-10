// @vitest-environment happy-dom
/*
 * 首启向导**不能把人锁死**。
 *
 * 这是审计发现的两个高危缺陷，都指向同一个后果：
 * 新用户第一次打开软件，看到一屏遮罩，点哪儿都没反应，也退不出去。
 *
 *   1. FirstRunWizard 的 confirm 里 `if (appDataRoot.value) emit(...)`：
 *      路径没拿到时点了**什么都不发生**（不报错、不转圈），
 *      而 App.vue 里 `v-if="firstRun"` 解除遮罩的唯一开关就是这个 emit。
 *   2. App.vue 的 onMounted `(await window.launcher?.config?.get()) ?? {}`：
 *      `?.` 不防 promise reject，一抛就中断在那一行，firstRun 保持 true。
 *
 * 两条都必须有测试守着 —— 这类 bug 平时跑不出来（开发机上 paths/config
 * 都正常），只会在用户的坏环境下发生，而且症状是「完全不能用」。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import FirstRunWizard from '../../src/renderer/src/FirstRunWizard.vue'

interface Win {
  window: Record<string, unknown>
}
const g = globalThis as unknown as Win

beforeEach(() => {
  g.window ??= {}
})

describe('FirstRunWizard：拿不到默认路径时不能静默失效', () => {
  it('正常情况：显示出路径，可以确认', async () => {
    g.window.launcher = {
      paths: { defaults: async () => ({ homeDataRoot: 'H:\\d', appDataRoot: 'E:\\app\\data' }) }
    }
    const w = mount(FirstRunWizard)
    await flushPromises()
    expect(w.text()).toContain('E:\\app\\data')
    await w.find('.main').trigger('click')
    expect(w.emitted('confirm')?.[0]).toEqual(['E:\\app\\data'])
  })

  it('paths.defaults 抛错 → 必须显示错误，而不是假装正常', async () => {
    g.window.launcher = {
      paths: {
        defaults: async () => {
          throw new Error('EACCES: 目录不可写')
        }
      }
    }
    const w = mount(FirstRunWizard)
    await flushPromises()

    // 错误必须看得见（原来是完全静默的）
    expect(w.text(), '要显示失败原因').toContain('EACCES')
    // 不能显示一个假的路径
    expect(w.text()).toContain('未取到')
    // 主按钮必须不可点（原来是可点但无反应，更容易误解成「按钮坏了」）
    expect((w.find('.main').element as HTMLButtonElement).disabled).toBe(true)
    // 要有重试入口
    expect(w.find('.retry').exists()).toBe(true)
    // 不能发出 confirm（否则 App 会拿空字符串去 set）
    expect(w.emitted('confirm')).toBeFalsy()
  })

  it('返回空字符串（接口在但没给值）也要拦住并提示', async () => {
    g.window.launcher = {
      paths: { defaults: async () => ({ homeDataRoot: '', appDataRoot: '' }) }
    }
    const w = mount(FirstRunWizard)
    await flushPromises()
    expect((w.find('.main').element as HTMLButtonElement).disabled).toBe(true)
    expect(w.text()).toContain('未取到')
    expect(w.emitted('confirm')).toBeFalsy()
  })

  it('重试能恢复：先失败后成功', async () => {
    let calls = 0
    g.window.launcher = {
      paths: {
        defaults: async () => {
          calls++
          if (calls === 1) throw new Error('暂时不可用')
          return { homeDataRoot: 'H:\\d', appDataRoot: 'E:\\ok\\data' }
        }
      }
    }
    const w = mount(FirstRunWizard)
    await flushPromises()
    expect((w.find('.main').element as HTMLButtonElement).disabled).toBe(true)

    // 点重试 → 这次成功
    await w.find('.retry').trigger('click')
    await flushPromises()

    expect(w.text()).toContain('E:\\ok\\data')
    expect(w.text(), '成功之后错误提示要消失').not.toContain('暂时不可用')
    expect((w.find('.main').element as HTMLButtonElement).disabled).toBe(false)
    await w.find('.main').trigger('click')
    expect(w.emitted('confirm')?.[0]).toEqual(['E:\\ok\\data'])
  })

  it('launcher API 完全不存在时也不能静默（桌面桥接未初始化的情形）', async () => {
    g.window.launcher = {}
    const w = mount(FirstRunWizard)
    await flushPromises()
    expect(w.text()).toContain('未取到')
    expect((w.find('.main').element as HTMLButtonElement).disabled).toBe(true)
  })
})
