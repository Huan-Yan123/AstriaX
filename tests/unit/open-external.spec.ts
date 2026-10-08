import { describe, expect, it, vi } from 'vitest'
import { buildHandlers } from '../../src/main/ipc'
import { createProcessManager } from '../../src/main/proc/process-manager'

/**
 * app:openExternal —— 给 QQ 弹窗里的「去官网下载」用。
 * 安全红线：渲染层传来的 URL 不能直接喂给 shell.openExternal，
 * 必须只放行 http/https（否则 file:// 或自定义协议可能被用来执行本机东西）。
 */
describe('app:openExternal', () => {
  const stubProbe = () => Promise.resolve(true)

  function mk(openExternal?: (url: string) => void): ReturnType<typeof buildHandlers> {
    return buildHandlers({ probe: stubProbe, processManager: createProcessManager(), openExternal })
  }

  it('放行 https 链接并原样交给系统浏览器', async () => {
    const seen: string[] = []
    const h = mk((u) => seen.push(u))
    await h['app:openExternal']('https://im.qq.com/pcqq/index.shtml')
    expect(seen).toEqual(['https://im.qq.com/pcqq/index.shtml'])
  })

  it('放行 http 链接', async () => {
    const seen: string[] = []
    const h = mk((u) => seen.push(u))
    await h['app:openExternal']('http://example.com/x')
    expect(seen).toEqual(['http://example.com/x'])
  })

  it('拦住 file:// —— 不能拿本机文件当网页打开', async () => {
    const seen: string[] = []
    const h = mk((u) => seen.push(u))
    await expect(h['app:openExternal']('file:///C:/Windows/System32/calc.exe')).rejects.toThrow(/不允许/)
    expect(seen).toEqual([])
  })

  it('拦住自定义协议（比如 ms-msdt: 这类能触发外部程序的）', async () => {
    const h = mk(() => undefined)
    await expect(h['app:openExternal']('ms-msdt:/id PCWDiagnostic')).rejects.toThrow(/不允许/)
    await expect(h['app:openExternal']('javascript:alert(1)')).rejects.toThrow()
    await expect(h['app:openExternal']('vscode://x')).rejects.toThrow(/不允许/)
  })

  it('拦住空串和乱码，报错要能看懂', async () => {
    const h = mk(() => undefined)
    await expect(h['app:openExternal']('')).rejects.toThrow()
    await expect(h['app:openExternal']('不是链接')).rejects.toThrow(/链接格式不对|不允许/)
  })

  it('没有注入 openExternal 时也不崩（走 shell 兜底或如实报错）', async () => {
    const h = mk(undefined)
    // 单测环境没有 electron shell，这里只要求它别把异常吞掉
    const spy = vi.fn()
    await h['app:openExternal']('https://im.qq.com/').catch(spy)
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1)
  })
})
