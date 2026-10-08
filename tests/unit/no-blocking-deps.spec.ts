/*
 * 守住「不许再引入 pidusage」这条线。
 *
 * 为什么值得写成测试：pidusage 是**整个项目最严重的一次性能事故**的根源。
 * 它在 Windows 上通过 spawn `wmic.exe` 取进程资源占用，而 wmic 已被新版
 * Windows 移除 —— 每次调用都要等它失败超时，实测单次 2.4~5.1 秒。
 * 它当时被放在一个每 2 秒执行一次的轮询里，于是主进程永远在等它，
 * 界面点什么都卡死。
 *
 * 光删掉代码不够：依赖还在 package.json 里、注释里还有它的名字，
 * 将来有人「照着注释里的写法」再引一次就复发了。所以：
 *   1) 源码里不许出现对 pidusage 的真实 import/require
 *   2) package.json 的 dependencies 里不许再有它（否则白拖进安装包）
 *   3) 顺带守住「任何采集进程资源的第三方库」这个思路别回来
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, basename } from 'path'

const ROOT = join(__dirname, '..', '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === 'out' || e === 'dist') continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|vue|js|mjs|cjs)$/.test(e)) out.push(p)
  }
  return out
}

describe('性能事故防线：不许再引入阻塞主进程的资源采集', () => {
  const srcFiles = walk(join(ROOT, 'src'))

  it('源码里没有对 pidusage 的真实引用', () => {
    const hits: string[] = []
    for (const f of srcFiles) {
      const src = readFileSync(f, 'utf8')
      // 只抓真实引用，注释里提到名字不算（注释里正是解释为什么不能用它）
      if (/(require\s*\(\s*['"]pidusage['"]|from\s+['"]pidusage['"]|import\s*\(\s*['"]pidusage['"])/.test(src)) {
        hits.push(f.replace(ROOT, '').replace(/\\/g, '/'))
      }
    }
    expect(
      hits,
      `这些文件又引用了 pidusage（会在 Windows 上卡死主进程）：\n${hits.join('\n')}`
    ).toEqual([])
  })

  it('package.json 的 dependencies 里没有 pidusage（不用了就该删，否则白拖进安装包）', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const deps = Object.keys(pkg.dependencies ?? {})
    expect(deps, 'pidusage 已无任何引用，应从 dependencies 移除').not.toContain('pidusage')
  })

  it('package.json 的 dependencies 里没有 nanoid（已被 crypto.randomBytes 取代）', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const deps = Object.keys(pkg.dependencies ?? {})
    expect(deps, 'nanoid 已无任何引用，应从 dependencies 移除').not.toContain('nanoid')
  })

  it('所有 dependencies 都真的被源码引用（防止僵尸依赖累积）', () => {
    /*
     * 反过来也查：dependencies 里列的每个包，源码里都该能找到引用。
     * 找不到 = 白占安装包体积。这类问题不会报错，只会让包越来越大。
     * devDependencies 不查（构建工具本来就可能在配置里引用）。
     */
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    const allSrc = srcFiles.map((f) => readFileSync(f, 'utf8')).join('\n')
    const zombie: string[] = []
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      /*
       * ★ 三种引用形态都要认（第一版只认前两种，把 electron-updater 误判成僵尸）
       *
       *   require('dep')   静态 CJS
       *   from 'dep'       静态 ESM
       *   import('dep')    **动态导入**
       *
       * 为什么动态导入必须算数：只依赖 electron 的库（如 electron-updater）
       * **不能**在顶层静态导入 —— ipc.ts 会被纯 node 的单测加载，
       * 顶层 import 会去碰 electron 的 app 并直接炸。所以"打包态才用"的库
       * 一律走动态导入。本守卫要守的是"这个依赖到底有没有被用"，
       * 而不是"它是不是静态导入的"。
       */
      const re = new RegExp(
        `(require\\s*\\(\\s*['"]${dep}['"]|from\\s+['"]${dep}['"]|import\\s*\\(\\s*['"]${dep}['"])`
      )
      if (!re.test(allSrc)) zombie.push(dep)
    }
    expect(zombie, `这些依赖没有任何源码引用，是僵尸依赖：\n${zombie.join('\n')}`).toEqual([])
  })
})
