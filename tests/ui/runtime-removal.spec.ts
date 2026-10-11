import { it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { useRuntimeRemoval } from '../../src/renderer/src/composables/useRuntimeRemoval'

it('gives immediate deletion feedback, prevents duplicate submission and premature dismissal', async () => {
  let resolve!: (value: unknown) => void
  const remove = vi.fn(() => new Promise((done) => { resolve = done }))
  const note = ref('')
  const reload = vi.fn(async () => {})
  const flow = useRuntimeRemoval(() => ({ runtimes: { remove }, instance: { list: async () => [] } }) as any, {
    err: ref(''), note, picking: ref(null), reload, loadVersions: async () => {}
  })
  await flow.askRemove('a', 'v1')
  const pending = flow.doRemove()
  expect(flow.deleting.value).toBe(true)
  flow.cancelRemove()
  await flow.doRemove()
  expect(flow.delTarget.value?.tag).toBe('v1')
  expect(remove).toHaveBeenCalledTimes(1)
  resolve({ removed: true, cleanupPending: true })
  await pending
  expect(flow.deleting.value).toBe(false)
  expect(flow.delTarget.value).toBeNull()
  expect(note.value).toContain('可正常退出')
  expect(reload).toHaveBeenCalledTimes(1)
})

it('clears busy state after an error and allows cancelling the next confirmation', async () => {
  const err = ref('')
  const flow = useRuntimeRemoval(() => ({ runtimes: { remove: async () => { throw new Error('文件被占用') } } }) as any, {
    err, note: ref(''), picking: ref(null), reload: async () => {}, loadVersions: async () => {}
  })
  await flow.askRemove('n', 'v1')
  await flow.doRemove()
  expect(err.value).toBe('文件被占用')
  expect(flow.deleting.value).toBe(false)
  await flow.askRemove('n', 'v2')
  flow.cancelRemove()
  expect(flow.delTarget.value).toBeNull()
})
