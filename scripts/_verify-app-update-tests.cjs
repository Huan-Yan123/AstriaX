#!/usr/bin/env node
/*
 * 尺子：验证 `app-update-same-version.spec.ts` 真能抓到那两个 bug。
 *
 * 做法：把修复**逐一撤回**，看测试是否变红。
 *   A) 把 `url: undefined` 那种合成写法放回去 → 源码守卫应变红
 *   B) 把渲染层的裸 `return` 放回去 → 渲染层守卫应变红
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const IPC = path.join(ROOT, 'src', 'main', 'ipc.ts')
const SETTINGS = path.join(ROOT, 'src', 'renderer', 'src', 'SettingsPanel.vue')

function runTest() {
  try {
    const out = execFileSync(
      process.execPath,
      [
        path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'),
        'run',
        '--no-file-parallelism',
        'tests/unit/app-update-same-version.spec.ts'
      ],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000 }
    )
    return { failed: false, out }
  } catch (e) {
    return { failed: true, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

function withBackup(file, fn) {
  const orig = fs.readFileSync(file, 'utf8')
  const bak = file + '.ruler-bak'
  fs.copyFileSync(file, bak)
  try {
    fs.writeFileSync(file, fn(orig), 'utf8')
    return runTest()
  } finally {
    fs.copyFileSync(bak, file)
    fs.unlinkSync(bak)
  }
}

let pass = true
function check(label, ok, detail) {
  console.log(`  ${ok ? '✔' : '✘'} ${label}`)
  if (!ok) {
    pass = false
    if (detail) console.log('      ' + detail.split('\n').slice(0, 4).join('\n      '))
  }
}

console.log('=== 尺子：撤回修复，测试是否变红 ===\n')

// 基线：不撤回时必须全绿
console.log('[0] 基线（当前代码）')
const base = runTest()
check('基线应当全绿', !base.failed, base.out.slice(-300))

// A) 放回 `url: undefined`（那正是"有更新但没直链"的写法）
console.log('\n[A] 把 `url: undefined` 放回 ipc.ts')
const a = withBackup(IPC, (s) => {
  // 在 checkAppUpdate 调用后插一句典型的错误合成
  const anchor = 'const r = await safeCheck(current)'
  if (!s.includes(anchor)) return s
  return s.replace(
    anchor,
    'const _via = { hasUpdate: true, currentVersion: current, latestVersion: "9.9.9" }\n' +
      'const _bad = ({ ..._via, url: undefined })\n' +
      'void _bad\n' +
      anchor
  )
})
check('源码守卫应当变红', a.failed && /url: undefined/.test(a.out), a.out.slice(-400))

// B) 放回渲染层的裸 return
console.log('\n[B] 把 doUpdate 的裸 return 放回')
const b = withBackup(SETTINGS, (s) => {
  const full =
    'if (!info?.url || !info.version) {\n' +
    "    updErr.value = true\n" +
    "    updMsg.value = '这条更新信息不完整，暂时下不了 —— 过一会儿再点「检查更新」试试'\n" +
    '    return\n' +
    '  }'
  if (!s.includes(full)) return s
  return s.replace(full, 'if (!info?.url || !info.version) return')
})
check('渲染层守卫应当变红', b.failed && /缺字段|静默/.test(b.out), b.out.slice(-400))

// C) 基线复查（确认撤回后已还原）
console.log('\n[C] 复查：撤回的两处都还原了吗')
const after = runTest()
check('还原后应当重新全绿', !after.failed, after.out.slice(-300))

console.log(`\n${pass ? '✔ 尺子通过：这些测试真的在守那两个 bug' : '✘ 尺子失败：有的测试抓不住'}`)
process.exit(pass ? 0 : 1)
