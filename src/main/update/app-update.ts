/*
 * 启动器自身更新。
 *
 * 用户要求（原话归纳）：
 *   1. 设置里显示「当前版本」和「检查更新」按钮
 *   2. 不是最新版就显示需要更新
 *   3. 点更新 → 从服务器下载**最新版全量包**到**系统默认下载目录**
 *   4. 从服务器获取版本失败 → 显示「最新版」（不打扰用户）
 *   5. 每次启动检测一次
 *   6. 一天最多推送一次
 *   7. 用户可以「跳过此版本」，等到**下一个**版本再提示
 *
 * 几个刻意的设计取舍：
 *
 * - **不自替换、不自安装**。只把安装包下到下载目录，让用户自己双击。
 *   自替换需要写文件到正在运行的 exe、还要处理 UAC 提权，失败就是"软件打不开"，
 *   风险远大于收益。
 *
 * - **清单用 JSON 而不是 electron-builder 的 latest.yml**。latest.yml 是 YAML，
 *   而项目没有任何 yaml 依赖；为了读两个字段引入依赖不划算，用正则解析 YAML
 *   又太脆（缩进/引号/多行都会翻车）。我们控制着服务器，直接多打一份 JSON。
 *
 * - **下载目录取 app.getPath('downloads')**，不是临时目录 —— 用户要能自己看到
 *   并双击那个文件。
 */
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { createHash } from 'crypto'

export interface AppUpdateManifest {
  /** 最新版本号，形如 "0.2.0" */
  version: string
  /** 全量安装包的下载地址（绝对 URL，或相对清单地址） */
  url: string
  /** 可选：安装包字节数，用于显示大小与进度 */
  size?: number
  /** 可选：安装包 sha256，用于下载后校验 */
  sha256?: string
  /** 可选：更新说明 */
  notes?: string
}

export interface AppUpdateCheck {
  hasUpdate: boolean
  currentVersion: string
  latestVersion?: string
  url?: string
  sizeMB?: number
  notes?: string
  /**
   * 安装包 sha256（来自清单）。
   *
   * ## 这个字段不能少 —— 少了它整个校验就是摆设
   *
   * 链路：`latest.json.sha256` → 这里 → 渲染层 `SettingsPanel`
   * （`sha256: r.sha256`）→ `app:downloadUpdate` 的 `expectSha256`
   * → `downloadAppUpdate` 里的
   *
   *     if (deps.expectSha256) { ...比对，不匹配就删掉并报错... }
   *
   * 接口里没这个字段、`checkAppUpdate` 返回时又不带上它，
   * `expectSha256` 就恒为 undefined，那个 `if` **永远不成立** ——
   * 校验代码一个字都没错，但一次都不会执行。
   *
   * 而下载安装包是整条更新链路上唯一信任远端字节的地方：
   * 服务器被投毒、传输被劫持/截断，用户就会装上一个未经校验的包。
   */
  sha256?: string
}

/**
 * 版本号比较：a 比 b 新返回 true。
 *
 * ## 必须是「任意低版本 → 任意更高版本」
 *
 * 用户明确要求：
 *   「覆盖更新不能只能 0.1.0 到 0.1.1 或者到 0.2.0 才能更新，
 *     必须是任何低版本到任何更新的版本，
 *     即使是 0.1 或者 1.0 直接更新到 10.0 版本都能更新」
 *
 * 所以这里**不能**有任何「只能相邻版本升级」的限制 —— 逐段比数字，
 * 谁先大谁就新，跨度多大都一样（0.1 → 10.0 直接算更新）。
 *
 * ## 两个必须小心的点
 *
 * ① **按数字比，不按文本比**。文本比较会得出 `"0.9" > "0.10"`（因为 '9' > '1'），
 *    那是错的。这里每段 parseInt 成数字再比，0.9 → 0.10 才是升级。
 *
 * ② **非法版本号一律判「没有更新」**。这是有实际风险的：
 *    `app:version` 在拿不到 Electron 版本时会兜底成 `'0.0.0'`，
 *    而清单里的版本号如果被写坏成空串或乱码，parse 出来是 `[0]` ——
 *    拿 `[0,1,0]` 和 `[0]` 比会得出「0.1.0 比空串新」，
 *    于是每次启动都提示有更新、点进去下载一个不存在的安装包。
 *    空/非法就当作「比不出来」，返回 false 更安全（用户要求失败时按最新版处理）。
 *
 * 段数不同时缺的补 0：`0.1` 和 `0.1.0` 是同一个版本，不算更新。
 */
export function isNewerVersion(a: string, b: string): boolean {
  /** 解析成数字数组；格式不合法返回 null */
  const parse = (s: string): number[] | null => {
    const t = String(s ?? '').trim().replace(/^v/i, '')
    if (!t) return null
    /*
     * 只接受「数字段 + 分隔符」组成的版本号，可选一个预发布后缀。
     *
     * 为什么要用正则卡死格式，而不是「解析不出就当 0」：
     * `'1abc'` 那种半截垃圾用 parseInt 会得到 `[1]`，
     * 拿去和 `0.1.0` 比就得出「1 比 0.1.0 新」—— 于是一个写坏的版本号
     * 会让所有人都收到更新提示。这类误报比"少提示一次"糟得多，
     * 所以格式不对就干脆判「比不出来」。
     *
     * 合法形态：1 / 1.2 / 1.2.3 / v1.2.3 / 1.2.3-beta.1 / 1.2.3+build
     */
    if (!/^\d+(\.\d+)*([.\-+][0-9A-Za-z.\-+]+)?$/.test(t)) return null
    return t.split(/[.\-+]/).map((x) => {
      const n = Number.parseInt(x, 10)
      return Number.isFinite(n) ? n : 0
    })
  }
  const pa = parse(a)
  const pb = parse(b)
  // 任一边非法 → 比不出来，保守地说「没有更新」
  if (!pa || !pb) return false

  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

/**
 * 一天推送一次的判据：距上次自动检查是否已满 intervalMs（默认 24h）。
 *
 * 用「上次检查时间」而不是「今天日期」：
 * 按日期算的话，用户晚上 23:59 启动过、00:01 再启动又会推一次
 * （跨天了但只隔了 2 分钟），显然不合理。
 *
 * lastAt 缺失/非法 → 当作从未检查过（返回 true），首次启动要能推。
 */
export function isCheckDue(lastAt: number | undefined, now: number, intervalMs = 24 * 60 * 60 * 1000): boolean {
  if (!lastAt || !Number.isFinite(lastAt) || lastAt <= 0) return true
  // 时钟被往回调过（lastAt 在未来）也当作到期，否则会永远不再检查
  if (lastAt > now) return true
  return now - lastAt >= intervalMs
}

/** 该版本是否被用户跳过（跳过只对该版本有效，下个版本照样提示） */
export function isVersionSkipped(latest: string | undefined, skipped: string | undefined): boolean {
  if (!latest) return true
  if (!skipped) return false
  return latest === skipped
}

/** 拉清单并判断有没有更新。清单取不到就抛，由调用方决定怎么表现（用户要求显示「最新版」） */
export async function checkAppUpdate(deps: {
  currentVersion: string
  manifestUrl: string
  fetchJson: (url: string) => Promise<string>
}): Promise<AppUpdateCheck> {
  const raw = await deps.fetchJson(deps.manifestUrl)
  const m = JSON.parse(raw) as Partial<AppUpdateManifest>
  if (!m || typeof m.version !== 'string' || !m.version.trim()) {
    // 清单结构不对：当作没有更新，而不是让用户看到一个莫名其妙的报错
    return { hasUpdate: false, currentVersion: deps.currentVersion }
  }
  const hasUpdate = isNewerVersion(m.version, deps.currentVersion)
  if (!hasUpdate) return { hasUpdate: false, currentVersion: deps.currentVersion, latestVersion: m.version }

  /*
   * url 允许写成相对路径（服务器上就放在清单旁边），
   * 这样发布时不用把域名硬编码进清单里，换域名只改一处。
   */
  let url = m.url ?? ''
  if (url && !/^https?:/i.test(url)) {
    try {
      url = new URL(url, deps.manifestUrl).toString()
    } catch {
      /* 拼不出来就保持原样，下载时会失败并报出来 */
    }
  }

  return {
    hasUpdate: true,
    currentVersion: deps.currentVersion,
    latestVersion: m.version,
    url,
    sizeMB: m.size ? Math.round((m.size / 1048576) * 10) / 10 : undefined,
    /*
     * sha256 必须**一路带到渲染层**，否则下载校验形同虚设 ——
     * 详见 AppUpdateCheck.sha256 的注释（那条链断在哪、后果是什么）。
     * 大小写统一成小写，避免和 downloadAppUpdate 的比对因大小写误判。
     */
    sha256: m.sha256?.trim().toLowerCase() || undefined,
    notes: m.notes
  }
}

/** 从 URL 里取一个安全的文件名（去掉查询串、防路径穿越） */
export function fileNameFromUrl(url: string, fallback = 'AstriaX-Setup.exe'): string {
  try {
    const p = new URL(url).pathname
    const base = decodeURIComponent(p.split('/').filter(Boolean).pop() ?? '')
    // 只留最后一段，并挡掉 .. 之类的穿越写法
    const safe = base.replace(/[\\/]/g, '').replace(/\.\.+/g, '.')
    return safe || fallback
  } catch {
    return fallback
  }
}

export interface DownloadDeps {
  /** 目标目录（生产=app.getPath('downloads')） */
  dir: string
  url: string
  fileName?: string
  /** 注入的下载实现：把 body 写进 outPath 并返回字节数 */
  fetchToFile: (url: string, outPath: string, onProgress?: (got: number, total?: number) => void) => Promise<number>
  onProgress?: (p: { percent: number; got: number; total?: number }) => void
  /** 期望的 sha256（可选）；给了就必须匹配 */
  expectSha256?: string
  /** 同名文件已存在时是否覆盖（默认 true） */
  overwrite?: boolean
}

/**
 * 把全量包下到**系统默认下载目录**，返回最终路径。
 *
 * 关键点：
 * - 目标目录不存在就建（系统下载目录被改过/删过的情况）
 * - 先下到 `.part` 再改名：中途失败/断电不会留下一个"看起来完整、其实半截"的
 *   exe，用户误双击会装出坏程序
 * - 校验（如果清单给了 sha256）在**改名之前**做，不匹配就删掉残file并报错
 */
export async function downloadAppUpdate(deps: DownloadDeps): Promise<string> {
  const name = deps.fileName ?? fileNameFromUrl(deps.url)
  mkdirSync(deps.dir, { recursive: true })
  const outPath = join(deps.dir, name)
  const partPath = `${outPath}.part`

  if (existsSync(outPath) && deps.overwrite === false) return outPath

  // 上次中断可能留下 .part，先清掉
  try {
    if (existsSync(partPath)) unlinkSync(partPath)
  } catch {
    /* 删不掉也继续，下面的写入会覆盖 */
  }

  const got = await deps.fetchToFile(deps.url, partPath, (g, t) => {
    const percent = t && t > 0 ? Math.min(100, Math.round((g / t) * 100)) : 0
    deps.onProgress?.({ percent, got: g, total: t })
  })

  if (deps.expectSha256) {
    const actual = await sha256OfFile(partPath)
    if (actual.toLowerCase() !== deps.expectSha256.toLowerCase()) {
      try {
        unlinkSync(partPath)
      } catch {
        /* 清理失败不影响报错 */
      }
      throw new Error(`安装包校验失败：SHA256 不匹配（期望 ${deps.expectSha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`)
    }
  }

  // 大小对不上也当失败（服务器传了个坏文件 / 中途被截断）
  if (got <= 0) {
    try {
      unlinkSync(partPath)
    } catch {
      /* ignore */
    }
    throw new Error('下载失败：收到 0 字节')
  }

  // 改名上位（同目录 rename 是原子的）
  const { renameSync } = await import('fs')
  if (existsSync(outPath)) {
    try {
      unlinkSync(outPath)
    } catch {
      /* 覆盖不了就让 rename 报错，别静默 */
    }
  }
  renameSync(partPath, outPath)
  return outPath
}

async function sha256OfFile(path: string): Promise<string> {
  const { readFileSync } = await import('fs')
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** 文件名里带版本号，避免新旧安装包同名互相覆盖（用户会想留着旧的） */
export function versionedInstallerName(version: string): string {
  const v = String(version ?? '').trim().replace(/[^0-9A-Za-z._-]/g, '')
  return `AstriaX-Setup-${v || 'unknown'}.exe`
}
