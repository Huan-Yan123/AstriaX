#!/usr/bin/env node
/**
 * 验证「审计必须跟着当前数据根」那条测试**真的能抓到 bug**。
 *
 * ## 为什么要这一步
 *
 * 那条断言里有一半是**静态**检查（读 ipc.ts 源码找特定写法）。
 * 静态检查最容易犯的错是"永远绿"：正则写宽了、或者匹配到了别的地方，
 * 于是无论代码怎么改都通过 —— 那它就只是个摆设。
 *
 * 做法：把生产代码临时改回**老写法**（启动时 createAuditLog 定死），
 * 跑那条测试，预期**必须失败**。失败 → 检测有效；通过 → 得重写。
 *
 * 原文件用 finally 保证还原。
 *
 * 用法：node scripts/_verify-audit-root-test.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const IPC = path.join(ROOT, 'src', 'main', 'ipc.ts')
const original = fs.readFileSync(IPC, 'utf8')

/**
 * 把惰性代理换回"启动时定死一个实例"的老写法。
 *
 * 老写法（会被静态断言抓到）：
 *   const audit = createAuditLog({ dataRoot: dataRoot0 })
 */
function breakIt(src) {
  const re = /const audit: AuditLog = \{[^}]*\}/
  const m = re.exec(src)
  if (!m) return null
  return (
    src.slice(0, m.index) +
    'const audit = createAuditLog({ dataRoot: dataRoot0 })' +
    src.slice(m.index + m[0].length)
  )
}

let bad = 0
const broken = breakIt(original)
if (!broken || broken === original) {
  console.error('✘ 没能把 audit 换回老写法 —— 探针失效，请更新脚本')
  process.exit(1)
}

try {
  fs.writeFileSync(IPC, broken, 'utf8')
  console.log('已把 audit 换回"启动时定死"的老写法，跑那条测试……\n')

  let out = ''
  try {
    out = execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', '--no-file-parallelism', 'tests/unit/audit-live-root.spec.ts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, shell: process.platform === 'win32' }
    )
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }

  const failed = /(\d+) failed/.exec(out)
  const n = failed ? Number(failed[1]) : 0
  if (n >= 1) {
    console.log(`  ✔ 老写法下有 ${n} 条失败 —— 说明这条测试确实能抓到"审计读错目录"`)
  } else {
    bad++
    console.log('  ✘ 老写法下测试仍然通过 —— 静态断言无效，是个摆设')
    console.log(out.split('\n').slice(-20).join('\n'))
  }
} finally {
  fs.writeFileSync(IPC, original, 'utf8')
  console.log('\nipc.ts 已还原（audit 惰性代理版本）。')
}

process.exit(bad)
