/*
 * 生成服务器用的更新清单 latest.json。
 *
 * 主进程「检查更新」读的就是这份（见 src/main/update/app-update.ts 的说明：
 * 清单用 JSON 而不是 electron-builder 的 latest.yml，因为项目没有 yaml 依赖）。
 *
 * 字段：
 *   version  最新版本号
 *   url      安装包地址（相对清单地址，放在同一目录 → 换域名只改一处）
 *   size     字节数（界面显示大小用）
 *   sha256   下载后校验用
 *   notes    更新说明
 *
 * 用法：node scripts/make-latest-json.cjs <版本号> [说明]
 *       node scripts/make-latest-json.cjs <版本号> --notes-file <文件>
 *
 * ## 为什么必须支持 --notes-file（踩过的坑）
 *
 * 0.1.3 发版时说明是当**命令行参数**传的（`--notes "0.1.3：界面不再卡顿…"`），
 * 结果被 Windows 的命令行编码搞坏了：中文变乱码、并且在 `·` 处被截断
 * （`"notes": "0.1.3：界面不再卡顿（列表不再同步扫描几万文件）·"`）。
 *
 * 这是本项目早就记录过的坑（中文/引号不要走 PowerShell 命令行），
 * 我又踩了一次。所以现在**也支持从文件读**：说明写进 UTF-8 文件，
 * 命令行上只出现一个路径 —— 路径里没有中文就没有编码风险。
 */
const { createHash } = require('crypto')
const { readFileSync, writeFileSync, statSync, existsSync } = require('fs')
const { join } = require('path')

const version = process.argv[2]
const fileIdx = process.argv.indexOf('--notes-file')
const notes =
  fileIdx >= 0
    ? readFileSync(process.argv[fileIdx + 1], 'utf8').trim()
    : (process.argv[3] ?? '')

if (!version) {
  console.error('用法：node scripts/make-latest-json.cjs <版本号> [说明 | --notes-file <文件>]')
  process.exit(1)
}

const exeName = `AstriaX-Setup-${version}.exe`
const exePath = join(__dirname, '..', 'dist', exeName)

if (!existsSync(exePath)) {
  console.error(`✘ 找不到安装包：${exePath}`)
  console.error('  先跑 npx electron-builder --win nsis')
  process.exit(1)
}

const buf = readFileSync(exePath)
const manifest = {
  version,
  url: exeName,
  size: statSync(exePath).size,
  sha256: createHash('sha256').update(buf).digest('hex'),
  notes
}

const out = join(__dirname, '..', 'dist', 'latest.json')
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

console.log('已生成 latest.json：')
console.log(JSON.stringify(manifest, null, 2))
console.log(`\n产物：${out}`)
console.log(`发布时把 ${exeName} 和 latest.json 一起放到服务器的 mxbot/ 目录下。`)
