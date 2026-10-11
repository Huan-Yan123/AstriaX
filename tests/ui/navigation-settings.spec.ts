import { it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import App from '../../src/renderer/src/App.vue'
import SettingsPanel from '../../src/renderer/src/SettingsPanel.vue'

it('navigates between pages, hides instance sidebar, collapses and restores history', async () => {
  ;(window as any).launcher = {
    config: { get: async () => ({ dataRoot: 'G:/fixture' }) },
    instance: { list: async () => [] }, runtimes: { list: async () => [] },
    webui: { list: async () => [] },
  }
  const wrapper = mount(App, { attachTo: document.body, global: { stubs: { DownloadPage: true } } })
  await flushPromises()
  expect(wrapper.find('.rail-heading').text()).toBe('实例')
  await wrapper.find('[aria-label="设置"]').trigger('click')
  await flushPromises()
  expect(wrapper.find('.rail').exists()).toBe(false)
  expect(wrapper.find('#settings-general').isVisible()).toBe(true)
  expect(wrapper.find('#settings-updates').isVisible()).toBe(false)
  await wrapper.findAll('.section-link').find(b => b.text() === '存储')!.trigger('click')
  expect(wrapper.find('.settings-main h1').text()).toBe('存储')
  expect(wrapper.find('#settings-general').isVisible()).toBe(false)
  await wrapper.find('[aria-label="后退"]').trigger('click')
  expect(wrapper.find('.settings-main h1').text()).toBe('常规')
  await wrapper.find('[aria-label="前进"]').trigger('click')
  expect(wrapper.find('.settings-main h1').text()).toBe('存储')
  await wrapper.find('[aria-label="收起侧边栏"]').trigger('click')
  expect(wrapper.find('.settings-nav').exists()).toBe(false)
  await wrapper.find('[aria-label="展开侧边栏"]').trigger('click')
  expect(wrapper.find('.settings-nav').exists()).toBe(true)
  await wrapper.find('[aria-label="资源与环境"]').trigger('click')
  expect(wrapper.find('.rail').exists()).toBe(false)
  await wrapper.find('[aria-label="后退"]').trigger('click')
  await wrapper.find('[aria-label="实例"]').trigger('click')
  expect(wrapper.find('[aria-label="前进"]').attributes('disabled')).toBeDefined()
  wrapper.unmount()
})

it('saves ask policy and leaves the previous selection checked if saving fails', async () => {
  const set = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('配置写入失败'))
  ;(window as any).launcher = { config: { get: async () => ({ closePolicy: 'tray' }), set } }
  const wrapper = mount(SettingsPanel, { props: { embedded: true } })
  await flushPromises()
  const radios = wrapper.findAll<HTMLInputElement>('input[type="radio"]')
  await radios[2].setValue(true)
  await flushPromises()
  expect(set).toHaveBeenCalledWith({ closePolicy: 'ask' })
  expect(radios[2].element.checked).toBe(true)
  await radios[1].setValue(true)
  await flushPromises()
  expect(wrapper.find('[role="alert"]').text()).toContain('配置写入失败')
  expect(radios[2].element.checked).toBe(true)
  wrapper.unmount()
})
