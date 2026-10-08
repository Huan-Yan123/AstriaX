import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * 读运行时**包自己带着的**版本号。
 *
 * 为什么不只看目录名/tag：目录名是我们下载时起的。用户手动替换过包、
 * 从别处拷来一份、或者旧的下载逻辑把内容解错层，名字和实际内容就会对不上。
 * 界面显示 v4.18.19、实际跑的是别的版本，这种「说了不算」是最难查的一类问题。
 * 所以以包内的权威标识为准，目录名只当兜底。
 *
 * 两种运行时的标识位置都在真实文件里确认过（见各函数的注释）。
 */

/** 从文本里挖一个形如 4.18.19 / 4.28.0-beta.1 的版本串 */
const VERSION_RE = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/

function clean(v: string | undefined): string | undefined {
  if (!v) return undefined
  const t = v.trim()
  const m = VERSION_RE.exec(t)
  return m ? m[1] : undefined
}

/**
 * NapCat：版本被烘焙进 napcat.mjs。
 *
 * 真实形态（打包压缩成一行）：
 *   const Oj = {}, Vu = typeof Oj < "u" && "4.18.19" || "1.0.0-dev", ...
 * 变量名（Vu）压缩后会变，所以不能写死名字，只能认这个「特征形状」：
 *   typeof <ident> < "u" && "<version>" || "1.0.0-dev"
 * 那个 `|| "1.0.0-dev"` 兜底串是稳定锚点。
 */
function readNapcatVersion(dir: string): string | undefined {
  const f = join(dir, 'napcat.mjs')
  if (!existsSync(f)) return undefined
  let text: string
  try {
    // 3MB 的包，读一次没问题；读不动就放弃
    text = readFileSync(f, 'utf8')
  } catch {
    return undefined
  }
  // 锚在 || "1.0.0-dev" 上往回收：那是 NapCat 的版本兜底默认值
  const m = /typeof\s+\w+\s*<\s*"u"\s*&&\s*"([^"]+)"\s*\|\|\s*"1\.0\.0-dev"/.exec(text)
  return clean(m?.[1])
}

/**
 * AstrBot：按权威程度依次找。
 *
 * 1. pip/--target 装完必有 `astrbot-<版本>.dist-info/METADATA`，里面的
 *    `Version:` 是打包时写死的，最权威。
 * 2. 源码形态读 `astrbot/__init__.py` 的 `__version__`
 *    （官方桌面壳的 version-sync.mjs 也是这么认的）。
 * 3. 再退到 `pyproject.toml` 的 `[project].version`。
 */
function readAstrbotVersion(dir: string): string | undefined {
  // 1. dist-info / egg-info
  try {
    for (const name of readdirSync(dir)) {
      if (!/^astrbot[-_].*\.(dist|egg)-info$/i.test(name)) continue
      const meta = join(dir, name, 'METADATA')
      if (!existsSync(meta)) continue
      const v = /^Version:\s*(.+)$/m.exec(readFileSync(meta, 'utf8'))?.[1]
      const c = clean(v)
      if (c) return c
    }
  } catch {
    /* 目录读不了就往下试 */
  }

  // 2. astrbot/__init__.py 的 __version__
  const init = join(dir, 'astrbot', '__init__.py')
  if (existsSync(init)) {
    try {
      const v = /^\s*__version__\s*=\s*["']([^"']+)["']/m.exec(readFileSync(init, 'utf8'))?.[1]
      const c = clean(v)
      if (c) return c
    } catch {
      /* 继续 */
    }
  }

  // 3. pyproject.toml 的 [project].version
  const pp = join(dir, 'pyproject.toml')
  if (existsSync(pp)) {
    try {
      const text = readFileSync(pp, 'utf8')
      // 只看 [project] 段里的 version，别误抓 tool.* 下的
      const projIdx = text.indexOf('[project]')
      const seg = projIdx >= 0 ? text.slice(projIdx, projIdx + 2000) : text
      const v = /^\s*version\s*=\s*["']([^"']+)["']/m.exec(seg)?.[1]
      const c = clean(v)
      if (c) return c
    } catch {
      /* 放弃 */
    }
  }

  return undefined
}

/**
 * 读运行时内置版本。读不到返回 undefined —— **绝不编一个假的**。
 * 调用方拿到了再用目录名兜底。
 */
export function readBuiltinVersion(deps: { dir: string; type: 'a' | 'n' }): string | undefined {
  try {
    if (!existsSync(deps.dir)) return undefined
    return deps.type === 'n' ? readNapcatVersion(deps.dir) : readAstrbotVersion(deps.dir)
  } catch {
    return undefined
  }
}
