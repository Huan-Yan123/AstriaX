import { loadMirrors, type Mirror } from './mirror-store'

export type MirrorStatus =
  /** 通了，而且这个源上真的有我们要的版本清单（可用） */
  | 'ok'
  /** 通了，但源上没有版本清单 / 清单是空的 → 拿不到东西，等同于不可用 */
  | 'empty'
  /** 连不上、超时、HTTP 错误 */
  | 'unreachable'

export interface MirrorTestResult {
  base: string
  label: string
  /** 往返延迟（毫秒）；不可用时为 null */
  ms: number | null
  status: MirrorStatus
  /** 不可用时的原因，可直接展示 */
  reason?: string
}

/**
 * 镜像测速 + 可用性判定。
 *
 * **「能连上」不等于「能用」** —— 这是之前判错的点：
 * 原来只要 HTTP 状态 < 400 就标成可用，于是一个活着但啥也没有的源
 * （比如根目录返回 200 的空站点、或者只放了别的文件的服务器）
 * 会被标成绿色「可用」，用户点「下载」才发现没版本可选。
 *
 * 现在的判据是「**真的拿到了版本清单，而且清单里有货**」：
 *   - 文件源：GET <base>versions.json，必须是 200 且 JSON 里至少有一个版本
 *   - 反代源：GET 被代理的 GitHub releases API，必须 200 且有非空数组
 * 任何一步不满足都算不可用：
 *   - 连不上/超时/HTTP ≥ 400  → unreachable
 *   - 连上了但清单缺失/为空    → empty（同样不可用，只是原因不同）
 *
 * 界面统一把这两种都显示成「不可用」，但 reason 保留区分，
 * 方便用户自己判断是「地址写错了」还是「这个源还没同步文件」。
 */
export async function testMirrors(deps: {
  dataRoot: string
  /** 拿 URL 的响应，返回 { status, body }；body 只在需要解析时读 */
  fetchText?: (url: string) => Promise<{ status: number; body: string }>
  now?: () => number
  timeoutMs?: number
}): Promise<MirrorTestResult[]> {
  const now = deps.now ?? (() => Date.now())
  const st = loadMirrors(deps.dataRoot)
  const timeout = deps.timeoutMs ?? 8000

  const fetchText =
    deps.fetchText ??
    (async (url: string) => {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), timeout)
      try {
        const r = await fetch(url, { signal: ctrl.signal })
        // 读 body 才能判断"有没有货"；限制大小避免恶意/异常的超大响应
        const text = r.ok ? (await r.text()).slice(0, 2_000_000) : ''
        return { status: r.status, body: text }
      } finally {
        clearTimeout(t)
      }
    })

  /** 这个源上要探测的 URL */
  const urlFor = (m: Mirror): string => {
    if (m.mode === 'files') {
      // 文件源用版本清单做存活+可用性探测（与版本探测同一文件，避免多一种约定）
      const base = m.base.endsWith('/') ? m.base : `${m.base}/`
      return `${base}versions.json`
    }
    // 反代型：打 GitHub releases API（能被前缀代理）
    const account = 'repos/NapNeko/NapCatQQ/releases'
    return m.base ? `${m.base}https://api.github.com/${account}` : `https://api.github.com/${account}`
  }

  /**
   * 判断响应体里到底有没有可用的版本。
   *
   * 文件源是我们自己的 versions.json（{ astrbot: [...], napcat: [...] }）；
   * 反代源是 GitHub releases 数组。两种结构不同，但判据一样：
   * **至少有一个条目**。空数组 / 空对象 / 解析不了都算「没货」。
   */
  const hasContent = (body: string): boolean => {
    const t = body.trim()
    if (!t) return false
    try {
      const j = JSON.parse(t) as unknown
      if (Array.isArray(j)) return j.length > 0
      if (j && typeof j === 'object') {
        const vals = Object.values(j as Record<string, unknown>)
        // versions.json 形态：任一分类下有非空数组就算有货
        return vals.some((v) => Array.isArray(v) && v.length > 0)
      }
      return false
    } catch {
      // 不是 JSON：只要不是明显空页（比如 GitHub 的 200 空壳），就当有内容
      return t.length > 32
    }
  }

  return Promise.all(
    st.mirrors.map(async (m): Promise<MirrorTestResult> => {
      const start = now()
      try {
        const { status, body } = await fetchText(urlFor(m))
        if (status >= 400) {
          return {
            base: m.base,
            label: m.label,
            ms: null,
            status: 'unreachable',
            reason: `HTTP ${status}`
          }
        }
        if (!hasContent(body)) {
          // 连得上但没东西：和连不上一样不可用，只是原因不同
          return { base: m.base, label: m.label, ms: null, status: 'empty', reason: '源上没有文件' }
        }
        return {
          base: m.base,
          label: m.label,
          ms: Math.max(1, now() - start),
          status: 'ok'
        }
      } catch (e) {
        /*
         * ★ 区分「超时」和「真的连不上」（与 python-source-test 同一处理）
         *
         * 主人 2026-09-27 实测：点「重新检测」时全部源显示不可用，
         * 而网络只是抽风了一下（再点一次就好了）。
         * 两者原来是同一个灰徽章 + 一句 `String(e)`，用户看不出区别，
         * 会以为源全坏了。
         */
        const msg = e instanceof Error ? e.message : String(e)
        const isTimeout = /abort|timeout|超时/i.test(msg)
        return {
          base: m.base,
          label: m.label,
          ms: null,
          status: 'unreachable',
          reason: isTimeout
            ? `超时（${Math.round(timeout / 1000)} 秒内没响应 —— 可能是网络一时卡顿或电脑正忙，可以再点一次「重新检测」）`
            : msg
        }
      }
    })
  )
}
