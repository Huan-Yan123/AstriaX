#!/usr/bin/env node
/*
 * 实测：改名 productName 之后，覆盖更新会不会把软件装到**另一个目录**、
 * 从而让用户觉得"数据没了"？
 * ============================================================================
 *
 * ## 为什么这是改名最危险的地方
 *
 * electron-builder 的安装器有这么一段（assistedInstaller.nsh instFilesPre）：
 *
 *     ${StrContains} $0 "${APP_FILENAME}" $INSTDIR
 *     ${If} $0 == ""
 *       StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"     ← 自动再拼一层
 *     ${endIf}
 *
 * `APP_FILENAME` 来自 productName，而 `$INSTDIR` 初值来自注册表
 * `InstallLocation`（老用户 = E:\MXBot）。老路径里**不含** "AstriaX"，
 * 所以可能被拼成 `E:\MXBot\AstriaX`：
 *
 *     新程序装进子目录 → `E:\MXBot\data` 相对新安装目录"不见了"
 *     → 用户看到的现象正是「更新完数据全没了」
 *
 * ## 怎么判（不猜，用真 makensis 跑）
 *
 * 用真 makensis 编两个最小安装器，复刻上面那段逻辑：
 *   A) productName=MXBot    起点 E:\MXBot → 看最终 $INSTDIR
 *   B) productName=AstriaX  起点 E:\MXBot → 看最终 $INSTDIR
 * 若两者不同，就证明"光改 productName 会让安装目录漂移"，必须加对策。
 *
 * StrContains 的实现直接从 electron-builder 模板里内联（48 行），
 * 这样探针不依赖它的缓存布局。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

/* ---------------- 找 makensis ---------------- */
function findNsisDir() {
  const bases = [
    path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'nsis')
  ]
  for (const base of bases) {
    if (!fs.existsSync(base)) continue
    for (const v of fs.readdirSync(base)) {
      const d = path.join(base, v)
      if (fs.existsSync(path.join(d, 'makensis.exe'))) return d
    }
  }
  return null
}

/* ---------------- 内联 StrContains.nsh（照抄 electron-builder 模板） ---------------- */
const STR_CONTAINS_NSH = [
  'Var STR_HAYSTACK',
  'Var STR_NEEDLE',
  'Var STR_CONTAINS_VAR_1',
  'Var STR_CONTAINS_VAR_2',
  'Var STR_CONTAINS_VAR_3',
  'Var STR_CONTAINS_VAR_4',
  'Var STR_RETURN_VAR',
  'Function StrContains',
  '  Exch $STR_NEEDLE',
  '  Exch 1',
  '  Exch $STR_HAYSTACK',
  '    StrCpy $STR_RETURN_VAR ""',
  '    StrCpy $STR_CONTAINS_VAR_1 -1',
  '    StrLen $STR_CONTAINS_VAR_2 $STR_NEEDLE',
  '    StrLen $STR_CONTAINS_VAR_4 $STR_HAYSTACK',
  '    loop:',
  '      IntOp $STR_CONTAINS_VAR_1 $STR_CONTAINS_VAR_1 + 1',
  '      StrCpy $STR_CONTAINS_VAR_3 $STR_HAYSTACK $STR_CONTAINS_VAR_2 $STR_CONTAINS_VAR_1',
  '      StrCmp $STR_CONTAINS_VAR_3 $STR_NEEDLE found',
  '      StrCmp $STR_CONTAINS_VAR_1 $STR_CONTAINS_VAR_4 done',
  '      Goto loop',
  '    found:',
  '      StrCpy $STR_RETURN_VAR $STR_NEEDLE',
  '      Goto done',
  '    done:',
  '   Pop $STR_NEEDLE',
  '   Exch $STR_RETURN_VAR',
  'FunctionEnd',
  '!macro _StrContainsConstructor OUT NEEDLE HAYSTACK',
  '  Push `${HAYSTACK}`',
  '  Push `${NEEDLE}`',
  '  Call StrContains',
  '  Pop `${OUT}`',
  '!macroend',
  "!define StrContains '!insertmacro \"_StrContainsConstructor\"'"
].join('\n')

/*
 * 用数组拼行，避免 JS 模板字符串把 NSIS 的 ${...} 当成插值。
 * 第一版直接用模板字符串，结果 `${StrContains}` 被 JS 求值 →
 * ReferenceError: StrContains is not defined。NSIS 和 JS **共用 ${} 语法**，
 * 写这种探针时用数组最稳。
 */
function buildNsi(productName, startDir) {
  return [
    'Unicode true',
    'RequestExecutionLevel user',
    'Name "probe"',
    `OutFile "probe-${productName}.exe"`,
    `InstallDir "${startDir}"`,
    'SilentInstall silent',
    '',
    // ${If}/${EndIf} 来自 LogicLib；electron-builder 的真实脚本会 include 它，
    // 探针里也必须 include，否则报 `Invalid command: "${If}"`。
    '!include "LogicLib.nsh"',
    '',
    STR_CONTAINS_NSH,
    '',
    'Function .onInit',
    '  ; ↓ 复刻 assistedInstaller.nsh 的 instFilesPre',
    `  \${StrContains} $0 "${productName}" $INSTDIR`,
    '  \${If} $0 == ""',
    `    StrCpy $INSTDIR "$INSTDIR\\${productName}"`,
    '  \${EndIf}',
    `  FileOpen $9 "$TEMP\\mxprobe-${productName}.txt" w`,
    '  FileWrite $9 "$INSTDIR"',
    '  FileClose $9',
    '  SetErrorLevel 0',
    '  Quit',
    'FunctionEnd',
    '',
    'Section',
    'SectionEnd',
    ''
  ].join('\r\n')
}

/* ---------------- 主流程 ---------------- */
console.log('')
console.log('  实测：productName 改名后，覆盖更新是否会换目录')
console.log('  ' + '='.repeat(66))

const nsisDir = findNsisDir()
if (!nsisDir) {
  console.log('  [跳过] 找不到 makensis.exe')
  process.exit(0)
}
const makensis = path.join(nsisDir, 'makensis.exe')
console.log('  makensis: ' + makensis)

const tmp = path.join(os.tmpdir(), 'mx-rename-probe-' + Date.now())
fs.mkdirSync(tmp, { recursive: true })

const START = 'E:\\MXBot'
const results = {}

for (const productName of ['MXBot', 'AstriaX']) {
  const nsi = path.join(tmp, `p-${productName}.nsi`)
  // Unicode true 需要 BOM，否则 makensis 报 Bad text encoding
  fs.writeFileSync(nsi, '\uFEFF' + buildNsi(productName, START), 'utf8')

  const outTxt = path.join(process.env.TEMP || os.tmpdir(), `mxprobe-${productName}.txt`)
  try {
    fs.unlinkSync(outTxt)
  } catch {}

  const r = spawnSync(makensis, [nsi], { cwd: tmp, encoding: 'utf8', timeout: 120000 })
  if (r.status !== 0) {
    const out = ((r.stdout || '') + (r.stderr || '')).trim()
    console.log(`  [!!] ${productName} 编译失败:`)
    console.log('    ' + out.split('\n').slice(-5).join('\n    '))
    results[productName] = null
    continue
  }

  // 真的运行（SilentInstall + .onInit 里 Quit，不会安装任何东西）
  const exe = path.join(tmp, `probe-${productName}.exe`)
  spawnSync(exe, [], { encoding: 'utf8', timeout: 60000 })

  const got = fs.existsSync(outTxt) ? fs.readFileSync(outTxt, 'utf8').trim() : '(没写出结果)'
  results[productName] = got
  console.log(`  productName=${productName.padEnd(8)}  起点 ${START}  →  最终 $INSTDIR = ${got}`)
}

console.log('')
console.log('  ' + '='.repeat(66))

const a = results['MXBot']
const b = results['AstriaX']

let bad = 0
if (a && b) {
  console.log('  旧版(MXBot)   装到: ' + a)
  console.log('  新版(AstriaX) 装到: ' + b)
  console.log('')
  if (a !== b) {
    console.log('  [结论] ★改名后安装目录会漂移：' + a + '  →  ' + b)
    console.log('         老用户覆盖更新后，程序装进子目录，')
    console.log('         而 `老目录\\data` 相对新安装位置"消失"，')
    console.log('         用户看到的就是「更新完数据全没了」。')
    console.log('')
    console.log('  [对策] 在 installer.nsh 里把 $INSTDIR 钉回老安装目录：')
    console.log('         读注册表 InstallLocation（键名由 appId 决定，改名不影响），')
    console.log('         非空就直接用它，别让模板再拼一层。')
    bad = 1
  } else {
    console.log('  [结论] 两种情况 $INSTDIR 相同（' + a + '），改名不影响安装目录。')
  }
} else {
  console.log('  [!!] 探测没拿到完整结果，无法下结论')
  bad = 1
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('')
process.exit(bad)
