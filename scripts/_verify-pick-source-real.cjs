#!/usr/bin/env node
/*
 * 尺子：验证 `pick-source-real.spec.ts` 真能抓到"点哪个源都一样"那个 bug。
 *
 * 撤回方式：把 `pickedSrc` 改回 `undefined`（= 只看配置里的首选源），
 * 看测试是否变红。
 *
 * 这条尺子特别重要 —— 上一版（源码守卫）就是**假绿**的：
 * 它检查"代码长得对"，而实际运行时因为 `findPythonSource` 没导入直接抛错，
 * 它照样全绿。这次必须确认新测试真的守在运行时行为上。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const IPC = path.join(ROOT, 'src', 'main', 'ipc.ts')

function runTest() {
  try {
    const out = execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--no-file-parallelism',
        'tests/unit/pick-source-real.spec.ts'
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000 }
    )
    return { failed: false, out }
  } catch (e) {
    return { failed: true, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

const GOOD =
  "const pickedSrc = p.base ? findPythonSource(loadPythonSources(cfg.dataRoot).sources, p.base) : undefined"

const orig = fs.readFileSync(IPC, 'utf8')
if (!orig.includes(GOOD)) {
  console.error('[FAIL] 锚点失效，找不到 pickedSrc 那行')
  process.exit(1)
}

/* 先跑基线 */
console.log('[0] 基线')
const base = runTest()
console.log(base.failed ? '  ✘ 基线就红了（先修代码）' : '  ✔ 基线全绿')
if (base.failed) process.exit(1)

/* 撤回：忽略界面传的 base，只看配置 */
console.log('\n[1] 撤回：把 pickedSrc 改成 undefined（= 只看配置里的首选源）')
const bak = IPC + '.ruler-bak'
let broken
try {
  fs.copyFileSync(IPC, bak)
  fs.writeFileSync(IPC, orig.replace(GOOD, 'const pickedSrc = undefined'), 'utf8')
  broken = runTest()
} finally {
  fs.copyFileSync(bak, IPC)
  fs.unlinkSync(bak)
  console.log('  文件已还原')
}

const caught =
  broken.failed && /用户点的是腾讯源，pip 必须用它|配置里是腾讯源/.test(broken.out)

console.log(
  caught
    ? '\n✔ 尺子通过：撤回修复后测试立刻红，并指名"pip 用了错的源"'
    : `\n✘ 尺子失败：没抓到（failed=${broken.failed}）—— 这些测试是摆设`
)

if (!caught) {
  for (const l of broken.out.split('\n').filter((l) => /×|→|实际用了/.test(l)).slice(0, 8)) {
    console.log('   ' + l.trim())
  }
}

process.exit(caught ? 0 : 1)
