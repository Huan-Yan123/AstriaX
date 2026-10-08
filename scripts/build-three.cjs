/**
 * 打三个包（主人 2026-10-08）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 产物
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   ① dist/AstriaX-Setup-0.2.1-public.exe            —— 测更新链路的"旧版"
 *   ② dist/AstriaX-Setup-1.0.0-public.exe            —— 公开版（传 GitHub）
 *   ③ dist/AstriaX-Setup-1.0.0-internal.exe          —— 内部定制版（硬件固定）
 *
 * ① 和 ② 的代码**完全相同**，只差版本号 —— 用途是验证
 * "检查更新 → 提示新版 → 下载 → 落到下载文件夹"这整条链：
 * 先装 0.2.1，把 1.0.0 发成 latest，打开 0.2.1 就应当提示更新。
 *
 * ③ 只是 ② 换一个构建开关（build-flags.ts 的 INTERNAL_BUILD），
 * 硬件信息固定成 9950X3D2 / RTX 5090 / 64GB，用于截图与演示。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 打完必须恢复到 **1.0.0**（主人 2026-10-08 纠正）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 我第一版是"恢复到打之前的原始值"（那时是 0.2.1）。后果：
 * 脚本跑完仓库停在 0.2.1，于是推上 GitHub 的源码**标着 0.2.1** ——
 * 而它明明是 1.0.0 的代码。主人看到仓库里到处是 0.2.1 的提交，
 * 完全对不上。
 *
 * 根子上的错是**把"当前发的是哪个版本"当成了"仓库的版本号"**。
 * `package.json` 的 `version` 就是**发布版本号**，它应该反映
 * "这个仓库是哪个版本"，而不是"上次打包临时借用了哪个号"。
 *
 * 所以现在固定恢复到 `PUBLISH_VERSION`（= 1.0.0）。
 * 开发态因此显示 1.0.0 —— 那是对的，它开发的本来就是 1.0.0。
 *
 * 至于"开发态检查更新会说自己已是最新"：那不影响开发
 *（线上清单也是 1.0.0，本来就该说最新）。真要测更新链路，
 * 装的是 ① 那个 0.2.1 包 —— 它的**构建产物**是 0.2.1，
 * 与仓库版本号无关。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 顺序为什么是"先公开、后内部"
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `INTERNAL_BUILD` 是**源码里的一行布尔**，构建时被烧进产物。
 * 如果先打内部版再打公开版、中途失败（或忘了改回来），
 * 传上 GitHub 的就会是**带定制硬件的公开版** —— 那是最坏的结果。
 *
 * 所以脚本开头就把开关写成 false 并先打两个公开包，
 * 内部版放在**最后**，打完立刻改回 false（finally 里）。
 */
const { execFileSync } = require('child_process')
const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const PKG = join(ROOT, 'package.json')
const FLAGS = join(ROOT, 'build-flags.ts')
const DIST = join(ROOT, 'dist')

/**
 * 仓库的发布版本号 —— 打完包固定恢复成它。
 *
 * 改版本号时只改这里（以及下面 PLAN 里的目标版本），
 * 别让它再跟"打包前的临时值"挂钩。
 */
const PUBLISH_VERSION = '1.0.0'

/** 打包计划（顺序有意义，见文件头说明） */
const PLAN = [
  { version: '0.2.1', internal: false, note: '测更新链路用的旧版' },
  { version: PUBLISH_VERSION, internal: false, note: '公开版（传 GitHub）' },
  { version: PUBLISH_VERSION, internal: true, note: '内部定制版（硬件固定）' }
]

const say = (m) => process.stdout.write(m + '\n')

/**
 * 改 package.json 的版本号（正则替换，只动那一行，不重排键序）。
 *
 * ★ 与 setInternal 同一个坑：**不能用"内容变了没有"当成功判据** ——
 *   第一轮的 0.2.1 本来就是 0.2.1，替换后内容完全相同，
 *   会被误判成"没改到"并中止（我第一次跑就死在这里）。
 *   判据应当是"正则匹配上了没有"。
 */
function setVersion(v) {
  const raw = readFileSync(PKG, 'utf8')
  const m = /("version"\s*:\s*")([^"]*)(")/.exec(raw)
  if (!m) throw new Error('package.json 里找不到 version 字段')
  if (m[2] === v) return /* 已经是目标版本，不必写盘 */
  writeFileSync(PKG, raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${v}$2`), 'utf8')
}

function readVersion() {
  return JSON.parse(readFileSync(PKG, 'utf8')).version
}

/**
 * 改构建开关（build-flags.ts 里那一行布尔）。
 *
 * 用正则而不是文本整体替换：那个文件里在注释中也提到了 `INTERNAL_BUILD`，
 * 必须只改**导出的那一行**，否则注释会被改坏。
 */
function setInternal(on) {
  const raw = readFileSync(FLAGS, 'utf8')
  const wanted = on ? 'true' : 'false'
  /*
   * ★ 不能用 `next === raw` 判"没改成"（踩过）
   *
   * 脚本开头会把开关**强制写成 false**，而它本来可能就是 false ——
   * 那时替换后内容与原文完全相同，`next === raw` 为真，
   * 于是误报"没能改到"并直接退出（我第一次跑就是这样失败的）。
   *
   * 正确的判据是：**正则有没有匹配上**，而不是"内容有没有变化"。
   */
  const m = /(export const INTERNAL_BUILD = )(true|false)/.exec(raw)
  if (!m) throw new Error('build-flags.ts 里找不到 INTERNAL_BUILD 的导出行')
  if (m[2] === wanted) return /* 已经是想要的值，不必写盘 */
  writeFileSync(FLAGS, raw.replace(/(export const INTERNAL_BUILD = )(true|false)/, `$1${wanted}`), 'utf8')
  /* 读回来确认 —— 改没改成不能靠"我以为" */
  const check = /export const INTERNAL_BUILD = (true|false)/.exec(readFileSync(FLAGS, 'utf8'))
  if (check?.[1] !== wanted) {
    throw new Error(`build-flags.ts 改写后校验失败：期望 ${wanted}，实际 ${check?.[1]}`)
  }
}

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: true })
}

/**
 * electron-builder 的中间产物（latest.yml 等）同名，会互相覆盖。
 * 每轮开始前把上一轮的挪进子目录存档，保留证据。
 */
function stashPrevMeta(round) {
  if (!existsSync(DIST)) return
  const dir = join(DIST, `_meta-${round}`)
  let moved = 0
  for (const name of ['latest.yml', 'builder-debug.yml', 'builder-effective-config.yaml']) {
    const p = join(DIST, name)
    if (existsSync(p)) {
      mkdirSync(dir, { recursive: true })
      try {
        renameSync(p, join(dir, name))
        moved++
      } catch {
        /* 挪不动就算了：它只是中间产物 */
      }
    }
  }
  if (moved) say(`  （上一轮的 ${moved} 个元数据文件已挪到 ${dir}）`)
}

const original = readVersion()
say(`仓库版本号：${original}（打完会恢复到 ${PUBLISH_VERSION}）`)
say(`将依次打 ${PLAN.length} 个包：`)
PLAN.forEach((p, i) => {
  say(`  ${i + 1}) ${p.version}${p.internal ? ' [内部定制版]' : ''}  —— ${p.note}`)
})
say('')

const built = []

try {
  /* ★ 先把开关强制写成 false —— 公开版必须是干净的（见文件头） */
  setInternal(false)

  for (let i = 0; i < PLAN.length; i++) {
    const step = PLAN[i]
    const round = i + 1
    say('═'.repeat(64))
    say(`[${round}/${PLAN.length}] ${step.version}${step.internal ? '（内部定制版）' : ''} —— ${step.note}`)
    say('═'.repeat(64))

    setVersion(step.version)
    setInternal(step.internal)
    stashPrevMeta(round)

    /*
     * 先 build（编译源码）再 electron-builder（打安装包）。
     * 两步分开而不是用 `npm run dist`：那样输出不好分辨，
     * 而且我们每次都要在两步之间确认开关状态。
     */
    run('npx', ['electron-vite', 'build'])

    /*
     * ★ 编译完**立刻验一遍**产物里的定制硬件字符串是否符合预期 ——
     * 这是防"开关没生效"的那道闸（我为此排查过好几轮）。
     */
    verifyBuildMatchesFlag(step.internal)

    run('npx', ['electron-builder', '--win', 'nsis'])

    const base = `AstriaX-Setup-${step.version}.exe`
    const exe = join(DIST, base)
    if (!existsSync(exe)) {
      throw new Error(`构建结束但没找到产物：${exe}\n（检查 electron-builder.yml 的 artifactName）`)
    }

    /*
     * ★ 打完**立刻**改名成带标识的名字，别留在原地等下一轮覆盖。
     *
     * 踩过的坑：我原来只在"内部版"那一轮改名，想着
     * "两个公开版版本号不同（0.2.1 / 1.0.0），天然不会撞"—— 对，
     * 但**内部版和公开版版本号相同**（都是 1.0.0），
     * 于是第三轮 electron-builder 先产出 `AstriaX-Setup-1.0.0.exe`
     * （把第二轮那个**覆盖掉**），我再把它改名成 `-internal` ——
     * 结果 **1.0.0 公开版彻底消失**，只剩 0.2.1 和内部版。
     *
     * 实测确认：dist 里当时只有 AstriaX-Setup-0.2.1.exe 和
     * AstriaX-Setup-1.0.0-internal.exe。
     *
     * 现在每轮产出后**立即**挪成唯一名字，下一轮再怎么覆盖都影响不到它。
     * 公开版叫 `-public` 后缀是刻意加的：它和内部版只差硬件，
     * 文件名上必须一眼能分清哪个能发布。
     */
    const suffix = step.internal ? '-internal' : '-public'
    const target = join(DIST, `AstriaX-Setup-${step.version}${suffix}.exe`)
    renameSync(exe, target)
    built.push(target)
    say(`✓ 已存为：${target.replace(ROOT + '\\', '')}`)

    const sz = (statSync(target).size / 1048576).toFixed(1)
    say(`✓ ${step.note} 打包完成（${sz} MB）`)
    say('')
  }

  say('═'.repeat(64))
  say('三个包都打好了')
  say('═'.repeat(64))
  for (const b of built) {
    say(`  ${b.replace(ROOT + '\\', '').replace(ROOT + '/', '')}`)
  }
} finally {
  /*
   * 无论成功失败，都要：
   *   ① 关掉内部开关 —— 否则下次构建（可能是发布）会带着定制硬件
   *   ② 恢复版本号 —— 否则 dev 态会以为自己是 1.0.0
   * 顺序上先关开关（后果更严重）。
   */
  try {
    setInternal(false)
    say('已把 INTERNAL_BUILD 改回 false（公开版默认）')
  } catch (e) {
    say(`⚠ 恢复 INTERNAL_BUILD 失败，请手动检查 build-flags.ts：${e.message}`)
  }
  try {
    /*
     * ★ 恢复成**发布版本号**（不是"打之前的原始值"）。
     *
     * 这样脚本跑完仓库就停在 1.0.0 —— 推上 GitHub 的源码
     * 与发布版本一致，不会出现"仓库里到处是 0.2.1"那种混乱。
     */
    setVersion(PUBLISH_VERSION)
    say(`已把仓库版本号恢复为 ${PUBLISH_VERSION}`)
  } catch (e) {
    say(`⚠ 恢复版本号失败，请手动把 package.json 改成 ${PUBLISH_VERSION}：${e.message}`)
  }
}

/**
 * 校验刚编译出的产物里"定制硬件字符串"的存在性是否符合开关预期。
 *
 * 为什么要这一步：`INTERNAL_HW_OVERRIDE` 是构建期注入的常量，
 * 一旦注入失效，内部版会**静默地**变成公开版（构建照样成功）。
 * 我第一版用环境变量时就踩过 —— 排查了好几轮。
 * 现在用产物内容做客观判据。
 */
function verifyBuildMatchesFlag(shouldBeInternal) {
  const outDir = join(ROOT, 'out')
  const files = []
  const walk = (d) => {
    for (const e of require('fs').readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.js')) files.push(p)
    }
  }
  if (existsSync(outDir)) walk(outDir)

  const hasMarker = files.some((f) => readFileSync(f, 'utf8').includes('9950X3D2'))
  if (shouldBeInternal && !hasMarker) {
    throw new Error(
      '开关是内部版，但编译产物里**没有**定制硬件字符串 ——\n' +
        '说明 INTERNAL_HW_OVERRIDE 注入失效了（构建会成功，但内容是错的）。\n' +
        '检查 build-flags.ts 与 electron.vite.config.ts 的 define。'
    )
  }
  if (!shouldBeInternal && hasMarker) {
    throw new Error(
      '开关是公开版，但编译产物里**存在**定制硬件字符串 ——\n' +
        '这个包绝不能发布：公开版里带着一套假硬件。\n' +
        '检查 build-flags.ts 是否忘了改回 false。'
    )
  }
  say(shouldBeInternal ? '  ✓ 校验：内部版产物含定制硬件' : '  ✓ 校验：公开版产物干净（无定制硬件）')
}
