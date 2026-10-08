#!/usr/bin/env node
/**
 * 验证「搬家守卫」那组测试真能抓到两个缺陷。
 *
 * 撤掉两处修复：
 *   1. 停机判活改回读磁盘 status（`rec.status === 'running' || ...`）
 *   2. 去掉 relocateActive 防重入守卫
 * 预期：至少 2 条变红（"实例在跑却不停止" + "第二次搬家没被拒"）。
 * 完了还原。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const P = path.join(ROOT, 'src', 'main', 'ipc.ts')
const original = fs.readFileSync(P, 'utf8')

function breakIt(src) {
  let s = src
  const before = s

  // 1) 判活退回"读磁盘 status"
  s = s.replace(
    /const liveRec = await liveStatusOf\(rec\)\r?\n\s*const rawProc = pm\.statusOf\(rec\.id\)\r?\n\s*const busy = \['running', 'starting'\]\r?\n\s*if \(busy\.includes\(liveRec\.status\) \|\| busy\.includes\(rawProc \?\? ''\)\) \{/,
    "if (rec.status === 'running' || rec.status === 'starting') {"
  )

  // 2) 去掉防重入守卫（把 if (relocateActive) {...} 整段删掉）
  s = s.replace(/      if \(relocateActive\) \{\r?\n[\s\S]*?\r?\n      \}\r?\n/, '')

  if (s === before) return null
  return s
}

let bad = 0
const broken = breakIt(original)
if (!broken) {
  console.error('[FAIL] 注入失败：锚点没匹配上，请更新脚本')
  process.exit(1)
}

try {
  fs.copyFileSync(P, P + '.probe-bak')
  fs.writeFileSync(P, broken, 'utf8')
  console.log('已撤掉两处修复（读盘判活 + 无防重入），跑测试……\n')

  let out = ''
  try {
    out = execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', '--no-file-parallelism', 'tests/unit/move-guard.spec.ts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 600000, shell: process.platform === 'win32' }
    )
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }
  const failed = /(\d+) failed/.exec(out)
  const n = failed ? Number(failed[1]) : 0
  if (n >= 2) {
    console.log(`[OK] 撤掉修复后有 ${n} 条失败 —— 测试确实守住了这两条契约`)
    for (const l of out.split('\n')) if (l.includes('×')) console.log('     ' + l.trim())
  } else {
    console.log(`[FAIL] 撤掉修复后只 ${n} 条失败 —— 断言有漏洞`)
    console.log(out.split('\n').slice(-16).join('\n'))
    bad = 1
  }
} finally {
  fs.copyFileSync(P + '.probe-bak', P)
  fs.unlinkSync(P + '.probe-bak')
  console.log('\nipc.ts 已还原。')
}
process.exit(bad)
