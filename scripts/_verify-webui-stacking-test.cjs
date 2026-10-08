#!/usr/bin/env node
/*
 * 验证：`webui-stacking.spec.ts` 真能抓到"多个 WebUI 视图互相堆叠"那个 bug。
 *
 * 做法：把 webui-manager 的 `showOnly` 改成**空操作**（= 第一版的行为：
 * 谁都不隐藏，视图就一层盖一层），跑测试，预期它变红。
 * 如果照样绿，说明这条测试抓不住那个用户反馈的现象。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const P = path.join(ROOT, 'src', 'main', 'webui', 'webui-manager.ts')
const orig = fs.readFileSync(P, 'utf8')

// 找到 showOnly 的函数体，把它改成"什么都不做"
const NEEDLE = `    for (const [key, v] of open) {
      try {
        v.setVisible?.(key === id)
      } catch {
        /* 测试用的假 view 可能没实现；生产实现失败也不该让打开动作失败 */
      }
    }
    visibleId = id`
const BROKEN = `    // 探针：故意不改可见性（等价于第一版"谁都不隐藏"）
    visibleId = id`

if (!orig.includes(NEEDLE)) {
  console.error('[FAIL] 找不到 showOnly 的函数体，锚点失效')
  process.exit(1)
}

let out = ''
let failed = false
try {
  fs.copyFileSync(P, P + '.probe-bak')
  fs.writeFileSync(P, orig.replace(NEEDLE, BROKEN), 'utf8')
  try {
    out = execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--no-file-parallelism',
        'tests/unit/webui-stacking.spec.ts'
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

const caught = /互相堆叠|只能有一个|点了 NapCat 就该看到 NapCat|不该可见/.test(out)
const ok = failed && caught
console.log(
  ok
    ? '[OK] 去掉"只显示一个"的逻辑后测试立刻红（说明它真在验那个用户反馈的 bug）'
    : `[FAIL] 没抓到（failed=${failed} caught=${caught}）`
)
for (const l of out.split('\n')) {
  if (/×|expected .* to be|AssertionError/.test(l)) console.log('   ' + l.trim())
}
console.log('文件已还原')
process.exit(ok ? 0 : 1)
