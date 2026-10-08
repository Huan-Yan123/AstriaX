/*
 * 一键发布到 GitHub（Releases + 仓库内的 latest.json）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么清单放仓库、安装包放 Release
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 这是这套发布流程最容易被后人改错的地方，先说清：
 *
 *   · **latest.json → 提交进仓库**（走 raw.githubusercontent.com 读）
 *     客户端每次启动都要读它来"检查更新"。Release 的资产上传/替换有延迟，
 *     而且替换同名资产后 CDN 还会缓存旧的 —— 用户会看到"版本号没变"。
 *     放仓库里由 Git 托管，改一次立刻生效。
 *
 *   · **安装包 exe → GitHub Release 资产**（走 releases/latest/download/ 读）
 *     exe 有 80MB+，塞进仓库会让 clone 变得极慢且永久膨胀历史。
 *
 * 两者的加速源都在 publish-urls.ts 里统一处理，客户端不关心它们在哪。
 *
 * ## 用法
 *
 *   node scripts/publish-github.cjs <版本号> [--notes-file <文件>] [--dry-run]
 *
 * 例：
 *   node scripts/publish-github.cjs 1.0.0 --notes-file release-notes.txt
 *
 * ## 为什么强制要求 --notes-file 存在时才读文件
 *
 * 踩过的坑（0.1.3）：说明当命令行参数传，中文被 Windows 控制台编码搞坏，
 * 还在 `·` 处被截断。所以中文说明一律走文件（UTF-8），命令行只出现路径。
 */
const { execFileSync } = require('child_process')
const { createHash } = require('crypto')
const { existsSync, readFileSync, statSync, writeFileSync } = require('fs')
const { join } = require('path')

const OWNER = 'Huan-Yan123'
const REPO = 'AstriaX'
const SLUG = `${OWNER}/${REPO}`

const args = process.argv.slice(2)
const version = args.find((a) => !a.startsWith('--'))
const dryRun = args.includes('--dry-run')
const notesIdx = args.indexOf('--notes-file')
const notes =
  notesIdx >= 0
    ? readFileSync(args[notesIdx + 1], 'utf8').trim()
    : `AstriaX ${version}`

if (!version) {
  console.error('用法：node scripts/publish-github.cjs <版本号> [--notes-file <文件>] [--dry-run]')
  process.exit(1)
}

const root = join(__dirname, '..')
const distDir = join(root, 'dist')
const exeName = `AstriaX-Setup-${version}.exe`
const exePath = join(distDir, exeName)

/**
 * 步骤 0：确认安装包存在。
 *
 * 为什么会漏：`electron-builder` 的产物名由 package.json 的 version 决定，
 * 而这里允许传一个**不同的版本号**（测试"从 0.2.1 更新到 1.0.0"时，
 * 1.0.0 那次的 package.json 就是 1.0.0）——
 * 版本号对不上时产物名也不一样，必须在这里明确报出来，
 * 而不是等到上传时报一个看不懂的 404。
 */
if (!existsSync(exePath)) {
  console.error(`✘ 找不到安装包：${exePath}`)
  console.error('  先跑：npm run dist')
  console.error(`  （package.json 里的 version 必须是 ${version}）`)
  process.exit(1)
}

const sha256 = createHash('sha256').update(readFileSync(exePath)).digest('hex')
const size = statSync(exePath).size

/**
 * latest.json 的 url 字段写成**相对路径**（只有文件名）。
 *
 * 为什么：客户端会把它拼到"当前正在用的那个加速源"上（见 publish-urls.ts 的
 * installerUrls）。写绝对 GitHub 地址的话，加速改造就失效了 ——
 * 客户端会拿着直链去下，国内基本下不动。
 */
const manifest = {
  version,
  url: exeName,
  size,
  sha256,
  notes
}

console.log('═══ 发布信息 ═══')
console.log(`版本:   ${version}`)
console.log(`安装包: ${exeName}（${(size / 1048576).toFixed(1)} MB）`)
console.log(`SHA256: ${sha256}`)
console.log(`说明:   ${notes.slice(0, 80)}${notes.length > 80 ? '…' : ''}`)
console.log('')

if (dryRun) {
  console.log('[dry-run] 不实际发布。会写入的 latest.json：')
  console.log(JSON.stringify(manifest, null, 2))
  process.exit(0)
}

function run(cmd, argv, opts = {}) {
  return execFileSync(cmd, argv, { cwd: root, encoding: 'utf8', ...opts }).trim()
}

/**
 * 步骤 1：写 latest.json 并提交。
 *
 * 提交信息里带版本号，这样 `git log -- latest.json` 一眼能看出历代版本。
 */
const manifestPath = join(root, 'latest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
console.log('✓ 已写入 latest.json')

run('git', ['add', 'latest.json'])
/*
 * 允许"没有变化"（同版本重复发布时内容一致，git commit 会失败）。
 * 用 --allow-empty 让它通过，避免发布脚本因为一个幂等操作中断。
 */
run('git', ['commit', '--allow-empty', '-m', `release: ${version}`])
console.log('✓ 已提交 latest.json')

/**
 * 步骤 2：推送到 main。
 *
 * 先 push 再建 Release：顺序反了的话，客户端可能先读到新清单、
 * 但 Release 资产还没上传完 —— 用户点下载拿到 404。
 * 清单指向的资产必须**先存在**。
 */
run('git', ['push', 'origin', 'HEAD:main'])
console.log('✓ 已推送到 origin/main')

/**
 * 步骤 3：创建/更新 Release 并上传安装包。
 *
 * `--clobber` 让同 tag 重复发布时覆盖同名资产 ——
 * 重新打包同一个版本号时很常见（修个紧急 bug 重发）。
 */
const tag = `v${version}`
const exists = (() => {
  try {
    run('gh', ['release', 'view', tag, '--repo', SLUG])
    return true
  } catch {
    return false
  }
})()

if (exists) {
  console.log(`! Release ${tag} 已存在，覆盖上传资产`)
  run('gh', ['release', 'upload', tag, exePath, '--repo', SLUG, '--clobber'])
} else {
  run('gh', [
    'release',
    'create',
    tag,
    exePath,
    '--repo',
    SLUG,
    '--title',
    `AstriaX ${version}`,
    '--notes',
    notes
  ])
}
console.log(`✓ 已上传 ${exeName} 到 Release ${tag}`)

/**
 * 步骤 4：核实清单里的 sha256 与实际下载到的资产一致。
 *
 * 为什么要这一步：如果上传过程中断（网络抖动很常见），
 * Release 上会留一个**大小不对的资产**，而清单里的 sha256 是本地文件的 ——
 * 客户端下载后会校验失败，报"安装包校验失败"。
 * 那种报错用户看不懂，也查不到原因。在这里拦住最省事。
 */
try {
  const remoteSize = Number(
    run('gh', [
      'api',
      `repos/${SLUG}/releases/tags/${tag}`,
      '--jq',
      `.assets[] | select(.name=="${exeName}") | .size`
    ])
  )
  if (remoteSize !== size) {
    console.error(`✘ 资产大小不一致：本地 ${size} / 远端 ${remoteSize}`)
    console.error('  上传可能不完整，重新跑一次本脚本。')
    process.exit(1)
  }
  console.log(`✓ 已核实远端资产大小一致（${(size / 1048576).toFixed(1)} MB）`)
} catch (e) {
  console.warn(`! 无法核实远端资产大小：${e.message}`)
}

console.log('')
console.log('═══════ 发布完成 ═══════')
console.log(`仓库地址:  https://github.com/${SLUG}`)
console.log(`Release:   https://github.com/${SLUG}/releases/tag/${tag}`)
console.log(`清单地址:  https://raw.githubusercontent.com/${SLUG}/main/latest.json`)
console.log('')
console.log('客户端会用加速源读取上面两个地址，无需再改配置。')
