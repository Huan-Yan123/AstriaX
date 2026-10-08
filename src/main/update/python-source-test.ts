/*
 * ★★ Python 源的测速与可用性判定
 *   （主人 2026-09-27：「加入和 github 一样的测通断」）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 为什么需要它
 * ══════════════════════════════════════════════════════════════════════════
 *
 * GitHub 源那一栏每个源都有「可用 544 ms」这样的**实测延迟徽章**
 *（见 mirror-store-test.ts），而 Python 源那一栏**什么都没有** ——
 * 因为延迟当初是**写死在 note 里**的：
 *     note: '实测唯一可列版本·下载稳定'
 *     note: '索引实测可用·不能列版本'
 *     note: '实测 403·视网络环境而定'
 *
 * 主人要求两件事，正好互为因果：
 *   1. 「去掉……的文案」—— 那些写死的实测结论本来就不可靠
 *      （我们的实测环境 ≠ 用户的网络）
 *   2. 「加入和 github 一样的测通断」—— 改成**当场测**，显示真实延迟
 *
 * ## 判据（与 GitHub 源同一套思路，但探测目标不同）
 *
 * GitHub 源探的是"有没有版本清单"（`versions.json` / releases API）。
 * Python 源探的是 **pip 索引本身**：
 *   · `<indexUrl>astrbot/` —— 这是 pip 真正会打的地址
 *     （`--index-url https://pypi.org/simple/` 时，pip 查的是
 *      `https://pypi.org/simple/astrbot/`）
 *   · 200 且有内容（HTML 链接列表或 JSON）→ 可用
 *   · 403 → 明确不可用（并如实说"被拒绝"，不猜原因）
 *   · 404 → 索引在，但没有这个包（也算不可用，但原因不同）
 *
 * 用 `/astrbot/` 而不是裸索引：裸索引首页很大（PyPI 的 simple 首页
 * 有几 MB），白白拖慢探测；而单包页面小得多，且更贴近真实使用。
 */
import type { PythonSource } from './python-source'
/*
 * 「现在磁盘忙不忙」—— 删大目录期间整机 IO 会被打满，
 * 那时测速超时**不是源坏了**。要如实说清（见下面失败分支的说明）。
 */
import { isDiskBusy } from '../util/workdir'

export type PySourceStatus = 'ok' | 'unreachable'

export interface PySourceTestResult {
  /** 源的标识（用 indexUrl，渲染层据此对上号） */
  indexUrl: string
  label: string
  /** 往返延迟（毫秒）；不可用时为 null */
  ms: number | null
  status: PySourceStatus
  /** 不可用时的原因，可直接展示 */
  reason?: string
}

/**
 * 探测用哪个包名。
 *
 * 用 `astrbot` —— 这正是我们要从这些源装的东西。
 * 如果某个源连 astrbot 都查不到，那它对这个软件就是不可用的
 *（用户选它装 AstrBot 必然失败），早点标出来比装到一半失败好。
 */
const PROBE_PACKAGE = 'astrbot'

/** 拼探测 URL：索引地址 + 包名（等价于 pip 的查询地址） */
export function pyProbeUrl(indexUrl: string): string {
  const base = indexUrl.endsWith('/') ? indexUrl : `${indexUrl}/`
  return `${base}${PROBE_PACKAGE}/`
}

export async function testPythonSources(deps: {
  sources: PythonSource[]
  /** 注入以便单测；缺省用全局 fetch */
  fetchText?: (url: string) => Promise<{ status: number; body: string }>
  now?: () => number
  timeoutMs?: number
}): Promise<PySourceTestResult[]> {
  const now = deps.now ?? (() => Date.now())
  const timeout = deps.timeoutMs ?? 8000

  const fetchText =
    deps.fetchText ??
    (async (url: string) => {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), timeout)
      try {
        const r = await fetch(url, { signal: ctrl.signal })
        /*
         * 只读前 64KB —— 够判断"有没有这个包"，又不会被大页面拖慢。
         * simple 索引的单包页是纯 HTML 链接列表，通常几 KB。
         */
        const text = r.ok ? (await r.text()).slice(0, 65_536) : ''
        return { status: r.status, body: text }
      } finally {
        clearTimeout(t)
      }
    })

  return Promise.all(
    deps.sources.map(async (s): Promise<PySourceTestResult> => {
      const start = now()
      const url = pyProbeUrl(s.indexUrl)
      try {
        const { status, body } = await fetchText(url)
        if (status >= 400) {
          return {
            indexUrl: s.indexUrl,
            label: s.label,
            ms: null,
            status: 'unreachable',
            /*
             * 如实报状态码，不替用户猜原因：
             * 403 就说被拒绝，404 就说没这个包 —— 都比"视网络环境而定"有用。
             */
            reason:
              status === 403
                ? 'HTTP 403（被拒绝，可能需要换源）'
                : status === 404
                  ? `HTTP 404（这个源上没有 ${PROBE_PACKAGE}）`
                  : `HTTP ${status}`
          }
        }
        /*
         * 通了也要看"有没有货"：一个返回 200 的空页面等于没这个包
         *（和 GitHub 源那条"能连上≠能用"是同一个教训）。
         */
        if (!body.trim()) {
          return {
            indexUrl: s.indexUrl,
            label: s.label,
            ms: null,
            status: 'unreachable',
            reason: '页面是空的'
          }
        }
        return {
          indexUrl: s.indexUrl,
          label: s.label,
          ms: Math.max(1, now() - start),
          status: 'ok'
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        /*
         * ★★ 必须区分「超时」和「真的不通」（主人 2026-09-27 的实测）
         *
         * ## 现场
         *
         * 他点了「重新检测」，界面显示**全部源不可用**（连 PyPI 官方也是），
         * 但同一时刻我用 python / node / Electron 直测那些源都是
         * **200、几百毫秒**。日志给出解释：
         *
         *     07:01:39  pysrc:test 耗时 744ms      ← 正常
         *     07:02:38  pysrc:test 耗时 8379ms     ← 撞满 8 秒超时
         *     07:02:38  mirrors:test 耗时 8381ms
         *     （同时段还有 instance:start 8204ms —— 主进程正忙着起实例）
         *
         * 也就是说：**那次是主进程繁忙 + 网络抽风**，请求没能在 8 秒内返回。
         * 网络恢复后再测就正常了（他说"现在可以测了"）。
         *
         * ## 为什么原来的表现有问题
         *
         * 原来不管什么原因，一律标成 `unreachable`、理由是 `String(e)` ——
         * 于是"**一瞬间卡了**"和"**这个源 403 被拒**"在界面上长得一模一样：
         * 都是灰色的"不可用"。用户会以为源全坏了（他正是这么问的），
         * 从而去折腾根本没问题的设置。
         *
         * ## 现在
         *
         * 超时单独给一句**说清"是慢，不是坏"**的原因，而且措辞里
         * 明确提示可以再试一次 —— 用户就知道该怎么办了。
         *
         * 状态仍用 `unreachable`（这一轮确实没测通，不该谎报可用），
         * 但 `reason` 完全不同 —— 界面把它显示在徽章的 title 里。
         */
        const isTimeout = /abort|timeout|超时/i.test(msg)
        /*
         * ★ 如果此刻正在删大目录（磁盘被 IO 打满），要把话说清楚
         *
         * 主人 2026-09-27：「我删了东西之后再测连通就是全部超时……
         *   好像是删除文件导致磁盘 IO 受限导致的，大半天都在 100% 磁盘占用」
         *
         * 这是**物理限制**：删一个 546MB / 4.9 万文件的运行时，
         * 磁盘要做几万次元数据操作，期间整机 IO 挤满 ——
         * 网络请求也会因此超时（不只是文件操作）。
         *
         * 所以失败理由里要**点名这件事**，否则用户会去折腾源设置。
         */
        const diskBusy = isDiskBusy()
        return {
          indexUrl: s.indexUrl,
          label: s.label,
          ms: null,
          status: 'unreachable',
          reason: diskBusy
            ? '超时（刚删过运行时，磁盘正忙 —— 等它闲下来再点一次「重新检测」）'
            : isTimeout
              ? `超时（${Math.round(timeout / 1000)} 秒内没响应 —— 可能是网络一时卡顿或电脑正忙，可以再点一次「重新检测」）`
              : `连不上：${msg}`
        }
      }
    })
  )
}
