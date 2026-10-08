#!/usr/bin/env node
/**
 * 验证「遮罩必须按取消结算」那组测试**真的能抓到旧行为**。
 *
 * 做法：把 AppDialog 模板临时改回老的 `@click.self="emit('close')"`
 * （并禁用 Esc 路径），跑 tests/ui/app-dialog-dismiss.spec.ts，
 * 预期至少 3 条红。然后还原。
 *
 * ASCII-only，不走 PowerShell 内联。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const P = path.join(ROOT, 'src', 'renderer', 'src', 'AppDialog.vue')
const original = fs.readFileSync(P, 'utf8')

let broken = original
if (!broken.includes('@click.self="dismissViaCancel()"')) {
  console.error('找不到遮罩绑定 —— 探针锚点失效')
  process.exit(1)
}
broken = broken.replace('@click.self="dismissViaCancel()"', '@click.self="emit(\'close\')"')

const tmp = P + '.probe-bak'
try {
  fs.copyFileSync(P, tmp) // ★ 先备份再改 —— 否则 finally 里拿什么还原？
  fs.writeFileSync(P, broken, 'utf8')
  console.log('已把遮罩点击改回老的"只关闭"，跑测试……\n')
  let out = ''
  let code = 0
  try {
    out = execFileSync(
      process.platform === 'win32' ? 'npx.cmd' : 'npx',
      ['vitest', 'run', '--no-file-parallelism', 'tests/ui/app-dialog-dismiss.spec.ts'],
      { cwd: ROOT, encoding: 'utf8', timeout: 600000, shell: process.platform === 'win32' }
    )
  } catch (e) {
    code = 1
    out = String(e.stdout ?? '') + String(e.stderr ?? '')
  }
  const failed = /(\d+) failed/.exec(out)
  const n = failed ? Number(failed[1]) : 0
  if (n >= 2) {
    console.log(`[OK] 旧行为下 ${n} 条失败 —— 测试确实守住了"遮罩=取消"`)
  } else {
    console.log(`[FAIL] 旧行为下只有 ${n} 条失败 —— 断言有漏洞`)
    console.log(out.split('\n').slice(-18).join('\n'))
    code = 1
  }
} finally {
  fs.copyFileSync(tmp, P)
  fs.unlinkSync(tmp)
  console.log('\nAppDialog.vue 已还原。')
}
process.exit(code)
