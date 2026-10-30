/*
 * 主进程外网请求统一走 Chromium 网络栈，从而自动跟随 Windows 系统代理。
 *
 * Node 的全局 fetch 使用 Node HTTP 栈，不读取 WinINET 系统代理；只要调用方
 * 写裸 fetch，下载、版本列表、源探测就会绕过用户正在用的代理。
 * 这里在运行时动态取 Electron 的 net，未初始化/纯 Node 测试时退回全局
 * fetch，保证工具函数仍可直接单测。
 */
type FetchLike = typeof fetch

let electronFetch: FetchLike | undefined

async function resolveFetch(): Promise<FetchLike> {
  if (electronFetch) return electronFetch
  try {
    const electron = (await import('electron')) as Partial<typeof import('electron')>
    const fetchFn = electron.net?.fetch
    if (typeof fetchFn === 'function') {
      electronFetch = fetchFn.bind(electron.net) as FetchLike
      return electronFetch
    }
  } catch {
    /* 纯 Node 单测没有 Electron 运行时 */
  }
  return globalThis.fetch
}

export async function systemFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const fetchFn = await resolveFetch()
  return fetchFn(input, init) as Promise<Response>
}

export async function applySystemProxy(): Promise<void> {
  try {
    const { session } = await import('electron')
    await session.defaultSession.setProxy({ mode: 'system' })
    /*
     * electron-updater 不读 defaultSession，它固定用名为
     * "electron-updater" 的分区（cache: false）。分区 session 不会继承
     * 默认 session 的代理设置，所以这里必须单独设置一次。
     */
    const updaterSession = session.fromPartition('electron-updater', { cache: false })
    await updaterSession.setProxy({ mode: 'system' })
  } catch {
    /* 纯 Node 单测或 Electron 尚未 ready：保持 Chromium 默认系统代理 */
  }
}

export async function systemProxyUrl(): Promise<string | undefined> {
  try {
    const { session } = await import('electron')
    const rule = await session.defaultSession.resolveProxy('https://github.com/')
    /*
     * resolveProxy 的格式可能是：
     *   PROXY 127.0.0.1:10808
     *   HTTPS 127.0.0.1:10808       （HTTPS 代理）
     *   SOCKS5 127.0.0.1:10808
     *   SOCKS 127.0.0.1:10808
     *   DIRECT
     * 先取第一条命中，再按协议拼 URL。SOCKS 不能伪装成 http://，
     * 否则 pip 会把 SOCKS 端口当 HTTP 代理，连接会直接失败。
     */
    const m = /\b(PROXY|HTTPS|SOCKS5|SOCKS)\s+([^;\s]+)/i.exec(rule)
    if (!m) return undefined
    const kind = m[1].toUpperCase()
    const hostPort = m[2]
    const scheme =
      kind === 'SOCKS5' ? 'socks5' : kind === 'SOCKS' ? 'socks4' : kind === 'HTTPS' ? 'https' : 'http'
    return `${scheme}://${hostPort}`
  } catch {
    return undefined
  }
}

export async function pipProxyEnv(): Promise<Record<string, string>> {
  const proxy = await systemProxyUrl()
  if (!proxy) return {}
  /*
   * ★ SOCKS 不能给 pip。
   *
   * 内置 Python 里没有 PySocks（实测 `find_spec('socks')` 为空），
   * pip 见到 `socks5://` 会直接报 "Missing dependencies for SOCKS support" ——
   * 那比"不注入代理、让它直连"更糟：原来直连至少装得上。
   * 所以只在 http/https 代理时注入。
   */
  if (/^socks/i.test(proxy)) return {}
  return {
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    /*
     * ★ 本机不许走代理。
     *
     * 用户可以在界面上加自己的 Python 源，localhost / 127.0.0.1 的私有索引
     * （devpi、本地缓存）经系统代理是连不上的 —— 代理转发不到 loopback。
     * Windows 环境变量大小写不敏感，所以只写一份 NO_PROXY。
     */
    NO_PROXY: 'localhost,127.0.0.1,::1'
  }
}
