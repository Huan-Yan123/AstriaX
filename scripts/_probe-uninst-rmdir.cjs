#!/usr/bin/env node
/**
 * 决定性实验：真卸载时，`RMDir /r $INSTDIR` 到底会不会连 `$INSTDIR\data` 一起删？
 *
 * ## 为什么非要做这个实验
 *
 * 主人要求「卸载器加一个是否保留用户数据的选项，默认保留」。
 * 我按这个要求写了数据处置页，然后写测试断言"默认卸载数据还在"。
 *
 * 但这里有一个可能让整个功能变成**死代码**的事实：
 *
 *   electron-builder 的 uninstaller.nsh 卸载段里有一句
 *   （实测第 169 行）：
 *       RMDir /r $INSTDIR
 *   它是**无条件**执行的，而这句话在 customUnInstall **之前**跑
 *   （RMDir 在 169 行，customUnInstall 在 238-240 行）。
 *
 * 而本产品的**默认数据目录就在 $INSTDIR\data**：
 *   src/main/ipc.ts  defaultDataRoot()
 *     → join(process.execPath, '..', 'data')
 *     → 打包后 process.execPath = $INSTDIR\AstriaX.exe
 *     → 默认数据目录 = $INSTDIR\data
 *
 * 如果上面那条推论成立，那么"默认保留数据"根本不可能实现：
 * 等 customUnInstall 跑的时候，数据已经被模板删掉了。
 * 用户点了"保留"，数据照样没了 —— 这比没有这个选项更糟（给了假承诺）。
 *
 * ## 为什么不能靠读代码下结论
 *
 * 我一度以为"模板会删掉 $INSTDIR"，但项目里有一条**相反的历史证据**：
 * 用户当初报告「卸载脚本遗漏了 E:\MXBot\data」——
 * 卸载后 MXBot.exe 没了、data\ 还在。也就是说 RMDir /r $INSTDIR
 * **实际上没有**删掉 data\。
 *
 * 两条结论互相矛盾，只能实测。（可能和 RMDir 失败条件、
 * 或者 data 里有正在被占用的文件有关 —— 猜测不算数。）
 *
 * ## 做法
 *
 * 造一个真的安装器 + 真的卸载器，$INSTDIR 下同时放：
 *   prog.exe           假装程序本体
 *   data\config.json   假装用户数据
 * 然后用 `uninst.exe /S _?=<安装目录>` 跑卸载（这正是 electron-builder
 * 真实调用卸载器的方式），再看 data 还在不在。
 *
 * 同时跑**两种顺序**，把模板的真实顺序也验证一遍：
 *   A) 先 RMDir /r $INSTDIR，再 customUnInstall   ← electron-builder 的真实顺序
 *   B) 先 customUnInstall，再 RMDir /r $INSTDIR   ← 本地 e2e 探针原来的顺序
 *
 * 用法：node scripts/_probe-uninst-rmdir.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')

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

const MAKENSIS = findMakensis()
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mx-uninst-rmdir-'))

/**
 * 造并跑一个实验。
 *
 * order = 'rmdir-first'（模板真实顺序） 或 'custom-first'（旧探针顺序）
 */
function experiment(order) {
  const tag = order === 'rmdir-first' ? 'A' : 'B'
  const inst = path.join(TMP, tag, 'AstriaX')
  fs.mkdirSync(path.join(inst, 'data'), { recursive: true })

  // 假装是已安装的程序
  fs.writeFileSync(path.join(inst, 'prog.exe'), 'FAKE-APP', 'utf8')
  fs.writeFileSync(path.join(inst, 'data', 'config.json'), '{"k":"PRECIOUS"}', 'utf8')
  fs.writeFileSync(path.join(inst, 'data', 'instances.json'), 'PRECIOUS-INST', 'utf8')

  const nsiPath = path.join(TMP, `${tag}.nsi`)
  const setupExe = path.join(TMP, `${tag}-setup.exe`)

  // customUnInstall 的替身：只写一个标记文件，证明它跑过、以及跑的时候 data 还在不在
  const body =
    order === 'rmdir-first'
      ? `
  RMDir /r "$INSTDIR"
  IfFileExists "$INSTDIR\\data\\config.json" 0 +2
    FileOpen $9 "$INSTDIR\\customUnInstall-saw-data.txt" w
    FileWrite $9 "data-was-alive"
    FileClose $9
  RMDir /r "$INSTDIR"`
      : `
  IfFileExists "$INSTDIR\\data\\config.json" 0 +2
    FileOpen $9 "$INSTDIR\\customUnInstall-saw-data.txt" w
    FileWrite $9 "data-was-alive"
    FileClose $9
  RMDir /r "$INSTDIR"`

  const nsi =
    '\uFEFF' +
    `!include "LogicLib.nsh"
InstallDir "${inst}"
OutFile "${setupExe}"
RequestExecutionLevel user
SilentInstall silent
Name "probe"
Section
  WriteUninstaller "$INSTDIR\\uninst.exe"
SectionEnd
Section "Uninstall"
${body}
SectionEnd
`
  fs.writeFileSync(nsiPath, nsi, 'utf8')

  execFileSync(MAKENSIS, ['/V2', '-INPUTCHARSET', 'UTF8', '-XUnicode true', nsiPath], {
    stdio: 'pipe'
  })

  // 跑安装器 → 生成 uninst.exe
  execFileSync(setupExe, [], { stdio: 'pipe', timeout: 30000 })

  const uninst = path.join(inst, 'uninst.exe')
  if (!fs.existsSync(uninst)) throw new Error(`${tag}: 安装器没生成 uninst.exe`)

  /*
   * 跑卸载器。
   * `_?=<目录>` 是 NSIS 的"不要复制自己到临时目录、就地运行"参数，
   * 也正是 electron-builder installUtil.nsh:224 用的形式。
   */
  try {
    execFileSync(uninst, ['/S', `_?=${inst}`], { stdio: 'pipe', timeout: 30000 })
  } catch {
    /* 卸载器返回非 0 是常态 */
  }

  const dataAlive = fs.existsSync(path.join(inst, 'data', 'config.json'))
  const sawData = fs.existsSync(path.join(inst, 'customUnInstall-saw-data.txt'))
  const instExists = fs.existsSync(inst)
  return { tag, order, dataAlive, sawData, instExists, inst }
}

console.log(`makensis : ${MAKENSIS}`)
console.log(`临时目录 : ${TMP}\n`)

let bad = 0
const results = []
for (const order of ['rmdir-first', 'custom-first']) {
  let r
  try {
    r = experiment(order)
  } catch (e) {
    console.log(`【${order}】实验失败：${e.message}`)
    bad++
    continue
  }
  results.push(r)
  console.log(`【${r.tag}】${order === 'rmdir-first' ? '模板真实顺序：RMDir /r $INSTDIR 在前' : '旧探针顺序：customUnInstall 在前'}`)
  console.log(`   卸载后 data\\config.json 还在？ ${r.dataAlive ? '在 ✔' : '没了 ✘'}`)
  console.log(`   customUnInstall 跑的时候 data 还活着？ ${r.sawData ? '是 ✔' : '否 ✘'}`)
  console.log(`   安装目录本身还在？ ${r.instExists ? '在（说明有东西没被删掉）' : '没了'}`)
  console.log('')
}

// ── 结论 ────────────────────────────────────────────────────────────────────
const A = results.find((r) => r.tag === 'A')
const B = results.find((r) => r.tag === 'B')
console.log('='.repeat(68))
if (A) {
  if (A.dataAlive) {
    console.log('结论 A（模板真实顺序）：**RMDir /r $INSTDIR 不会删掉 $INSTDIR\\data**')
    console.log('  → "默认保留数据"这个功能是**可以成立**的，customUnInstall 里不删就够了。')
  } else {
    console.log('结论 A（模板真实顺序）：**RMDir /r $INSTDIR 会把 $INSTDIR\\data 一起删掉**')
    console.log('  → 光在 customUnInstall 里"不删"是**无效**的：')
    console.log('     模板在它之前就已经把整个安装目录删了，')
    console.log('     用户选"保留"却仍然丢数据 —— 必须先把数据挪出 $INSTDIR 再让模板删。')
  }
}
if (B) {
  console.log(
    `结论 B（旧探针顺序）：customUnInstall 跑时 data ${B.sawData ? '还活着' : '已经不在了'}` +
      `（data 最终 ${B.dataAlive ? '还在' : '没了'}）`
  )
  if (A && A.dataAlive !== B.dataAlive) {
    console.log('  ⚠ 两种顺序结果不一致 —— 说明本地 e2e 探针的顺序与真实不同，')
    console.log('    用探针验证"保留数据"会得到**假绿**。')
  }
}
console.log('='.repeat(68))
process.exit(bad)
