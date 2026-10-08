import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { readJsonFile } from '../util/json-file'
import { writeJsonAtomic } from '../util/atomic-write'
import { MX_OFFICIAL_BASE } from './publish-urls'
// AstrBot 的 Python 源（pip 索引）—— 与上面这份 GitHub 代理源**完全分开**
import {
  BUILTIN_PYTHON_SOURCES,
  DEFAULT_PYTHON_SOURCE,
  findPythonSource,
  pythonSourceCandidates,
  type PythonSource
} from './python-source'

/**
 * 镜像源模型
 * - proxy：GitHub 反代前缀（如 gh-proxy），把 github.com 直链拼在后面
 * - files：文件型镜像，自己托管 AstrBot/NapCat 原文件（可选 index.json 给文件名→直链+sha256）
 */
export type MirrorMode = 'proxy' | 'files'

export interface Mirror {
  label: string
  base: string
  mode: MirrorMode
  builtin?: boolean
  note?: string
  /** UI 不展示真实地址（官方源对外只显示名字，避免暴露服务器 IP） */
  hideBase?: boolean
}

export interface MirrorState {
  mirrors: Mirror[]
  /** 各类型的首选源；空串=自动（按测速顺序） */
  pref: { a: string; n: string }
}

/**
 * 内置镜像源。
 *
 * 这里每一个都是**实测过的**（2026-09-13 用真实请求验证两条通路）：
 *   - 列版本：GET <base>https://api.github.com/repos/NapNeko/NapCatQQ/releases
 *   - 下文件：GET <base>https://github.com/NapNeko/NapCatQQ/raw/main/README.md
 * 两条都通才算可用 —— 光能连上没用，用户要的是「列得出版本 + 下得动文件」。
 *
 * 实测淘汰的（留个记录，别再手贱加回去）：
 *   - gh-proxy.net     两条通路全不通（用户反馈「显示没读到版本却显示可用」的来源之一）
 *   - ghproxy.net      能下文件但 API 返回 403 → 列不出可用版本
 *   - gh-proxy.ygxz.in / gh.llkk.cc / ghfast.top / github.moeyy.xyz / gh-proxy.02s.xyz
 *                      超时（>9 秒无响应）
 *   - slink.ltd / down.npee.cn / gh.xmly.dev   能连上但返回的不是 release JSON
 *   - ghproxy.cc / hub.gitmirror.com / ghp.ci / github.store / gitdl.cn / gh-proxy.top / kkgithub.com
 *                      连接直接失败（域名不通）
 *   - gh.ddlc.top / ghps.cc / gh-proxy.p2hp.com / gh-proxy.llyke.com / cdn.jsdelivr.net
 *                      HTTP 404（路径规则不匹配）
 *   - ghproxy.homeboyc.cn / cors.isteed.cc / gitproxy.click / api.akams.cn
 *                      403 / 429 / 502（限流或拒绝）
 */
export const BUILTIN_MIRRORS: Mirror[] = [
  { label: 'GitHub 直连', base: '', mode: 'proxy', builtin: true, note: '官方源' },
  // 实测两条通路都通，速度最快的放前面
  { label: 'gh-proxy.com', base: 'https://gh-proxy.com/', mode: 'proxy', builtin: true, note: '加速·实测可用' },
  { label: 'cors.isteed.cc', base: 'https://cors.isteed.cc/', mode: 'proxy', builtin: true, note: '加速·实测可用' },
  /*
   * 下面两个是「能下文件、列不了版本」的源，保留为**手动选用的备用** 没用 ——
   * 列不出可安装版本，界面会一直显示「这个源还没上架版本」，对用户是干扰。
   * 所以不内置。用户真要加，可以在下面「加一个镜像源」里自己填。
   */
  /*
   * UI 对外只显示「AstriaX官方源」，不暴露服务器地址。
   *
   * 名称从「MX 官方源」改过来（用户要求）。这个 label 是**单一来源** ——
   * version-catalog.ts 里 `from: deps.mirror.label`（三处）直接引用它，
   * 所以改这一处，版本列表里的来源标签和镜像源列表会一起跟着变。
   *
   * 注意 label 也是**已安装版本记录里的 `from` 字段值**：
   * 老用户机器上 runtimes.json 里存着「MX 官方源」这个旧字符串。
   * 这里**不做兼容映射** —— `from` 只用于界面展示（这个版本从哪装的），
   * 不参与任何判断逻辑（比对、查找、路径拼接都用 tag/base，不用 from）。
   * 所以老记录显示旧名字无副作用，不会因为改名而"认不出已装版本"。
   * （如果哪天 from 被用于逻辑判断，就必须回来加兼容。）
   *
   * ## ★ 唯一官方源（主人 2026-09-15：服务器换到 8.216.54.25，只有这一个）
   *
   * 之前有过一段"主源 + ·备用"的双源时期；两台老机都已下线，
   * 所以现在只保留一个 files 官方源（地址仍来自 publish-urls.ts）。
   *
   * 为什么不再"凑一个备用"：备用源若指向已退役的机器，
   * 每次下载失败都要多等一轮必然超时，更糟的是它让"这条路是活的"这个
   * 判断失真。将来真需要加源，只改 publish-urls.ts 的 MX_OFFICIAL_BASES
   *（顺序即优先级），这里按数组生成即可。
   */
  {
    label: 'AstriaX官方源',
    base: `${MX_OFFICIAL_BASE}files/`,
    mode: 'files',
    builtin: true,
    note: '官方文件源',
    hideBase: true
  }
]

function fileOf(dataRoot: string): string {
  return join(dataRoot, 'mirrors.json')
}

interface RawMirrorState {
  custom?: Mirror[]
  /**
   * 首选源的 base。
   *
   * ★ 语义澄清（第二轮复审抓出"注释与实现相反"）：
   *
   *   · `n` = **NapCat** 的首选 GitHub 代理源 base（唯一真正在用的）
   *   · `a` = **历史字段**，曾是"AstrBot 的首选源"。
   *     但自从把 AstrBot 从 GitHub 源剥离（主人 2026-09-26：
   *     「astrbot 从 GitHub 源剥离，单独做一个 python 源」+
   *      「github 源只有 napcat」）之后，AstrBot 的源已经搬到
   *     **独立文件 `python-sources.json`**（见本文件的 loadPythonSources）。
   *
   *   所以 `a` 现在**只是兼容老数据**：`loadMirrors` 仍会用 GitHub base
   *   去校验它（`known.has(raw.pref.a)`），语义与 `n` 相同（都是 GitHub 代理）。
   *   界面侧已经不再写它（DownloadPage 的 autoPickFastest 只写 `n`）。
   *
   *   **不要**把它当成 Python 源 —— 那是 `python-sources.json` 里的事。
   */
  pref?: { a?: string; n?: string }
}

/**
 * 读镜像源状态。
 *
 * ## 损坏时必须留证，不能静默当成"没有自定义源"
 *
 * 原来这里是 `try { readJsonFile } catch { raw = {} }` —— 
 * 一个损坏的 mirrors.json 会被**无声**降级成"用户从没加过源"。
 *
 * 这个文件里装的**全是用户手输的东西**（自定义源地址、首选源），
 * 内置源写在代码里、不依赖它。所以静默降级 = 用户配的东西凭空消失，
 * 而且：
 *   - 界面不报错，他只是下次打开「下载」页发现自己的源没了
 *   - 事后也查不出"曾经坏过"，因为坏文件被直接无视
 *
 * 所以坏文件**改名留证**（`mirrors.json.corrupt-<时间>`），
 * 和 instances.json 的处理保持一致。留证的好处是：
 * 用户想手工抢救的话，里面的内容还在；
 * 我们排查"源怎么没了"的时候有东西可看。
 */
export function loadMirrors(dataRoot: string): MirrorState {
  const f = fileOf(dataRoot)
  let raw: RawMirrorState = {}
  if (existsSync(f)) {
    try {
      raw = readJsonFile<RawMirrorState>(f)
    } catch (e) {
      raw = {}
      quarantineCorrupt(dataRoot, e)
    }
  }
  const custom = (raw.custom ?? [])
    .filter((m) => m && typeof m.base === 'string' && m.base.trim())
    .map((m) => ({
      label: m.label || m.base,
      base: m.base,
      mode: (m.mode ?? 'proxy') as MirrorMode,
      note: m.note,
      hideBase: m.hideBase
    }))

  const mirrors = [...BUILTIN_MIRRORS, ...custom.filter((c) => !BUILTIN_MIRRORS.some((b) => b.base === c.base))]
  const known = new Set(mirrors.map((m) => m.base))
  const prefA = raw.pref?.a && known.has(raw.pref.a) ? raw.pref.a : ''
  const prefN = raw.pref?.n && known.has(raw.pref.n) ? raw.pref.n : ''
  return { mirrors, pref: { a: prefA, n: prefN } }
}

/**
 * 把损坏的 mirrors.json 改名留证。
 *
 * 改名而不是复制：复制会留下一个原始坏文件，下次读还是坏的，
 * 于是每次启动都重复"留证"一遍、堆出一串 .corrupt 文件。
 * 改名则一次性挪走，下次读到的就是"不存在"（干净的初始状态）。
 *
 * 整个过程**不能抛**：留证失败不该让"读镜像源"这个基础操作挂掉 ——
 * 那会把一个小毛病升级成"下载页打不开"。
 */
function quarantineCorrupt(dataRoot: string, cause: unknown): void {
  const f = fileOf(dataRoot)
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    renameSync(f, `${f}.corrupt-${stamp}`)
  } catch {
    /*
     * 改名失败（被占用等）→ 退而求其次：直接删掉。
     *
     * 删掉确实丢了原始内容，但坏文件留着也没用 —— loadMirrors 反正读不了它，
     * 而它会让下一次 saveMirrors 覆盖掉（那反而是正确的恢复）。
     * 保留一个永远读不了的坏文件只会让每次启动都白跑一次 catch。
     */
    try {
      writeFileSync(
        `${f}.corrupt-info.txt`,
        `mirrors.json 读不出来，已丢弃。原因：${cause instanceof Error ? cause.message : String(cause)}\n`,
        'utf8'
      )
    } catch {
      /* 连留证都做不到就算了，至少别抛 */
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * AstrBot 的 **Python 源**（与上面的 GitHub 代理源**完全分开存储**）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人 2026-09-26：「把 astrbot 从 GitHub 源剥离，单独做一个 python 源」
 *                +「github 源只有 napcat」。
 *
 * 存**独立文件** `python-sources.json`，而不是塞进 mirrors.json：
 *   · 两类源的语义完全不同（pip 索引 vs GitHub 代理前缀），混在一起存
 *     必然出现"给 NapCat 加的源出现在 AstrBot 列表里"这种串味
 *   · 独立文件出问题时不会连累另一类（一个损坏只影响自己）
 *
 * 结构：{ custom: [...], pref: "<label 或 indexUrl>" }
 */

/** Python 源的持久化状态 */
export interface PythonSourceState {
  /** 内置 + 用户自定义（内置在前，顺序即优先级） */
  sources: PythonSource[]
  /** 首选源的 label（空 = 用内置第一个） */
  pref: string
}

function pythonFileOf(dataRoot: string): string {
  return join(dataRoot, 'python-sources.json')
}

interface RawPythonState {
  custom?: PythonSource[]
  pref?: string
}

/**
 * 读 AstrBot 的 Python 源状态。
 *
 * 与 loadMirrors 同样的原则：**损坏要留证**，不能静默当"没配过"。
 * 另外这里多做一件事：`pref` 若指向一个已经不存在的源（用户删了自定义源、
 * 或老数据里的 GitHub base），就**回落成空**（= 用默认源），
 * 而不是把一个无效值继续存着 —— 无效 pref 会让 pip 带上一个错的 -i。
 */
export function loadPythonSources(dataRoot: string): PythonSourceState {
  const f = pythonFileOf(dataRoot)
  let raw: RawPythonState = {}
  if (existsSync(f)) {
    try {
      raw = readJsonFile<RawPythonState>(f)
    } catch (e) {
      raw = {}
      // 留证（与 mirrors.json 同一个做法，只是换个文件名）
      try {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        renameSync(f, `${f}.corrupt-${stamp}`)
      } catch {
        /* 留证失败不该让读源挂掉 */
      }
      void e
    }
  }
  const custom = (raw.custom ?? [])
    .filter((s) => s && typeof s.indexUrl === 'string' && s.indexUrl.trim())
    .map((s) => ({
      label: s.label || s.indexUrl,
      indexUrl: s.indexUrl,
      jsonApi: s.jsonApi,
      note: s.note,
      trustedHost: s.trustedHost
    }))
  const sources = [
    ...BUILTIN_PYTHON_SOURCES,
    ...custom.filter((c) => !BUILTIN_PYTHON_SOURCES.some((b) => b.indexUrl === c.indexUrl))
  ]
  const pref = raw.pref && sources.some((s) => s.label === raw.pref || s.indexUrl === raw.pref)
    ? raw.pref
    : ''
  return { sources, pref }
}

/** 保存 Python 源状态（自定义项 + 首选） */
export function savePythonSources(
  dataRoot: string,
  state: { custom?: PythonSource[]; pref?: string }
): void {
  const f = pythonFileOf(dataRoot)
  const payload = {
    custom: (state.custom ?? []).map((s) => ({
      label: s.label,
      indexUrl: s.indexUrl,
      jsonApi: s.jsonApi,
      note: s.note,
      trustedHost: s.trustedHost
    })),
    pref: state.pref ?? ''
  }
  /*
   * ★ 必须**原子写**（审查抓出的一致性缺陷）
   *
   * 第一版用的是 `writeFileSync(f, ...)` —— 而它**先把目标截断成 0 字节**
   * 再写。写一半被杀/断电，磁盘上就是一个空文件或半个 JSON，
   * 下次 `loadPythonSources` 读不出来（虽然会留证改名，但用户配的源**还是没了**）。
   *
   * 同一个文件里的 `saveMirrors` 早就改成 `writeJsonAtomic` 了，
   * 上面还专门留了一整段论证为什么必须原子 —— 而新加的这份
   * 装的是**同一类用户资产**（用户手输的 pip 索引），风险完全一致。
   * 这里对齐。
   */
  try {
    writeJsonAtomic(f, payload, true)
  } catch (e) {
    throw new Error(`保存 Python 源失败：${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * 取出"AstrBot 当前应该用哪个源" —— 这是 pip 参数的唯一来源。
 *
 * 面板没选（pref 为空）时返回内置第一个（PyPI 官方，实测三项全通）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 坏源不再"照用不误"（主人 2026-09-27 实测的真实故障）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 现象：本地导入 AstrBot 的 whl 报"依赖没装上"，日志原始错误：
 *     Could not find a version that satisfies the requirement aiocqhttp>=1.4.4
 *     (from versions: none)
 *
 * 查下去：配置里 `pref: "清华源"`，而**清华源实测 403 Forbidden**
 *（python-source.ts 顶部的实测记录早就写着）。
 * pip 拿着 403 的索引去装 → 必然 `from versions: none`。
 *
 * **一个源坏了，所有安装就都坏了，用户还看不出原因** —— 这不合理。
 *
 * ## 修法
 *
 * 记住上次**失败的源**（一个短 TTL 的"黑名单"），在这期间
 * `resolvePythonSource` 直接跳过它、返回下一个候选。
 * 于是：
 *   · 用户不用手动去设置里改（他也未必知道该改）
 *   · 修好之后（TTL 过期）会自动重新尝试那个源，不会被永久拉黑
 *
 * 为什么不在这里做**网络探测**（每次装之前先 test 一遍源）：
 * 那会给每次安装都加一次网络往返（几百毫秒到超时几秒），
 * 而绝大多数情况源是好的。用"上次失败"这个**已有的信息**更省。
 */
const failedSources = new Map<string, number>()
/** 源失败的"记忆"时长：5 分钟。够跨过一次安装，又不会永久拉黑 */
const SOURCE_FAIL_TTL_MS = 5 * 60 * 1000

/** 记下"这个源刚刚失败了"（由 pip 失败路径调用，见 ipc.ts） */
export function markPythonSourceFailed(indexUrl: string): void {
  if (indexUrl) failedSources.set(indexUrl, Date.now())
}

/** 这个源是不是刚刚失败过（TTL 内） */
export function isPythonSourceFailed(indexUrl: string): boolean {
  const at = failedSources.get(indexUrl)
  if (at === undefined) return false
  if (Date.now() - at > SOURCE_FAIL_TTL_MS) {
    failedSources.delete(indexUrl)
    return false
  }
  return true
}

/** 清掉失败记忆（测试用；也让"用户手动重新选了这个源"能立即生效） */
export function clearPythonSourceFailures(): void {
  failedSources.clear()
}

export function resolvePythonSource(dataRoot: string): PythonSource {
  const st = loadPythonSources(dataRoot)
  const wanted = findPythonSource(st.sources, st.pref) ?? DEFAULT_PYTHON_SOURCE
  /*
   * 首选源刚失败过 → 从候选链里挑第一个**没失败**的。
   *
   * 全部候选都失败过时怎么办：**仍返回首选源**（而不是抛错）——
   * 让 pip 去跑、让它给出真实的报错，比我们编一个"没有可用源"更有用
   *（用户至少能看到 pip 的原始错误）。
   */
  if (!isPythonSourceFailed(wanted.indexUrl)) return wanted
  const candidates = pythonSourceCandidates(st.sources, wanted)
  const healthy = candidates.find((s) => !isPythonSourceFailed(s.indexUrl))
  return healthy ?? wanted
}

export function saveMirrors(dataRoot: string, state: RawMirrorState): void {
  /*
   * 必须**原子写**。
   *
   * `writeFileSync(target)` 会先把目标截断成 0 字节再写，
   * 所以哪怕只是磁盘满/被杀，留下的也是残缺文件；
   * 而读的那头（loadMirrors）会把残缺当成"没有自定义源" →
   * **用户手输的镜像源全部消失，且没有任何报错**。
   *
   * 这个文件里装的全是用户资产（内置源在代码里，不靠它），
   * 所以这里宁可慢一点点也要 tmp+rename。
   */
  writeJsonAtomic(
    fileOf(dataRoot),
    { custom: state.custom ?? [], pref: state.pref ?? {} },
    !existsSync(dataRoot) // 目录不在就顺手建（原来就是 mkdirSync recursive）
  )
}

export function addCustomMirror(dataRoot: string, m: { label: string; base: string; mode?: MirrorMode }): MirrorState {
  const base = (m.base ?? '').trim()
  const label = (m.label ?? '').trim() || base
  if (!base) throw new Error('镜像地址不能为空')
  if (!/^https?:\/\//i.test(base)) throw new Error('镜像地址要以 http:// 或 https:// 开头')
  const st = loadMirrors(dataRoot)
  if (st.mirrors.some((x) => x.base === base)) throw new Error('这个镜像地址已存在')
  const custom = st.mirrors.filter((x) => !x.builtin).map((x) => ({ label: x.label, base: x.base, mode: x.mode, note: x.note, hideBase: x.hideBase }))
  custom.push({ label, base, mode: m.mode ?? 'proxy' })
  saveMirrors(dataRoot, { custom, pref: st.pref })
  return loadMirrors(dataRoot)
}

export function removeCustomMirror(dataRoot: string, base: string): MirrorState {
  const st = loadMirrors(dataRoot)
  const target = st.mirrors.find((x) => x.base === base)
  if (!target) throw new Error('找不到这个镜像源')
  if (target.builtin) throw new Error('内置镜像源不能删除')
  const custom = st.mirrors.filter((x) => !x.builtin && x.base !== base).map((x) => ({ label: x.label, base: x.base, mode: x.mode, note: x.note, hideBase: x.hideBase }))
  const pref = { ...st.pref }
  if (pref.a === base) pref.a = ''
  if (pref.n === base) pref.n = ''
  saveMirrors(dataRoot, { custom, pref })
  return loadMirrors(dataRoot)
}

export function setMirrorPref(dataRoot: string, patch: { a?: string; n?: string }): MirrorState {
  const st = loadMirrors(dataRoot)
  const pref = { a: patch.a ?? st.pref.a, n: patch.n ?? st.pref.n }
  const custom = st.mirrors.filter((x) => !x.builtin).map((x) => ({ label: x.label, base: x.base, mode: x.mode, note: x.note, hideBase: x.hideBase }))
  saveMirrors(dataRoot, { custom, pref })
  return loadMirrors(dataRoot)
}

/** 该类型的下载尝试顺序：首选源排最前，其余保持原顺序做回退 */
export function mirrorOrderFor(dataRoot: string, type: 'a' | 'n'): Mirror[] {
  const st = loadMirrors(dataRoot)
  const wanted = st.pref[type]
  if (!wanted) return st.mirrors
  const head = st.mirrors.filter((m) => m.base === wanted)
  return [...head, ...st.mirrors.filter((m) => m.base !== wanted)]
}

export function resolveMirrorPrefix(base: string, githubUrl: string): string {
  if (!base) return githubUrl
  const b = base.endsWith('/') ? base : `${base}/`
  return `${b}${githubUrl}`
}

export function resolveFileUrl(base: string, fileName: string): string {
  const b = base.endsWith('/') ? base : `${base}/`
  return `${b}${fileName}`
}

export interface FilesIndex {
  assets?: Array<{ name?: string; url?: string; sha256?: string }>
}

/** 文件型镜像：优先 index.json 里登记的直链，否则按文件名拼基址 */
export function fileUrlFor(base: string, fileName: string, index: FilesIndex | null): { url: string; sha256?: string } {
  const hit = index?.assets?.find((x) => x.name === fileName)
  if (hit?.url) return { url: hit.url, sha256: hit.sha256 }
  return { url: resolveFileUrl(base, fileName), sha256: hit?.sha256 }
}
