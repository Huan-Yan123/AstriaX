#!/usr/bin/env node
/**
 * 验证「快速切换不泄漏定时器」那条测试**真能抓到泄漏**。
 *
 * 做法：临时把 DownloadPage.vue 卸载时的 stall 时钟清理去掉，
 * 跑 rapid-switch.spec.ts，预期它红（且失败信息里会报"还有 1 个定时器活着"）。
 *
 * 为什么必须验：这条用例的第一版是**空转的** —— 它没推过任何进度事件，
 * 于是 stall 时钟从来没被创建，断言"没有定时器活着"恒真。
 * 我补了"必须先起来"的断言之后，还得证明"泄漏时真的会红"，
 * 否则它可能只是"从一种空转变成了另一种空转"。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const P = path.join(ROOT, 'src', 'renderer', 'src', 'DownloadPage.vue')
const original = fs.readFileSync(P, 'utf8')

// 卸载清理那几行（按实际内容匹配）
//
// ★ 必须先把 CRLF 归一成 LF 再匹配：这个文件在 Windows 上是 CRLF，
// 而脚本里的模板串是 LF —— 直接 includes 会"看着一模一样却匹配不上"
//（我第一版就是这么失败的）。归一化之后两边口径一致。
const NEEDLE = [
  '  // stall 时钟同理：组件都卸载了还在每秒 tick 是纯浪费',
  '  if (stallTimer) clearInterval(stallTimer)',
  '  stallTimer = undefined'
].join('\n')
const normalized = original.replace(/\r\n/g, '\n')
if (!normalized.includes(NEEDLE)) {
  console.error('[FAIL] 找不到卸载清理那段代码，探针锚点失效')
  process.exit(1)
}
const broken = normalized.replace(
  NEEDLE,
  '  // 探针：故意不清 stall 时钟（验证测试能不能抓到）'
)

let bad = 0
try {
  fs.copyFileSync(P, P + '.probe-bak')
  fs.writeFileSync(P, broken, 'utf8')
  let out = ''
  let failed = false
  try {
    out = execFileSync(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--no-file-parallelism', 'tests/ui/rapid-switch.spec.ts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000 }
    )
  } catch (e) {
    failed = true
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }
  const mentionsLeak = /定时器活着|没清干净/.test(out)
  if (failed && mentionsLeak) {
    console.log('[OK] 去掉清理逻辑后测试确实红了，并且指出是定时器泄漏')
    for (const l of out.split('\n')) if (/定时器活着|没清干净/.test(l)) console.log('     ' + l.trim())
  } else {
    console.log(`[FAIL] 没抓到泄漏（failed=${failed}, mentionsLeak=${mentionsLeak}）`)
    bad = 1
  }
} finally {
  fs.copyFileSync(P + '.probe-bak', P)
  fs.unlinkSync(P + '.probe-bak')
  console.log('\nDownloadPage.vue 已还原。')
}
process.exit(bad)
