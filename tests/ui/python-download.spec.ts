// @vitest-environment happy-dom
import { it, expect, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import PythonDownloadDialog from '../../src/renderer/src/components/PythonDownloadDialog.vue'
import PythonDownloadProgress from '../../src/renderer/src/components/PythonDownloadProgress.vue'
import DownloadPage from '../../src/renderer/src/DownloadPage.vue'
import { dlInvalidate } from '../../src/renderer/src/dl-cache'
import type { PythonDownloadSource } from '../../src/renderer/src/types/python'
const official = 'https://www.python.org/ftp/python/', mirror = 'https://mirror.test/python/'
function bridge() {
  let sources: PythonDownloadSource[] = [{ label: '官方', base: official, builtin: true }, { label: '镜像', base: mirror, builtin: true }]
  let pref = official
  return {
    versions: vi.fn(async ({ base }) => ({ versions: (base === official ? ['3.14.1', '3.12.10'] : ['3.13.9']).map(version => ({ version, base, assetName: `python-${version}-embed-amd64.zip`, assetUrl: `${base}${version}/python-${version}-embed-amd64.zip` })) })),
    sources: {
      state: async () => ({ sources, pref }),
      pref: vi.fn(async (value: string) => { pref = value; return { sources, pref } }),
      test: vi.fn(async () => [
        { base: official, status: 'unstable', successes: 1, attempts: 3, ms: 5, reason: '代理连接超时' },
        { base: mirror, status: 'ok', successes: 3, attempts: 3, ms: 60, reason: '' },
      ]),
      add: vi.fn(async (value: { label: string; base: string }) => { sources = [...sources, { ...value, builtin: false }]; return { sources, pref } }),
      remove: vi.fn(async (base: string) => { sources = sources.filter(s => s.base !== base); if (pref === base) pref = official; return { sources, pref } }),
    },
  }
}
afterEach(() => { dlInvalidate(); vi.restoreAllMocks() })

it('loads versions from the selected source and recommends reliable sources before faster unstable ones', async () => {
  const python = bridge()
  ;(window as any).launcher = { python }
  const wrapper = mount(PythonDownloadDialog, { props: { busy: false } })
  await flushPromises()
  expect(wrapper.find('select').element.value).toBe('3.12.10')
  await wrapper.findAll('button').find(b => b.text() === '测试所有下载源')!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('1/3 成功')
  expect(wrapper.text()).toContain('代理连接超时')
  expect(python.sources.pref).not.toHaveBeenCalled()
  await wrapper.findAll('button').find(b => b.text() === '选择推荐源')!.trigger('click')
  await flushPromises()
  expect(python.sources.pref).toHaveBeenCalledWith(mirror)
  expect(wrapper.find('select').element.value).toBe('3.13.9')
  await wrapper.findAll('button').find(b => b.text() === '刷新版本列表')!.trigger('click')
  await flushPromises()
  expect(python.versions).toHaveBeenLastCalledWith({ base: mirror, noCache: true })
  await wrapper.findAll('button').find(b => b.text() === '下载并安装')!.trigger('click')
  expect(wrapper.emitted('install')?.[0]).toEqual([{ base: mirror, version: '3.13.9' }])
  wrapper.unmount()
})

it('adds a custom source, uses its catalog, and restores the official preference on removal', async () => {
  const python = bridge()
  ;(window as any).launcher = { python }
  const wrapper = mount(PythonDownloadDialog, { props: { busy: false } })
  await flushPromises()
  await wrapper.findAll('button').find(b => b.text() === '添加下载源')!.trigger('click')
  const inputs = wrapper.findAll('.add-source input')
  await inputs[0].setValue('我的镜像')
  await inputs[1].setValue('https://my.test/python/')
  await wrapper.find('form').trigger('submit')
  await flushPromises()
  expect(python.sources.add).toHaveBeenCalledWith({ label: '我的镜像', base: 'https://my.test/python/' })
  expect(python.versions).toHaveBeenLastCalledWith({ base: 'https://my.test/python/', noCache: false })
  await wrapper.findAll('.python-source button')[0].trigger('click')
  await flushPromises()
  expect(python.sources.remove).toHaveBeenCalledWith('https://my.test/python/')
  expect(wrapper.find('select').element.value).toBe('3.12.10')
  wrapper.unmount()
})

it('shows version catalog errors and disables installation instead of using an old list', async () => {
  const python = bridge()
  python.versions.mockRejectedValueOnce(new Error('HTTP 403：源拒绝访问'))
  ;(window as any).launcher = { python }
  const wrapper = mount(PythonDownloadDialog, { props: { busy: false } })
  await flushPromises()
  expect(wrapper.find('[role=alert]').text()).toContain('HTTP 403')
  expect(wrapper.findAll('button').find(b => b.text() === '下载并安装')!.attributes('disabled')).toBeDefined()
  wrapper.unmount()
})

it('displays percentage, bytes, speed, cancellation, and persistent errors in the Python area', async () => {
  const wrapper = mount(PythonDownloadProgress, { props: { busy: true, progress: { type: 'python', tag: 'python', phase: 'downloading', percent: 38, gotText: '3.8 MB', speedText: '1.2 MB/s', label: '下载 Python 3.14.1' } } })
  expect(wrapper.find('progress').attributes('value')).toBe('38')
  expect(wrapper.text()).toContain('3.8 MB')
  expect(wrapper.text()).toContain('1.2 MB/s')
  await wrapper.find('button').trigger('click')
  expect(wrapper.emitted('cancel')).toHaveLength(1)
  await wrapper.setProps({ busy: false, error: '代理端口拒绝连接' })
  expect(wrapper.find('[role=alert]').text()).toBe('代理端口拒绝连接')
  expect(wrapper.find('progress').exists()).toBe(false)
  wrapper.unmount()
})

it('restores Python download controls after navigating back to the resource page', async () => {
  dlInvalidate()
  const cancel = vi.fn(async () => ({ ok: true }))
  ;(window as any).launcher = {
    config: { get: async () => ({}) }, mirrors: { state: async () => ({ mirrors: [], pref: { a: '', n: '' } }), test: async () => [] },
    runtimes: { list: async () => [], cancel }, python: { status: async () => ({ ready: false }) },
    downloadSessions: async () => [{ type: 'python', tag: 'python', phase: 'downloading', percent: 40, gotText: '4 MB', speedText: '2 MB/s' }],
  }
  const wrapper = mount(DownloadPage)
  await flushPromises()
  expect(wrapper.find('.python-download-progress progress').attributes('value')).toBe('40')
  expect(wrapper.findAll('.python-environment button').filter(b => b.text() !== '取消下载').every(b => b.attributes('disabled') !== undefined)).toBe(true)
  await wrapper.find('.python-download-progress button').trigger('click')
  await flushPromises()
  expect(cancel).toHaveBeenCalledWith({ type: 'python', tag: 'python' })
  wrapper.unmount()
})
