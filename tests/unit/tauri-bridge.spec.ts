import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createLauncherApi } from '../../src/shared/launcher-api'

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
import { createTauriTransport } from '../../src/renderer/src/platform/tauri'

describe('Tauri launcher transport', () => {
  beforeEach(() => { vi.resetAllMocks() })
  it('keeps existing Vue request contracts while invoking Rust', async () => {
    mocks.invoke.mockResolvedValue({ ok: true })
    const api = createLauncherApi(createTauriTransport())
    await api.instance.create({ type: 'a', name: '中文实例', tag: 'v4.28.1' })
    expect(mocks.invoke).toHaveBeenCalledWith('launcher_request', {
      channel: 'instance:create', payload: { type: 'a', name: '中文实例', tag: 'v4.28.1' },
    })
    await api.ping()
    expect(mocks.invoke).toHaveBeenLastCalledWith('launcher_request', { channel: 'app:ping', payload: null })
  })
  it('releases an event subscription that resolves after the component unmounts', async () => {
    let resolve!: (off: () => void) => void
    let receive!: (event: { payload: unknown }) => void
    mocks.listen.mockImplementation((_channel, callback) => { receive = callback; return new Promise(r => { resolve = r }) })
    const api = createLauncherApi(createTauriTransport())
    const callback = vi.fn(), off = vi.fn()
    const unsubscribe = api.onDownloadProgress(callback)
    unsubscribe()
    receive({ payload: { type: 'a', phase: 'done' } })
    resolve(off)
    await Promise.resolve()
    expect(callback).not.toHaveBeenCalled()
    expect(off).toHaveBeenCalledOnce()
  })
  it('forwards payloads and structured Rust errors', async () => {
    const callback = vi.fn(), off = vi.fn()
    mocks.listen.mockImplementation(async (_channel, receive) => { receive({ payload: { percent: 50 } }); return off })
    const api = createLauncherApi(createTauriTransport())
    const unsubscribe = api.app.onUpdateProgress(callback)
    await Promise.resolve()
    expect(callback).toHaveBeenCalledWith({ percent: 50 })
    unsubscribe()
    mocks.invoke.mockRejectedValue({ code: 'Busy', message: '版本正在安装' })
    await expect(api.runtimes.remove({ type: 'a', tag: 'v4.28.1' })).rejects.toThrow('版本正在安装')
  })
})
