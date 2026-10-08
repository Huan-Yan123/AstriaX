/*
 * 验证两条"致命"指控是否成立 —— 并且**反向验证这个验证本身**。
 *
 * 指控 1：`installer.nsh` 里判 robocopy 退出码用了 `$R6 > 7`。
 *         整数比较对字符串 `"error"` 判假，于是 robocopy **起不来**时
 *         走"成功"分支，紧接着 `RMDir /r "$mxKeepDir"` 删掉唯一备份。
 *
 * 指控 2：RESTORE 失败时弹框说"你的数据还在 keep\payload"，
 *         紧接着 STASH 无条件 `RMDir /r "$mxKeepDir"` 把它删了。
 *
 * ============================================================================
 * 这个脚本的两条设计原则（都是踩过坑换来的）
 * ============================================================================
 *
 * **一、落盘结果只用纯 ASCII 标记。**
 * NSIS 的 FileWrite 写 ANSI，我用 UTF-8 读回来中文全乱码，断言里的中文
 * 匹配不上 → 明明复现了却报"未复现"。用 OK/FAIL/PRESENT/GONE 就与编码无关。
 *
 * **二、直接调用真实的宏，绝不在测试里"照着抄一遍"。**
 * 第一版我把 RESTORE/STASH 的逻辑在测试里复现了一遍 —— 那验证的是
 * **我抄的版本**，把 `> 7` 改回真实代码也不会让测试变红（假绿）。
 * 所以现在：
 *   - 判退出码：`!insertmacro MXBOT_ROBO_VERDICT`（真宏）
 *   - 恢复/备份：`!insertmacro MXBOT_RESTORE_KEEP` / `MXBOT_STASH_KEEP`（真宏）
 *
 * 这样 `--reverse` 把 installer.nsh 里的判定改坏时，本脚本会真的报红。
 *
 * 用法：
 *   node scripts/_probe-fatal-claims.cjs            正常跑
 *   node scripts/_probe-fatal-claims.cjs --reverse  反向验证（应报红）
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
const TMP = join(ROOT, 'data', 'cache', 'tmp', `fatal-${Date.now()}`)
const REVERSE = process.argv.includes('--reverse')
const NSH_ORIG = join(TMP, 'installer.nsh.orig')

mkdirSync(TMP, { recursive: true })
// 先把真脚本备份出来，反向验证后要还原
copyFileSync(NSH, NSH_ORIG)

/*
 * ---- 注册表沙箱（必需）----
 *
 * 本脚本会 `!insertmacro MXBOT_STASH_KEEP`，而 STASH 会：
 *   ReadRegStr $R7 HKCU "Software\MXBot" "DataRoot"
 *   Rename "$R6" "$mxKeepDir\payload"
 * 不做沙箱就会去 rename **用户的真实数据目录**。
 *
 * 我在 _probe-restore-gate.cjs 里已经真实踩过一次：那次之所以没搬走
 * 用户数据，只是因为用户开着 NapCat、QQ 占着文件导致 rename 失败。
 * 那是运气，不是设计。这里必须显式隔离。
 */
const box = sandboxRegistry(TMP)
const realDataRoot = box.before
const realFileCount = realDataRoot && existsSync(realDataRoot) ? countFiles(realDataRoot) : null

if (REVERSE) {
  /*
   * 反向验证：把白名单判定改回 `$R6 > 7` 整数比较。
   * 如果测试**仍然通过**，说明断言没在盯这一行 —— 那是假绿。
   */
  let s = readFileSync(NSH, 'utf8')
  const anchor = '!macro MXBOT_ROBO_VERDICT'
  const i = s.indexOf(anchor)
  if (i < 0) {
    console.log('  ✘ 找不到 MXBOT_ROBO_VERDICT 宏，无法反向验证')
    process.exit(2)
  }
  const end = s.indexOf('!macroend', i) + '!macroend'.length
  const broken = [
    '!macro MXBOT_ROBO_VERDICT',
    '  StrCpy $R7 "1"',
    '  ${If} $R6 > 7',
    '    StrCpy $R7 "0"',
    '  ${EndIf}',
    '!macroend'
  ].join('\n')
  s = s.slice(0, i) + broken + s.slice(end)
  writeFileSync(NSH, s, 'utf8')
  console.log('  [反向验证] 已把白名单判定改回 `$R6 > 7` 整数比较\n')
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

function build(label, body, installDir) {
  const nsi = join(TMP, `${label}.nsi`)
  const exe = join(TMP, `${label}.exe`)
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
!define UNINSTALL_APP_KEY "mx.launcher.fatal"
!define VERSION "9.9.9"
InstallDir "${installDir}"
OutFile "${exe}"
RequestExecutionLevel user
SilentInstall silent
!include "${NSH}"

Section
${body}
SectionEnd
`,
    'utf8'
  )
  execFileSync(MK, ['/V2', '-INPUTCHARSET', 'UTF8', '-XUnicode true', nsi], { stdio: 'pipe' })
  return exe
}

function run(exe) {
  try {
    execFileSync(exe, [], { stdio: 'pipe', timeout: 60000 })
  } catch (e) {
    return e.status ?? 1
  }
  return 0
}

/** 读探测结果（我们只写 ASCII，按 latin1 读与编码无关） */
function readOut(f) {
  return existsSync(f) ? readFileSync(f).toString('latin1') : null
}

const results = []

// ===========================================================================
console.log('  指控 1：nsExec 起不来时压栈什么？判定走哪个分支？（调真宏）\n')
{
  const out = join(TMP, 't1.txt')
  const exe = build(
    't1',
    [
      `  FileOpen $9 "${out}" w`,
      '  ; 调一个不存在的程序 —— 等价于 robocopy.exe 被安全软件拦掉',
      '  nsExec::ExecToLog \'"$TEMP\\no-such-prog-$RANDOM.exe" a b\'',
      '  Pop $R6',
      '  FileWrite $9 "POP=[$R6]$\\r$\\n"',
      '  ; ↓ 调**真实的**判定宏（不是测试里抄的）',
      '  !insertmacro MXBOT_ROBO_VERDICT',
      '  ${If} $R7 == "1"',
      '    FileWrite $9 "VERDICT=SUCCESS$\\r$\\n"',
      '  ${Else}',
      '    FileWrite $9 "VERDICT=FAIL$\\r$\\n"',
      '  ${EndIf}',
      '  ${If} ${Errors}',
      '    FileWrite $9 "ERRORS=SET$\\r$\\n"',
      '  ${Else}',
      '    FileWrite $9 "ERRORS=CLEAR$\\r$\\n"',
      '  ${EndIf}',
      '  FileClose $9'
    ].join('\n'),
    join(TMP, 't1')
  )
  run(exe)
  const txt = readOut(out)
  if (!txt) {
    console.log('    ✘ 没写出结果')
    results.push(['指控1', false])
  } else {
    console.log(txt.split(/\r?\n/).filter(Boolean).map((l) => '    ' + l).join('\n'))
    // 缺陷成立 = nsExec 报 "error" 且**被当成成功**
    const buggy = /POP=\[error\]/.test(txt) && /VERDICT=SUCCESS/.test(txt)
    console.log(
      buggy
        ? '    → robocopy 起不来被判成成功 → 会删掉唯一备份。（缺陷存在）'
        : '    → robocopy 起不来被判成失败 → 备份会被保住。（已修好）'
    )
    // 正常模式：期望"不是 buggy"；反向模式：期望"buggy"
    results.push(['robocopy 起不来时被判成成功', buggy])
  }
}

// ===========================================================================
console.log('\n  指控 2：RESTORE 失败后，STASH 会不会删掉它承诺保留的备份？\n')
{
  const instDir = join(TMP, 't2')
  const dataDir = join(instDir, 'data')
  /*
   * keep 目录**必须**和 MXBOT_SET_KEEP 算出的一致：
   *   "$INSTDIR\..\MXBot-update-keep"
   * 随便挑个路径的话，STASH 删的是一个不存在的目录、payload 安然无恙，
   * 就会得出"指控不成立"的**假阴性**（第一版就这么错过一次）。
   */
  const keepDir = join(TMP, 'MXBot-update-keep')
  const payload = join(keepDir, 'payload')
  const out = join(TMP, 't2.txt')

  rmSync(keepDir, { recursive: true, force: true })
  mkdirSync(payload, { recursive: true })
  mkdirSync(join(payload, 'sub'), { recursive: true })
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(payload, 'REAL.txt'), 'ONLY-REAL-COPY', 'utf8')
  writeFileSync(join(payload, 'sub', 'deep.txt'), 'DEEP', 'utf8')
  writeFileSync(join(dataDir, 'stub.json'), '{}', 'utf8')
  /*
   * origin.txt 指向一个**不存在的盘符**，逼 RESTORE 走失败分支：
   *   ${FileExists} "$R8\*.*" → 假 → Rename 到 Z:\ 失败 → robocopy 也失败
   *   → 退出码 >= 8 → 弹框分支（静默模式下弹框不会卡住自动化）
   */
  writeFileSync(join(keepDir, 'origin.txt'), 'Z:\\mxbot-nonexistent\\data', 'utf8')

  // 沙箱：让 STASH 即使成功也只会动沙箱里的目录
  box.pointAt(dataDir)

  /*
   * 结果用**独立文件是否存在**来表达，不共用 NSIS 文件句柄。
   *
   * 第一版这里用 `FileOpen $9 ... a` 追加写一个 txt，结果读出来是
   *     AFTER_STASH=GONE
   *     ENT
   * —— "PRESENT" 被截成了 "ENT"。原因是 **`$9` 和被测宏内部用的句柄撞了**：
   * MXBOT_READLINE / STASH 里都有 `FileOpen $9 "$mxKeepDir\..."`，
   * 我的写和宏的写互相踩，落盘内容就成了两段重叠的碎片。
   * 当时我按这个乱码输出判"未复现"，差点放掉一个真缺陷。
   *
   * 换成"文件存在与否"之后，不需要任何寄存器，也就没有再撞的可能。
   */
  const mBefore = join(TMP, 'm-before.txt')
  const mAfterRestore = join(TMP, 'm-after-restore.txt')
  const mAfterStash = join(TMP, 'm-after-stash.txt')
  const markerFor = (p) => `    FileOpen $8 "${p}" w\n    FileWrite $8 "X"\n    FileClose $8`
  const markerIfAlive = (p) =>
    [
      `  ${'$'}{If} ${'$'}{FileExists} "${payload}\\REAL.txt"`,
      markerFor(p),
      '  ${EndIf}'
    ].join('\n')

  const exe = build(
    't2',
    [
      '  ; ---- 前置：payload 在不在 ----',
      markerIfAlive(mBefore),
      '',
      '  ; ---- 真实 RESTORE（会失败，弹出"数据还在"） ----',
      '  !insertmacro MXBOT_RESTORE_KEEP',
      '',
      '  ; 恢复失败后 payload 还在不在',
      markerIfAlive(mAfterRestore),
      '',
      '  ; ---- 真实 STASH（customInit 紧接着就会调它） ----',
      '  !insertmacro MXBOT_STASH_KEEP',
      '',
      '  ; STASH 之后 payload 还在不在',
      markerIfAlive(mAfterStash)
    ].join('\n'),
    instDir
  )
  run(exe)

  const alive = (p) => existsSync(p)
  const before = alive(mBefore)
  const afterRestore = alive(mAfterRestore)
  const afterStash = alive(mAfterStash)

  console.log(`    BEFORE=       ${before ? 'PRESENT' : 'GONE'}`)
  console.log(`    AFTER_RESTORE=${afterRestore ? 'PRESENT' : 'GONE'}`)
  console.log(`    AFTER_STASH=  ${afterStash ? 'PRESENT' : 'GONE'}`)

  // 缺陷成立 = RESTORE 后还在（承诺保留），STASH 后没了（被删）
  const buggy = afterRestore && !afterStash
  console.log(
    buggy
      ? '    → 弹框刚说"数据还在"，STASH 就把它删了。（缺陷存在）'
      : '    → 备份被保住了。（已修好）'
  )
  results.push(['STASH 删掉 RESTORE 承诺保留的备份', buggy])
}

// ===========================================================================
console.log('\n  ──────────────────────────────────────────')
let found = 0
for (const [what, hit] of results) {
  console.log(`  ${hit ? '· 缺陷存在' : '✔ 未触发'}  ${what}`)
  if (hit) found++
}

/*
 * ---- 收尾：还原注册表 + 断言真实数据没被动过 ----
 *
 * restore() 必须在断言**之前**跑，否则 verify() 比的是沙箱值，
 * 永远"通过" —— 顺序错一步这层保护就形同虚设。
 */
box.restore()
if (REVERSE) copyFileSync(NSH_ORIG, NSH)

const safetyProblems = box.verify()
if (realDataRoot && realFileCount !== null && existsSync(realDataRoot)) {
  const now = countFiles(realDataRoot)
  if (now < realFileCount) {
    safetyProblems.push(`真实数据目录文件数变少：${realFileCount} → ${now}（${realDataRoot}）`)
  } else {
    console.log(`\n  ✔ 真实数据目录未被动过（${now} 文件）`)
  }
}
if (realDataRoot && safetyProblems.length === 0) {
  console.log(`  ✔ 真实注册表已还原（DataRoot=${realDataRoot}）`)
}
for (const p of safetyProblems) console.log(`  ✘ 安全断言失败：${p}`)

if (REVERSE) {
  /*
   * 反向验证：改坏了判定之后，**必须**至少有一项报"缺陷存在"。
   * 全绿才说明这些断言根本没在盯那行代码（假绿）。
   */
  const good = found > 0
  console.log(
    good
      ? `\n  ✔ 反向验证通过：改坏判定后有 ${found} 项报红，断言确实在盯它`
      : '\n  ✘ 反向验证失败：改坏了判定却全绿 —— 这是假绿，断言无效'
  )
  console.log('  （已还原 installer.nsh）')
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
  process.exit(good && safetyProblems.length === 0 ? 0 : 1)
} else {
  console.log(
    found === 0
      ? '\n  ✔ 两条指控都已修复（复查未复现）'
      : `\n  ✘ 有 ${found} 条缺陷仍存在，必须修`
  )
  try {
    rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
  process.exit(found === 0 && safetyProblems.length === 0 ? 0 : 1)
}
