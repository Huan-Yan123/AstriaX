import { describe, it, expect } from 'vitest'
import { resolveLatest, TEMPLATE_SOURCES, MIRROR_PREFIXES } from '../../src/main/update/template-source'

/**
 * NapCat 用 Shell 版（NapCat.Shell.zip），不是自带 node.exe 的 Windows.Node 版。
 * Shell 版才是「注入已装 QQ」的正路：解压出来有 launcher*.bat + NapCatWinBootMain.exe。
 * 夹具里故意同时放几个别的资产（Framework / OneKey），验证筛选器只挑对那个。
 */
const napPayload = {
  tag_name: 'v4.18.19',
  name: 'NapCat v4.18.19',
  assets: [
    { name: 'NapCat.Framework.zip', browser_download_url: 'https://github.com/x/NapCat.Framework.zip' },
    { name: 'NapCat.Shell.Windows.Node.zip', browser_download_url: 'https://github.com/x/NapCat.Shell.Windows.Node.zip' },
    { name: 'NapCat.Shell.Windows.OneKey.zip', browser_download_url: 'https://github.com/x/NapCat.Shell.Windows.OneKey.zip' },
    {
      name: 'NapCat.Shell.zip',
      browser_download_url: 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.19/NapCat.Shell.zip',
      digest: 'sha256:abc123'
    }
  ]
}

const astrPayload = {
  tag_name: 'v4.28.0',
  assets: [
    { name: 'AstrBot-v4.28.0-dashboard.zip', browser_download_url: 'https://github.com/AstrBotDevs/AstrBot/releases/download/v4.28.0/AstrBot-v4.28.0-dashboard.zip', digest: 'sha256:dd91' }
  ]
}

describe('resolveLatest（镜像回退链）', () => {
  it('直连成功 → 命中 NapCat Shell 版资产与 sha256', async () => {
    const r = await resolveLatest({
      source: TEMPLATE_SOURCES.n,
      fetch: async () => JSON.stringify(napPayload)
    })
    expect(r.tag).toBe('v4.18.19')
    expect(r.assetName).toBe('NapCat.Shell.zip')
    expect(r.sha256).toBe('abc123')
  })

  it('第一个镜像 404 → 回退到下一个前缀', async () => {
    const seen: string[] = []
    const r = await resolveLatest({
      source: TEMPLATE_SOURCES.n,
      fetch: async (url) => {
        seen.push(url)
        if (url.includes('gh-proxy.com/')) throw new Error('HTTP 404')
        return JSON.stringify(napPayload)
      },
      prefixes: MIRROR_PREFIXES.slice(0, 3)
    })
    expect(r.tag).toBe('v4.18.19')
    expect(seen.some((u) => u.includes('ghproxy.net/'))).toBe(true)
  })

  it('直连也失败（无可用镜像）→ 明确报错', async () => {
    /*
     * 对 AstrBot 来说，「GitHub release 里没有可装资产」是**正常且正确**的
     * （那边只发 dashboard.zip，只有前端），所以错误信息不再是笼统的「拉不到」，
     * 而是明确指向 PyPI。断言改成匹配这条更有用的提示。
     */
    await expect(
      resolveLatest({ source: TEMPLATE_SOURCES.a, fetch: async () => { throw new Error('HTTP 500') } })
    ).rejects.toThrow(/PyPI/)
  })

  it('NapCat 直连失败时报「拉不到」（它是真的网络问题）', async () => {
    await expect(
      resolveLatest({ source: TEMPLATE_SOURCES.n, fetch: async () => { throw new Error('HTTP 500') } })
    ).rejects.toThrow(/拉不到/)
  })

  /*
   * AstrBot 的资产过滤 —— 这里曾经断言「dashboard.zip 命中」，等于给坏行为盖章。
   *
   * dashboard.zip 是官方 release 里的**WebUI 静态资源包**（约 6MB），
   * 里面只有前端 dist/，**没有 astrbot 后端包**。下下来解压是个空目录，
   * AstrBot 根本起不来 —— 这正是服务器上最早那版错误资产。
   *
   * AstrBot 的正确分发是 PyPI（内置 Python 的 pip 装），
   * 所以「从 GitHub release 抓 AstrBot 资产」这条路本身就不该产出可安装的东西。
   * 现在把它明确标成不匹配，让调用方走 PyPI 分支去。
   */
  it('AstrBot 资产过滤：dashboard.zip 必须【不】命中（它只有前端，没后端）', async () => {
    await expect(
      resolveLatest({ source: TEMPLATE_SOURCES.a, fetch: async () => JSON.stringify(astrPayload) }),
      'dashboard.zip 被当成可安装的 AstrBot 了 —— 那是只有 dist/ 的前端包，解压出来跑不起来。'
        + 'AstrBot 应走 PyPI（kind=pypi），不该从这里选资产。'
    ).rejects.toThrow()
  })

  it('AstrBot 的 assetFilter 拒绝一切 release 资产（AstrBot 只从 PyPI 装）', () => {
    const f = TEMPLATE_SOURCES.a.assetFilter
    // 官方发过的各种形态，都不该被选中
    expect(f('AstrBot-v4.28.0-dashboard.zip')).toBe(false)
    expect(f('AstrBot-v4.29.0-beta.1-dashboard.zip')).toBe(false)
    expect(f('AstrBot-v4.28.0.zip')).toBe(false)
    expect(f('astrbot-4.28.0-py3-none-any.whl')).toBe(false)
    expect(f('whatever.zip')).toBe(false)
  })

  it('NapCat 还是从 GitHub 抓 Shell 包（这条路径是有效的）', () => {
    const f = TEMPLATE_SOURCES.n.assetFilter
    expect(f('NapCat.Shell.zip'), 'Shell 形态应命中').toBe(true)
    expect(f('NapCat.Shell.Windows.Node.zip'), 'Node 形态不该命中（多 89MB 且我们用不上）').toBe(false)
  })
})
