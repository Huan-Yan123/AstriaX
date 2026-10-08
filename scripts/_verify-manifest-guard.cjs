#!/usr/bin/env node
/**
 * 验证「禁止生产注入 updateManifestUrl」这道自检守卫真的会拦。
 *
 * 做法：临时往 ipc.ts 的生产装配里塞一行 `updateManifestUrl: 'x',`，
 * 跑 self-check，预期它红并指名这一行；完了还原。
 *
 * 为什么值得验：自检里的检查项如果锚点写错（比如正则不匹配真实缩进），
 * 它会**永远通过**——那就是个安慰剂。守卫没被证伪过就不算守卫。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const P = path.join(ROOT, 'src', 'main', 'ipc.ts')
const original = fs.readFileSync(P, 'utf8')

// 找一个真实存在的装配行做锚点（downloadsDir 那一段是 buildHandlers 的参数对象）
const ANCHOR = '    downloadsDir: async () => {'
if (!original.includes(ANCHOR)) {
  console.error('[FAIL] 锚点没找到，探针失效')
  process.exit(1)
}

const injected = original.replace(ANCHOR, "    updateManifestUrl: 'probe-injected',\n" + ANCHOR)

let bad = 0
try {
  fs.copyFileSync(P, P + '.probe-bak')
  fs.writeFileSync(P, injected, 'utf8')

  let out = ''
  let failed = false
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'self-check.cjs')], {
      encoding: 'utf8',
      timeout: 600000
    })
  } catch (e) {
    failed = true
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }

  const named = /updateManifestUrl/.test(out) && /双源回落失效/.test(out)
  if (failed && named) {
    console.log('[OK] 注入后自检确实红了，并且指出了原因：')
    for (const l of out.split('\n')) if (l.includes('updateManifestUrl')) console.log('     ' + l.trim())
  } else {
    console.log('[FAIL] 守卫没拦住（failed=' + failed + ', named=' + named + '）')
    bad = 1
  }
} finally {
  fs.copyFileSync(P + '.probe-bak', P)
  fs.unlinkSync(P + '.probe-bak')
  console.log('\nipc.ts 已还原。')
}
process.exit(bad)
