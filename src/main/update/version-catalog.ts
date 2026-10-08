import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { readJsonFile } from '../util/json-file'
import { loadMirrors, resolveFileUrl, type Mirror } from './mirror-store'
import { TEMPLATE_SOURCES } from './template-source'

export interface VersionItem {
  tag: string
  /** 资产名：GitHub 源=官方资产名；文件源=源上的相对路径 */
  assetName: string
  /** 下载直链（GitHub 源=github.com 直链；文件源=源基址+相对路径） */
  assetUrl: string
  sha256?: string
  sizeMB?: number
  publishedAt?: string
  prerelease?: boolean
  /** 来自哪个镜像源（UI 展示用） */
  from: string
  /** 该版本所在源的 base（下载时定位用） */
  base: string
  /** 分发方式：zip=下载解压；pypi=用内置 Python 的 pip 安装 */
  kind?: 'zip' | 'pypi'
}

/**
 * AstrBot 列版本用的元数据接口。
 *
 * ## ★ 为什么这里是**写死的 PyPI 官方**（而不是跟随用户选的源）
 *
 * 实测（scripts/test-python-sources.py，2026-09-26）：
 *   · 清华 TUNA  索引 403；`/pypi/{pkg}/json` 403
 *   · 阿里云     索引 SSL 超时；`/pypi/{pkg}/json` **404**
 *   · 腾讯云     索引 200；`/pypi/{pkg}/json` **404**
 *   · PyPI 官方  索引 200；元数据 200（astrbot 最新 4.28.1，168 个版本）
 *
 * 也就是说**国内镜像根本没有 `/pypi/{pkg}/json` 这个接口** —— 那是我
 * 照 PyPI 的路径猜出来的。所以"列版本"这件事**只有 PyPI 官方能做**，
 * 与用户选的"安装源"是两件事：
 *   · **装**（pip install）→ 用用户选的源（可能是腾讯云加速）
 *   · **列**（有哪些版本）→ 固定问 PyPI 官方
 *
 * 这也是 `python-source.ts` 里 `metadataSourceFor` 的同一套逻辑；
 * 那个函数目前是未被接线的抽象（第一轮审查点名过），这里保持直白写死，
 * 避免再引一层"定义了但没人调用"的间接。
 *
 * ## PYPI_INDEX_URLS 已删除
 *
 * 原来这里还躺着一个 `PYPI_INDEX_URLS` 数组（pypi/tuna/aliyun），
 * **全项目零引用**，且内容与实测结论相矛盾（tuna 那时已 403）——
 * 留着只会误导下一个人。要改安装源请去 `update/python-source.ts`。
 */
export const PYPI_ASTRBOT_JSON = 'https://pypi.org/pypi/astrbot/json'

/**
 * 可用版本列表的磁盘缓存。
 *
 * 用户报告：「为什么很多地方都不做持久化保存？比如已经获取的文件包列表，
 * 每次打开都要重新获取」。
 *
 * 原来每进一次下载页/每点一个镜像源，都要把 GitHub + 各个代理 + 服务器源
 * 全打一遍网络（每个源超时 15 秒）。网络慢的时候界面就是转圈，用户感觉
 * 像卡死。版本列表这种东西**几分钟内不会变**，缓存起来完全够用。
 *
 * 规则（按用户要求）：
 *   - 启动时静默预热一次（在后台，不挡界面）
 *   - 有缓存就直接用，先给用户看
 *   - 出现**更新操作**（下载完成、删除版本）时主动失效，下次拿到的是新的
 */
const VERSION_CACHE_FILE = 'versions-cache.json'
/** 缓存多久算过期（毫秒）。15 分钟：够快，也不会让用户看到太旧的列表。 */
export const VERSION_CACHE_TTL_MS = 15 * 60 * 1000

interface VersionCacheEntry {
  /** 缓存键：`${type}|${base ?? '*'}` */
  key: string
  at: number
  items: VersionItem[]
}
interface VersionCacheFile {
  entries: VersionCacheEntry[]
}

function versionCachePath(dataRoot: string): string {
  return join(dataRoot, 'cache', VERSION_CACHE_FILE)
}

function readVersionCache(dataRoot: string): VersionCacheFile {
  try {
    const f = versionCachePath(dataRoot)
    if (!existsSync(f)) return { entries: [] }
    const j = readJsonFile<VersionCacheFile>(f)
    return { entries: Array.isArray(j.entries) ? j.entries : [] }
  } catch {
    // 缓存坏了就当没有 —— 它只是加速用的，绝不能因为它读不出来就报错
    return { entries: [] }
  }
}

/** 取缓存（过期或不匹配返回 undefined）。freshOnly=false 时忽略过期时间。 */
export function readCachedVersions(
  dataRoot: string,
  type: 'a' | 'n',
  base: string | undefined,
  opts: { freshOnly?: boolean; now?: number } = {}
): VersionItem[] | undefined {
  const key = `${type}|${base ?? '*'}`
  const hit = readVersionCache(dataRoot).entries.find((e) => e.key === key)
  if (!hit || !Array.isArray(hit.items)) return undefined
  if (opts.freshOnly !== false) {
    const age = (opts.now ?? Date.now()) - hit.at
    if (age > VERSION_CACHE_TTL_MS) return undefined
  }
  return hit.items
}

/** 写缓存（合并已有的其它键）。写失败静默——缓存不该影响主流程。 */
export function writeCachedVersions(
  dataRoot: string,
  type: 'a' | 'n',
  base: string | undefined,
  items: VersionItem[]
): void {
  try {
    const key = `${type}|${base ?? '*'}`
    const cur = readVersionCache(dataRoot)
    const next: VersionCacheFile = {
      entries: [...cur.entries.filter((e) => e.key !== key), { key, at: Date.now(), items }]
    }
    mkdirSync(join(dataRoot, 'cache'), { recursive: true })
    writeFileSync(versionCachePath(dataRoot), JSON.stringify(next), 'utf8')
  } catch {
    /* 缓存写不进去不影响功能 */
  }
}

/**
 * 让缓存失效。
 *
 * 在**更新操作**之后调用：装完一个版本、删掉一个版本。
 * 这样下次读到的就是重新拉过的列表，而不是「已经装过了却还显示下载按钮」
 * 这种对不上的状态。
 */
export function invalidateVersionCache(dataRoot: string): void {
  try {
    rmSync(versionCachePath(dataRoot), { force: true })
  } catch {
    /* 删不掉也无所谓，TTL 到期自然会重取 */
  }
}

async function defaultFetchJson(url: string): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()
  } finally {
    clearTimeout(t)
  }
}

interface GhRelease {
  tag_name?: string
  name?: string
  prerelease?: boolean
  published_at?: string
  assets?: Array<{ name?: string; browser_download_url?: string; digest?: string; size?: number }>
}

interface FilesManifest {
  astrbot?: Array<{ tag?: string; asset?: string; sha256?: string; size?: number; added?: string }>
  napcat?: Array<{ tag?: string; asset?: string; sha256?: string; size?: number; added?: string }>
}

const mb = (bytes?: number): number | undefined => (bytes ? Math.round((bytes / 1048576) * 10) / 10 : undefined)

/** 代理型源：GitHub releases 列表 */
async function fromProxySource(deps: {
  mirror: Mirror
  type: 'a' | 'n'
  fetchJson: (url: string) => Promise<string>
  includePrerelease?: boolean
}): Promise<VersionItem[]> {
  const repo = TEMPLATE_SOURCES[deps.type].repo
  const filter = TEMPLATE_SOURCES[deps.type].assetFilter
  const api = 'https://api.github.com/'
  const url = deps.mirror.base ? `${deps.mirror.base}${api}repos/${repo}/releases?per_page=30` : `${api}repos/${repo}/releases?per_page=30`
  const raw = await deps.fetchJson(url)
  const list = JSON.parse(raw) as GhRelease[]
  const out: VersionItem[] = []
  for (const rel of list) {
    if (!rel.tag_name) continue
    if (rel.prerelease && !deps.includePrerelease) continue
    const asset = (rel.assets ?? []).find((a) => a.name && filter(a.name))
    if (!asset?.browser_download_url) continue
    out.push({
      tag: rel.tag_name,
      assetName: asset.name!,
      assetUrl: asset.browser_download_url,
      sha256: asset.digest?.replace(/^sha256:/, ''),
      sizeMB: mb(asset.size),
      publishedAt: rel.published_at,
      prerelease: rel.prerelease,
      from: deps.mirror.label,
      base: deps.mirror.base
    })
  }
  return out
}

/** 文件型源：读源上的 versions.json（由源主人上架时写好；启动器只读） */
async function fromFilesSource(deps: {
  mirror: Mirror
  type: 'a' | 'n'
  fetchJson: (url: string) => Promise<string>
}): Promise<VersionItem[]> {
  const base = deps.mirror.base.endsWith('/') ? deps.mirror.base : `${deps.mirror.base}/`
  let manifest: FilesManifest
  try {
    manifest = JSON.parse(await deps.fetchJson(`${base}versions.json`)) as FilesManifest
  } catch {
    return [] // 该源没上架/没清单：不报错，视作无版本
  }
  const rows = (deps.type === 'a' ? manifest.astrbot : manifest.napcat) ?? []
  /*
   * ★ 用 `flatMap` 而不是 `map`（我第一版用 map 返回 undefined，类型炸了）
   *
   * 原因：PyPI 指路记录会**展开成多条**（PyPI 上的每个版本一条），
   * 而取不到版本时要**整条丢掉**（返回空数组）。
   * `map` 做不到这两件事 —— 它只能一对一，且"丢掉"只能返回 undefined
   *（那会让结果里混进 undefined，类型检查当场报错）。
   */
  const mapped = await Promise.all(
    rows
      .filter((r) => r?.tag && r?.asset)
      .map(async (r): Promise<VersionItem[]> => {
      /*
       * `pypi:<包名>` 是发布侧（scripts/publish-runtime.py 的 PYPI_HINT）定下的约定：
       * 这条只是「告诉启动器 AstrBot 走 PyPI」，**服务器上并没有这个文件**。
       *
       * 必须在这里认出来并标 kind=pypi：
       *  - 不标 → ipc.ts 的 runtime:install 会落到 zip 分支，去下载
       *    `.../pypi:astrbot` 这个不存在的地址，必然 404；
       *  - 标了 → 走 pip install 分支，正是服务器想表达的安装方式。
       * 同时不该给它拼下载直链（拼出来的地址没有意义，还会误导 UI）。
       */
      const isPypi = typeof r.asset === 'string' && r.asset.startsWith('pypi:')
      if (isPypi) {
        /*
         * ══════════════════════════════════════════════════════════════════════
         * ★★ 指路记录**不能**原样当版本条目用（主人 2026-09-27 踩到的真 bug）
         * ══════════════════════════════════════════════════════════════════════
         *
         * 服务器上那条记录是：
         *     { "tag": "pypi", "asset": "pypi:astrbot", "note": "由 PyPI 直接安装" }
         * 第一版这里写的是 `tag: r.tag!` —— 也就是把 **"pypi" 当成了版本号**。
         * 于是用户点它的「下载」时：
         *     pip install astrbot==pypi
         *     → ERROR: Invalid requirement: 'astrbot==pypi'
         *（主人实测报错原文就是这句）
         *
         * ## 现在怎么做
         *
         * 这条记录的真实含义是「**AstrBot 去 PyPI 装**」，不是一个版本。
         * 所以把它**展开成 PyPI 上的可用版本列表**：
         *   · 列表里显示的是真实版本号（v4.28.1、v4.28.0…），点哪个装哪个
         *   · 每个都标 `kind: 'pypi'`，装的时候走 pip
         *   · 全部来自 PyPI —— 这正是服务器那条记录想表达的
         */
        let pypiVersions: VersionItem[] = []
        try {
          pypiVersions = await listAstrbotPypiVersions({ fetchJson: deps.fetchJson })
        } catch {
          pypiVersions = []
        }
        /*
         * PyPI 不通时**整条丢掉**（返回空数组）。
         *
         * 绝不能留一个 `tag: 'pypi'` 的条目 —— 那会让用户点到一个
         * 必然报 `Invalid requirement` 的按钮，比"这个源没版本"糟得多。
         */
        return pypiVersions.map((v) => ({
          tag: v.tag,
          /* 保留来源标记：让界面/日志能看出"这条是从官方源的 PyPI 指路记录展开的" */
          assetName: 'pypi:astrbot',
          assetUrl: '', // 没有可下载的文件 —— 走 pip
          sha256: r.sha256,
          sizeMB: v.sizeMB,
          publishedAt: v.publishedAt ?? r.added,
          from: deps.mirror.label,
          base: deps.mirror.base,
          kind: 'pypi' as const
        }))
      }
      return [
        {
          tag: r.tag!,
          assetName: r.asset!,
          // 文件源：相对路径拼在源基址后；downloadRuntime 走 files 分支时也是这个规则
          assetUrl: resolveFileUrl(deps.mirror.base, r.asset!),
          sha256: r.sha256,
          sizeMB: mb(r.size),
          publishedAt: r.added,
          from: deps.mirror.label,
          base: deps.mirror.base
        }
      ]
      })
  )
  return mapped.flat()
}

/** 从 PyPI 读 AstrBot 全版本（官方分发方式；含预发布，不做过滤） */
export async function listAstrbotPypiVersions(deps: {
  fetchJson?: (url: string) => Promise<string>
  includePrerelease?: boolean
} = {}): Promise<VersionItem[]> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson
  const raw = JSON.parse(await fetchJson(PYPI_ASTRBOT_JSON)) as {
    releases?: Record<
      string,
      Array<{ filename?: string; url?: string; size?: number; upload_time_iso_8601?: string; digests?: { sha256?: string } }>
    >
  }
  const out: VersionItem[] = []
  for (const [ver, files] of Object.entries(raw.releases ?? {})) {
    const file = (files ?? []).find((f) => f.filename && f.url)
    if (!file?.url) continue
    const pre = /[a-zA-Z]/.test(ver)
    if (pre && deps.includePrerelease === false) continue
    out.push({
      tag: ver.startsWith('v') ? ver : `v${ver}`,
      assetName: file.filename!,
      assetUrl: file.url,
      sha256: file.digests?.sha256,
      sizeMB: mb(file.size),
      publishedAt: file.upload_time_iso_8601,
      prerelease: pre,
      from: 'PyPI 官方',
      base: 'pypi',
      kind: 'pypi'
    })
  }
  return out.sort((x, y) => cmpVersion(y.tag, x.tag))
}

/**
 * 版本探测：逐个镜像源问「你有哪些版本」，合并去重后按版本号倒序返回。
 * - onlyBase 指定：只探这一个源
 * - 不指定：探所有源（用户首选源优先），同 tag 先命中的来源胜出
 * 服务器侧不需要跑任何服务，启动器直接读它上面的 versions.json / GitHub API。
 *
 * 结果会写进磁盘缓存（见本文件顶部的说明），所以重复进页面不会再打一遍网络。
 */
export async function listVersions(deps: {
  dataRoot: string
  type: 'a' | 'n'
  onlyBase?: string
  includePrerelease?: boolean
  fetchJson?: (url: string) => Promise<string>
  maxSources?: number
  /** true=跳过缓存，强制走网络（用户点「刷新」时用） */
  noCache?: boolean
  /** 测试注入：拿当前时间判断缓存是否过期 */
  now?: number
}): Promise<VersionItem[]> {
  /*
   * 先看缓存。**只在没有注入 fetchJson 时走缓存** ——
   * 测试注入 fetchJson 就是要检验解析逻辑，被缓存短路就测了个寂寞。
   */
  if (!deps.noCache && !deps.fetchJson) {
    const hit = readCachedVersions(deps.dataRoot, deps.type, deps.onlyBase, { now: deps.now })
    if (hit && hit.length > 0) return hit
  }

  const fetchJson = deps.fetchJson ?? defaultFetchJson
  const st = loadMirrors(deps.dataRoot)
  const pref = st.pref[deps.type]
  let sources = st.mirrors
  /*
   * ★★ 空串 `''` **不算"显式指定源"**（主人 2026-09-27 实测的空白列表 bug）
   *
   * ## 现象
   *
   * 下载页点「Python源」或「腾讯源」的下载 → 弹窗显示
   *     「这个源上没读到版本呢」
   * 而 AstrBot 明明有 168 个版本。
   *
   * ## 根因
   *
   * 界面对 Python 源传 `base: ''`（**故意的** —— AstrBot 的版本要从
   * PyPI 元数据读，不能拿 pip 索引地址当 base，否则会去请求
   * `https://pypi.org/simple/versions.json` 那个不存在的地址）。
   *
   * 而这里原来写的是 `deps.onlyBase !== undefined` —— **空串也满足**，
   * 于是走进"只探这一个源"分支：
   *     sources.filter((m) => m.base === '')
   * 内置源里 base 为 `''` 的只有 `GitHub 直连`，而它是 **proxy** 模式；
   * 紧接着 AstrBot 那步会 `filter(m => m.mode === 'files')` → **空数组**
   * → `anyFromAstrBotCapableSource === false` → 不并 PyPI → 列表空白。
   *
   * ## 修法
   *
   * 空串与 undefined 同义（都表示"没指定具体源"）。
   * 这同时也符合界面的意图：传空串正是为了"别按这个源过滤"。
   */
  const explicit = deps.onlyBase !== undefined && deps.onlyBase !== ''
  if (explicit) sources = sources.filter((m) => m.base === deps.onlyBase)

  /*
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ 按类型**过滤源** —— AstrBot 与 NapCat 走完全不同的来源
   *   （主人 2026-09-27 明确要求）
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 主人原话：
   *   「你为啥不直接在下载页分类，NapCat 下载，下面是 github 源和官方源，
   *     AstrBot 下载，下面是 python 源和官方源」
   *   「为什么 github 源打开还是有 astrbot」
   *   「官方源的 astrbot 为什么也是 PyPI 的」
   *
   * 之前的问题是**根本没分类**：`st.mirrors` 是"GitHub 代理源 + 官方文件源"
   * 的混合列表，给 AstrBot 列版本时也会把 GitHub 代理挨个试一遍 ——
   * 而那些代理对 AstrBot **毫无意义**（它的后端只在 PyPI）：
   *   · 界面上的"GitHub 源"里会出现 AstrBot（用户看到的困惑）
   *   · 每个代理都要等一次超时（15 秒 × N）→ 列表慢
   *
   * 现在的分工（与界面的两个分区一一对应）：
   *
   *   ┌──────────┬─────────────────────────────┬──────────────────────────┐
   *   │ 类型     │ 版本从哪来（列）             │ 装的时候用哪              │
   *   ├──────────┼─────────────────────────────┼──────────────────────────┤
   *   │ AstrBot  │ **PyPI（Python 源）**        │ pip（用户选的 Python 源） │
   *   │ NapCat   │ **GitHub 源**（代理/直连）   │ 下载 zip                  │
   *   └──────────┴─────────────────────────────┴──────────────────────────┘
   *
   * **官方源两边都出现**（`mode: 'files'`，`/mxbot/files/versions.json`）：
   * 它是一份**我们自己上架的清单**，里面 astrbot / napcat 两段分开写
   *（见服务器上的 versions.json），所以两类都能从它列出版本 ——
   * 这正是主人要的"官方源在两边都在"。
   *
   * ## 关于"官方源的 AstrBot 为什么也是 PyPI 的"
   *
   * 因为**AstrBot 的后端只有 PyPI 这一个渠道**（实测：GitHub release 只发
   * dashboard.zip，5.75MB 的前端 dist，没有后端）。所以官方源的 versions.json 里
   * 那条 AstrBot 记的是 `asset: "pypi:astrbot"` ——
   * **它是一条"指路"记录，不是一个可下载的文件**。
   * 界面据此标成 `kind: 'pypi'`，点击时走 pip 安装，而不是下载 zip。
   * 这不是 bug，是 AstrBot 的分发现实；但它**不该出现在 GitHub 源那一栏**
   *（那才是真正让用户困惑的地方，现在过滤掉了）。
   */
  if (deps.type === 'a') {
    // AstrBot：只保留官方文件源 —— GitHub 代理对它没有意义
    sources = sources.filter((m) => m.mode === 'files')
  } else {
    // NapCat：只保留 GitHub 系（proxy）与官方文件源
    //（官方源的 napcat 段是真的可下载文件，见 versions.json）
    sources = sources.filter((m) => m.mode === 'proxy' || m.mode === 'files')
  }
  if (pref) sources = [...sources.filter((m) => m.base === pref), ...sources.filter((m) => m.base !== pref)]
  if (deps.maxSources) sources = sources.slice(0, deps.maxSources)

  const merged = new Map<string, VersionItem>()
  /*
   * AstrBot 的 pyPI 版本始终参与合并 —— 不是"额外补充"，而是它的**唯一渠道**。
   *
   * 实测（2026-09-13，经服务器查证）：官方 GitHub release 六个版本
   * （v4.27.3 ~ v4.28.0）**全都只发 dashboard.zip**（5.75MB，只有前端 dist/），
   * 后端只在 PyPI：astrbot-4.28.0-py3-none-any.whl（7.396MB）。
   * 所以从镜像源那边根本列不出可用的 AstrBot。
   *
   * 原来只在「没指定 base」时才查 PyPI，导致用户点某个源看 AstrBot 时列表**空白** ——
   * 界面一片空，而用户要的版本其实在 PyPI 上好好躺着。
   * 现在无论指定哪个源都带上 PyPI（只有明确要别的源时才不用它的元数据，
   * 但版本条目本身必须保留，否则等于告诉用户"没有 AstrBot 可装"）。
   *
   * ══════════════════════════════════════════════════════════════════════════
   * ★★ 判据不是"有没有指定源"，而是"**这个源上有没有 AstrBot 的发布**"
   * ══════════════════════════════════════════════════════════════════════════
   *
   * 主人 2026-09-27 的两个实测质疑：
   *   「官方源也是高达几十个版本，你真的塞了这么多版本在我的服务器上吗」
   *   「github 源打开还是有 astrbot」
   *
   * 而 integration 的 full-chain 又钉住了另一条（同样重要）：
   *   「点**官方源**要能拿到**可安装**的 AstrBot 条目」
   *（服务器那条 `pypi:astrbot` 只是"指路"，真能装的是 PyPI 的 wheel）
   *
   * 两类源的正确行为**不一样**，所以不能一刀切：
   *
   *   · **官方源**（`mode: 'files'`）：它的 `versions.json` 里
   *     **有 astrbot 段**（哪怕只有一条 pypi 指路）→ 说明"这个源确实
   *     发布/指路 AstrBot" → **并上 PyPI 的真实版本**，
   *     让用户拿到能装的东西。
   *
   *   · **GitHub 代理**（`mode: 'proxy'`）：它上面**根本没有 AstrBot**
   *     （只有前端 dashboard.zip，被过滤掉了）→ **不并**。
   *     这正是"github 源打开还是有 astrbot"的根治。
   *
   * 判据落在"这个源的清单里有没有 astrbot 段"——
   * `fromFilesSource` 已经把有 astrbot 段的源解析出来了，
   * 所以看 `merged` 里有没有**来自这个源的 astrbot 条目**即可。
   *
   * ## 特例：`onlyBase === 'pypi'`
   *
   * 这是**虚拟源**（PyPI 条目的 `base` 就是 'pypi'，见 METADATA_SOURCE），
   * `st.mirrors` 里并没有它 —— 所以 `sources` 会被上面那句
   * `filter(m => m.base === onlyBase)` 过滤成**空数组**。
   * 这时"有没有 files 源"当然是 false，但用户/测试的意图恰恰是
   * **"我就要 PyPI 的版本"** → 必须列。
   *
   * integration 的 full-chain 第 3 条就钉着这个：
   *     listVersions({ type: 'a', onlyBase: 'pypi' })
   * 它要拿这个列表去核对"服务器说的 tag 在 PyPI 上真的存在"。
   */
  const asksPypiOnly = deps.onlyBase === 'pypi'
  const anyFromAstrBotCapableSource = sources.some((m) => m.mode === 'files')
  if (deps.type === 'a' && (asksPypiOnly || anyFromAstrBotCapableSource)) {
    try {
      for (const it of await listAstrbotPypiVersions({ fetchJson })) {
        /*
         * ★ 用"同 tag 就覆盖"而不是"已有就不加"。
         *
         * 因为服务器那条指路条目的 `assetName` 是 `pypi:astrbot`
         *（没有可下载的包体），而 PyPI 那条是真正的 `.whl`。
         * 保留前者的话，用户看到的就是一条**点了装不上**的条目 ——
         * 那正是主人踩到的 `astrbot==pypi` 报错的近亲。
         */
        merged.set(it.tag, it)
      }
    } catch {
      /* PyPI 不通就只列镜像源的条目（那时代理源那边也不会有可用的 AstrBot） */
    }
  }

  /*
   * ★ 各源**并行**探测（拿主人机器的日志换来的）
   *
   * 原来是一个源一个 await：总耗时 = 所有源之和。而每个源都有 15 秒超时，
   * 内置的 GitHub 代理在国内基本都不通 —— 于是"探测 4 个源"正常也要十几秒。
   * 日志原始记录（E:\MXBot\...\app-2026-09-15.log）：
   *     [ERROR] [perf] IPC versions:list 耗时 20926ms（严重）
   *     [ERROR] [perf] IPC versions:list 耗时 21584ms（严重）
   * 而主进程是单线程的：它卡这十几秒时，用户点的"下载"只能排队 ——
   * 这就是"NapCat/AstrBot 都下载失败"的上游原因之一。
   *
   * 这些源之间**没有任何依赖**（各拉各的清单，最后合并去重），
   * 并行之后总耗时 = 最慢那一个，而不是相加。
   *
   * 仍然**按顺序合并**（Promise.all 保持入参顺序）：这样"优先级高的源
   * 先写进 merged"这条既有语义不变（`if (!merged.has(tag))` 决定用谁的）。
   */
  const probed = await Promise.all(
    sources.map(async (m) => {
      try {
        return m.mode === 'files'
          ? await fromFilesSource({ mirror: m, type: deps.type, fetchJson })
          // 版本列表不过滤测试版：全都列出来，由用户自己决定装不装
          : await fromProxySource({ mirror: m, type: deps.type, fetchJson, includePrerelease: true })
      } catch {
        return [] as VersionItem[] // 这个源不通 → 当它没有版本，继续下一个
      }
    })
  )
  for (const items of probed) {
    for (const it of items) {
      if (!merged.has(it.tag)) merged.set(it.tag, it)
    }
  }

  const out = [...merged.values()].sort((x, y) => cmpVersion(y.tag, x.tag))
  /*
   * 拉到了就写缓存，下次进页面直接给用户看，不用再等网络
   * （用户报告：「已经获取的文件包列表，每次打开都要重新获取」）。
   *
   * 只在**真的拿到东西**时写：空列表多半是网络不通，
   * 把它缓存下来会让用户在一段时间里都看到「没有可装的版本」。
   */
  if (out.length > 0) writeCachedVersions(deps.dataRoot, deps.type, deps.onlyBase, out)
  return out
}

/** 版本号比较（v4.10.0 > v4.9.9） */
export function cmpVersion(x: string, y: string): number {
  const norm = (s: string): number[] =>
    s
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .map((p) => Number.parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0))
  const a = norm(x)
  const b = norm(y)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
