#!/usr/bin/env node
/*
 * 查清：tar.exe 打包时中文文件名到底变成了什么？
 *
 * 测试报「人格-梦汐.json 不在包里」，这可能是三种情况，必须分开：
 *   1. tar 把中文名按 **ANSI/GBK** 存了 → 解开时名字乱码（用户会看到乱码文件名）
 *   2. tar 存的是 UTF-8，但 `-tzf` 列出来时被控制台编码搞乱 → 只是显示问题
 *   3. 文件真的没进去 → 严重 bug
 *
 * 判据不能靠肉眼看控制台（GBK 控制台一定乱），必须**用字节比**。
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const { join } = require('path')
const path = { join }

const TAR = 'C:\\Windows\\System32\\tar.exe'
const OUT = path.join(process.cwd(), 'data', 'cache', 'tmp', `cnprobe-${Date.now()}`)
fs.mkdirSync(OUT, { recursive: true })

const SRC = path.join(OUT, 'src')
fs.mkdirSync(join(SRC, 'sub'), { recursive: true })
fs.writeFileSync(join(SRC, 'sub', '人格-梦汐.json'), '{"name":"梦汐"}', 'utf8')
fs.writeFileSync(join(SRC, 'sub', 'ascii.json'), '{"a":1}', 'utf8')

const tgz = path.join(OUT, 'out.tar.gz')
const r = spawnSync(TAR, ['-czf', tgz, '-C', SRC, 'sub'], { encoding: 'buffer', timeout: 60000 })
console.log('')
console.log('  tar 打包退出码: ' + r.status)

// ---- 用 buffer 拿列表（绕开控制台编码）----
const rl = spawnSync(TAR, ['-tzf', tgz], { encoding: 'buffer', timeout: 60000 })
const rawList = rl.stdout
console.log('')
console.log('  === tar -tzf 的原始字节（hex + 可打印）===')
console.log('  长度 ' + rawList.length + ' 字节')
console.log('  原样输出: ' + JSON.stringify(rawList.toString('latin1')))

// 试着按不同编码解释
console.log('')
console.log('  === 按不同编码解释同一段字节 ===')
console.log('  UTF-8 : ' + JSON.stringify(rawList.toString('utf8')))
try {
  console.log('  GBK   : ' + JSON.stringify(new TextDecoder('gbk').decode(rawList)))
} catch (e) {
  console.log('  GBK   : (解码不支持)')
}

// ---- 关键判据：解开后文件名对不对 ----
const ex = path.join(OUT, 'ex')
fs.mkdirSync(ex, { recursive: true })
const rx = spawnSync(TAR, ['-xzf', tgz, '-C', ex], { encoding: 'buffer', timeout: 60000 })
console.log('')
console.log('  === 解开后的实际文件名（用 readdir 读真名）===')
const names = fs.readdirSync(join(ex, 'sub'))
console.log('  readdir 结果: ' + JSON.stringify(names))
for (const n of names) {
  const bytes = Buffer.from(n, 'utf8')
  console.log('    ' + JSON.stringify(n) + '  utf8 bytes: ' + bytes.toString('hex'))
}

// 期望的中文名
const WANT = '人格-梦汐.json'
console.log('')
console.log('  期望: ' + JSON.stringify(WANT))
console.log('        utf8 bytes: ' + Buffer.from(WANT, 'utf8').toString('hex'))
console.log('')
const exactMatch = names.includes(WANT)
console.log('  === 结论 ===')
console.log('  ' + (exactMatch
  ? '[OK] 解开后文件名与原文完全一致（中文没坏）—— 之前测试失败是列表解析的编码问题'
  : '[!!] 解开后文件名对不上 —— 中文名真的被破坏了，用户会看到乱码文件名'))

// ---- 再验一次：能不能读到内容 ----
try {
  const c = fs.readFileSync(join(ex, 'sub', WANT), 'utf8')
  console.log('  内容读取: ' + JSON.stringify(c))
} catch (e) {
  console.log('  内容读取失败: ' + e.message)
}

try {
  fs.rmSync(OUT, { recursive: true, force: true })
} catch {}
console.log('')
