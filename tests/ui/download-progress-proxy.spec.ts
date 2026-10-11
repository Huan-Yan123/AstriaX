import { it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DownloadPage from '../../src/renderer/src/DownloadPage.vue'
import NetworkProxy from '../../src/renderer/src/components/NetworkProxy.vue'
import { dlInvalidate } from '../../src/renderer/src/dl-cache'
import { ref } from 'vue'
import { useGithubSources } from '../../src/renderer/src/composables/useGithubSources'
import type { Progress } from '../../src/renderer/src/types/runtime-center'

it('keeps the new proxy probe result when an older failed probe completes later', async () => {
  let oldResult!: (value: any) => void
  const test = vi.fn().mockImplementationOnce(() => new Promise(done => { oldResult = done }))
    .mockResolvedValueOnce([{ base: '', status: 'ok', ms: 20 }])
  const flow = useGithubSources(() => ({ mirrors: { test } }) as any,
    ref({ mirrors: [{ base: '', label: 'GitHub', mode: 'proxy' as const }], pref: { a: '', n: '' } }), ref(''), async () => {})
  const oldProbe = flow.probeMirrors()
  await flow.probeMirrors()
  oldResult([{ base: '', status: 'down', ms: 10000, reason: 'old proxy failure' }])
  await oldProbe
  expect(flow.mirrorHealth.value.get('')?.status).toBe('ok')
})

it('shows download percentage and persistent failure inside the version picker', async () => {
  dlInvalidate()
  let emit!: (progress: Progress) => void
  let reject!: (reason: Error) => void
  ;(window as any).launcher = {
    config: { get: async () => ({}) },
    mirrors: { state: async () => ({ mirrors: [{ base: '', label: 'GitHub', mode: 'proxy' }], pref: { a: '', n: '' } }), test: async () => [] },
    runtimes: { list: async () => [] }, python: { status: async () => ({ ready: true }) },
    versions: { list: async () => [{ tag: 'v1.2.3', from: 'GitHub', base: '', assetName: 'runtime.zip' }] },
    runtime: { install: () => new Promise((_, fail) => { reject = fail }) },
    onDownloadProgress: (callback: typeof emit) => { emit = callback; return () => {} },
  }
  const wrapper = mount(DownloadPage)
  await flushPromises()
  await wrapper.find('.source-row button').trigger('click')
  await flushPromises()
  await wrapper.find('.vitem button').trigger('click')
  emit({ type: 'n', tag: 'v1.2.3', phase: 'downloading', percent: 48, gotText: '4.8 MB', speedText: '1 MB/s' })
  await flushPromises()
  expect(wrapper.find('.version-download progress').attributes('value')).toBe('48')
  expect(wrapper.find('.version-download').text()).toContain('48%')
  reject(new Error('代理端口连接被拒绝：127.0.0.1:7890'))
  await flushPromises()
  expect(wrapper.find('.version-download [role="alert"]').text()).toContain('代理端口连接被拒绝')
  vi.useFakeTimers()
  await vi.advanceTimersByTimeAsync(7000)
  expect(wrapper.find('.version-download [role="alert"]').exists()).toBe(true)
  wrapper.unmount()
  vi.useRealTimers()
})

it('saves proxy options and requests a source recheck only after a successful save', async () => {
  const set = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('地址错误'))
  ;(window as any).launcher = { config: { get: async () => ({}), set } }
  const wrapper = mount(NetworkProxy)
  await flushPromises()
  await wrapper.find('select').setValue('manual')
  await wrapper.find('input').setValue('http://127.0.0.1:7890')
  await wrapper.find('button').trigger('click')
  await flushPromises()
  expect(set).toHaveBeenCalledWith({ proxyMode: 'manual', proxyUrl: 'http://127.0.0.1:7890' })
  expect(wrapper.emitted('saved')).toHaveLength(1)
  await wrapper.find('button').trigger('click')
  await flushPromises()
  expect(wrapper.find('[role="alert"]').text()).toBe('地址错误')
  expect(wrapper.emitted('saved')).toHaveLength(1)
  wrapper.unmount()
})
