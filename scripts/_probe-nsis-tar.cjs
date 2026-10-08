#!/usr/bin/env node
/*
 * 实测：安装器（32 位 NSIS 进程）到底能不能调用 tar.exe？
 * ============================================================================
 *
 * ## 为什么必须实测，不能直接写代码
 *
 * NSIS 安装包是 **32 位**进程。在 64 位 Windows 上，32 位进程访问
 * `C:\Windows\System32` 会被 WOW64 **文件系统重定向**到 `C:\Windows\SysWOW64`。
 *
 * 而 `tar.exe` 很可能只存在于真正的 System32 里（它是 64 位二进制）。
 * 那样的话安装器里写 `$WINDIR\System32\tar.exe` 会**静默失败** ——
 * 压缩包根本不生成，而用户（和我）都会以为"备份做好了"。
 *
 * 这比崩溃危险得多：崩溃看得见，静默失效看不见。
 *
 * ## 所以这个探针直接编译一个真的 NSIS 安装器并运行它
 *
 * 不是"我推测能行"，而是让真实的 32 位 NSIS 进程真的去调用，
 * 把结果写进日志再读回来。候选路径三条：
 *   1. $WINDIR\System32\tar.exe    ← 会被重定向的那个
 *   2. $WINDIR\Sysnative\tar.exe   ← 32 位进程访问真 System32 的专用别名
 *   3. $WINDIR\SysWOW64\tar.exe    ← 重定向后的落点
 *
 * 判据：**真的产出了非空 .tar.gz**，而不只是退出码为 0。
 *
 * 顺带实测 PowerShell 能否被调用（备用方案）与 ${GetTime} 的输出格式。
 */
const { spawnSync } = require('child_process')
const fs = require('fs')
const { join } = require('path')

const NSIS_DIR = 'C:\\Users\\huanyan\\AppData\\Local\\electron-builder\\Cache\\nsis\\nsis-3.0.4.1'
const MAKENSIS = join(NSIS_DIR, 'makensis.exe')
const WORK = join(process.cwd(), 'data', 'cache', 'tmp', 'nsis-tar-probe')
const SYS_TEMP = process.env.TEMP || 'C:\\Windows\\Temp'
const PROBE_DIR = join(SYS_TEMP, 'mxbot-tar-probe')
const LOGF = join(SYS_TEMP, 'mxbot-tar-probe.log')

if (!fs.existsSync(MAKENSIS)) {
  console.log('  找不到 makensis：' + MAKENSIS)
  process.exit(1)
}
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(WORK, { recursive: true })
fs.rmSync(PROBE_DIR, { recursive: true, force: true })
try {
  fs.unlinkSync(LOGF)
} catch {}

const outExe = join(WORK, 'probe.exe')
const nsiPath = join(WORK, 'probe.nsi')

/* ------------------------------------------------------------------ *
 * 生成探针 .nsi。**全 ASCII** —— 避免任何编码问题干扰这次实测。
 * ------------------------------------------------------------------ */
const L = [
  'Unicode true',
  'RequestExecutionLevel user',
  'SilentInstall silent',
  'ShowInstDetails nevershow',
  'Name "MXBotTarProbe"',
  'OutFile "' + outExe + '"',
  'InstallDir "$TEMP\\mxbot-tar-probe"',
  '',
  '!include "LogicLib.nsh"',
  '!include "FileFunc.nsh"',
  '',
  'Var LOGF',
  '',
  '; 对一条候选路径做"真的打包一次"的测试',
  ';',
  '; 判据用**最朴素**的办法：把产物文件读进来，看长度和内容。',
  '; 为什么不用 ${GetSize}：实测它在这里返回空（bytes=），',
  '; 拿到空串再比较 > 0 会得到 EMPTY 这个**假红** —— 报告"tar 不能用"，',
  '; 而实际上 tar 可能完全正常。假红会导致我放弃正确方案去改坏代码。',
  '; FileRead 的返回值是**实际读到的字节数**，骗不了人。',
  '!macro TESTONE ID PATH',
  '  FileWrite $0 "--- candidate ${ID} ---$\\r$\\n"',
  '  FileWrite $0 "  path=${PATH}$\\r$\\n"',
  '  ${If} ${FileExists} "${PATH}"',
  '    FileWrite $0 "  exists=YES$\\r$\\n"',
  '    Delete "$TEMP\\mxbot-tar-probe\\out-${ID}.tar.gz"',
  '    nsExec::ExecToStack \'"${PATH}" -czf "$TEMP\\mxbot-tar-probe\\out-${ID}.tar.gz" -C "$TEMP\\mxbot-tar-probe\\src" a.txt\'',
  '    Pop $1',
  '    Pop $2',
  '    StrCpy $3 $2 70',
  '    FileWrite $0 "  rc=$1$\\r$\\n"',
  '    FileWrite $0 "  out=$3$\\r$\\n"',
  '    ${If} ${FileExists} "$TEMP\\mxbot-tar-probe\\out-${ID}.tar.gz"',
  '      FileOpen $5 "$TEMP\\mxbot-tar-probe\\out-${ID}.tar.gz" r',
  '      FileRead $5 $6',
  '      FileClose $5',
  '      ; $6 里是读到的内容（NSIS 的 FileRead 会把实际读到的字节放进 $6，最多 1024）',
  '      StrLen $7 $6',
  '      FileWrite $0 "  readlen=$7$\\r$\\n"',
  '      ; 真 tar.gz 以 gzip 魔数 1F 8B 开头，用字节值判断最靠得住',
  '      ClearErrors',
  '      FileOpen $5 "$TEMP\\mxbot-tar-probe\\out-${ID}.tar.gz" r',
  '      FileReadByte $5 $8',
  '      FileClose $5',
  '      FileWrite $0 "  firstbyte=$8 (gzip 应为 31)$\\r$\\n"',
  '      ${If} $8 == 31',
  '        FileWrite $0 "  VERDICT=REAL$\\r$\\n"',
  '      ${Else}',
  '        FileWrite $0 "  VERDICT=NOTGZIP$\\r$\\n"',
  '      ${EndIf}',
  '    ${Else}',
  '      FileWrite $0 "  ARCHIVE=MISSING$\\r$\\n"',
  '      FileWrite $0 "  VERDICT=FAILED$\\r$\\n"',
  '    ${EndIf}',
  '  ${Else}',
  '    FileWrite $0 "  exists=NO$\\r$\\n"',
  '    FileWrite $0 "  VERDICT=NOPATH$\\r$\\n"',
  '  ${EndIf}',
  '!macroend',
  '',
  'Section',
  '  StrCpy $LOGF "$TEMP\\mxbot-tar-probe.log"',
  '  FileOpen $0 "$LOGF" w',
  '  FileWrite $0 "WINDIR=$WINDIR$\\r$\\n"',
  '  FileWrite $0 "TEMP=$TEMP$\\r$\\n"',
  '',
  '  ; 造一个待打包的源文件',
  '  CreateDirectory "$TEMP\\mxbot-tar-probe\\src"',
  '  FileOpen $9 "$TEMP\\mxbot-tar-probe\\src\\a.txt" w',
  '  FileWrite $9 "hello world"',
  '  FileClose $9',
  '',
  '  !insertmacro TESTONE 1 "$WINDIR\\System32\\tar.exe"',
  '  !insertmacro TESTONE 2 "$WINDIR\\Sysnative\\tar.exe"',
  '  !insertmacro TESTONE 3 "$WINDIR\\SysWOW64\\tar.exe"',
  '',
  '  ; PowerShell 是否可调用（备用方案）',
  '  ${If} ${FileExists} "$WINDIR\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"',
  '    nsExec::ExecToStack \'"$WINDIR\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "exit 7"\'',
  '    Pop $1',
  '    Pop $2',
  '    FileWrite $0 "PS-System32 rc=$1 (期望 7)$\\r$\\n"',
  '  ${Else}',
  '    FileWrite $0 "PS-System32 exists=NO$\\r$\\n"',
  '  ${EndIf}',
  '',
  '  ; ${GetTime} 的输出格式',
  '  ${GetTime} "" "L" $2 $3 $4 $5 $6 $7 $8',
  '  FileWrite $0 "GetTime: r1=$2 r2=$3 r3=$4 r4=$5 r5=$6 r6=$7 r7=$8$\\r$\\n"',
  '',
  '  FileClose $0',
  'SectionEnd',
  ''
]

/*
 * 必须写 BOM：NSIS 的 `Unicode true` 靠 BOM 判定这是 UTF-8 脚本。
 * 没有 BOM 时报 "Bad text encoding" 并直接中止编译（实测踩到过）。
 * 这个探针本身是全 ASCII，加 BOM 只是为了满足编译器的编码判定。
 */
fs.writeFileSync(nsiPath, '\uFEFF' + L.join('\r\n'), 'utf8')

console.log('')
console.log('  实测：32 位 NSIS 进程能否调用 tar.exe')
console.log('  ' + '='.repeat(60))

/* ---- 编译 ---- */
const c = spawnSync(MAKENSIS, ['/V2', nsiPath], { encoding: 'utf8', timeout: 180000 })
console.log('  编译退出码: ' + c.status)
if (c.status !== 0) {
  console.log((c.stdout || '') + (c.stderr || ''))
  process.exit(1)
}
if (!fs.existsSync(outExe)) {
  console.log('  没生成探针 exe')
  process.exit(1)
}

/* ---- 运行（真实 32 位进程）---- */
const r = spawnSync(outExe, [], { encoding: 'utf8', timeout: 120000 })
console.log('  运行退出码: ' + r.status)

/* ---- 读回日志 ---- */
if (!fs.existsSync(LOGF)) {
  console.log('  没有日志文件 —— 探针没跑起来')
  process.exit(1)
}
const log = fs.readFileSync(LOGF, 'utf8')
console.log('')
console.log('  === 探针日志 ===')
for (const line of log.split(/\r?\n/)) {
  if (line.trim()) console.log('  ' + line)
}

/* ---- 判定 ---- */
console.log('')
console.log('  === 判定（判据是 VERDICT=REAL，即真的产出了非空压缩包）===')
const verdictOf = (id) => {
  const m = log.match(new RegExp(`--- candidate ${id} ---([\\s\\S]*?)(?=--- candidate|PS-System32|$)`))
  if (!m) return 'NOLOG'
  const v = /VERDICT=(\w+)/.exec(m[1])
  return v ? v[1] : 'NOVERDICT'
}
const v1 = verdictOf(1)
const v2 = verdictOf(2)
const v3 = verdictOf(3)
console.log('  System32  : ' + v1)
console.log('  Sysnative : ' + v2)
console.log('  SysWOW64  : ' + v3)
console.log('')

/*
 * 结论要按"哪个真的成了"来给，而不是按"文件存在"。
 * 优先 Sysnative（32 位进程拿真 System32 的正规别名），
 * 其次 System32（在 64 位进程/未重定向环境下有效），
 * 再次 SysWOW64（重定向后的落点）。
 */
let pick = null
if (v2 === 'REAL') pick = '$WINDIR\\Sysnative\\tar.exe'
else if (v1 === 'REAL') pick = '$WINDIR\\System32\\tar.exe'
else if (v3 === 'REAL') pick = '$WINDIR\\SysWOW64\\tar.exe'

if (pick) {
  console.log('  → 安装器可以用：' + pick)
} else {
  console.log('  → 都不能用！必须改用 PowerShell 备用方案')
}
console.log('')

/* ---- 清理 ---- */
try {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.rmSync(PROBE_DIR, { recursive: true, force: true })
  fs.unlinkSync(LOGF)
} catch {}
