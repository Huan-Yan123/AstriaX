#!/usr/bin/env node
/**
 * 验证「各源并行探测」那条测试真能抓到"退回串行"。
 *
 * 做法：临时把 version-catalog 的 Promise.all 并行改回 for-await 串行，
 * 跑 dl-failure-fixes.spec.ts，预期那条断言变红（耗时成倍累加）。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const P = path.join(ROOT, 'src', 'main', 'update', 'version-catalog.ts')
const orig = fs.readFileSync(P, 'utf8')

const PARALLEL = `  const probed = await Promise.all(
    sources.map(async (m) => {
      try {
        return m.mode === 'files'
          ? await fromFilesSource({ mirror: m, type: deps.type, fetchJson })
          // 版本列表不过滤测试版：全都列出来，由用户自己决定装不装
          : await fromProxySource({ mirror: m, type: deps.type, fetchJson, includePrerelease: true })
      } catch {
        return [] as VersionItem[] // 这个源不通 → 当它没有版本，继续下一个
      }
    })
  )`

const SERIAL = `  const probed: VersionItem[][] = []
  for (const m of sources) {
    try {
      probed.push(
        m.mode === 'files'
          ? await fromFilesSource({ mirror: m, type: deps.type, fetchJson })
          : await fromProxySource({ mirror: m, type: deps.type, fetchJson, includePrerelease: true })
      )
    } catch {
      probed.push([])
    }
  }`

if (!orig.includes(PARALLEL)) {
  console.error('[FAIL] 找不到并行那段代码，锚点失效')
  process.exit(1)
}

let out = ''
let failed = false
try {
  fs.copyFileSync(P, P + '.probe-bak')
  fs.writeFileSync(P, orig.replace(PARALLEL, SERIAL), 'utf8')
  try {
    out = execFileSync(
      process.execPath,
      [path.join(ROOT, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--no-file-parallelism', 'tests/unit/dl-failure-fixes.spec.ts'],
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

const named = /看起来还是串行的/.test(out)
console.log(failed && named ? '[OK] 退回串行后测试确实红了（说明这条断言真的在验并行）' : `[FAIL] 没抓到（failed=${failed}, named=${named}）`)
for (const l of out.split('\n')) if (/看起来还是串行的/.test(l)) console.log('   ' + l.trim())
console.log('version-catalog.ts 已还原')
process.exit(failed && named ? 0 : 1)
