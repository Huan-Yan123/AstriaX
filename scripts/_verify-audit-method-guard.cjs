#!/usr/bin/env node
/**
 * 验证「不许调审计对象上不存在的方法」这道自检守卫真会拦。
 *
 * 做法：临时往 ipc.ts 塞回一处 `opts.audit?.write?.(...)`，跑 self-check，
 * 预期它红并指出 audit.write；完了还原。
 *
 * 为什么必须验：这正是那个 bug 原来的形态（静默空操作），
 * 守卫如果锚点写错就会永远通过 —— 那就白加了。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const P = path.join(ROOT, 'src', 'main', 'ipc.ts')
const original = fs.readFileSync(P, 'utf8')

const ANCHOR = '  const handlers = buildHandlers({'
if (!original.includes(ANCHOR)) {
  console.error('[FAIL] 锚点没找到')
  process.exit(1)
}
const injected = original.replace(
  ANCHOR,
  "  opts.audit?.write?.('探针：这行应当被自检拦下', '成功')\n" + ANCHOR
)

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
  const named = /audit\.write/.test(out) && /静默/.test(out)
  if (failed && named) {
    console.log('[OK] 注入后自检确实红了，并指出 audit.write 是静默空操作：')
    for (const l of out.split('\n')) if (/audit\.write/.test(l)) console.log('     ' + l.trim())
  } else {
    console.log(`[FAIL] 守卫没拦住（failed=${failed}, named=${named}）`)
    bad = 1
  }
} finally {
  fs.copyFileSync(P + '.probe-bak', P)
  fs.unlinkSync(P + '.probe-bak')
  console.log('\nipc.ts 已还原。')
}
process.exit(bad)
