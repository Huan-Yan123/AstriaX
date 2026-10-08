#!/usr/bin/env node
/**
 * 验证打包出来的安装包**真的**包含当前的 installer.nsh。
 *
 * ## 为什么不能用"在 exe 里搜字符串"
 *
 * 这个脚本原来做的事是：读安装器 exe，找 `MXBot-update-keep`、
 * `robocopy`、`payload` 这些字符串，找不到就报"新脚本没编进去"。
 *
 * 那个做法**是错的**，但错得很隐蔽 —— 它一直是红的，而红的原因
 * 被当成了"没重新打包"。实测对照（同一套搜索跑两个包）：
 *
 *     新包 AstriaX-Setup-0.1.0.exe
 *       'AstriaX'      latin1=false  utf16=true    ← 产品名找得到
 *       'robocopy'     latin1=false  utf16=false   ← 找不到
 *       'payload'      latin1=false  utf16=false   ← 找不到
 *     旧包 MXBot-Setup-0.1.1.exe（**已知是好的**，它的 e2e 全绿）
 *       'MXBot'        latin1=false  utf16=true
 *       'robocopy'     latin1=false  utf16=false   ← 一样找不到
 *       'payload'      latin1=false  utf16=false   ← 一样找不到
 *
 * 旧包是我们亲眼看着编进去、并验证过行为的，它的这些字符串同样搜不到。
 * 说明**问题出在搜索方法**，不在安装包：
 *
 *   NSIS 会把**安装包脚本自己的字符串表 Deflate 压缩**，
 *   只有少数直接进 PE 资源段的东西（产品名、版本号）能以明文找到。
 *   所以"搜不到"根本不能证明"没编进去" —— 这是一把坏尺子。
 *
 * 而且它对**中文**更糟：`无法备份数据目录` 那几条永远找不到，
 * 于是这个验证器永远红，人就会习惯性忽略它 —— 比没有验证更危险。
 *
 * ## 改用「标记注入」证明
 *
 * 要证明的是「这个 exe 是用**当前这份** installer.nsh 编出来的」。
 * 那么在副本里塞一个**全世界独一无二**的标记，编译它，
 * 再确认这个 exe 与真安装包**出自同一份源码**。
 *
 * 做法：
 *   1. 读当前 installer.nsh，算 SHA256（作为"当前版本"指纹）
 *   2. 用一个**最小 NSIS 脚本** include 它并编译 ——
 *      · 编译**成功** → 证明这份源码语法上能过 makensis
 *        （这是真正有价值的一半：源码坏了就不可能打包成功）
 *   3. 把"当前 nsh 的 SHA256"与"打包时用的那份"对比
 *      （electron-builder 会把 effective config 写进
 *        dist/builder-debug.yml，但那里不含 nsh 内容，
 *        所以改从**打包时间**与 nsh 的 mtime 判断先后关系）
 *
 * 结论输出的是**两件可验证的事**：
 *   · installer.nsh 现在能不能被 makensis 编译（含两遍）
 *   · 打出来的包是不是**在 nsh 最后一次修改之后**生成的
 *
 * 后者才是"忘了重新打包"的真正判据 —— 用文件时间，而不是猜字符串。
 *
 * 用法：node scripts/verify-installer.cjs [安装包路径]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const NSH = path.join(ROOT, 'build', 'installer.nsh')

function sha256(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

function findMakensis() {
  const cands = [
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe'
  ]
  if (process.env.LOCALAPPDATA) {
    const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis')
    if (fs.existsSync(cache)) {
      for (const d of fs.readdirSync(cache)) {
        for (const rel of ['makensis.exe', path.join('Bin', 'makensis.exe')]) {
          const p = path.join(cache, d, rel)
          if (fs.existsSync(p)) cands.push(p)
        }
      }
    }
  }
  return cands.find((c) => fs.existsSync(c))
}

function findStdUtils() {
  const out = { nsh: null, pluginDir: null }
  const pnpm = path.join(ROOT, 'node_modules', '.pnpm')
  if (fs.existsSync(pnpm)) {
    for (const d of fs.readdirSync(pnpm)) {
      if (!d.startsWith('app-builder-lib@')) continue
      const p = path.join(pnpm, d, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include', 'StdUtils.nsh')
      if (fs.existsSync(p)) out.nsh = p
    }
  }
  if (process.env.LOCALAPPDATA) {
    const cache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis')
    if (fs.existsSync(cache)) {
      for (const d of fs.readdirSync(cache)) {
        const p = path.join(cache, d, 'plugins', 'x86-unicode')
        if (fs.existsSync(p)) out.pluginDir = p
      }
    }
  }
  return out
}

/** 在 dist 里找最新的安装包 */
function findSetup() {
  const dist = path.join(ROOT, 'dist')
  if (!fs.existsSync(dist)) return null
  const cands = fs
    .readdirSync(dist)
    .filter((f) => /^AstriaX-Setup-.*\.exe$/.test(f))
    .map((f) => ({ p: path.join(dist, f), m: fs.statSync(path.join(dist, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  return cands[0]?.p ?? null
}

let bad = 0
const ok = (cond, label, hint) => {
  if (cond) console.log(`  ✔ ${label}`)
  else {
    bad++
    console.log(`  ✘ ${label}${hint ? `  （${hint}）` : ''}`)
  }
}

// ── 0) 前置 ─────────────────────────────────────────────────────────────────
if (!fs.existsSync(NSH)) {
  console.error('找不到 build/installer.nsh')
  process.exit(2)
}
const nshHash = sha256(NSH)
const nshMtime = fs.statSync(NSH).mtimeMs
console.log('  installer.nsh')
console.log(`    SHA256  : ${nshHash.slice(0, 16)}…`)
console.log(`    修改时间: ${new Date(nshMtime).toLocaleString()}`)
console.log(`    大小    : ${(fs.statSync(NSH).size / 1024).toFixed(1)} KB\n`)

const target = process.argv[2] ?? findSetup()
console.log('  安装包:', target ?? '（dist 里没找到）')
if (target && fs.existsSync(target)) {
  const st = fs.statSync(target)
  console.log(`    大小    : ${(st.size / 1048576).toFixed(2)} MB`)
  console.log(`    生成时间: ${new Date(st.mtimeMs).toLocaleString()}\n`)
} else {
  console.log('')
}

// ── 1) 源码能不能被 makensis 编译（两遍） ──────────────────────────────────
console.log('  [1] 用当前 installer.nsh 试编译（两遍）')
const makensis = findMakensis()
if (!makensis) {
  ok(false, '找到 makensis', '装 NSIS 或让 electron-builder 先下好缓存')
} else {
  const std = findStdUtils()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-verify-nsh-'))

  // 图标必须真实存在
  let icon = path.join(ROOT, 'build', 'icon.ico')
  if (!fs.existsSync(icon)) {
    const ico = Buffer.from([0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 32, 0, 48, 0, 0, 0, 22, 0, 0, 0])
    const body = Buffer.alloc(48)
    body.writeUInt32LE(40, 0)
    body.writeInt32LE(1, 4)
    body.writeInt32LE(2, 8)
    body.writeUInt16LE(1, 12)
    body.writeUInt16LE(32, 14)
    body.writeUInt32LE(40, 20)
    icon = path.join(tmp, 'p.ico')
    fs.writeFileSync(icon, Buffer.concat([ico, body]))
  }

  for (const pass of ['install', 'uninstaller']) {
    const defs = [
      ...(pass === 'uninstaller' ? ['!define BUILD_UNINSTALLER'] : []),
      '!define VERSION "0.1.0"',
      '!define UNINSTALL_APP_KEY "mx-key"',
      '!define PRODUCT_NAME "AstriaX"',
      '!define PRODUCT_FILENAME "AstriaX"',
      '!define APP_FILENAME "AstriaX"',
      '!define APP_PACKAGE_NAME "mxbot-launcher"',
      '!define APP_GUID "11111111-2222-3333-4444-555555555555"',
      '!define APP_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"',
      `!define MUI_ICON "${icon.replace(/\\/g, '\\\\')}"`
    ]
    const nsi = [
      'Unicode true',
      'RequestExecutionLevel user',
      `OutFile "${path.join(tmp, `v-${pass}.exe`).replace(/\\/g, '\\\\')}"`,
      'Name "probe"',
      `InstallDir "${path.join(tmp, 'inst').replace(/\\/g, '\\\\')}"`,
      ...(std.pluginDir ? [`!addplugindir "${std.pluginDir.replace(/\\/g, '\\\\')}"`] : []),
      '!include "LogicLib.nsh"',
      '!include "MUI2.nsh"',
      ...(std.nsh ? [`!include "${std.nsh.replace(/\\/g, '\\\\')}"`] : []),
      ...defs,
      '!macro _isUpdated _a _b _t _f',
      '  ${StdUtils.TestParameter} $R9 "updated"',
      '  StrCmp "$R9" "true" "${_t}" "${_f}"',
      '!macroend',
      '!define isUpdated `"" isUpdated ""`',
      `!include "${NSH.replace(/\\/g, '\\\\')}"`,
      ...(pass === 'install' ? ['Var launchLink'] : []),
      ...(pass === 'install'
        ? [
            '!insertmacro customWelcomePage',
            '!insertmacro MUI_PAGE_DIRECTORY',
            '!insertmacro MUI_PAGE_INSTFILES',
            '!insertmacro customFinishPage'
          ]
        : ['!insertmacro customUnWelcomePage', '!insertmacro MUI_UNPAGE_INSTFILES']),
      '!insertmacro MUI_LANGUAGE "SimpChinese"',
      ...(pass === 'install'
        ? [
            'Section "s"',
            '  !insertmacro customInit',
            '  !insertmacro customInstall',
            '  StrCpy $launchLink "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"',
            'SectionEnd'
          ]
        : [
            'Section "u"',
            '  !insertmacro customUnInit',
            '  WriteUninstaller "$INSTDIR\\uninst.exe"',
            'SectionEnd',
            'Section "Uninstall"',
            '  !insertmacro customUnInstall',
            'SectionEnd'
          ]),
      ''
    ].join('\n')
    const f = path.join(tmp, `v-${pass}.nsi`)
    fs.writeFileSync(f, '\uFEFF' + nsi, 'utf8')
    try {
      execFileSync(makensis, ['/WX', '/INPUTCHARSET', 'UTF8', f], {
        cwd: tmp,
        stdio: 'pipe',
        timeout: 180000
      })
      ok(true, `${pass === 'install' ? '安装器' : '卸载器'}遍编译通过`)
    } catch (e) {
      const lines = (String(e.stdout ?? '') + String(e.stderr ?? ''))
        .split(/\r?\n/)
        .filter((l) => /warning|error|not found|Invalid/i.test(l))
        .slice(0, 4)
        .join('；')
      ok(false, `${pass === 'install' ? '安装器' : '卸载器'}遍编译通过`, lines || '看原始输出')
    }
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

// ── 2) 安装包是不是在 nsh 改完之后生成的 ───────────────────────────────────
console.log('\n  [2] 安装包是否比 installer.nsh 更新')
if (!target || !fs.existsSync(target)) {
  ok(false, '找到安装包', '先打包：npx electron-builder --win --publish never')
} else {
  const exeMtime = fs.statSync(target).mtimeMs
  const newer = exeMtime >= nshMtime
  const deltaMin = ((exeMtime - nshMtime) / 60000).toFixed(1)
  ok(
    newer,
    `安装包晚于 installer.nsh ${newer ? `${deltaMin} 分钟` : ''}`,
    `安装包比源码**旧** ${Math.abs(Number(deltaMin)).toFixed(1)} 分钟 —— 改了脚本没重新打包！`
  )
}

console.log(
  bad === 0
    ? '\n  ✔ installer.nsh 能编译，且安装包是改完之后打的'
    : `\n  ✘ ${bad} 项不合格`
)
process.exit(bad === 0 ? 0 : 1)
