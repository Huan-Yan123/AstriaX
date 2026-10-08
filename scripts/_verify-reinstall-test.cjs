#!/usr/bin/env node
/**
 * 验证「重装不能毁掉可用运行时」那组测试**真的能抓到那个 bug**。
 *
 * ## 这个脚本本身是有来历的
 *
 * 我第一版测试**立刻通过**了 —— 而当时 bug 还好好地在那儿。
 * 用 `_dbg-reinstall.cjs` 才发现：测试没造 python.exe，
 * 于是代码在 `if (!existsSync(pyExe)) throw` 就提前返回，
 * pip 那行和失败分支一行都没跑，而我的断言 `/Python/i` 恰好匹配那句
 * 提前抛错。**那是安慰剂。**
 *
 * 改成造假 python.exe 之后测试红了（正确的红）。现在再做最后一步：
 * 把修复撤掉，确认它**仍然红** —— 只有这样才能证明这条测试
 * 真的守住了"失败时不许删用户运行时"。
 *
 * ## 做法
 *
 * 把失败分支里的 `removeDirAsync(stageDir)` 换回老的 `removeDirAsync(dest)`,
 * 并把 pip 的 --target 也换回 dest（等价于修复前的行为），跑测试。
 * 预期：那几条必须失败。
 *
 * 用法：node scripts/_verify-reinstall-test.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const IPC = path.join(ROOT, 'src', 'main', 'ipc.ts')
const original = fs.readFileSync(IPC, 'utf8')

/**
 * 撤掉修复，恢复"就地装 + 失败删 dest"的老行为。
 *
 * 只改两处，最小化改动面：
 *   1. pip 的 --target 从 stageDir 改回 dest
 *   2. 失败分支的 removeDirAsync(stageDir) 改回 removeDirAsync(dest)
 *   3. 本体校验也从 stageDir 改回 dest（否则它会因为"stage 里没有"而误报）
 */
function breakIt(src) {
  let s = src
  const before = s

  // 1) pip --target stageDir → dest
  s = s.replace(
    /'--target',\s*stageDir,/,
    "'--target', dest,"
  )
  // 2) 失败分支清 dest（老行为 = 毁掉用户运行时）
  s = s.replace(
    /if \(r\.status !== 0\) \{\s*await removeDirAsync\(stageDir\)/,
    'if (r.status !== 0) {\n          await removeDirAsync(dest)'
  )
  // 3) 本体校验改回 dest
  s = s.replace(
    /if \(!existsSync\(join\(stageDir, 'astrbot', '__init__\.py'\)\)\)/,
    "if (!existsSync(join(dest, 'astrbot', '__init__.py')))"
  )

  if (s === before) return null
  return s
}

let bad = 0
const broken = breakIt(original)
if (!broken) {
  console.error('✘ 注入失败 —— 找不到要替换的代码，请更新本脚本的锚点')
  process.exit(1)
}

// 确认三处都改到了（注入必须真的生效，否则结论无意义）
const checks = [
  ["'--target', dest,", 'pip 指向 dest'],
  ['removeDirAsync(dest)', '失败时删 dest'],
  ["existsSync(join(dest, 'astrbot'", '本体校验查 dest']
]
console.log('注入校验：')
let injectOk = true
for (const [needle, label] of checks) {
  const hit = broken.includes(needle)
  console.log(`  [${hit ? 'OK ' : 'FAIL'}] ${label}`)
  if (!hit) injectOk = false
}
if (!injectOk) {
  console.error('✘ 注入不完整，中止（结论会不可靠）')
  process.exit(1)
}

try {
  fs.writeFileSync(IPC, broken, 'utf8')
  console.log('\n已恢复"就地装 + 失败删用户目录"的老行为，跑测试……\n')

  let out = ''
  try {
    out = execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', '--no-file-parallelism', 'tests/unit/runtime-reinstall-safe.spec.ts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 600000, shell: process.platform === 'win32' }
    )
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }

  const failed = /(\d+) failed/.exec(out)
  const n = failed ? Number(failed[1]) : 0
  if (n >= 2) {
    console.log(`  ✔ 老行为下有 ${n} 条失败 —— 这组测试确实守住了"失败不许删用户运行时"`)
    for (const line of out.split('\n')) {
      if (line.includes('×')) console.log('     ' + line.trim())
    }
  } else {
    bad++
    console.log(`  ✘ 老行为下只有 ${n} 条失败 —— 测试不足以防住这个 bug`)
    console.log(out.split('\n').slice(-20).join('\n'))
  }
} finally {
  fs.writeFileSync(IPC, original, 'utf8')
  console.log('\nipc.ts 已还原（暂存目录 + 原子替换版本）。')
}

process.exit(bad)
