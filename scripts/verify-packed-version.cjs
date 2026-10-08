#!/usr/bin/env node
/*
 * 读 dist/win-unpacked/resources/app.asar 里的 package.json，确认
 * **打进包里的版本号**和 package.json 里写的一致。
 *
 * 为什么值得单独验一次：
 * electron-builder 的 version 来自 package.json，但产物文件名也来自它。
 * 万一有缓存（out/ 是旧的、或 dist/ 是上次 0.1.1 的残留），
 * 会出现"文件名写着 0.1.2、里面其实还是 0.1.1"的错位 ——
 * 用户装完仍然会被同版本拦截挡下，或者更糟：以为更新了其实没更新。
 * 这种错位光看文件名看不出来，必须进 asar 里读。
 *
 * 教训：本文件必须写成 .cjs 而不是 `node -e "..."`。
 * 这次我又用 node -e 传正则，PowerShell 把 `\d+` 当成命令去执行了。
 * 这个坑之前已经踩过 3 次，规则是"永远写 .cjs"。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const ASAR = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar')

function readFromAsar(asarPath, entry) {
  const buf = fs.readFileSync(asarPath)

  /*
   * asar 的目录区是一个 Pickle：
   *   [0..3]   = 4
   *   [4..7]   = 头部 pickle 剩余长度
   *   [8..11]  = JSON 字符串长度（含 4 字节长度字段）
   *   [12..15] = JSON 字符串真实长度
   *   [16..]   = JSON 目录
   *
   * 第一版按 `readUInt32LE(12)` 当长度、从 16 取 JSON —— 结果 JSON.parse
   * 在 292 字节处报"缺逗号"，说明**长度对但起点/对齐差了**（Pickle 会
   * 把字符串按 4 字节对齐并填充）。
   *
   * 与其继续猜偏移，不如**做括号配平**把 JSON 抠出来：
   * 从 16 之后的第一个 `{` 开始，数花括号，配平即结束。
   * JSON 里可能有字符串内的花括号，所以顺带处理引号与转义。
   */
  let start = buf.indexOf(0x7b, 16) // '{'
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  let end = -1
  for (let i = start; i < buf.length; i++) {
    const c = buf[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === 0x5c) esc = true // backslash
      else if (c === 0x22) inStr = false // quote
      continue
    }
    if (c === 0x22) inStr = true
    else if (c === 0x7b) depth++
    else if (c === 0x7d) {
      depth--
      if (depth === 0) {
        end = i + 1
        break
      }
    }
  }
  if (end < 0) return null

  const json = JSON.parse(buf.slice(start, end).toString('utf8'))
  const base = buf.readUInt32LE(4) + 8 // 文件数据区起点

  const parts = entry.split('/').filter(Boolean)
  let node = json
  for (const p of parts) {
    if (!node || !node.files || !node.files[p]) return null
    node = node.files[p]
  }
  if (!node || typeof node.offset !== 'string' || typeof node.size !== 'number') return null
  const off = Number(node.offset)
  return buf.slice(base + off, base + off + node.size).toString('utf8')
}

console.log('')
console.log('  校验打进包里的版本号')
console.log('  ' + '='.repeat(58))

if (!fs.existsSync(ASAR)) {
  console.log('  找不到 ' + ASAR)
  console.log('  （说明还没打包，或 dist 被清理过）')
  process.exit(1)
}

const declared = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
console.log('  package.json 声明版本 : ' + declared)

const raw = readFromAsar(ASAR, 'package.json')
if (!raw) {
  console.log('  [!!] asar 里读不到 package.json —— 打包可能不完整')
  process.exit(1)
}

const pkg = JSON.parse(raw)
console.log('  asar 内实际版本       : ' + pkg.version)
console.log('  asar 内 name          : ' + pkg.name)

const ok = pkg.version === declared
console.log('')
console.log(ok ? '  [OK] 版本一致' : '  [!!] 版本不一致！产物可能是旧的（缓存残留）')
console.log('')

// 顺便确认产物文件名也带上这个版本
const setup = path.join(ROOT, 'dist', `AstriaX-Setup-${pkg.version}.exe`)
console.log(
  '  安装包 ' + path.basename(setup) + ' : ' + (fs.existsSync(setup) ? '存在' : '★不存在！文件名对不上版本')
)

process.exit(ok && fs.existsSync(setup) ? 0 : 1)
