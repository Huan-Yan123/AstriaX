// @vitest-environment happy-dom
import { it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import SettingsPanel from '../../src/renderer/src/SettingsPanel.vue'

it('embeds settings, filters sections, and installs only on an explicit click', async () => {
  const installUpdate = vi.fn(async () => undefined)
  ;(window as any).launcher = {
    config: { get: async () => ({ dataRoot: 'D:\\data', closePolicy: 'tray' }) },
    app: {
      version: async () => '1.0.2',
      checkUpdate: async () => ({ hasUpdate: true, latestVersion: '1.0.3', url: 'https://github.com/Soffd/AstriaX/releases/download/v1.0.3/AstriaX.exe', sha256: 'a'.repeat(64) }),
      downloadUpdate: async () => 'C:\\Downloads\\AstriaX.exe',
      installUpdate,
    },
  }
  const wrapper = mount(SettingsPanel, { props: { embedded: true }, attachTo: document.body })
  await flushPromises()
  expect(wrapper.find('.settings-shell.embedded').exists()).toBe(true)
  await wrapper.find('[aria-label="搜索设置"]').setValue('存储')
  expect(wrapper.find('#settings-storage').isVisible()).toBe(true)
  expect(wrapper.find('#settings-updates').isVisible()).toBe(false)
  await wrapper.find('[aria-label="搜索设置"]').setValue('')
  await wrapper.findAll('button').find(b => b.text() === '检查更新')!.trigger('click')
  await flushPromises()
  await wrapper.findAll('button').find(b => b.text() === '下载更新')!.trigger('click')
  await flushPromises()
  expect(installUpdate).not.toHaveBeenCalled()
  await wrapper.findAll('button').find(b => b.text() === '退出并安装更新')!.trigger('click')
  await flushPromises()
  expect(installUpdate).toHaveBeenCalledOnce()
  wrapper.unmount()
})
