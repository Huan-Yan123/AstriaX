/*
 * 验证：静默安装（/S）时，没有 /SD 的 MessageBox 会不会**永久卡住**。
 *
 * 为什么值得单独测：electron-builder 的 nsis-web 自动更新、以及用户
 * 手动 `AstriaX-Setup.exe /S`，都是静默运行。NSIS 的 MessageBox 在
 * SilentInstall 下**依然会弹**（silent 只压掉向导界面，不压对话框），
 * 没有 /SD 就一直等人点，自动化流程永远走不完。
 *
 * 这个脚本用 3 秒超时跑一个只含 MessageBox 的静默安装器：
 *   带 /SD  → 应当 3 秒内自己退出
 *   不带 /SD → 应当被超时杀掉（证明会卡住）
 */
const { execFileSync } = require('child_process')
const { existsSync, mkdirSync, writeFileSync, rmSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const MK = join(process.env.LOCALAPPDATA, 'electron-builder/Cache/nsis/nsis-3.0.4.1/makensis.exe')
const TMP = join(ROOT, 'data', 'cache', 'tmp', `mb-${Date.now()}`)
mkdirSync(TMP, { recursive: true })

function build(label, mbLine) {
  const nsi = join(TMP, `${label}.nsi`)
  const exe = join(TMP, `${label}.exe`)
  writeFileSync(
    nsi,
    '\uFEFF' +
      `!include "LogicLib.nsh"
InstallDir "${join(TMP, label)}"
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall silent

Section
  ${mbLine}
  FileOpen $9 "${join(TMP, label + '-done.txt')}" w
  FileWrite $9 "DONE"
  FileClose $9
SectionEnd
`,
    'utf8'
  )
  execFileSync(MK, ['/V2', '-INPUTCHARSET', 'UTF8', '-XUnicode true', nsi], { stdio: 'pipe' })
  return { exe, done: join(TMP, `${label}-done.txt`) }
}

function tryRun(exe, timeoutMs) {
  const t0 = Date.now()
  try {
    execFileSync(exe, ['/S'], { stdio: 'pipe', timeout: timeoutMs })
    return { ok: true, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, killed: e.killed === true || e.signal != null }
  }
}

console.log('  静默模式下的 MessageBox 行为（超时 3 秒）\n')

let bad = 0

// A：不带 /SD —— 预期卡住
{
  const { exe, done } = build('noSD', 'MessageBox MB_OK "测试"')
  const r = tryRun(exe, 3000)
  const hung = !r.ok
  console.log(`  不带 /SD : ${hung ? '卡住了' : '没卡'}（${r.ms}ms）${hung ? '' : ' ← 与预期不符'}`)
  if (!hung) bad++
  else console.log('             → 证实：静默安装会在这里永久等待')
  if (existsSync(done)) rmSync(done)
}

// B：带 /SD IDOK —— 预期自己过
{
  const { exe, done } = build('withSD', 'MessageBox MB_OK "测试" /SD IDOK')
  const r = tryRun(exe, 5000)
  const passed = r.ok && existsSync(done)
  console.log(`  带 /SD IDOK: ${passed ? '自己过了' : '没通过'}（${r.ms}ms）`)
  if (!passed) bad++
  if (existsSync(done)) rmSync(done)
}

console.log('')
console.log(
  bad === 0
    ? '  ✔ 结论：/SD 是必须的 —— 静默安装下没有它会永久卡住'
    : `  ✘ 有 ${bad} 项与预期不符，需要重新看`
)

try {
  rmSync(TMP, { recursive: true, force: true })
} catch {
  /* 忽略 */
}
process.exit(0)
