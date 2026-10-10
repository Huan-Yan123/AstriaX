import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SettingsPanel from '../../src/renderer/src/SettingsPanel.vue'

/**
 * 设置面板现在用 <Teleport to="body">（居中弹窗），
 * 内容不在 wrapper 的子树里，所以断言要看 document.body。
 */
const bodyText = (): string => document.body.textContent ?? ''

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('SettingsPanel（固定数据根只读展示）', () => {
  it('显示 dataRoot 值；无迁移按钮', async () => {
    ;(window as any).launcher = {
      config: { get: async () => ({ dataRoot: 'D:\\ACB\\data' }) }
    }
    mount(SettingsPanel)
    await flushPromises()
    expect(bodyText()).toContain('D:\\ACB\\data')
    // 不再有「固定在程序同目录…」这类啰嗦文案
    expect(bodyText()).not.toContain('固定在程序同目录')
    const btns = [...document.body.querySelectorAll('button')].map((b) => b.textContent ?? '')
    expect(btns.filter((t) => t.includes('更改')).length).toBe(0)
  })

  it('未设置时显示占位文本', async () => {
    ;(window as any).launcher = {
      config: { get: async () => ({}) }
    }
    mount(SettingsPanel)
    await flushPromises()
    expect(bodyText()).toContain('（未设置）')
  })

  it('关闭行为用圆点单选（不是一堆按钮）', async () => {
    ;(window as any).launcher = {
      config: { get: async () => ({ dataRoot: 'D:\\ACB\\data', closePolicy: 'tray' }), set: async () => undefined }
    }
    mount(SettingsPanel)
    await flushPromises()

    // Windows 风格原生单选控件，保留键盘与辅助技术支持。
    expect(document.body.querySelectorAll('input[type="radio"]').length).toBe(2)
    expect(document.body.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('关闭行为')
    // 曾经那套「一句话按钮」不该再出现
    expect(bodyText()).not.toContain('点 ✕ 缩回托盘')
  })

  it('★开机自启已整个移除（用户要求去掉这个功能）', async () => {
    ;(window as any).launcher = {
      config: { get: async () => ({ dataRoot: 'D:\\ACB\\data' }) },
      // 即使桌面 API 仍兼容这些通道，界面上也不该再有入口
      app: { autostartStatus: async () => true, setAutostart: async () => true }
    }
    mount(SettingsPanel)
    await flushPromises()
    expect(bodyText()).not.toContain('开机自启')
    expect(document.body.querySelector('.switch'), '那个开关控件应该没了').toBeFalsy()
  })

  it('★「操作记录」已整个移除（用户要求去掉这个功能）', async () => {
    ;(window as any).launcher = {
      config: { get: async () => ({ dataRoot: 'D:\\ACB\\data' }) },
      audit: { read: async () => '2026-09-13 xx', days: async () => ['2026-09-13'] }
    }
    mount(SettingsPanel)
    await flushPromises()
    expect(bodyText()).not.toContain('操作记录')
    expect(document.body.querySelector('.auditbox'), '审计预览框应该没了').toBeFalsy()
  })

  it('显示当前版本和检查更新入口（用户要求）', async () => {
    ;(window as any).launcher = {
      config: { get: async () => ({ dataRoot: 'D:\\ACB\\data' }) },
      app: { version: async () => '0.1.0' }
    }
    mount(SettingsPanel)
    await flushPromises()
    expect(bodyText()).toContain('当前版本')
    expect(bodyText()).toContain('0.1.0')
    const btns = [...document.body.querySelectorAll('button')].map((b) => b.textContent ?? '')
    expect(btns.some((t) => t.includes('检查更新')), '要有检查更新按钮').toBe(true)
  })

  it('不再出现注册表之类的内部实现文案', async () => {
    ;(window as any).launcher = {
      config: { get: async () => ({ dataRoot: 'D:\\ACB\\data' }) }
    }
    mount(SettingsPanel)
    await flushPromises()
    expect(bodyText()).not.toContain('注册表')
    expect(bodyText()).not.toContain('HKCU')
  })
})
