#!/usr/bin/env node
/* 检查反向验证有没有留下未还原的变异（被超时杀掉时最危险） */
const fs = require('fs')
const path = require('path')
const ROOT = path.join(__dirname, '..')

const CHECKS = [
  ['src/main/util/atomic-write.ts', ['const broken = ((('], ['写实例记录是否仍原子']],
  ['tests/unit/instance-meta-atomic.spec.ts', ['describe(<<<'], []],
  ['src/main/ipc.ts', ['const broken = ((('], []],
  ['build/installer.nsh', ['MXBOT_DOES_NOT_EXIST_PROBE'], []]
]

let bad = 0
console.log('')
console.log('  变异残留检查')
console.log('  ' + '-'.repeat(56))

for (const [rel, forbidden] of CHECKS) {
  const p = path.join(ROOT, rel)
  let t
  try {
    t = fs.readFileSync(p, 'utf8')
  } catch {
    console.log('  [--] ' + rel + '  (不存在)')
    continue
  }
  const hits = forbidden.filter((s) => t.includes(s))
  const ffd = (t.match(/\uFFFD/g) || []).length
  if (hits.length || ffd > 0) {
    bad++
    console.log('  [!!] ' + rel)
    if (hits.length) console.log('       残留: ' + hits.join(' | '))
    if (ffd > 0) console.log('       U+FFFD ' + ffd + ' 个（编码被破坏！）')
  } else {
    console.log('  [OK] ' + rel + '  行数 ' + t.split('\n').length)
  }
}

// 关键：原子写必须还在用 tmp+rename
{
  const p = path.join(ROOT, 'src/main/util/atomic-write.ts')
  const t = fs.readFileSync(p, 'utf8')
  const hasTmp = /renameSync\(tmp,\s*file\)/.test(t)
  const hasAtomic = /writeFileSync\(tmp,\s*text/.test(t)
  if (hasTmp && hasAtomic) {
    console.log('  [OK] atomic-write.ts 仍然是 tmp+rename（原子）')
  } else {
    bad++
    console.log('  [!!] atomic-write.ts 的原子性被破坏了！')
  }
}

console.log('  ' + '-'.repeat(56))
console.log(bad === 0 ? '  [OK] 没有残留，工作区干净' : `  [!!] 有 ${bad} 处残留，必须修复`)
console.log('')
process.exit(bad === 0 ? 0 : 1)
