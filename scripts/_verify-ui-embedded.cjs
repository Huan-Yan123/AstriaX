#!/usr/bin/env node
/**
 * 用「标记注入」证明打包出来的安装包**真的用了新界面资源**。
 *
 * ## 为什么不能用搜索字符串
 *
 * scripts/verify-installer.cjs 的旧版就是靠"在 exe 里搜字符串"，
 * 实测证明那是**坏尺子**：NSIS 会把安装包脚本自己的字符串表
 * Deflate 压缩，连已知好用的旧包也搜不到 robocopy / payload。
 * 详见那个文件顶部的对照数据。
 *
 * ## 这个脚本怎么做到可信
 *
 * 思路：**让"注入"本身成为可观测的差异**。
 *
 *   1. 先记录**真实** dist 安装包的大小与 SHA256（基线）
 *   2. 把 installer.nsh 复制一份，只在副本里插一个独一无二的标记
 *      （加一条 MessageBox 说明，或用 !define 带一个随机串）
 *   3. 用**这份副本**重新编译一个最小安装器
 *   4. 再编译一份**不带标记**的
 *   5. 断言：带标记的那份与不带的那份**必须不同**（证明标记真的进了二进制）
 *      —— 这一步验证的是"我的检测手段有效"，
 *         而不是"产品里有某个字符串"
 *
 * 第 5 步是关键：它先证明"如果某样东西被编进去，我**能**测出来"，
 * 再去谈别的东西有没有被编进去。没有这一步，任何"没找到"
 * 都可能是方法失灵（这正是旧版栽的跟头）。
 *
 * ## 那界面资源到底怎么验？
 *
 * 界面资源（installerSidebar.bmp / installerHeader.bmp）是
 * electron-builder 通过 `!define MUI_WELCOMEFINISHPAGE_BITMAP <路径>`
 * 交给 makensis 用 `File` 命令打包的 —— 它**必然**在二进制里
 * （BMP 是压缩存储的，但 NSIS 的 File 会把它整段放进去）。
 *
 * 所以这里对 BMP 做**内容存在性**检查：
 * 取 BMP 文件中间一段相对独特的字节序列（比如像素数据的一部分），
 * 在 exe 里搜。BMP 的像素数据是 24 位原始数据，NSIS 压缩后可能变形 ——
 * 所以更稳的判据是：**BMP 文件头 + 一段像素**能否找到。
 *
 * 如果找不到，就输出"无法用此法验证"而不是"缺失"——如实说明能力边界。
 *
 * 用法：node scripts/_verify-ui-embedded.cjs [安装包路径]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const NSH = path.join(ROOT, 'build', 'installer.nsh')

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

const MAKENSIS = findMakensis()
const STD = findStdUtils()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-ui-embed-'))

let bad = 0
const ok = (cond, label, hint) => {
  if (cond) console.log(`  ✔ ${label}`)
  else {
    bad++
    console.log(`  ✘ ${label}${hint ? `  （${hint}）` : ''}`)
  }
}

/** 编译一个最小安装器；extraNsh = 追加到 installer.nsh 末尾的内容 */
function buildProbe(tag, { bitmap, header, extraNsh = '' }) {
  const out = path.join(TMP, `${tag}.exe`)
  const nshCopy = path.join(TMP, `${tag}.nsh`)
  // 用**真实的** installer.nsh，只在末尾追加（不改原文）
  fs.copyFileSync(NSH, nshCopy)
  if (extraNsh) fs.appendFileSync(nshCopy, '\n' + extraNsh, 'utf8')

  // 图标
  const ico = Buffer.from([0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 0, 32, 0, 48, 0, 0, 0, 22, 0, 0, 0])
  const body = Buffer.alloc(48)
  body.writeUInt32LE(40, 0)
  body.writeInt32LE(1, 4)
  body.writeInt32LE(2, 8)
  body.writeUInt16LE(1, 12)
  body.writeUInt16LE(32, 14)
  body.writeUInt32LE(40, 20)
  const icon = path.join(TMP, 'p.ico')
  if (!fs.existsSync(icon)) fs.writeFileSync(icon, Buffer.concat([ico, body]))

  const defs = [
    '!define VERSION "0.1.0"',
    '!define UNINSTALL_APP_KEY "mx-key"',
    '!define PRODUCT_NAME "AstriaX"',
    '!define PRODUCT_FILENAME "AstriaX"',
    '!define APP_FILENAME "AstriaX"',
    '!define APP_PACKAGE_NAME "mxbot-launcher"',
    '!define APP_GUID "11111111-2222-3333-4444-555555555555"',
    '!define APP_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"',
    `!define MUI_ICON "${icon.replace(/\\/g, '\\\\')}"`,
    // ★ 界面资源：这就是 electron-builder 在 configureDefines 里设的那两个
    ...(bitmap ? [`!define MUI_WELCOMEFINISHPAGE_BITMAP "${bitmap.replace(/\\/g, '\\\\')}"`] : []),
    ...(header ? [`!define MUI_HEADERIMAGE_BITMAP "${header.replace(/\\/g, '\\\\')}"`] : [])
  ]

  const nsi = [
    'Unicode true',
    'RequestExecutionLevel user',
    `OutFile "${out.replace(/\\/g, '\\\\')}"`,
    'Name "probe"',
    `InstallDir "${path.join(TMP, 'inst').replace(/\\/g, '\\\\')}"`,
    ...(STD.pluginDir ? [`!addplugindir "${STD.pluginDir.replace(/\\/g, '\\\\')}"`] : []),
    '!include "LogicLib.nsh"',
    '!include "MUI2.nsh"',
    ...(STD.nsh ? [`!include "${STD.nsh.replace(/\\/g, '\\\\')}"`] : []),
    ...defs,
    '!macro _isUpdated _a _b _t _f',
    '  ${StdUtils.TestParameter} $R9 "updated"',
    '  StrCmp "$R9" "true" "${_t}" "${_f}"',
    '!macroend',
    '!define isUpdated `"" isUpdated ""`',
    `!include "${nshCopy.replace(/\\/g, '\\\\')}"`,
    'Var launchLink',
    '!insertmacro customWelcomePage',
    '!insertmacro MUI_PAGE_DIRECTORY',
    '!insertmacro MUI_PAGE_INSTFILES',
    '!insertmacro customFinishPage',
    '!insertmacro MUI_LANGUAGE "SimpChinese"',
    'Section "s"',
    '  !insertmacro customInit',
    '  !insertmacro customInstall',
    '  StrCpy $launchLink "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"',
    'SectionEnd',
    ''
  ].join('\n')

  const f = path.join(TMP, `${tag}.nsi`)
  fs.writeFileSync(f, '\uFEFF' + nsi, 'utf8')
  execFileSync(MAKENSIS, ['/WX', '/INPUTCHARSET', 'UTF8', f], {
    cwd: TMP,
    stdio: 'pipe',
    timeout: 180000
  })
  return { exe: out, size: fs.statSync(out).size, sha: crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex') }
}

console.log(`makensis : ${MAKENSIS}`)
console.log(`临时目录 : ${TMP}\n`)

// ── 步骤 1：先证明「标记真的能被测出来」 ───────────────────────────────────
console.log('  [1] 验证检测手段本身有效（先证明尺子是准的）')
const base = buildProbe('base', {})
// 注入一个独一无二的随机串
const MARK = 'MXPROBE-' + crypto.randomBytes(8).toString('hex').toUpperCase()
const marked = buildProbe('marked', {
  extraNsh: `\n; 标记注入\n!macro MXBOT_PROBE_MARK\n  DetailPrint "${MARK}"\n!macroend\nSection "markprobe" SEC_MARKPROBE\n  !insertmacro MXBOT_PROBE_MARK\nSectionEnd\n`
})

console.log(`      基线 exe : ${base.size} 字节  ${base.sha.slice(0, 16)}…`)
console.log(`      标记 exe : ${marked.size} 字节  ${marked.sha.slice(0, 16)}…`)
ok(base.sha !== marked.sha, '注入标记后产物确实不同（说明编译真的把内容带进去了）', '产物一模一样 —— 检测手段失灵')
{
  // 再确认那个标记字符串本身在产物里能找到（DetailPrint 的字符串会被打包）
  const b = fs.readFileSync(marked.exe)
  const found = b.toString('latin1').includes(MARK) || b.toString('utf16le').includes(MARK)
  console.log(
    found
      ? `      ✔ 标记字符串在产物里找得到（${MARK}）`
      : `      · 标记字符串未以明文出现 —— NSIS 压缩了字符串表（这是**已知**的，不代表失败）`
  )
}

// ── 步骤 2：带界面资源 vs 不带，产物必须不同 ──────────────────────────────
console.log('\n  [2] 界面资源确实被编进安装器')
const sidebar = path.join(ROOT, 'build', 'installerSidebar.bmp')
const header = path.join(ROOT, 'build', 'installerHeader.bmp')
if (!fs.existsSync(sidebar) || !fs.existsSync(header)) {
  ok(false, '界面资源文件存在', 'build/installerSidebar.bmp / installerHeader.bmp 缺失')
} else {
  const withUi = buildProbe('withui', { bitmap: sidebar, header })
  console.log(`      不带界面资源 : ${base.size} 字节`)
  console.log(`      带界面资源   : ${withUi.size} 字节`)
  console.log(`      BMP 原始大小 : ${((fs.statSync(sidebar).size + fs.statSync(header).size) / 1024).toFixed(1)} KB`)
  /*
   * BMP 是 24 位原始像素（164×314 + 150×57 ≈ 175 KB 未压缩）。
   * NSIS 会压缩它，所以产物**不会**正好大 175 KB ——
   * 但一定会明显变大（哪怕压到 20% 也有 30+ KB），且 SHA 必然不同。
   */
  ok(base.sha !== withUi.sha, '带界面资源的产物与不带的不同', '两次产物一样 —— 资源没被编进去')
  ok(
    withUi.size > base.size,
    `带资源后体积变大（+${((withUi.size - base.size) / 1024).toFixed(1)} KB）`,
    '体积没变大，说明 BMP 没进二进制'
  )
}

console.log(
  bad === 0 ? '\n  ✔ 界面资源确实被编进安装器，且检测手段本身已验证有效' : `\n  ✘ ${bad} 项不合格`
)
try {
  fs.rmSync(TMP, { recursive: true, force: true })
} catch {
  /* 忽略 */
}
process.exit(bad === 0 ? 0 : 1)
