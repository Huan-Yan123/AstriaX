// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import PythonEnvironment from '../../src/renderer/src/components/PythonEnvironment.vue'

describe('Python interpreter selection', () => {
  it('discovers system Python and allows an explicit interpreter path', async () => {
    const ready = { ready: true, version: '3.14.0', exe: 'C:\\Python314\\python.exe', source: 'system' as const }
    const select = vi.fn(async () => ({ ...ready, source: 'manual' as const }))
    ;(window as any).launcher = { python: { discover: async () => ready, select, pickFile: async () => ready.exe } }
    const wrapper = mount(PythonEnvironment, { props: { status: null, downloading: false } })
    await wrapper.findAll('button').find(b => b.text() === '重新检测系统 Python')!.trigger('click')
    await flushPromises()
    expect(wrapper.emitted('changed')?.[0]).toEqual([ready])
    await wrapper.find('input').setValue(ready.exe)
    await wrapper.findAll('button').find(b => b.text() === '应用')!.trigger('click')
    await flushPromises()
    expect(select).toHaveBeenCalledWith(ready.exe)
    wrapper.unmount()
  })
  it('shows unsupported interpreter errors and blocks selection during a download', async () => {
    ;(window as any).launcher = { python: { select: async () => { throw new Error('需要 Python 3.12 或更高版本') } } }
    const wrapper = mount(PythonEnvironment, { props: { status: null, downloading: false } })
    await wrapper.find('input').setValue('C:\\Python311\\python.exe')
    await wrapper.findAll('button').find(b => b.text() === '应用')!.trigger('click')
    await flushPromises()
    expect(wrapper.find('[role=alert]').text()).toContain('3.12')
    expect(wrapper.emitted('changed')).toBeUndefined()
    await wrapper.setProps({ downloading: true })
    expect(wrapper.findAll('button').every(b => b.attributes('disabled') !== undefined)).toBe(true)
    wrapper.unmount()
  })
})
