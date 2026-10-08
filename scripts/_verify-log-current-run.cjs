#!/usr/bin/env node
/*
 * 尺子：验证 `instance-log-current-run.spec.ts` 真能抓到"日志时间用 UTC"
 *      和"只显示本次运行"这两个 bug。
 *
 * 撤回方式：
 *   A. 把时间戳改回 `toISOString()` → 时间那条应当红
 *   B. 让 `readLogTail` 忽略 `fromOffset` → "只显示本次"那几条应当红
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const PM = path.join(ROOT, 'src', 'main', 'proc', 'process-manager.ts')
const SNIP = path.join(ROOT, 'src', 'main', 'logs', 'read-snippet.ts')

function run() {
  try {
    const out = execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--no-file-parallelism',
        'tests/unit/instance-log-current-run.spec.ts'
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000 }
    )
    return { failed: false, out }
  } catch (e) {
    return { failed: true, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

function withBroken(file, fn) {
  const bak = file + '.ruler-bak'
  const orig = fs.readFileSync(file, 'utf8')
  const broken = fn(orig)
  if (!broken || broken === orig) return { failed: false, out: '（锚点失效，未改）', skipped: true }
  try {
    fs.copyFileSync(file, bak)
    fs.writeFileSync(file, broken, 'utf8')
    return run()
  } finally {
    fs.copyFileSync(bak, file)
    fs.unlinkSync(bak)
  }
}

let pass = true
const check = (label, ok, detail) => {
  console.log(`  ${ok ? '✔' : '✘'} ${label}`)
  if (!ok) {
    pass = false
    if (detail) console.log('      ' + String(detail).split('\n').slice(0, 3).join('\n      '))
  }
}

console.log('=== 尺子：日志时间 + 只显示本次运行 ===\n')

console.log('[0] 基线')
const base = run()
check('基线应当全绿', !base.failed, base.out.slice(-300))

console.log('\n[A] 把时间戳改回 toISOString（UTC）')
const a = withBroken(PM, (s) => {
  const good = 'const stamp = `${p2(d.getHours())'
  if (!s.includes(good)) return null
  return s.replace(
    /const stamp = `\$\{p2\(d\.getHours\(\)\)[\s\S]*?\}`/,
    'const stamp = new Date().toISOString().slice(11, 23)'
  )
})
check('时间守卫应当变红', a.failed && !a.skipped, a.out.slice(-300))

console.log('\n[B] 让 readLogTail 忽略 fromOffset')
const b = withBroken(SNIP, (s) => {
  const good = 'if (typeof off === \'number\' && off > 0) {'
  if (!s.includes(good)) return null
  return s.replace(good, "if (false) {")
})
check('"只显示本次运行"的用例应当变红', b.failed && !b.skipped, b.out.slice(-300))

console.log('\n[C] 复查还原后')
const after = run()
check('还原后应当重新全绿', !after.failed, after.out.slice(-200))

console.log(`\n${pass ? '✔ 尺子通过：两条修复都守得住' : '✘ 尺子失败'}`)
process.exit(pass ? 0 : 1)
