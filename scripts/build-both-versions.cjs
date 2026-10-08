/*
 * 打两份包：0.2.1（当前版）+ 1.0.0（更新目标版）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么要打两份（主人 2026-10-08）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 主人的原话：
 *   「最终版一份 0.2.1，一份 1.0.0，其他完全一致，
 *     版本差异用于测试拉取更新用的」
 *
 * 也就是：**两份包的代码完全相同，只有版本号不同**。用途是验证
 * "检查更新 → 提示有新版本 → 下载 → 拿到 exe" 这整条链：
 *
 *   ① 先装 0.2.1（旧版）
 *   ② 把 1.0.0 发布成 latest（GitHub Release + 仓库里的 latest.json）
 *   ③ 打开 0.2.1 → 它应当检查到 1.0.0 并提示更新
 *   ④ 点更新 → 从加速源下载 1.0.0 的 exe 到下载文件夹
 *
 * 没有这个"人为造出的版本差"，更新链路就只能靠改服务器清单来测，
 * 而那测不到"打包出来的真实 exe 能不能被正确下载与校验"。
 *
 * ## 用法
 *
 *   node scripts/build-both-versions.cjs
 *
 * 产物（都在 dist/）：
 *   AstriaX-Setup-0.2.1.exe   ← 用来装的那个
 *   AstriaX-Setup-1.0.0.exe   ← 用来当"新版本"的那个
 *
 * ## 关键实现细节
 *
 * · 临时改 `package.json` 的 version，打完立刻**改回来**（用 try/finally）。
 *   不改回去的话，仓库里就留着一个 1.0.0 的版本号 —— 下次开发时
 *   `npm run dev` 会以为自己是 1.0.0，检查更新永远说"已是最新"。
 *
 * · 每打完一份就把产物**改名带版本号存档**。因为 electron-builder 的
 *   产物名就叫 `AstriaX-Setup-<version>.exe`，两次构建天然不会互相覆盖；
 *   但 `latest.yml` 之类会（同名），所以第二遍开始前先把它挪走。
 *
 * · **不做任何代码差异**。主人明确说"其他完全一致" —— 任何
 *   `if (version === '1.0.0')` 之类的测试后门都会让这次验证失真
 *   （真实更新场景里，新旧版本的代码本来就可能不同，
 *    但我们要先在一个"只差版本号"的干净条件下验证链路本身通不通）。
 */
const { execFileSync } = require('child_process')
const { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const PKG = join(ROOT, 'package.json')
const DIST = join(ROOT, 'dist')

/** 要打的两个版本（顺序有意义：先打旧版，再打新版） */
const VERSIONS = ['0.2.1', '1.0.0']

function say(msg) {
  process.stdout.write(msg + '\n')
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts })
}

/**
 * 改 package.json 的 version。
 *
 * 为什么用正则替换而不是 `JSON.parse` + `JSON.stringify`：
 * 后者会**重排键顺序**并把文件整体重写，导致 package.json 出现巨大 diff
 *（而这个改动本该是"只动一个字段"）。用正则只改 version 那一行。
 */
function setVersion(v) {
  const raw = readFileSync(PKG, 'utf8')
  const next = raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${v}$2`)
  if (next === raw) {
    throw new Error('没能改到 package.json 的 version 字段（正则没匹配上）')
  }
  writeFileSync(PKG, next, 'utf8')
}

function readVersion() {
  return JSON.parse(readFileSync(PKG, 'utf8')).version
}

const original = readVersion()
say(`原始版本：${original}`)
say(`将依次打：${VERSIONS.join(' → ')}`)
say('')

/*
 * ★ 整个流程包在 try/finally 里。
 *
 * package.json 的 version 是**仓库里的一份真实文件**，
 * 中途失败（构建报错、Ctrl+C）如果不恢复，就会留下一个错误的版本号，
 * 而那个错误很隐蔽 —— 下次开发时"检查更新"永远说已是最新。
 */
try {
  for (const v of VERSIONS) {
    say('═'.repeat(60))
    say(`开始打 ${v}`)
    say('═'.repeat(60))

    setVersion(v)

    /*
     * electron-builder 的中间产物（latest.yml / *.blockmap）是同名的，
     * 两份包会互相覆盖。上面那行 rename 把上一份的挪进子目录存档。
     */
    if (existsSync(DIST)) {
      const staging = join(DIST, `_prev-${Date.now()}`)
      mkdirSync(staging, { recursive: true })
      for (const name of ['latest.yml', 'builder-debug.yml']) {
        const p = join(DIST, name)
        if (existsSync(p)) {
          try {
            renameSync(p, join(staging, name))
          } catch {
            /* 挪不动就算了（它只是中间产物，不影响安装包本身） */
          }
        }
      }
    }

    /* 只打 Windows 的 nsis 全量包 —— 与 electron-builder.yml 的配置一致 */
    run('npx', ['electron-builder', '--win', 'nsis'], { shell: true })

    const exe = join(DIST, `AstriaX-Setup-${v}.exe`)
    if (!existsSync(exe)) {
      throw new Error(`构建结束但没找到产物：${exe}\n（检查 electron-builder.yml 的 artifactName）`)
    }
    const mb = (require('fs').statSync(exe).size / 1048576).toFixed(1)
    say(`✓ ${v} 打包完成：${exe}（${mb} MB）`)
    say('')
  }

  say('═'.repeat(60))
  say('两份包都打好了')
  say('═'.repeat(60))
  for (const v of VERSIONS) {
    say(`  dist/AstriaX-Setup-${v}.exe`)
  }
  say('')
  say('下一步（测试更新链路）：')
  say('  1) 先装 0.2.1 那个')
  say('  2) 用 scripts/publish-github.cjs 把 1.0.0 发布成 latest')
  say('  3) 打开 0.2.1，它应当提示有新版本并下载 1.0.0')
} finally {
  /*
   * 无论成功失败都恢复原版本号 —— 见上面那段说明。
   * 这里刻意**不用** `setVersion(original)`，因为它内部有"没改到就抛错"的检查，
   * 而恢复阶段再抛错会把真实错误盖掉。直接无条件写回。
   */
  try {
    const raw = readFileSync(PKG, 'utf8')
    writeFileSync(PKG, raw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${original}$2`), 'utf8')
    say(`已恢复 package.json 的版本号为 ${original}`)
  } catch (e) {
    say(`⚠ 恢复版本号失败，请手动把 package.json 的 version 改回 ${original}：${e.message}`)
  }
}
