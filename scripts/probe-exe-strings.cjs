/*
 * 测一下：安装包 exe 里到底还能不能搜到 NSIS 脚本的字符串？
 *
 * 背景：`verify-installer.cjs` 想在 exe 里搜 `MXBot-update-keep` 之类的
 * 标记来证明"新脚本编进去了"。但 NSIS 会把所有脚本数据 **LZMA 压缩**，
 * 所以明文搜是搜不到的 —— 那个脚本报的 6 处"缺失"全是假阴性。
 *
 * 这个脚本只是把事实摆出来（哪些串能搜到、哪些搜不到），
 * 用来说明为什么必须改用别的办法验证（见 verify-nsi-script.cjs）。
 */
const { readFileSync } = require('fs')
const { join } = require('path')

const exe = process.argv[2] ?? join(__dirname, '..', 'dist', 'AstriaX-Setup-0.1.1.exe')
const b = readFileSync(exe)

console.log('  文件:', exe, `(${(b.length / 1024 / 1024).toFixed(2)} MB)\n`)
console.log('  字符串                     utf8        utf16le')
console.log('  ' + '-'.repeat(52))

// 注意：$ 在 JS 字符串里没特殊含义，但 shell 传参时会被吃掉，所以脚本内写死
const probes = [
  'MXBot',
  'robocopy',
  'payload',
  'installer.nsh',
  'NSIS',
  'Nullsoft',
  'LZMA',
  '$INSTDIR',
  'MXBot-update-keep',
  // 这几条是"给用户看的中文提示"，理论上应当以某种编码留在 exe 里
  '无法备份数据目录',
  '数据恢复失败'
]

let found = 0
for (const t of probes) {
  const u8 = b.indexOf(Buffer.from(t, 'utf8'))
  const u16 = b.indexOf(Buffer.from(t, 'utf16le'))
  const hit = u8 >= 0 || u16 >= 0
  if (hit) found++
  const label = u8 >= 0 ? `@${u8}` : u16 >= 0 ? `@${u16} (utf16)` : '—'
  console.log('  ' + t.padEnd(24) + label)
}

console.log('')
console.log(`  命中 ${found}/${probes.length}`)
console.log('')
console.log('  说明：NSIS 的脚本数据是 LZMA 压缩的，明文搜索**天然不可靠**。')
console.log('  要验证「改动真的进了安装包」，正确做法是读 electron-builder 生成的')
console.log('  dist/builder-debug.yml（里面是展开后的脚本与 !include 列表），')
console.log('  见 scripts/verify-nsi-script.cjs。')
