/*
 * 发布/分发相关的地址常量。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 2026-10-08：改成 GitHub 仓库 + 多加速源（主人指令）
 *     —— 本文件曾被覆盖回旧内容，这里是**重新应用**的版本
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人原话：
 *   「更新设置的更新源为我的 GitHub 仓库 https://github.com/Huan-Yan123/AstriaX，
 *     需要带加速源而不是直链」
 *   「多设置几个加速源，默认用最快的下载最新版 exe 文件到默认下载文件夹
 *     并提示用户，带下载进度与速度」
 *   「astriax.huanyan.fun 已经废弃了」
 *
 * ## 为什么必须带加速源而不是直链
 *
 * GitHub 的直链在国内**基本不可用**（实测经常几十 KB/s 或直接超时）。
 * 用户点「下载更新」后卡在 0% 会以为软件坏了 —— 而真相只是链路被墙。
 * 所以所有 GitHub 地址都要包一层前缀，走国内可达的加速节点。
 *
 * ## 为什么是"多源 + 测速选最快"而不是"按顺序回落"
 *
 * 按顺序回落的缺陷：第一个源如果**能连上但极慢**（比如 30KB/s），
 * 它不会被判失败，用户就得用这个慢源下完 80MB（要等 40 分钟）。
 * 现在改成：并发探测所有加速源，取响应最快的那个去下载。
 * 慢源自然被淘汰，且探测耗时 = 最快那个源的延迟（不是累加）。
 *
 * ## 加速源清单与选型依据
 *
 * 这些都是社区长期维护的 GitHub 加速前缀，用法统一为
 * `<加速前缀>https://github.com/<owner>/<repo>/...`。
 * 直链排在最后：它是唯一不依赖第三方服务的，但国内速度最差。
 */

/** GitHub 仓库（owner/repo），发布与更新都从这里取 */
export const GITHUB_OWNER = 'Huan-Yan123'
export const GITHUB_REPO = 'AstriaX'

/** 仓库网页地址（设置里展示给用户看） */
export const GITHUB_WEB_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`

/**
 * Releases 下载用的直链根（**不加任何加速前缀**）。
 *
 * 用 `releases/latest/download/` 而不是 `releases/download/<tag>/`：
 * 前者永远指向最新发布的那个 release，发布时不用回填 tag ——
 * 少一处"发布时忘了改"的地方。
 */
export const GITHUB_RAW_BASE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download/`

/**
 * Raw 文件直链根（读 latest.json 用）。
 *
 * 为什么清单不放 Releases 而是放仓库：
 *   Releases 的资产上传有延迟，而清单是"检查更新"每次启动都要读的 ——
 *   放仓库里由 Git 托管，改一次立刻生效。
 */
export const GITHUB_RAW_MANIFEST_BASE = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/`

/** GitHub 加速前缀（**顺序即优先级，但运行时按实测速度重排**） */
export interface GithubAccelerator {
  /** 展示名（日志与界面上用） */
  label: string
  /** 加速前缀（拼在完整 github url 前面） */
  prefix: string
}

export const GITHUB_ACCELERATORS: GithubAccelerator[] = [
  { label: 'gh-proxy', prefix: 'https://gh-proxy.com/' },
  { label: 'ghfast', prefix: 'https://ghfast.top/' },
  { label: 'ghproxy.net', prefix: 'https://ghproxy.net/' },
  { label: 'isteed', prefix: 'https://cors.isteed.cc/' },
  { label: 'moeyy', prefix: 'https://github.moeyy.xyz/' },
  { label: 'llkk', prefix: 'https://gh.llkk.cc/' }
]

/**
 * 把任意 GitHub 直链包上加速前缀。
 *
 * 非 github 的地址原样返回 —— 这样调用方可以无脑对所有 url 用这个函数，
 * 不用先判断"这是不是 GitHub 地址"。
 */
export function withAccelerator(prefix: string, url: string): string {
  const isGh =
    /^https?:\/\/(raw\.)?githubusercontent\.com\//i.test(url) || /^https?:\/\/github\.com\//i.test(url)
  if (!isGh) return url
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`
  return `${p}${url}`
}

/**
 * 生成清单的候选地址（**顺序即优先级，调用方按速度选**）。
 *
 * 清单很小（几百字节），所以用它做测速探针 —— 探测和真正要用的是
 * 同一个 URL，测出来的速度就是实际读清单的速度，不会"探测快、下载慢"。
 */
export function manifestUrls(): Array<{ label: string; url: string }> {
  const direct = `${GITHUB_RAW_MANIFEST_BASE}latest.json`
  return [
    ...GITHUB_ACCELERATORS.map((a) => ({ label: a.label, url: withAccelerator(a.prefix, direct) })),
    // 直链排最后：唯一不依赖第三方服务的，但国内最慢
    { label: 'GitHub 直连', url: direct }
  ]
}

/**
 * 生成安装包的候选下载地址。
 *
 * 与清单不同的是：安装包有 80MB+，每个源都试一遍代价太大，
 * 所以调用方应当先测速、再选**一个**最快的下载。
 */
export function installerUrls(assetPath: string): Array<{ label: string; url: string }> {
  const direct = `${GITHUB_RAW_BASE}${assetPath}`
  return [
    ...GITHUB_ACCELERATORS.map((a) => ({ label: a.label, url: withAccelerator(a.prefix, direct) })),
    { label: 'GitHub 直连', url: direct }
  ]
}

/*
 * ══════════════════════════════════════════════════════════════════════════
 * 兼容旧名字
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 老代码里到处引用 MX_OFFICIAL_BASE / MX_OFFICIAL_BASES。
 * 保留它们是为了不把改动扩散到所有调用点（那些地方行为没变，
 * 只是"官方源"现在指向 GitHub 而不是那台已废弃的服务器）。
 * 新代码请直接用上面的具体常量。
 */

/** 运行时文件源的根地址（NapCat 等，末尾必须带斜杠） */
export const MX_FILES_BASE = `${GITHUB_RAW_MANIFEST_BASE}files/`

/** @deprecated 用 GITHUB_RAW_MANIFEST_BASE 或具体的 GITHUB_* 常量 */
export const MX_OFFICIAL_BASE = GITHUB_RAW_MANIFEST_BASE

/** @deprecated 用 manifestUrls() 拿候选清单地址 */
export const MX_OFFICIAL_BASES = [MX_OFFICIAL_BASE] as const
