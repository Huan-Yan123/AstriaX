import { createHash } from 'crypto'

export interface TemplateSource {
  type: 'a' | 'n'
  repo: string
  /** 直接命中资产，无需逐个试探 */
  assetFilter: (name: string) => boolean
}

export const TEMPLATE_SOURCES: Record<'a' | 'n', TemplateSource> = {
  a: {
    type: 'a',
    repo: 'AstrBotDevs/AstrBot',
    /*
     * AstrBot **不从这里拿资产**，永远返回 false。
     *
     * 为什么：官方 release 里唯一带 zip 的资产是
     *   AstrBot-v4.28.0-dashboard.zip（约 6MB）
     * 那是 **WebUI 静态资源包**，里面只有前端 dist/，**没有 astrbot 后端包**。
     * 下下来解压是空目录，实例一启动就失败 —— 这是真实踩过的坑，
     * 服务器上最早那版错误资产就是它。
     *
     * AstrBot 的正确分发方式是 PyPI：内置 Python 的
     *   pip install --target <运行时目录> astrbot==<版本>
     * （见 ipc.ts 的 runtime:install 里 kind==='pypi' 分支；
     *  清单侧由 version-catalog.ts 识别 `pypi:` 前缀条目。）
     *
     * 这里明确返回 false 而不是删掉这个键：删了会变成 undefined，
     * 调用方 `filter(a.name)` 直接 TypeError；返回 false 是「没有可选项」，
     * 上层会得到「拉不到 release 清单」这种能看懂的错误，然后走 PyPI。
     */
    assetFilter: () => false
  },
  /*
   * NapCat 用 Shell 版（28 MB），不是 Windows.Node 版（112 MB）。
   *
   * Shell 版才是「注入已装 QQ」的正路：解压出来有 launcher.bat + NapCatWinBootMain.exe
   * + NapCatWinBootHook.dll + qqnt.json，launcher.bat 从注册表读 QQ 安装目录，
   * 然后 NapCatWinBootMain.exe <QQ.exe> NapCatWinBootHook.dll 把机器人注进去。
   *
   * Windows.Node 版自带 node.exe，看着像能独立跑，实际它同样依赖 QQ 的运行时
   * （wrapper.node 要 QQ 目录里的 SSOPlatform.dll 等一堆随附 DLL），
   * 裸跑会卡在 "The specified module could not be found"，白下 84 MB。
   *
   * 所以门槛是「本机装好 QQ 且版本 ≥ 40768」——见 runtime/qq-check.ts。
   */
  n: {
    type: 'n',
    repo: 'NapNeko/NapCatQQ',
    assetFilter: (n) => /^NapCat\.Shell\.zip$/.test(n)
  }
}

/** 镜像前缀列表（speed 由测速排行决定），空串=官方直连 */
export const MIRROR_PREFIXES = [
  'https://gh-proxy.com/',
  'https://ghproxy.net/',
  'https://gh-proxy.net/',
  ''
]

export interface ReleaseInfo {
  tag: string
  name: string
  assetUrl: string // 资产直链（github.com/...）
  assetName: string
  sha256?: string
}

async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()
  } finally {
    clearTimeout(t)
  }
}

/** 抓 latest release 并按 assetFilter 选资产。tryMirrorPrefixes 按 MIRROR_PREFIXES 顺序试 */
export async function resolveLatest(deps: {
  source: TemplateSource
  fetch?: (url: string) => Promise<string>
  prefixes?: string[]
}): Promise<ReleaseInfo> {
  const fetchFn = deps.fetch ?? fetchText
  const prefixes = deps.prefixes ?? ['']
  for (const p of prefixes) {
    try {
      const apiBase = p ? `${p}https://api.github.com/` : 'https://api.github.com/'
      const j = JSON.parse(await fetchFn(`${apiBase}repos/${deps.source.repo}/releases/latest`)) as {
        tag_name?: string
        name?: string
        assets?: Array<{ name?: string; browser_download_url?: string; digest?: string }>
      }
      const asset = (j.assets ?? []).find((x) => x.name && deps.source.assetFilter(x.name))
      if (!asset?.browser_download_url) continue
      return {
        tag: j.tag_name ?? 'unknown',
        name: asset.name!,
        assetUrl: asset.browser_download_url,
        assetName: asset.name,
        sha256: asset.digest?.replace(/^sha256:/, '')
      }
    } catch {
      /* 换下一个镜像前缀 */
    }
  }
  /*
   * 走到这里说明没有任何资产被选中。
   *
   * AstrBot 的情况要单独说清楚：官方 release **从来只发 dashboard.zip**
   * （实测 v4.27.3 ~ v4.28.0 六个版本全是），那是只有前端 dist/ 的资源包，
   * 不含后端 —— 后端在 PyPI 的 wheel 里（astrbot-<ver>-py3-none-any.whl）。
   * 所以对 AstrBot 来说这里「失败」是**正常且正确**的，
   * 上层应当走 PyPI 分支，而不是把这条错误当成网络故障去重试。
   */
  const hint =
    deps.source.type === 'a'
      ? 'AstrBot 不经 GitHub release 分发（那边只有 dashboard 前端包），应从 PyPI 安装。'
      : '所有镜像都拉不到 release 清单'
  throw new Error(hint)
}

export function sha256Buf(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex')
}
