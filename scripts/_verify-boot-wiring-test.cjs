#!/usr/bin/env node
/*
 * 验证：`boot-watch-wiring.spec.ts` 真能抓到"判断用错状态对象"那个 bug。
 *
 * 做法：把测试里复刻的编排**故意写反**（先 beginBoot 再判断 —— 就是第一版的错法），
 * 跑测试，预期它变红。如果照样绿，说明这条测试是空转的。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const P = path.join(ROOT, 'tests', 'unit', 'boot-watch-wiring.spec.ts')
const orig = fs.readFileSync(P, 'utf8')

// 正确的编排（被测对象）
const RIGHT = `  const prev = readBootState(root)
  const isBootFail = shouldAlertBootFailure(prev)
  const isCrashLoop = !isBootFail && shouldAlertCrash(prev)
  beginBoot(root, now)
  if (isBootFail) return 'boot-fail'
  if (isCrashLoop) return 'crash-loop'
  return 'none'`

// 第一版的**错误**编排：先自增、再拿自增后的状态判断
const WRONG = `  beginBoot(root, now)
  const st = readBootState(root)
  const isBootFail = shouldAlertBootFailure(st)
  const isCrashLoop = !isBootFail && shouldAlertCrash(st)
  if (isBootFail) return 'boot-fail'
  if (isCrashLoop) return 'crash-loop'
  return 'none'`

if (!orig.includes(RIGHT)) {
  console.error('[FAIL] 找不到被测编排，锚点失效')
  process.exit(1)
}

let out = ''
let failed = false
try {
  fs.copyFileSync(P, P + '.probe-bak')
  fs.writeFileSync(P, orig.replace(RIGHT, WRONG), 'utf8')
  try {
    out = execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--no-file-parallelism',
        'tests/unit/boot-watch-wiring.spec.ts'
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000 }
    )
  } catch (e) {
    failed = true
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }
} finally {
  fs.copyFileSync(P + '.probe-bak', P)
  fs.unlinkSync(P + '.probe-bak')
}

// 期望：至少"全新安装第一次启动"与"连续健康启动"两条变红
const caughtNew = /全新安装第一次启动|全新机器不该被弹/.test(out)
const caughtHealthy = /健康启动不该弹框/.test(out)
const ok = failed && caughtNew && caughtHealthy
console.log(
  ok
    ? '[OK] 写反编排后测试确实红了（说明这条接线测试真的在验顺序）'
    : `[FAIL] 没抓到（failed=${failed} new=${caughtNew} healthy=${caughtHealthy}）`
)
for (const l of out.split('\n')) {
  if (/×|expected .* to be/.test(l)) console.log('   ' + l.trim())
}
console.log('文件已还原')
process.exit(ok ? 0 : 1)
