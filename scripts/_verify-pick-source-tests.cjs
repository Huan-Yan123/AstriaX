#!/usr/bin/env node
/*
 * 尺子：验证 `pick-source-strict.spec.ts` 真能抓到"点哪个源都不管用"那个 bug。
 *
 * 做法：把修复**撤回**成改之前的样子（只读配置里的首选源），
 * 看测试是否变红。不红就说明它守不住。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const IPC = path.join(ROOT, 'src', 'main', 'ipc.ts')
const PAGE = path.join(ROOT, 'src', 'renderer', 'src', 'DownloadPage.vue')

function runTest() {
  try {
    const out = execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--no-file-parallelism',
        'tests/unit/pick-source-strict.spec.ts'
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000 }
    )
    return { failed: false, out }
  } catch (e) {
    return { failed: true, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

function withBackup(file, fn) {
  const bak = file + '.ruler-bak'
  fs.copyFileSync(file, bak)
  try {
    const orig = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, fn(orig), 'utf8')
    return runTest()
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

console.log('=== 尺子：撤回修复，测试是否变红 ===\n')

console.log('[0] 基线（当前代码）')
const base = runTest()
check('基线应当全绿', !base.failed, base.out.slice(-300))

console.log('\n[A] 把 ipc.ts 改回"只看配置里的首选源"')
const a = withBackup(IPC, (s) => {
  const good = 'const pickedSrc = p.base ? findPythonSource(loadPythonSources(cfg.dataRoot).sources, p.base) : undefined'
  if (!s.includes(good)) return s
  return s.replace(good, 'const pickedSrc = undefined')
})
check('源码守卫应当变红（findPythonSource 与 p.base 不再同时出现）', a.failed, a.out.slice(-400))

console.log('\n[B] 把渲染层改回只传 base（Python 源拿不到地址）')
const b = withBackup(PAGE, (s) => {
  const good = 'base: picking.value?.indexUrl ?? picking.value?.base'
  if (!s.includes(good)) return s
  return s.replace(good, 'base: picking.value?.base')
})
check('渲染层守卫应当变红', b.failed, b.out.slice(-400))

console.log('\n[C] 把弹窗的类型切换器加回来')
const c = withBackup(PAGE, (s) => {
  const anchor = '<p v-if="err" class="line bad">{{ err }}</p>'
  if (!s.includes(anchor)) return s
  return s.replace(
    anchor,
    '<div class="seg"><button>AstrBot</button><button>NapCat</button></div>\n          ' + anchor
  )
})
check('类型切换器守卫应当变红', c.failed, c.out.slice(-400))

console.log('\n[D] 把版本列表的大小标注加回来')
const d = withBackup(PAGE, (s) => {
  const anchor = '<span v-if="v.prerelease" class="tag warn">测试版</span>'
  if (!s.includes(anchor)) return s
  return s.replace(anchor, anchor + '\n                <span v-if="v.sizeMB" class="meta">{{ v.sizeMB }} MB</span>')
})
check('大小标注守卫应当变红', d.failed, d.out.slice(-400))

console.log('\n[E] 复查：撤回的都还原了吗')
const after = runTest()
check('还原后应当重新全绿', !after.failed, after.out.slice(-300))

console.log(`\n${pass ? '✔ 尺子通过：这些守卫真的守得住' : '✘ 尺子失败：有的守卫抓不住'}`)
process.exit(pass ? 0 : 1)
