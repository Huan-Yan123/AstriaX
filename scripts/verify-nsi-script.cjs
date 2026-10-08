/*
 * 验证 `${isUpdated}` 在**卸载器**的编译单元里也是可见且正确的。
 *
 * ## 为什么必须专门验这件事
 *
 * electron-builder 会编译安装器**两次**：
 *   1. 装机器（BUILD_UNINSTALLER 未定义）—— 生成 uninstaller.exe
 *   2. 卸载器（BUILD_UNINSTALLER 定义）—— 生成那个被内嵌的 un.exe
 *
 * 我们的 `customUnInstall` 宏跑在**第 2 次**（卸载器）里，而 isUpdated 的
 * `!define` 出现在生成脚本靠前的公共部分。问题是：卸载器和安装器的
 * 宏可见性不完全一样，`${IfNot} ${isUpdated}` 在卸载器里如果展开成一堆
 * 未定义的符号，编译会**直接报错**（这能发现）；但如果它被静默地
 * 求值成"永远不是更新"，编译一样通过、而用户更新一次就丢数据 ——
 * 这种错只能靠读生成脚本来发现。
 *
 * 所以本脚本做两件事：
 *   1. 确认 isUpdated 的定义出现在生成脚本里（且在使用之前）
 *   2. 确认 customUnInstall 里的数据删除语句**确实**在 `${IfNot} ${isUpdated}` 之内
 *      （按文本顺序判断，而不是只看有没有出现这两个符号）
 */
const { readFileSync, existsSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const debugYml = process.argv[2] ?? join(ROOT, 'dist', 'builder-debug.yml')
const nshPath = join(ROOT, 'build', 'installer.nsh')

let bad = 0
const ok = (cond, label, hint) => {
  if (!cond) bad++
  console.log(`  ${cond ? '✔' : '✘'} ${label}${cond || !hint ? '' : '   ← ' + hint}`)
}

// ---------- 1) 生成脚本里有 isUpdated 的定义 ----------
console.log('  [1] electron-builder 注入的 isUpdated 定义')
if (!existsSync(debugYml)) {
  console.log('  ✘ 缺', debugYml, '—— 先打包')
  process.exit(1)
}
const yml = readFileSync(debugYml, 'utf8')
const def = yml.match(/!macro _isUpdated[\s\S]*?!macroend/)
ok(Boolean(def), 'isUpdated 宏已定义')
if (def) {
  ok(/TestParameter/.test(def[0]), 'isUpdated 用 StdUtils.TestParameter 解析（正规做法）')
  ok(/"updated"/.test(def[0]), 'isUpdated 判断的是 "updated" 参数')
  console.log('      定义原文：')
  def[0]
    .split('\n')
    .slice(0, 6)
    .forEach((l) => console.log('        ' + l.trim()))
}

// isUpdated 的 define 必须在它被使用之前出现
const defIdx = yml.indexOf('!define isUpdated')
ok(defIdx > 0, 'isUpdated 有 !define（LogicLib 靠它把 ${isUpdated} 展开）')

// ---------- 2) 我们的脚本用的是 ${isUpdated} 而不是手动解析 ----------
console.log('\n  [2] installer.nsh 里的更新判断')
const nsh = readFileSync(nshPath, 'utf8')
const cuStart = nsh.indexOf('!macro customUnInstall')
ok(cuStart >= 0, '定义了 customUnInstall')
const cu = nsh.slice(cuStart)

ok(/\$\{IfNot\}\s*\$\{isUpdated\}/.test(cu), 'customUnInstall 用 ${IfNot} ${isUpdated} 守卫')
ok(
  !/\$\{GetOptions\}[\s\S]{0,200}--updated/.test(cu),
  '没有用手写 GetOptions 解析 --updated（那种写法边界会坏）'
)

// ---------- 3) 删数据的语句必须在守卫之内（按文本顺序判断）----------
console.log('\n  [3] 删数据的语句是否都在守卫之内（文本顺序）')
const guardIdx = cu.search(/\$\{IfNot\}\s*\$\{isUpdated\}/)
ok(guardIdx >= 0, '能定位到 ${IfNot} ${isUpdated} 守卫')

if (guardIdx >= 0) {
  /*
   * 找守卫块对应的那个 ${EndIf} —— **必须处理嵌套**。
   *
   * 第一版检查器就是在这里错的：它取守卫之后的**第一个** `${EndIf}`，
   * 而守卫里还有一个 `${If} $R1 != ""`（删注册表记录的 dataRoot），
   * 于是范围在嵌套的那一层就截断了，后面几条删除语句全被误判成"在外面"。
   * 这种"检查器自己写错、然后对着正确的代码报红"最误导人，
   * 所以这里老老实实数嵌套层级。
   */
  let depth = 0
  let endIdx = -1
  const re = /\$\{(If|IfNot|IfThen|Else|ElseIf|EndIf)\b/g
  /*
   * 从守卫那个 `$` 的**下一个字符**开始扫 —— 否则正则又会在 guardIdx
   * 处匹配到守卫自己，depth 从 1 开始，就永远等不到 depth===0 的那个 EndIf。
   * （第一版就是栽在这，报出"找不到配对 EndIf"。）
   */
  re.lastIndex = guardIdx + 1
  let m
  while ((m = re.exec(cu))) {
    if (m[1] === 'EndIf') {
      if (depth === 0) {
        endIdx = m.index
        break
      }
      depth--
    } else if (m[1] !== 'Else' && m[1] !== 'ElseIf') {
      depth++
    }
  }
  ok(endIdx > guardIdx, '能找到与守卫配对的 ${EndIf}（已处理嵌套）')

  if (endIdx > guardIdx) {
    const inner = cu.slice(guardIdx, endIdx)
    const outer = cu.slice(endIdx)

    // 每条删除语句必须都在守卫块**内部**，且不出现在外部
    const mustInside = [
      ['RMDir /r "$R1"', '删注册表记录的 dataRoot'],
      ['RMDir /r "$INSTDIR\\data"', '删默认 data 目录'],
      ['RMDir /r "$TEMP\\MX-launcher-data"', '删 0.1.0 遗留临时目录'],
      ['DeleteRegKey HKCU "Software\\MXBot"', '删注册表项']
    ]
    for (const [stmt, what] of mustInside) {
      const inInner = inner.includes(stmt)
      const inOuter = outer.includes(stmt)
      ok(
        inInner && !inOuter,
        `${what} 在守卫内`,
        inOuter ? '出现在守卫块外面了！更新时会执行' : '没找到这条语句'
      )
    }
  }
}

// ---------- 4) 落脚点在 $INSTDIR 外面 ----------
console.log('\n  [4] 备份落脚点的位置')
ok(/\$INSTDIR\\\.\.\\MXBot-update-keep/.test(nsh), '落脚点定义为 $INSTDIR 的兄弟目录')
ok(
  !/Var \/GLOBAL mxKeepDir[\s\S]{0,80}StrCpy \$mxKeepDir "\$INSTDIR\\data/i.test(nsh),
  '落脚点没有落在 $INSTDIR 内部'
)
ok(/Var \/GLOBAL mxKeepDir/.test(nsh), '落脚点用变量保存（防止用户改安装目录后两处算出不同路径）')

// ---------- 5) 中断恢复 ----------
console.log('\n  [5] 中断恢复与跨盘处理')
ok(/MXBOT_RESTORE_KEEP/.test(nsh), '有中断恢复宏')
ok(
  nsh.indexOf('!insertmacro MXBOT_RESTORE_KEEP') < nsh.indexOf('!insertmacro MXBOT_STASH_KEEP', nsh.indexOf('!macro customInit')),
  'customInit 里先恢复旧备份、再搬新数据（顺序错了会覆盖）'
)
ok(/regroot\.txt/.test(nsh), '跨盘时记录并临时摘除注册表 DataRoot')
ok(/robocopy/.test(nsh), 'Rename 失败的复制退路')
ok(/Abort/.test(nsh), '同盘被锁时中止安装（而不是删一半）')

console.log(bad === 0 ? '\n  ✔ NSIS 更新/卸载的数据保全逻辑都正确' : `\n  ✘ 有 ${bad} 处问题`)
process.exit(bad === 0 ? 0 : 1)
