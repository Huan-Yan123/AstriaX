#!/usr/bin/env node
/**
 * 决定性验证：真卸载时，用户选「保留」到底留不留得住数据。
 *
 * ## 为什么必须做这个实验（而不是看代码/看单测）
 *
 * 第一版我把"不删数据"写在 customUnInstall 里，单测也全绿 ——
 * 但那是**假绿**：scripts/_probe-uninst-rmdir.cjs 实测发现，
 * electron-builder 模板的 `RMDir /r $INSTDIR`（uninstaller.nsh:169）
 * 跑在 customUnInstall（:239）**之前**，而本产品的数据默认就在
 * $INSTDIR\data，所以等 customUnInstall 跑到时数据已经没了。
 *
 * 修法是在 customUnInit（un.onInit，早于卸载段）里先把数据
 * Rename 到 $INSTDIR\..\AstriaX-uninst-keep\payload，
 * 等卸载段跑完再由 customUnInstall 搬回去。
 *
 * 这个脚本就是验证那个修法**真的**有效，而且两种选择都对：
 *
 *   场景 K（保留）：不带 --delete-app-data
 *     → 程序文件没了
 *     → 数据**必须**回到原位且内容一字不差
 *   场景 D（删除）：带 --delete-app-data
 *     → 程序文件没了
 *     → 数据**必须**被清掉
 *
 * ## 关键：复刻真实的调用形态
 *
 * 用**真的** build/installer.nsh（不是替身），并按真实模板的顺序
 * 调 customUnInit → 删 $INSTDIR → 调 customUnInstall。
 * 顺序错了就测不出这个 bug（第一版就是这么假绿的）。
 *
 * 用法：node scripts/_probe-uninst-keep-data.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
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
  const m = cands.find((c) => fs.existsSync(c))
  if (!m) throw new Error('找不到 makensis')
  return m
}

function findStdUtilsNsh() {
  const pnpm = path.join(ROOT, 'node_modules', '.pnpm')
  for (const d of fs.readdirSync(pnpm)) {
    if (!d.startsWith('app-builder-lib@')) continue
    const p = path.join(pnpm, d, 'node_modules', 'app-builder-lib', 'templates', 'nsis', 'include', 'StdUtils.nsh')
    if (fs.existsSync(p)) return p
  }
  throw new Error('找不到 StdUtils.nsh')
}

function findStdUtilsPlugin() {
  const cache = path.join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis')
  for (const d of fs.readdirSync(cache)) {
    const p = path.join(cache, d, 'plugins', 'x86-unicode')
    if (fs.existsSync(path.join(p, 'StdUtils.dll'))) return p
  }
  throw new Error('找不到 StdUtils.dll 插件目录')
}

const MAKENSIS = findMakensis()
const STD_NSH = findStdUtilsNsh()
const STD_PLUGIN = findStdUtilsPlugin()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-keep-data-'))

/**
 * 造一个"安装器"，它的卸载器完全照真实顺序跑：
 *
 *   .onInit         → customUnInit（抢救数据）
 *   Section un.install 前的等价位置 → RMDir /r $INSTDIR（模板那一句）
 *   Section "Uninstall" → customUnInstall（搬回 / 删除）
 *
 * `deleteArg` 决定跑的时候带不带 --delete-app-data。
 */
function buildAndRun(tag, { deleteAppData }) {
  const inst = path.join(TMP, tag, 'AstriaX')
  const data = path.join(inst, 'data')
  fs.mkdirSync(path.join(data, 'instances', 'a_1'), { recursive: true })
  fs.mkdirSync(path.join(data, 'runtimes', 'a', 'v4.28.0'), { recursive: true })
  fs.writeFileSync(path.join(inst, 'prog.exe'), 'FAKE-APP', 'utf8')
  fs.writeFileSync(path.join(data, 'config.json'), '{"marker":"PRECIOUS-CONFIG"}', 'utf8')
  fs.writeFileSync(path.join(data, 'instances', 'a_1', 'deep.txt'), 'PRECIOUS-INSTANCE', 'utf8')
  fs.writeFileSync(path.join(data, 'runtimes', 'a', 'v4.28.0', 'astrbot.py'), 'PRECIOUS-RUNTIME', 'utf8')

  const nsiPath = path.join(TMP, `${tag}.nsi`)
  const setupExe = path.join(TMP, `${tag}-setup.exe`)

  const nsi =
    '\uFEFF' +
    `; 用真实 build/installer.nsh，并复刻真实模板的调用顺序
Unicode true
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WinVer.nsh"
!include "${STD_NSH.replace(/\\/g, '\\\\')}"
!addplugindir "${STD_PLUGIN.replace(/\\/g, '\\\\')}"

!define UNINSTALL_APP_KEY "mx.launcher.probe"
!define VERSION "9.9.9"
!define PRODUCT_FILENAME "AstriaX"
!define APP_FILENAME "AstriaX"
!define APP_PACKAGE_NAME "mxbot-launcher"
!define APP_GUID "11111111-2222-3333-4444-555555555555"
!define APP_EXECUTABLE_FILENAME "\${PRODUCT_FILENAME}.exe"

/*
 * 必须定义 BUILD_UNINSTALLER。
 *
 * 真实 electron-builder 跑两遍：
 *   NsisTarget.js:326  defines.BUILD_UNINSTALLER = null   （卸载器遍）
 *   NsisTarget.js:350  delete defines.BUILD_UNINSTALLER   （安装遍）
 * 而 uninstaller.nsh（含 customUnInit 的调用点）只在卸载器遍被 include
 * （installer.nsi:123-124 包在 !ifdef BUILD_UNINSTALLER 里）。
 *
 * installer.nsh 里 customUnInit / 数据处置页 / 那几个 Var 都声明在
 * !ifdef BUILD_UNINSTALLER 之内，所以这一遍必须带上这个 define，
 * 否则报 macro named "customUnInit" not found ——
 * 那是探针没复刻真实环境，不是产品的问题。
 *
 * （注意：这段说明写在 JS 里，不能放进下面的 NSIS 模板字符串 ——
 *   模板字符串里出现注释结束符会把字符串截断，已经踩过一次。）
 */
!define BUILD_UNINSTALLER

!macro _isUpdated _a _b _t _f
  \${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" "\${_t}" "\${_f}"
!macroend
!define isUpdated \`"" isUpdated ""\`

InstallDir "${inst.replace(/\\/g, '\\\\')}"
OutFile "${setupExe.replace(/\\/g, '\\\\')}"
RequestExecutionLevel user
SilentInstall silent
Name "probe"

!include "${NSH.replace(/\\/g, '\\\\')}"

Section
  WriteUninstaller "$INSTDIR\\uninst.exe"
SectionEnd

/*
 * ★ customUnInit 必须在 un.onInit 里调用。
 *
 * 真实模板就是这么做的（uninstaller.nsh:26-28）：
 *     Function un.onInit
 *       !insertmacro initMultiUser
 *       !ifmacrodef customUnInit
 *         !insertmacro customUnInit
 *       !endif
 *     FunctionEnd
 *
 * 而 un.onInit 跑在**卸载段之前** —— 这正是"抢救数据"能成立的前提。
 *
 * 我第一版漏了这一步，于是 customUnInit 根本没跑，数据当然没被救出来，
 * 探针报了一片红。红得对：探针不忠实，测的就不是产品行为。
 */
Function un.onInit
  !insertmacro customUnInit
FunctionEnd

/* 卸载段：照真实模板的**顺序**来 */
Section "Uninstall"
  /* 1) 模板那句无条件的整目录删除（uninstaller.nsh:169） */
  RMDir /r "$INSTDIR"
  /* 2) 模板之后才轮到 customUnInstall（uninstaller.nsh:239） */
  !insertmacro customUnInstall
SectionEnd
`
  fs.writeFileSync(nsiPath, nsi, 'utf8')

  execFileSync(MAKENSIS, ['/V2', '-INPUTCHARSET', 'UTF8', '-XUnicode true', nsiPath], {
    stdio: 'pipe'
  })
  execFileSync(setupExe, [], { stdio: 'pipe', timeout: 30000 })

  const uninst = path.join(inst, 'uninst.exe')
  if (!fs.existsSync(uninst)) throw new Error(`${tag}: 没生成 uninst.exe`)

  /*
   * 跑卸载器。
   *
   * ## 为什么先睡一下再判定（踩过的坑）
   *
   * NSIS 的卸载器是**两段式**的：uninst.exe 启动后会把工作交给一个
   * 子进程（或就地继续），父进程**立刻返回**。所以
   *   execFileSync(uninst, ...) 返回 ≠ 卸载做完了
   * 立即去读文件系统会读到"什么都还在"的中间状态。
   *
   * 第一版探针就是这么假绿/假红的：
   *   · K 场景读到 stale 状态 → 误报"数据还在"（其实那次也没跑完）
   *   · D 场景读到 stale 状态 → 误报"程序还在"
   * 手动跑同一个 uninst.exe（带 Start-Process -Wait）却完全正常 ——
   * 说明产品代码没问题，是探针**没等它跑完**。
   *
   * 所以这里：起进程 → 轮询等 prog.exe 消失 → 再多等一会儿
   * 让 customUnInstall 的搬回动作落定。
   */
  const sleepSync = (ms) => {
    const sab = new Int32Array(new SharedArrayBuffer(4))
    Atomics.wait(sab, 0, 0, ms)
  }

  /*
   * ★ 参数顺序有讲究：`_?=<目录>` 必须**最后一个**。
   *
   * 这是本次调试最花时间的一处，值得写下来。
   *
   * NSIS 解析命令行时把 `_?=` 当作"就地运行"的指示，
   * 它后面的所有参数都会被当成**传给 $INSTDIR 那个程序的参数**，
   * 而不再是卸载器自己的参数。
   *
   * 我原来的写法是：
   *     const args = ['/S', `_?=${inst}`]
   *     if (deleteAppData) args.push('--delete-app-data')   // ← 跑到 _?= 后面去了
   * 于是 `--delete-app-data` 被"吞"掉，卸载器根本收不到它。
   *
   * 但现象很迷惑：手动跑（`Start-Process -ArgumentList /S,--delete-app-data,_?=...`
   * 或者我自己拼 `['/S','--delete-app-data','_?='+inst]`）**完全正常**，
   * 只有探针红。因为手动那次我把 `_?=` 放在了最后，顺序正好是对的。
   *
   * 教训：报错的是探针，不是产品代码 —— 但**必须先证明这一点**，
   * 不能因为"我觉得是这样"就把断言改绿。
   */
  const args = ['/S']
  if (deleteAppData) args.push('--delete-app-data')
  args.push(`_?=${inst}`)
  let runLog = ''
  let runErr = ''
  try {
    const r = execFileSync(uninst, args, {
      stdio: 'pipe',
      timeout: 30000,
      encoding: 'utf8'
    })
    runLog = String(r ?? '')
  } catch (e) {
    runLog = String(e.stdout ?? '')
    runErr = String(e.stderr ?? '') + ` [exit=${e.status} signal=${e.signal}]`
  }

  /*
   * 等到"程序文件消失"为止（上限 15s）。
   * 注意 `_?=` 让卸载器就地运行，$INSTDIR 就是 inst，
   * 所以 prog.exe 消失 = 删除段确实跑到了。
   */
  const prog = path.join(inst, 'prog.exe')
  const deadline = Date.now() + 15000
  while (Date.now() < deadline && fs.existsSync(prog)) sleepSync(150)
  // 再给 customUnInstall 的搬回/清理留一点时间
  sleepSync(500)

  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null)
  return {
    tag,
    inst,
    data,
    runLog,
    runErr,
    appGone: !fs.existsSync(path.join(inst, 'prog.exe')),
    dataDirExists: fs.existsSync(data),
    config: read(path.join(data, 'config.json')),
    instFile: read(path.join(data, 'instances', 'a_1', 'deep.txt')),
    runtimeFile: read(path.join(data, 'runtimes', 'a', 'v4.28.0', 'astrbot.py')),
    keepDirExists: fs.existsSync(path.join(inst, '..', 'AstriaX-uninst-keep'))
  }
}

console.log(`makensis   : ${MAKENSIS}`)
console.log(`installer.nsh: ${NSH}`)
console.log(`临时目录   : ${TMP}\n`)

let bad = 0
const ok = (cond, label, hint) => {
  if (cond) {
    console.log(`  ✔ ${label}`)
  } else {
    bad++
    console.log(`  ✘ ${label}${hint ? `  （${hint}）` : ''}`)
  }
}

// ── 场景 K：保留（默认） ────────────────────────────────────────────────────
console.log('='.repeat(68))
console.log('【K】真卸载 · 默认路径（用户选「保留用户数据」）')
console.log('='.repeat(68))
const K = buildAndRun('keep', { deleteAppData: false })
ok(K.appGone, '程序文件被删掉了（卸载确实执行了）', '卸载没跑起来，后面的结论都不算数')
ok(K.dataDirExists, '数据目录还在原位 <安装目录>\\data', '数据目录不见了')
ok(
  K.config === '{"marker":"PRECIOUS-CONFIG"}',
  'config.json 内容一字不差',
  `实际内容=${JSON.stringify(K.config)}`
)
ok(K.instFile === 'PRECIOUS-INSTANCE', '实例数据还在', `实际=${JSON.stringify(K.instFile)}`)
ok(K.runtimeFile === 'PRECIOUS-RUNTIME', '运行时数据还在', `实际=${JSON.stringify(K.runtimeFile)}`)
ok(!K.keepDirExists, '临时落脚点已清理（不留垃圾目录）', '落脚点残留了')

// ── 场景 D：明确要求删除 ──────────────────────────────────────────────────
console.log('')
console.log('='.repeat(68))
console.log('【D】真卸载 · 用户明确要求删除（--delete-app-data）')
console.log('='.repeat(68))
const D = buildAndRun('delete', { deleteAppData: true })
// 诊断：把卸载器的输出打出来（它为什么没跑/跑了什么）
if (D.runLog && D.runLog.trim()) {
  console.log('  卸载器 stdout：')
  for (const line of D.runLog.trim().split(/\r?\n/).slice(0, 12)) console.log('    ' + line)
} else {
  console.log('  卸载器 stdout：无')
}
if (D.runErr && D.runErr.trim()) {
  console.log('  卸载器 stderr：')
  for (const line of D.runErr.trim().split(/\r?\n/).slice(0, 12)) console.log('    ' + line)
}
console.log(`  uninst.exe 是否还在：${fs.existsSync(path.join(D.inst, 'uninst.exe'))}`)
console.log(`  prog.exe 是否还在：${fs.existsSync(path.join(D.inst, 'prog.exe'))}`)
ok(D.appGone, '程序文件被删掉了')
ok(!D.dataDirExists, '数据目录被清掉了（删除功能有效）', '明确要求删除却没删')
ok(!D.keepDirExists, '临时落脚点也清掉了', '落脚点残留 —— 用户以为删干净了其实没有')

console.log('')
console.log('='.repeat(68))
if (bad === 0) {
  console.log('全部通过：')
  console.log('  · 默认（保留）：程序删掉、数据原样回来')
  console.log('  · 明确删除：程序和数据都不留')
  console.log('  两个方向的语义都成立，没有假承诺。')
} else {
  console.log(`${bad} 项不合格 —— 见上面 ✘`)
}
console.log('='.repeat(68))
process.exit(bad === 0 ? 0 : 1)
