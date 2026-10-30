// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'

const delegated = vi.fn(async () => new Response('ok'))
const setProxy = vi.fn(async () => undefined)
const updaterSetProxy = vi.fn(async () => undefined)
const resolveProxy = vi.fn(async () => 'PROXY 127.0.0.1:10808')
const fromPartition = vi.fn(() => ({ setProxy: updaterSetProxy }))

vi.mock('electron', () => ({
  net: { fetch: delegated },
  session: { defaultSession: { setProxy, resolveProxy }, fromPartition }
}))

describe('主进程网络跟随系统代理', () => {
  afterEach(() => {
    delegated.mockClear()
    setProxy.mockClear()
    updaterSetProxy.mockClear()
    fromPartition.mockClear()
    resolveProxy.mockClear()
  })

  it('systemFetch 使用 Electron net.fetch（Chromium 网络栈）', async () => {
    const { systemFetch } = await import('../../src/main/update/network')
    const r = await systemFetch('https://example.com/file')
    expect(await r.text()).toBe('ok')
    expect(delegated).toHaveBeenCalledWith('https://example.com/file', undefined)
  })

  it('applySystemProxy 显式设置 system 模式，不锁死成某个代理地址', async () => {
    const { applySystemProxy } = await import('../../src/main/update/network')
    await applySystemProxy()
    expect(setProxy).toHaveBeenCalledWith({ mode: 'system' })
  })

  it('electron-updater 分区 session 也跟随系统代理', async () => {
    const { applySystemProxy } = await import('../../src/main/update/network')
    await applySystemProxy()
    expect(fromPartition).toHaveBeenCalledWith('electron-updater', { cache: false })
    expect(updaterSetProxy).toHaveBeenCalledWith({ mode: 'system' })
  })

  it('pipProxyEnv 只导出系统实际选中的代理，并排除本机', async () => {
    const { pipProxyEnv } = await import('../../src/main/update/network')
    expect(await pipProxyEnv()).toEqual({
      HTTP_PROXY: 'http://127.0.0.1:10808',
      HTTPS_PROXY: 'http://127.0.0.1:10808',
      http_proxy: 'http://127.0.0.1:10808',
      https_proxy: 'http://127.0.0.1:10808',
      /*
       * 用户自定义的 Python 源常在 localhost：经代理反而连不上，
       * 所以 NO_PROXY 必须一起给（少了它，"本地源装不上"会回归）。
       */
      NO_PROXY: 'localhost,127.0.0.1,::1'
    })
  })

  it('DIRECT 时 pipProxyEnv 返回空对象，不强制走代理', async () => {
    resolveProxy.mockResolvedValueOnce('DIRECT')
    const { pipProxyEnv } = await import('../../src/main/update/network')
    expect(await pipProxyEnv()).toEqual({})
  })

  it('SOCKS5 代理：URL 保持 socks5 协议（不能拼成 http://）', async () => {
    resolveProxy.mockResolvedValueOnce('SOCKS5 127.0.0.1:10808')
    const { systemProxyUrl } = await import('../../src/main/update/network')
    expect(await systemProxyUrl()).toBe('socks5://127.0.0.1:10808')
  })

  it('SOCKS5 代理不给 pip：内置 Python 没 PySocks，注入只会让 pip 直接失败', async () => {
    resolveProxy.mockResolvedValueOnce('SOCKS5 127.0.0.1:10808')
    const { pipProxyEnv } = await import('../../src/main/update/network')
    /* 返回空 = 让 pip 直连（原来就是直连，至少装得上） */
    expect(await pipProxyEnv()).toEqual({})
  })

  it('HTTPS 代理保持 https://，不能降级成明文 HTTP', async () => {
    resolveProxy.mockResolvedValueOnce('HTTPS proxy.example:8443')
    const { pipProxyEnv } = await import('../../src/main/update/network')
    expect(await pipProxyEnv()).toEqual({
      HTTP_PROXY: 'https://proxy.example:8443',
      HTTPS_PROXY: 'https://proxy.example:8443',
      http_proxy: 'https://proxy.example:8443',
      https_proxy: 'https://proxy.example:8443',
      NO_PROXY: 'localhost,127.0.0.1,::1'
    })
  })
})
