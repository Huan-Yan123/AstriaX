import { EventEmitter } from 'events'
import type { WebContents, IpcMainInvokeEvent } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { assertTrustedIpcSender, configureLauncherSecurity } from '../../src/main/security/renderer'

const rendererUrl = 'file:///G:/AstriaX/out/renderer/index.html'
function page(url = rendererUrl) {
  const emitter = new EventEmitter()
  let popup: (details: { url: string }) => { action: string }
  const frame = { url }
  const contents = Object.assign(emitter, {
    mainFrame: frame,
    isDestroyed: () => false,
    setWindowOpenHandler: (handler: typeof popup) => { popup = handler }
  }) as unknown as WebContents
  const openExternal = vi.fn(async (_url: string) => undefined)
  configureLauncherSecurity(contents, url, openExternal)
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  return { contents, frame, event, openExternal, popup: (url: string) => popup({ url }) }
}

describe('启动器导航和 IPC 信任边界', () => {
  it('启动器自己的主框架可访问 IPC，hash 变化不影响使用', () => {
    const p = page()
    p.frame.url += '#settings'
    expect(() => assertTrustedIpcSender(p.event)).not.toThrow()
  })
  it('相同 URL 的未登记窗口也不能调用 IPC', () => {
    const p = page()
    const unknown = { ...p.event, sender: { ...p.contents } } as IpcMainInvokeEvent
    expect(() => assertTrustedIpcSender(unknown)).toThrow(/非启动器/)
  })
  it('子框架不能冒充启动器主框架', () => {
    const p = page()
    expect(() => assertTrustedIpcSender({ ...p.event, senderFrame: { url: rendererUrl } } as IpcMainInvokeEvent)).toThrow()
  })
  it.each(['https://evil.example/', 'file:///G:/other.html', 'about:blank', 'data:text/html,unsafe'])('页面离开受信任文档后拒绝 IPC：%s', (url) => {
    const p = page()
    p.frame.url = url
    expect(() => assertTrustedIpcSender(p.event)).toThrow()
  })
  it.each(['http://localhost.evil.example:5173/', 'http://localhost:5174/', 'http://localhost:5173/other'])('开发页面拒绝伪造前缀或其他路径：%s', (url) => {
    const p = page('http://localhost:5173/')
    p.frame.url = url
    expect(() => assertTrustedIpcSender(p.event)).toThrow()
  })
  it.each(['will-navigate', 'will-redirect'])('%s 拦截外部导航，保留自身重载', (name) => {
    const p = page()
    const preventDefault = vi.fn()
    p.contents.emit(name as any, { preventDefault }, 'https://evil.example/')
    expect(preventDefault).toHaveBeenCalledOnce()
    preventDefault.mockClear()
    p.contents.emit(name as any, { preventDefault }, rendererUrl)
    expect(preventDefault).not.toHaveBeenCalled()
  })
  it.each(['file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id test', 'javascript:alert(1)', 'https://user:pass@example.com/'])('不将危险协议或带凭据链接交给系统：%s', async (url) => {
    const p = page()
    expect(p.popup(url)).toEqual({ action: 'deny' })
    await Promise.resolve()
    expect(p.openExternal).not.toHaveBeenCalled()
  })
  it('普通网页链接在系统浏览器打开，启动器不新建窗口', async () => {
    const p = page()
    expect(p.popup('https://example.com/help')).toEqual({ action: 'deny' })
    await Promise.resolve()
    expect(p.openExternal).toHaveBeenCalledWith('https://example.com/help')
  })
})
