/*
 * ★★ 首选源下不到时**必须回退到别的源**
 *
 * 主人 2026-09-27：「NapCat 一键更新失败」，日志给出关键线索：
 *
 *     instance:update  n_2d9a960119  失败
 *     :: 下载失败：**试过 1 个镜像源**都没成。最后错误：Error: HTTP 404
 *
 * 「试过 1 个」而不该是"试过 N 个" —— 配置里 NapCat 有
 * 官方源 + GitHub 直连 + gh-proxy + cors 四个源，全都该被试一遍。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 根因
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 下载时传的是 `onlyBase: mirror?.base ?? prefBase` —— `prefBase` 是
 * **配置里的首选源**（他设了官方源）。而 `downloadRuntime` 里：
 *
 *     const order = deps.onlyBase !== undefined
 *       ? mirrorOrderFor(...).filter((m) => m.base === deps.onlyBase)  // ← 只剩 1 个
 *       : mirrorOrderFor(...)
 *
 * 候选只剩官方源一个。而那时服务器上**还没有 v4.18.28 的文件**
 *（只有 v4.18.19）→ 404 → **没有回退** → 失败。
 *
 * ## 修法
 *
 * 按"用户有没有**显式点**这个源"区分：
 *   · 点了（`isMirrorBase`）→ `onlyBase` 锁死它（尊重选择）
 *   · 没点（用配置首选）    → **不传 onlyBase**，让首选源排最前、其余回退
 *
 * ## 这条测试钉什么
 *
 * 「首选源 404 时，下载应当**继续试下一个源**」——
 * 这是**行为**层面的断言（不是看代码里写了什么），所以它能真正
 * 防止"锚死一个源"这种回归。
 */
import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { testStage } from '../helpers/stage'
import { downloadRuntime } from '../../src/main/update/runtime-download'
import { mirrorOrderFor } from '../../src/main/update/mirror-store'
import { MX_FILES_BASE } from '../../src/main/update/publish-urls'

/*
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 源地址**从源码常量派生**，不在这里硬编码（主人 2026-10-08）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 这个文件原来把官方源地址写死成 `https://astriax.huanyan.fun/mxbot/files/`
 * 写了 9 处。发布地址一换（旧域名废弃、改成 GitHub 加速源），
 * 三条用例全红 —— 而**功能本身完全正常**，只是测试还在说旧地址。
 *
 * 那是最没价值的一类红：它不指向任何缺陷，只制造"测试不可信"。
 * 改成从 `MX_FILES_BASE` 派生之后，**以后再换域名这里自动跟随**。
 */
const OFFICIAL_FILES = MX_FILES_BASE
/** 只取主机名做 contains 匹配 —— 用来在"试过哪些 url"里认出官方源 */
const OFFICIAL_HOST = new URL(MX_FILES_BASE).hostname

/** 造一个数据根：config + mirrors（首选官方源） */
function seedRoot(prefN: string): string {
  const root = testStage('fallback-')
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'config.json'), JSON.stringify({ dataRoot: root }), 'utf8')
  writeFileSync(
    join(root, 'mirrors.json'),
    JSON.stringify({ custom: [], pref: { a: '', n: prefN } }),
    'utf8'
  )
  return root
}

describe('★★首选源下不到 → 继续试别的源', () => {
  it('先看清候选顺序：首选源排最前，**其余源仍在列表里**', () => {
    const root = seedRoot(OFFICIAL_FILES)
    try {
      const order = mirrorOrderFor(root, 'n')
      console.log('\n  候选源顺序:')
      order.forEach((m, i) => console.log(`    ${i + 1}. ${m.label}  (${m.mode})`))

      expect(order.length, '★候选**不能只有一个**，否则没有回退余地').toBeGreaterThan(1)
      expect(order[0].base, '首选源排最前').toBe(OFFICIAL_FILES)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('★★传了 onlyBase=首选源 → 候选被缩到 1 个（这正是那个 bug 的机制）', () => {
    const root = seedRoot(OFFICIAL_FILES)
    try {
      const all = mirrorOrderFor(root, 'n')
      const pref = OFFICIAL_FILES
      const filtered = all.filter((m) => m.base === pref)
      console.log(`\n  全部源 ${all.length} 个 → 传 onlyBase 之后只剩 ${filtered.length} 个`)
      expect(filtered).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('★★不传 onlyBase → 首选源 404 时会**继续试下一个源**', async () => {
    const root = seedRoot(OFFICIAL_FILES)
    try {
      const tried: string[] = []
      const dest = join(root, 'out.zip')

      /*
       * 假 fetch：**首选源 404**，其余源成功。
       * 记录每个被请求的 URL —— 那就是"试过哪些源"的证据。
       */
      const result = await downloadRuntime({
        dataRoot: root,
        type: 'n',
        release: {
          tag: 'v4.18.28',
          assetName: 'napcat/v4.18.28/NapCat.Shell.zip',
          assetUrl: 'https://github.com/NepNeko/NapCatQQ/releases/download/v4.18.28/NapCat.Shell.zip',
          sha256: ''
        },
        destFile: dest,
        /* ★ 关键：**不传 onlyBase**（模拟"用户没点源、只用配置首选"） */
        fetchJson: async (url: string) => {
          tried.push(url)
          if (url.includes(OFFICIAL_HOST)) {
            /* 首选源：404（模拟服务器上还没有那个版本的文件） */
            throw new Error('HTTP 404')
          }
          /* 其它源：正常返回一份"索引"（files 模式用它查 asset） */
          return { assets: [] }
        },
        fetchBuf: async (url: string) => {
          tried.push(url)
          if (url.includes(OFFICIAL_HOST)) throw new Error('HTTP 404')
          return Buffer.from('fake-zip-content')
        },
        onProgress: () => {},
        onPhase: () => {}
      } as never).catch((e: unknown) => ({ failed: String(e) }))

      console.log('\n  被请求过的地址:')
      tried.forEach((u) => console.log(`    ${u.slice(0, 100)}`))

      const hitPref = tried.some((u) => u.includes(OFFICIAL_HOST))
      expect(hitPref, '首选源必须被试过').toBe(true)

      const others = tried.filter((u) => !u.includes(OFFICIAL_HOST))
      expect(
        others.length,
        '★★首选源 404 之后必须继续试别的源'
      ).toBeGreaterThan(0)
      expect(result, '后续源成功时应当拿到结果（不是抛错）').not.toHaveProperty('failed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/*
 * ══════════════════════════════════════════════════════════════════════════════
 * ★★ 接线层守卫：`runtime:install` 到底传没传 `onlyBase`
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * ## 为什么必须单独测"接线"
 *
 * 我第一版只测了 `downloadRuntime` 函数本身（上面那几条），
 * 而**用尺子验证时发现它抓不到 bug** —— 把 `ipc.ts` 里
 * `onlyBase: isMirrorBase ? p.base : undefined` 改回"锚死首选源"，
 * 上面那些测试**依然全绿**。
 *
 * 原因：**是否锚死取决于调用方传的参数**，函数自己怎么测都测不出来。
 * 这正是本项目反复踩的"组件写好了、调用方没接对"那一类 ——
 * 函数级测试照不到接线错误。
 *
 * 所以这里改成**直接检查接线**：读 `ipc.ts` 的源码，
 * 断言那行传参的形状。它是"源码守卫"，不漂亮，但**真的守得住**
 *（尺子验证过：改回去就红）。
 *
 * 判据是**语义**而不是字面串：必须是 `isMirrorBase ? ... : undefined`
 * 这个形状 —— 也就是"只有用户显式点了源才锚定"。
 */
describe('★★接线守卫：只有用户显式点源才锚定', () => {
  it('runtime:install 的 onlyBase 必须是「点了才锁、没点就放开」', () => {
    const raw = readFileSync(join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8')

    /*
     * ★ 必须先剥掉注释再判断 —— 这个坑我踩过两次了
     *
     * 我写的**解释性注释里就引用了那句错的旧写法**
     *（"不许再回到 `onlyBase: mirror?.base ?? prefBase`"），
     * 于是不剥注释的话，守卫永远红。
     *
     * 同类教训在 `instance-log-current-run.spec.ts` 的时间戳守卫里也记过：
     * 扫源码前先剥注释 —— "解释错的注释"不是错本身。
     */
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n')
      .map((l) => l.replace(/(^|[^:'"`])\/\/.*$/, '$1'))
      .join('\n')

    /* 找到下载那处传参（唯一一处 onlyBase 带三元的地方） */
    const m = /onlyBase:\s*isMirrorBase\s*\?\s*p\.base\s*:\s*undefined/.exec(src)
    expect(
      m,
      '★`runtime:install` 的 `onlyBase` 必须写成 `isMirrorBase ? p.base : undefined`\n' +
        '（= 只有用户在界面上**显式点了某个镜像源**才锚定它；\n' +
        '  只是配置里的首选源时不锚定，好让别的源能回退）。\n' +
        '写成 `mirror?.base ?? prefBase` 会锚死首选源 ——\n' +
        '主人实测的「试过 1 个镜像源都没成 / HTTP 404」就是这么来的。'
    ).toBeTruthy()

    expect(
      /onlyBase:\s*mirror\?\.base\s*\?\?/.test(src),
      '★不许再回到 `onlyBase: mirror?.base ?? prefBase`（那会锚死首选源、没有回退）'
    ).toBe(false)
  })
})
