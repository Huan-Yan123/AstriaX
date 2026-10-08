#!/usr/bin/env node
/**
 * 把 dist 里刚打好的产物同步进「成品」文件夹（主人长期要求：成品必须跟着更新）。
 *
 * ## 为什么要写成脚本
 *
 * 这一步以前是手抄的（复制 exe/7z 过去），而"手抄"在发版这种多步骤流程里
 * 迟早会漏 —— 漏一个 WebSetup 或者忘了覆盖 latest.yml，表现是
 * "服务器上是新的、成品文件夹里是旧的"（或反过来），下次照成品发版就错了。
 *
 * 脚本化之后：按**版本**从 dist 里取全部 6 类产物 + 3 份清单，
 * 缺任何一个都报错退出（不做"跳过缺失"的假同步）。
 *
 * 用法：node scripts/sync-to-done-folder.cjs [版本号]
 *       版本号缺省读 package.json
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const DONE = process.env.MXBOT_DONE_DIR || path.join(ROOT, '..', '..', 'MX机器人启动器成品')

const version =
  process.argv[2] || JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version

/**
 * 要同步的产物：[源路径, 目标文件名]
 *
 * ★ 联网安装包（nsis-web）已下线（主人 2026-09-26：「web安装包不搞了」）
 *
 * 原来这里还要求 `dist/nsis-web/` 下的三样东西（WebSetup.exe / nsis.7z /
 * latest-web.yml），而 `electron-builder.yml` 的 target 只剩 `nsis` ——
 * 那些文件不会被产出，于是这个"宁可不做也不做假同步"的 missing 检查
 * **必然失败**，`release.cjs` 第 4 步（同步进成品文件夹）直接卡死。
 * 配置里去掉、脚本里仍要求 = 必挂的中间态，一起清干净。
 */
const ITEMS = [
  [path.join(DIST, `AstriaX-Setup-${version}.exe`), `AstriaX-Setup-${version}.exe`],
  [path.join(DIST, `AstriaX-Setup-${version}.exe.blockmap`), `AstriaX-Setup-${version}.exe.blockmap`],
  // 清单：latest.json 是客户端自更新读的那份，latest.yml 是 electron-updater 的备用清单
  [path.join(DIST, 'latest.json'), 'latest.json'],
  [path.join(DIST, 'latest.yml'), 'latest.yml']
]

if (!fs.existsSync(DONE)) {
  console.error('[FAIL] 成品目录不存在：', DONE)
  process.exit(1)
}

const missing = ITEMS.filter(([src]) => !fs.existsSync(src))
if (missing.length) {
  // 宁可不做，也不做"少同步几件"的假同步
  console.error('[FAIL] dist 里缺这些产物，先确认打包成功：')
  for (const [src] of missing) console.error('   ', src)
  process.exit(1)
}

for (const [src, name] of ITEMS) {
  const dst = path.join(DONE, name)
  fs.copyFileSync(src, dst)
  const mb = (fs.statSync(dst).size / 1048576).toFixed(2)
  console.log(`  ✔ ${name}  (${mb} MB)`)
}

// 自检：latest.json 里的版本必须与被同步的版本一致
const manifest = JSON.parse(fs.readFileSync(path.join(DONE, 'latest.json'), 'utf8'))
if (manifest.version !== version) {
  console.error(`[FAIL] 成品里的 latest.json 版本是 ${manifest.version}，期望 ${version}`)
  process.exit(1)
}
console.log(`\n[OK] 成品文件夹已更新到 ${version}（latest.json 一致）`)
