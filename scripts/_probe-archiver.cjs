#!/usr/bin/env node
/*
 * 实测：安装器里该用哪个工具打压缩包。
 *
 * ============================================================================
 * 为什么必须先实测，不能直接写 NSIS
 * ============================================================================
 *
 * 安装器（NSIS）自己没有压缩能力，必须调外部程序。候选：
 *   A. tar.exe        —— Windows 10 1803+ 自带（bsdtar）
 *   B. PowerShell     —— Compress-Archive（PS 5.0+）
 *
 * 两者都有"看起来能用、实际踩坑"的地方，必须用**真实数据**量一遍：
 *
 *   - 中文路径 / 中文文件名会不会乱码或失败
 *   - 退出码可信吗（PS 的很多失败不返回非零！）
 *   - 耗时（每次更新都要等，太慢用户会骂）
 *   - 压缩出来的包能不能正常解开（校验完整性）
 *
 * 判据不靠"我认为"，靠下面实际跑出来的结果。
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const DATA = 'E:\\MXBot\\data'
const OUT = path.join(DATA, 'cache', 'tmp', `archprobe-${Date.now()}`)
fs.mkdirSync(OUT, { recursive: true })

console.log('')
console.log('  压缩工具实测（安装器要用的那个）')
console.log('  ' + '='.repeat(62))

/* ------------------------------------------------------------------ *
 * 0) tar.exe 在不在
 * ------------------------------------------------------------------ */
const TAR = 'C:\\Windows\\System32\\tar.exe'
const hasTar = fs.existsSync(TAR)
console.log('')
console.log('  [0] 工具可用性')
console.log('      tar.exe: ' + (hasTar ? '有  ' + TAR : '没有'))
{
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
    encoding: 'utf8',
    timeout: 30000
  })
  console.log('      PowerShell 主版本: ' + (r.stdout || '').trim())
}

/* ------------------------------------------------------------------ *
 * 1) 造一份带中文名的测试数据（真实数据里没有中文，
 *    但用户可能把实例命名成中文，所以必须试）
 * ------------------------------------------------------------------ */
const SRC = path.join(OUT, 'src')
fs.mkdirSync(path.join(SRC, 'instances', 'AstrBot', 'a_test', 'data', 'config'), { recursive: true })
fs.mkdirSync(path.join(SRC, 'instances', 'NapCat', 'n_test', 'config'), { recursive: true })
fs.writeFileSync(path.join(SRC, 'instances', 'AstrBot', 'a_test', 'data', 'cmd_config.json'), '{"dashboard":{"username":"astrbot"}}', 'utf8')
fs.writeFileSync(path.join(SRC, 'instances', 'AstrBot', 'a_test', 'data', 'config', '人格设定.json'), '{"name":"梦汐"}', 'utf8')
fs.writeFileSync(path.join(SRC, 'instances', 'NapCat', 'n_test', 'config', 'onebot11_3859054833.json'), '{"token":"secret"}', 'utf8')
fs.writeFileSync(path.join(SRC, 'instances', 'NapCat', 'n_test', 'config', '中文文件.txt'), '中文内容', 'utf8')
fs.writeFileSync(path.join(SRC, 'config.json'), '{"dataRoot":"E:\\\\MXBot\\\\data"}', 'utf8')

/* ------------------------------------------------------------------ *
 * 2) tar.exe 打包
 * ------------------------------------------------------------------ */
console.log('')
console.log('  [1] tar.exe 打包')
let tarOk = false
let tarFile = path.join(OUT, 'by-tar.tar.gz')
if (hasTar) {
  const t0 = Date.now()
  const r = spawnSync(
    TAR,
    ['-czf', tarFile, '-C', SRC, 'instances', 'config.json'],
    { encoding: 'utf8', timeout: 120000 }
  )
  const ms = Date.now() - t0
  tarOk = r.status === 0 && fs.existsSync(tarFile)
  console.log('      退出码 ' + r.status + '   耗时 ' + ms + 'ms')
  if (r.stderr && r.stderr.trim()) console.log('      stderr: ' + r.stderr.trim().slice(0, 300))
  console.log('      产物: ' + (fs.existsSync(tarFile) ? fs.statSync(tarFile).size + ' 字节' : '不存在'))
  if (!tarOk) console.log('      [FAIL] tar 打包失败')
  else {
    // 校验能解开、中文名保住了
    const ex = path.join(OUT, 'ex-tar')
    fs.mkdirSync(ex, { recursive: true })
    const r2 = spawnSync(TAR, ['-xzf', tarFile, '-C', ex], { encoding: 'utf8', timeout: 120000 })
    const cn = path.join(ex, 'instances', 'NapCat', 'n_test', 'config', '中文文件.txt')
    const cn2 = path.join(ex, 'instances', 'AstrBot', 'a_test', 'data', 'config', '人格设定.json')
    const okEx = r2.status === 0
    const okCn = fs.existsSync(cn) && fs.readFileSync(cn, 'utf8') === '中文内容'
    const okCn2 = fs.existsSync(cn2)
    const okTok = fs.readFileSync(path.join(ex, 'instances', 'NapCat', 'n_test', 'config', 'onebot11_3859054833.json'), 'utf8').includes('secret')
    console.log('      解开退出码 ' + r2.status)
    console.log('      ' + (okEx ? '[OK]' : '[FAIL]') + ' 能正常解开')
    console.log('      ' + (okCn ? '[OK]' : '[FAIL]') + ' 中文文件名与内容完好')
    console.log('      ' + (okCn2 ? '[OK]' : '[FAIL]') + ' 中文目录名完好')
    console.log('      ' + (okTok ? '[OK]' : '[FAIL]') + ' 关键配置(token)完好')
    tarOk = tarOk && okEx && okCn && okCn2 && okTok
  }
}

/* ------------------------------------------------------------------ *
 * 3) PowerShell Compress-Archive 打包（对照）
 * ------------------------------------------------------------------ */
console.log('')
console.log('  [2] PowerShell Compress-Archive（对照）')
let psOk = false
let psFile = path.join(OUT, 'by-ps.zip')
{
  const t0 = Date.now()
  const cmd =
    `$ErrorActionPreference='Stop'; ` +
    `Compress-Archive -Path '${path.join(SRC, 'instances')}','${path.join(SRC, 'config.json')}' ` +
    `-DestinationPath '${psFile}' -Force`
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8',
    timeout: 300000
  })
  const ms = Date.now() - t0
  console.log('      退出码 ' + r.status + '   耗时 ' + ms + 'ms')
  if (r.stderr && r.stderr.trim()) console.log('      stderr: ' + r.stderr.trim().slice(0, 300))
  const exists = fs.existsSync(psFile)
  console.log('      产物: ' + (exists ? fs.statSync(psFile).size + ' 字节' : '不存在'))
  psOk = r.status === 0 && exists
  if (psOk) {
    const ex = path.join(OUT, 'ex-ps')
    fs.mkdirSync(ex, { recursive: true })
    const r2 = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Path '${psFile}' -DestinationPath '${ex}' -Force`],
      { encoding: 'utf8', timeout: 300000 }
    )
    const cn = path.join(ex, 'instances', 'NapCat', 'n_test', 'config', '中文文件.txt')
    const okCn = fs.existsSync(cn)
    console.log('      ' + (r2.status === 0 ? '[OK]' : '[FAIL]') + ' 能解开')
    console.log('      ' + (okCn ? '[OK]' : '[FAIL]') + ' 中文文件名完好')
    psOk = psOk && okCn
  }
}

/* ------------------------------------------------------------------ *
 * 4) PowerShell 失败时退出码可信吗（这决定我能不能靠退出码判断）
 * ------------------------------------------------------------------ */
console.log('')
console.log('  [3] PowerShell 失败时退出码是否可信（关键！）')
{
  const cmd = `$ErrorActionPreference='Continue'; Compress-Archive -Path 'Z:\\不存在的路径\\xxx' -DestinationPath '${path.join(OUT, 'nope.zip')}' -Force`
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], {
    encoding: 'utf8',
    timeout: 60000
  })
  console.log('      对不存在的路径打包 → 退出码 ' + r.status)
  console.log('      ' + (r.status !== 0 ? '[OK] 返回非零，能靠退出码判断' : '[!!] 返回 0 —— 失败却是成功码，不能只靠退出码！'))
  if (r.stderr && r.stderr.trim()) console.log('      stderr 前 200 字: ' + r.stderr.trim().slice(0, 200))
}

/* ------------------------------------------------------------------ *
 * 5) 真实数据的体积与耗时
 * ------------------------------------------------------------------ */
console.log('')
console.log('  [4] 真实用户数据（instances）体积与耗时')
{
  const real = path.join(DATA, 'instances')
  let bytes = 0
  let n = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        try {
          bytes += fs.statSync(p).size
          n++
        } catch {}
      }
    }
  }
  if (fs.existsSync(real)) walk(real)
  console.log('      instances: ' + n + ' 个文件, ' + (bytes / 1024).toFixed(1) + ' KB')
  if (hasTar && n > 0) {
    const t0 = Date.now()
    const rf = path.join(OUT, 'real.tar.gz')
    const r = spawnSync(TAR, ['-czf', rf, '-C', DATA, 'instances'], { encoding: 'utf8', timeout: 120000 })
    console.log('      tar 打包真实数据: ' + (Date.now() - t0) + 'ms, 退出码 ' + r.status +
      ', 产物 ' + (fs.existsSync(rf) ? fs.statSync(rf).size + ' 字节' : '无'))
  }
}

console.log('')
console.log('  ' + '='.repeat(62))
console.log('  结论：')
console.log('    tar.exe     : ' + (tarOk ? '可用且中文/内容完好 —— 首选' : '不可用或有缺陷'))
console.log('    PowerShell  : ' + (psOk ? '可用' : '有缺陷'))
console.log('')

// 清理
try {
  fs.rmSync(OUT, { recursive: true, force: true })
} catch {}
