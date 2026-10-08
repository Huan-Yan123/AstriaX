#!/usr/bin/env node
/**
 * 一条命令走完发版（避免"漏一步"这类事故）。
 *
 * ## 为什么需要它
 *
 * 0.1.3 这次我就差点漏了「生成 latest.json」那一步 —— 它是**项目脚本**
 * 生成的（不是 electron-builder 写的），打完包如果忘了跑，
 * 服务器上的清单还指着**上一个版本**：用户点"检查更新"被告知最新，
 * 而其实新版早就打好了。这类"流程漏步"没有任何报错，只有用户会发现。
 *
 * 所以把顺序固定下来：
 *   1. 自检 + 全量测试（full-check）
 *   2. 打包（electron-builder，仅 nsis 全量包）
 *   3. 生成 latest.json（版本号取自 package.json，说明由调用方给）
 *   4. 同步进「成品」文件夹
 *   5. 上传到官方源（scripts/upload-release.py）
 *   6. 逐文件验收（scripts/verify-new-host-release.py，比 sha256）
 *
 * 任何一步失败**立即停**，不往下走（半成品发出去比不发更糟）。
 *
 * 用法：
 *   node scripts/release.cjs --notes "本次更新说明"
 *   node scripts/release.cjs --notes-file "E:\...\更新说明.txt"   ← **推荐**
 *   node scripts/release.cjs --skip-check      # 已经跑过全量测试时
 *   node scripts/release.cjs --skip-upload     # 只打包+落成品
 *
 * ## 为什么推荐 --notes-file（我自己踩过两次）
 *
 * 中文说明经命令行传递会被 Windows 的编码/引号处理搞坏：
 * 第一次是**截断+乱码**（在 `·` 处断掉），第二次更隐蔽 ——
 * 我传 `--notes-file`，但本脚本当时只认 `--notes`，于是那个参数被
 * **静默忽略**，线上清单里的说明直接是空的（176 字节），
 * 而所有校验都"通过"（校验的是版本与 sha256，没人查说明）。
 *
 * 现在两种都支持，并把说明来源打印出来 —— 至少要让人看见"说明是从哪来的"。
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const args = process.argv.slice(2)
const skipCheck = args.includes('--skip-check')
const skipUpload = args.includes('--skip-upload')
const notesIdx = args.indexOf('--notes')
const notesFileIdx = args.indexOf('--notes-file')
const notes = notesIdx >= 0 ? args[notesIdx + 1] ?? '' : ''
const notesFile = notesFileIdx >= 0 ? args[notesFileIdx + 1] ?? '' : ''

if (notesFile && !fs.existsSync(notesFile)) {
  console.error(`[FAIL] --notes-file 指定的文件不存在：${notesFile}`)
  process.exit(1)
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
if (!version || version === '0.0.0') {
  console.error('[FAIL] package.json 里的版本号看起来不对：', version)
  process.exit(1)
}

/** 跑一步；失败就停（这就是本脚本存在的意义） */
function step(name, cmd, cmdArgs, opts = {}) {
  console.log(`\n═══ ${name} ═══`)
  const r = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...opts
  })
  if (r.status !== 0) {
    console.error(`\n[FAIL] ${name} 失败（退出码 ${r.status}）—— 就此停住，不继续往下发`)
    process.exit(1)
  }
  console.log(`[OK] ${name}`)
}

console.log(`AstriaX 发版：${version}`)
if (notesFile) console.log(`说明来源：文件 ${notesFile}`)
else if (notes) console.log(`说明来源：命令行参数（中文经命令行有编码风险，建议改用 --notes-file）`)
else console.log('说明来源：（空）—— 线上清单里不会有更新说明')

if (!skipCheck) step('1/6 自检 + 全量测试', 'node', ['scripts/full-check.cjs'])
step('2/6 打包（nsis 全量包）', 'npx', ['electron-builder'])
// 说明优先走文件：命令行传中文会被 Windows 编码搞坏（踩过两次，见文件头）
step(
  '3/6 生成更新清单 latest.json',
  'node',
  notesFile
    ? ['scripts/make-latest-json.cjs', version, '--notes-file', notesFile]
    : ['scripts/make-latest-json.cjs', version, notes]
)
step('4/6 同步进成品文件夹', 'node', ['scripts/sync-to-done-folder.cjs', version])

if (!skipUpload) {
  if (!process.env.MXBOT_SSH_PASSWORD) {
    console.error('\n[FAIL] 没设 MXBOT_SSH_PASSWORD（上传需要它；不想上传就加 --skip-upload）')
    process.exit(1)
  }
  step('5/6 上传到官方源', 'python', ['scripts/upload-release.py'])
  step('6/6 逐文件验收（含 sha256）', 'python', ['scripts/verify-new-host-release.py'])
} else {
  console.log('\n（已按 --skip-upload 跳过上传与验收）')
}

console.log(`\n★ ${version} 发版完成`)
