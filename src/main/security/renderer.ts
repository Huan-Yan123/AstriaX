import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'

const rendererDocuments = new WeakMap<WebContents, string>()

function isRendererDocument(raw: string, expected: string): boolean {
  try {
    const url = new URL(raw)
    const trusted = new URL(expected)
    url.hash = ''
    trusted.hash = ''
    return url.href === trusted.href
  } catch {
    return false
  }
}

export function httpExternalUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** 在加载页面前登记唯一受信任的启动器文档，并锁住导航与弹窗边界。 */
export function configureLauncherSecurity(
  contents: WebContents,
  rendererUrl: string,
  openExternal: (url: string) => Promise<unknown>,
  onExternalError: (error: unknown) => void = () => undefined
): void {
  rendererDocuments.set(contents, rendererUrl)
  const guardNavigation = (event: { preventDefault: () => void }, url: string): void => {
    if (!isRendererDocument(url, rendererUrl)) event.preventDefault()
  }
  contents.on('will-navigate', guardNavigation)
  contents.on('will-redirect', guardNavigation)
  contents.setWindowOpenHandler(({ url }) => {
    const external = httpExternalUrl(url)
    if (external) void Promise.resolve().then(() => openExternal(external)).catch(onExternalError)
    return { action: 'deny' }
  })
}

/** WebUI、子帧及跳转后的网页不能使用启动器的文件、进程和凭据接口。 */
export function assertTrustedIpcSender(event: Pick<IpcMainInvokeEvent | IpcMainEvent, 'sender' | 'senderFrame'>): void {
  const contents = event.sender
  const expected = rendererDocuments.get(contents)
  const frame = event.senderFrame
  if (!expected || contents.isDestroyed() || !frame || frame !== contents.mainFrame ||
      !isRendererDocument(frame.url, expected)) {
    throw new Error('拒绝来自非启动器页面的 IPC 请求')
  }
}
