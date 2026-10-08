/*
 * 用户真实数据目录的完整性快照 / 对比。
 *
 * 为什么需要它：installer.nsh 里的 MXBOT_STASH_KEEP 是**读注册表
 * HKCU\Software\MXBot\DataRoot** 来决定"保护哪个目录"的。任何直接编译
 * 运行 installer.nsh 的测试（包括我一开始写的那个 e2e）如果没先把那个
 * 注册表值指到沙箱里，**动的就是用户真实的数据目录**。
 *
 * 这个脚本只做两件事：
 *   node scripts/data-snapshot.cjs save <file>   存一份快照
 *   node scripts/data-snapshot.cjs diff <file>   和快照比对
 *
 * 快照内容：数据根下每个子目录的文件数/字节数 + 关键文件是否存在。
 * 不做哈希（几十万文件太慢），只比"数量与总量"，足以发现搬家/删一半。
 */
const { existsSync, readdirSync, statSync, writeFileSync, readFileSync, mkdirSync } = require('fs')
const { join, dirname } = require('path')

/** 用户实际的数据根（打包版在 E:\MXBot\data） */
const DATA_ROOT = process.env.MXBOT_DATA_ROOT ?? 'E:\\MXBot\\data'

/** 递归统计一个目录的文件数与总字节数；出错（权限）就记下来，不中断 */
function measure(dir) {
  let files = 0
  let bytes = 0
  const errors = []
  const walk = (d, depth) => {
    if (depth > 12) return
    let ents
    try {
      ents = readdirSync(d, { withFileTypes: true })
    } catch (e) {
      errors.push(`${d}: ${e.code ?? e.message}`)
      return
    }
    for (const e of ents) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else {
        try {
          files++
          bytes += statSync(p).size
        } catch (err) {
          errors.push(`${p}: ${err.code ?? err.message}`)
        }
      }
    }
  }
  walk(dir, 0)
  return { files, bytes, errors: errors.length }
}

function snapshot() {
  const snap = { at: new Date().toISOString(), exists: existsSync(DATA_ROOT), dirs: {}, extra: {} }
  if (!snap.exists) return snap

  // 顶层每个目录单独测（这样"哪个子目录少了"一目了然）
  for (const e of readdirSync(DATA_ROOT, { withFileTypes: true })) {
    const p = join(DATA_ROOT, e.name)
    if (e.isDirectory()) snap.dirs[e.name] = measure(p)
    else {
      try {
        snap.extra[e.name] = statSync(p).size
      } catch {
        snap.extra[e.name] = -1
      }
    }
  }

  // 关键文件点名（缺了就是硬伤）
  snap.key = {}
  for (const f of [
    'config.json',
    'instances.json',
    'runtimes.json',
    'instances\\NapCat\\n_c58a357f6c\\instance.json',
    'instances\\NapCat\\n_c58a357f6c\\.mx-ready',
    'runtime\\python\\python.exe',
    'runtimes\\n\\v4.18.19\\napcat.mjs'
  ]) {
    snap.key[f] = existsSync(join(DATA_ROOT, f))
  }
  return snap
}

const [cmd, file] = process.argv.slice(2)
if (!cmd) {
  console.log('用法: node scripts/data-snapshot.cjs save|diff <file>')
  process.exit(2)
}

if (cmd === 'save') {
  const s = snapshot()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(s, null, 2), 'utf8')
  console.log(`  数据根: ${DATA_ROOT}`)
  console.log(`  已存快照: ${file}`)
  let tf = 0
  let tb = 0
  for (const [k, v] of Object.entries(s.dirs)) {
    console.log(`    ${k.padEnd(16)} ${String(v.files).padStart(7)} 文件  ${(v.bytes / 1048576).toFixed(1).padStart(9)} MB${v.errors ? `  (${v.errors} 项读不到)` : ''}`)
    tf += v.files
    tb += v.bytes
  }
  console.log(`    ${'合计'.padEnd(15)} ${String(tf).padStart(7)} 文件  ${(tb / 1048576).toFixed(1).padStart(9)} MB`)
  const miss = Object.entries(s.key).filter(([, v]) => !v).map(([k]) => k)
  console.log(`  关键文件缺失: ${miss.length ? miss.join(', ') : '无'}`)
} else if (cmd === 'diff') {
  const before = JSON.parse(readFileSync(file, 'utf8'))
  const after = snapshot()
  let bad = 0

  console.log(`  对比 ${before.at} → ${after.at}`)
  for (const k of Object.keys(before.dirs)) {
    const b = before.dirs[k]
    const a = after.dirs[k]
    if (!a) {
      console.log(`    ✘ ${k} 整个目录不见了（原有 ${b.files} 文件）`)
      bad++
      continue
    }
    if (a.files !== b.files) {
      console.log(`    ${a.files < b.files ? '✘' : '·'} ${k.padEnd(14)} 文件 ${b.files} → ${a.files} (${a.files - b.files >= 0 ? '+' : ''}${a.files - b.files})`)
      if (a.files < b.files) bad++
    } else {
      console.log(`    ✔ ${k.padEnd(14)} 文件 ${a.files} 未变`)
    }
  }
  for (const k of Object.keys(after.dirs)) {
    if (!before.dirs[k]) console.log(`    · 新增目录 ${k}（${after.dirs[k].files} 文件）`)
  }
  for (const [k, v] of Object.entries(before.key)) {
    if (v && !after.key[k]) {
      console.log(`    ✘ 关键文件消失: ${k}`)
      bad++
    }
  }

  console.log(bad === 0 ? '\n  ✔ 数据目录没有减少任何文件' : `\n  ✘ 有 ${bad} 处减少/丢失 —— 需要人工介入`)
  process.exit(bad === 0 ? 0 : 1)
} else {
  console.log('未知命令:', cmd)
  process.exit(2)
}
