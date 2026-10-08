#!/usr/bin/env node
/**
 * 验证 SWR 那组测试真能抓到"没有缓存"。
 *
 * 做法：临时让 dlHydrate() 永远返回 null（= 完全没有 SWR），
 * 跑 tests/ui/dl-cache.spec.ts，预期至少 2 条红：
 *   · 「第二次进入立刻可见」（没有缓存就只能是空白）
 *   · 「60s 内不重复探测」（没有缓存就没有 probeAt，每次都重探）
 * 完了还原。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const P = path.join(ROOT, 'src', 'renderer', 'src', 'dl-cache.ts')
const original = fs.readFileSync(P, 'utf8')

const broken = original
  .replace(
    /export function dlHydrate\(\): DlSnapshot \| null \{\r?\n\s*return snap\r?\n\}/,
    'export function dlHydrate(): DlSnapshot | null {\n  return null // 探针：模拟"完全没有缓存"\n}'
  )
  /*
   * 节流也要一起禁掉：第一版只禁用了水合，结果"60s 不重复探测"那条**照样过**
   *（因为节流读的是 snap，与 dlHydrate 无关）。要模拟"这个功能从来没存在过"，
   * 必须把节流也变成"永远不拦"。这也解释了第一版为什么只红 1 条。
   */
  .replace(
    /export function dlProbeBlocked\(\): boolean \{\r?\n\s*if \(!snap\) return false\r?\n\s*return Date\.now\(\) - snap\.probeAt < PROBE_TTL_MS\r?\n\}/,
    'export function dlProbeBlocked(): boolean {\n  return false // 探针：模拟"没有节流"\n}'
  )
if (broken === original) {
  console.error('[FAIL] 注入失败：锚点没匹配上')
  process.exit(1)
}

let bad = 0
try {
  fs.copyFileSync(P, P + '.probe-bak')
  fs.writeFileSync(P, broken, 'utf8')
  console.log('已禁用缓存（dlHydrate 恒 null），跑测试……\n')
  let out = ''
  try {
    out = execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', '--no-file-parallelism', 'tests/ui/dl-cache.spec.ts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 600000, shell: process.platform === 'win32' }
    )
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }
  const failed = /(\d+) failed/.exec(out)
  const n = failed ? Number(failed[1]) : 0
  if (n >= 2) {
    console.log(`[OK] 无缓存时 ${n} 条失败 —— 这组测试确实在验"缓存有没有生效"`)
    for (const l of out.split('\n')) if (l.includes('×')) console.log('     ' + l.trim())
  } else {
    console.log(`[FAIL] 无缓存时只 ${n} 条失败 —— 断言抓不到"没有缓存"`)
    bad = 1
  }
} finally {
  fs.copyFileSync(P + '.probe-bak', P)
  fs.unlinkSync(P + '.probe-bak')
  console.log('\ndl-cache.ts 已还原。')
}
process.exit(bad)
