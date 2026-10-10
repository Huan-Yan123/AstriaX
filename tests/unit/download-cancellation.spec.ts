import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { useDownloadProgress } from '../../src/renderer/src/composables/useDownloadProgress'
import type { Progress } from '../../src/renderer/src/types/runtime-center'

let wrapper: VueWrapper | undefined
afterEach(() => { wrapper?.unmount(); wrapper = undefined })
const progress: Progress = { type: 'a', tag: 'v4.28.1', phase: 'downloading', percent: 10, gotText: '1 MB', speedText: '1 MB/s' }
function setup(cancel: () => Promise<{ ok: boolean }>) {
  let state!: ReturnType<typeof useDownloadProgress>
  wrapper = mount(defineComponent({ setup() { state = useDownloadProgress({ cancel, reload: async () => {} }); return () => null } }))
  state.setProgress(progress)
  return state
}
describe('download cancellation acknowledgement', () => {
  it('waits for backend cleanup before presenting a terminal result', async () => {
    const state = setup(async () => ({ ok: true }))
    await state.cancelTask(progress)
    expect(state.progressList.value[0].phase).toBe('downloading')
    expect(state.progressList.value[0].label).toContain('等待后台清理')
    expect(state.cancelling.value.has('a|v4.28.1')).toBe(true)
    state.setProgress({ ...progress, phase: 'error', error: '操作已取消' })
    expect(state.cancelling.value.size).toBe(0)
    expect(state.progressList.value[0].error).toBe('操作已取消')
  })
  it('keeps the final backend event when it arrives before the acknowledgement', async () => {
    let acknowledge!: (value: { ok: boolean }) => void
    const state = setup(() => new Promise(resolve => { acknowledge = resolve }))
    const request = state.cancelTask(progress)
    state.setProgress({ ...progress, phase: 'done' })
    acknowledge({ ok: true })
    await request
    expect(state.progressList.value[0].phase).toBe('done')
    expect(state.cancelling.value.size).toBe(0)
  })
})
