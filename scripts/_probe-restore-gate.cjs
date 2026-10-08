/*
 * 验证「RESTORE 失败 → customInit 必须停手」这道闸门真的存在。
 *
 * 为什么单独测：上一份 _probe-fatal-claims.cjs 的指控 2 直接调
 * MXBOT_RESTORE_KEEP / MXBOT_STASH_KEEP 两个宏，结果是"备份被保住" ——
 * 但那只说明"STASH 单独跑时没删掉 payload"，**不代表真实流程安全**。
 *
 * 真实流程里，闸门在 customInit 里：
 *   !insertmacro MXBOT_RESTORE_KEEP     ← 失败时置 $mxRestoreFailed="1"
 *   ${If} $mxRestoreFailed == "1"
 *     Abort                              ← 关键的一行
 *   ${EndIf}
 *   ... 后面才会调 STASH
 *
 * 也就是说：**如果没有那道 Abort，STASH 照样会删掉备份**。
 * 所以要验证的是 customInit 这个组合，而不是两个宏各自的行为。
 *
 * 这个脚本跑**真实的 customInit**，并检查：
 *   1. RESTORE 失败后有没有 Abort（用 Section 有没有执行来判定）
 *   2. payload 在 customInit 结束后还在不在
 *
 * 反向验证：把 customInit 里那段 Abort 注释掉，本脚本必须报红。
 *
 * 用法：
 *   node scripts/_probe-restore-gate.cjs
 *   node scripts/_probe-restore-gate.cjs --reverse
 */
const { execFileSync } = require('child_process')
const { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, copyFileSync } = require('fs')
const { join } = require('path')
const { sandboxRegistry, countFiles } = require('./nsis-sandbox.cjs')

const ROOT = join(__dirname, '..')
const NSH = join(ROOT, 'build', 'installer.nsh')
const MK = join(
  process.env.LOCALAPPDATA,
  'electron-builder/Cache/nsis/nsis-3.0.4.1/makensis.exe'
)
const TMP = join(ROOT, 'data', 'cache', 'tmp', `gate-${Date.now()}`)
const REVERSE = process.argv.includes('--reverse')
const NSH_ORIG = join(TMP, 'installer.nsh.orig')

mkdirSync(TMP, { recursive: true })
copyFileSync(NSH, NSH_ORIG)

/*
 * ---- 注册表沙箱：这一步是**必需**的，不是可选的 ----
 *
 * installer.nsh 里的 STASH 会 `ReadRegStr HKCU\Software\MXBot\DataRoot`
 * 拿到**真实**的数据目录，然后 `Rename` 它。
 *
 * 我第一版这个脚本没做沙箱，跑的时候 STASH 真的去 rename 了
 * `E:\MXBot\data` —— 之所以没成功，纯粹是因为用户当时开着 NapCat，
 * QQ 占着里面的文件导致 rename 失败，走了"情况 C → Abort"分支。
 * 数据没丢是**运气**，不是测试安全。
 *
 * 现在：备份真实注册表 → 指向沙箱 → 收尾还原 + 断言。
 */
const box = sandboxRegistry(TMP)
const realDataRoot = box.before
const realFileCount = realDataRoot && existsSync(realDataRoot) ? countFiles(realDataRoot) : null
if (realDataRoot) {
  console.log(`  真实 DataRoot=${realDataRoot}（${realFileCount} 文件）—— 将被沙箱替换，收尾还原`)
}

if (REVERSE) {
  // 把 customInit 里的闸门拆掉（模拟"忘了写 Abort"）
  let s = readFileSync(NSH, 'utf8')
  const anchor = '${If} $mxRestoreFailed == "1"'
  const i = s.indexOf(anchor)
  if (i < 0) {
    console.log('  ✘ 找不到 mxRestoreFailed 闸门，无法反向验证')
    process.exit(2)
  }
  const end = s.indexOf('${EndIf}', i) + '${EndIf}'.length
  s = s.slice(0, i) + '; [反向验证] 闸门已删除' + s.slice(end)
  writeFileSync(NSH, s, 'utf8')
  console.log('  [反向验证] 已拆掉 customInit 里的 mxRestoreFailed 闸门\n')
}

function findAppBuilderLib() {
  const pnpm = join(ROOT, 'node_modules', '.pnpm')
  for (const d of readdirSync(pnpm)) {
    if (!d.startsWith('app-builder-lib@')) continue
    const p = join(pnpm, d, 'node_modules', 'app-builder-lib')
    if (existsSync(join(p, 'templates', 'nsis', 'include', 'StdUtils.nsh'))) return p
  }
  throw new Error('找不到 app-builder-lib')
}
function findPlug() {
  const cache = join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis')
  for (const d of readdirSync(cache)) {
    if (!d.startsWith('nsis-resources-')) continue
    const p = join(cache, d, 'plugins', 'x86-unicode')
    if (existsSync(join(p, 'StdUtils.dll'))) return p
  }
  throw new Error('找不到 StdUtils.dll')
}

const instDir = join(TMP, 'app')
const keepDir = join(TMP, 'MXBot-update-keep')
const payload = join(keepDir, 'payload')
const marker = join(TMP, 'section-ran.txt')
const entered = join(TMP, 'oninit-entered.txt')
const survived = join(TMP, 'survived.txt')
const out = join(TMP, 'gate.txt')

// 造出"上次安装中断、数据搁浅在 keep 里"的现场
mkdirSync(payload, { recursive: true })
mkdirSync(join(instDir, 'data'), { recursive: true })
writeFileSync(join(payload, 'REAL.txt'), 'ONLY-REAL-COPY', 'utf8')
writeFileSync(join(instDir, 'data', 'stub.json'), '{}', 'utf8')
// origin 指向不存在的盘 → RESTORE 必定失败 → 走弹框分支
writeFileSync(join(keepDir, 'origin.txt'), 'Z:\\mxbot-nonexistent\\data', 'utf8')

/*
 * 把注册表 DataRoot 指向**沙箱里**的 data —— 这样即使 STASH 成功
 * rename 了"它以为的数据目录"，被搬走的也只是沙箱里的东西。
 */
box.pointAt(join(instDir, 'data'))

const nsi = join(TMP, 'g.nsi')
const exe = join(TMP, 'g.exe')
const inc = join(findAppBuilderLib(), 'templates', 'nsis', 'include')
writeFileSync(
  nsi,
  '\uFEFF' +
    `!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WinVer.nsh"
!include "${join(inc, 'StdUtils.nsh')}"
!addincludedir "${inc}"
!addplugindir /x86-unicode "${findPlug()}"
!macro _isUpdated _a _b _t _f
  \${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" \`\${_t}\` \`\${_f}\`
!macroend
!define isUpdated \`"" isUpdated ""\`
!define UNINSTALL_APP_KEY "mx.launcher.gate"
!define VERSION "9.9.9"
InstallDir "${instDir}"
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall silent
!include "${NSH}"

Function .onInit
  ; ---- 先证明 .onInit 真的跑了 ----
  ; 没有这一步就分不清"闸门拦住了"和"安装器压根没执行"。
  ; 我第一版就吃了这个亏：两种模式输出完全一样（都是 sectionRan=false +
  ; payloadAlive=true），看着像"闸门生效"，其实可能是安装器根本没跑起来。
  FileOpen $9 "${entered}" w
  FileWrite $9 "ONINIT-ENTERED"
  FileClose $9

  ; 跑**真实的** customInit（内含 RESTORE → 闸门 → 同版本拦截 → STASH）
  !insertmacro customInit

  ; ---- 走到这里说明没有 Abort ----
  FileOpen $9 "${survived}" w
  FileWrite $9 "SURVIVED-CUSTOMINIT"
  FileClose $9
FunctionEnd

Section
  FileOpen $9 "${marker}" w
  FileWrite $9 "SECTION-RAN"
  FileClose $9
SectionEnd
`,
  'utf8'
)

execFileSync(MK, ['/V2', '-INPUTCHARSET', 'UTF8', '-XUnicode true', nsi], { stdio: 'pipe' })
try {
  execFileSync(exe, [], { stdio: 'pipe', timeout: 60000 })
} catch {
  /* Abort 会让退出码非 0，正常 */
}

// 结果落盘
const sectionRan = existsSync(marker)
const payloadAlive = existsSync(join(payload, 'REAL.txt'))
const didEnter = existsSync(entered)
const didSurvive = existsSync(survived)
writeFileSync(
  out,
  `entered=${didEnter}\nsurvived=${didSurvive}\nsectionRan=${sectionRan}\npayloadAlive=${payloadAlive}\n`,
  'utf8'
)

console.log('  RESTORE 失败后的闸门检查')
console.log(`    安装器 .onInit 执行了: ${didEnter}`)
console.log(`    customInit 跑完了（没 Abort）: ${didSurvive}`)
console.log(`    进入安装段: ${sectionRan}`)
console.log(`    payload（唯一真数据）是否还在: ${payloadAlive}`)
console.log('')

/*
 * 判定分三层，缺一层就可能得出错误结论：
 *
 *   .onInit 没执行    → 测试本身没跑起来，结论无效（不能算通过）
 *   Abort 生效        → customInit 没跑完 + 数据还在  = 正确
 *   Abort 没生效      → customInit 跑完了            = 缺陷
 *
 * 第一版只看"有没有进安装段 + 数据在不在"，两种模式输出一样，
 * 于是把"测试压根没跑"误判成"闸门生效"。
 */
if (!didEnter) {
  console.log('  ✘ 无效：安装器 .onInit 没有执行，这次测试什么都没验证到')
} else if (!didSurvive) {
  console.log('  ✔ 闸门生效：RESTORE 失败后 customInit 立刻 Abort，唯一备份保住了')
} else {
  console.log('  ✘ 闸门失效：customInit 一路跑完（会调用 STASH 删掉备份）')
}
const good = didEnter && !didSurvive

/*
 * ---- 收尾：先还原注册表，再断言真实数据没被动过 ----
 *
 * 顺序很重要：restore() **必须**在断言前跑，否则 verify() 比较的是
 * 沙箱值、永远"通过"。这类顺序错误会让安全断言变成摆设。
 */
box.restore()
if (REVERSE) copyFileSync(NSH_ORIG, NSH)

const safetyProblems = box.verify()
if (realDataRoot && realFileCount !== null && existsSync(realDataRoot)) {
  const now = countFiles(realDataRoot)
  if (now < realFileCount) {
    safetyProblems.push(`真实数据目录文件数变少了：${realFileCount} → ${now}（${realDataRoot}）`)
  } else {
    console.log(`  ✔ 真实数据目录未被动过（${now} 文件，与开跑前一致）`)
  }
}
if (realDataRoot) {
  console.log(safetyProblems.length === 0 ? `  ✔ 真实注册表已还原（DataRoot=${realDataRoot}）` : '')
}
for (const p of safetyProblems) console.log(`  ✘ 安全断言失败：${p}`)

if (REVERSE) {
  const ok = !good // 拆掉闸门后必须报红
  console.log(
    ok
      ? '\n  ✔ 反向验证通过：拆掉闸门后本脚本确实报红，说明它真的在盯那道 Abort'
      : '\n  ✘ 反向验证失败：拆掉闸门后仍然全绿 —— 断言无效（假绿）'
  )
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
  process.exit(ok && safetyProblems.length === 0 ? 0 : 1)
}

try {
  rmSync(TMP, { recursive: true, force: true })
} catch {
  /* 忽略 */
}
process.exit(good && safetyProblems.length === 0 ? 0 : 1)
