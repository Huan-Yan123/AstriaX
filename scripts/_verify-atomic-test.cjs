#!/usr/bin/env node
/**
 * 验证「凭据写入必须原子」那组测试**真的能抓到非原子写**。
 *
 * ## 为什么要这一步
 *
 * 那个 spec 里有一条断言"rename 失败时 tmp 被清掉"，
 * 还有一条"写完后没有 .tmp 残留"。这些断言有个自欺风险：
 * 如果我把实现换回裸 `writeFileSync`，**它本来就不会产生 .tmp 文件**，
 * 于是"没有 tmp 残留"这条**照样通过** —— 它测不出非原子！
 *
 * 那真正能区分"原子 / 非原子"的是哪条？
 * 应该是"rename 到非空目录会**抛错**"这类 —— 但那条我直接测的是
 * writeJsonAtomic 本身，换掉 creds.ts 不影响它。
 *
 * 所以这个脚本要回答的问题是：**这组测试里到底有没有一条能区分？**
 * 做法：把 creds.ts 的两处 writeJsonAtomic 换回 writeFileSync，
 * 跑测试，看是否变红。
 *
 *   · 变红 → 有区分力，测试有效
 *   · 全绿 → 说明这组测试**抓不到非原子写**，是安慰剂，需要重新设计
 *
 * 无论结果如何都如实报告 —— 如果是后者，我会去补一条真正有区分力的断言。
 *
 * 用法：node scripts/_verify-atomic-test.cjs
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const CREDS = path.join(ROOT, 'src', 'main', 'creds', 'creds.ts')
const original = fs.readFileSync(CREDS, 'utf8')

/** 把两处原子写换回裸 writeFileSync */
function breakIt(src) {
  let s = src
  s = s.replace(/writeJsonAtomic\(cfgFile, obj\)/, "writeFileSync(cfgFile, JSON.stringify(obj, null, 2), 'utf8')")
  s = s.replace(/writeJsonAtomic\(f, obj\)/, "writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8')")
  return s
}

let bad = 0
const broken = breakIt(original)
if (broken === original) {
  console.error('✘ 没能把 writeJsonAtomic 换回 writeFileSync —— 探针失效')
  process.exit(1)
}

try {
  fs.writeFileSync(CREDS, broken, 'utf8')
  console.log('已把两处原子写换回裸 writeFileSync，跑那组测试……\n')

  let out = ''
  try {
    out = execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', '--no-file-parallelism', 'tests/unit/creds-atomic-write.spec.ts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, shell: process.platform === 'win32' }
    )
  } catch (e) {
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }

  const failed = /(\d+) failed/.exec(out)
  const n = failed ? Number(failed[1]) : 0
  if (n >= 1) {
    console.log(`  ✔ 非原子写下有 ${n} 条失败 —— 这组测试确实能区分原子/非原子`)
    for (const line of out.split('\n')) {
      if (line.includes('×') || line.includes('AssertionError')) console.log('     ' + line.trim())
    }
  } else {
    bad++
    console.log('  ✘ 非原子写下测试**全部通过** —— 这组测试没有区分力')
    console.log('     说明它只是安慰剂：换回裸 writeFileSync 也不会报警。')
    console.log('     需要补一条真正能区分的断言（例如：写入过程中原文件始终完整）。')
  }
} finally {
  fs.writeFileSync(CREDS, original, 'utf8')
  console.log('\ncreds.ts 已还原（writeJsonAtomic 版本）。')
}

process.exit(bad)
