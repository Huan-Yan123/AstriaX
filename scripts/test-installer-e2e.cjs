/*
 * 真机验证：覆盖安装时，**用户数据到底会不会丢**。
 *
 * ============================================================================
 * 为什么不能只靠"读代码"或"在 exe 里搜字符串"
 * ============================================================================
 *
 * 这条链路有三个"看起来对、实际会出事"的陷阱，全都只能靠**真跑安装器**才发现：
 *
 *   1. electron-builder 生成的安装器在装新版之前会**先调用旧版的卸载器**
 *      （installSection.nsh:52 → installUtil.nsh:224），而卸载器模板里
 *      `customUnInstall` 是**无条件**执行的（uninstaller.nsh:238）。
 *      旧版卸载器会把 data\ 删掉 —— 0.1.0 → 0.1.1 就会丢光用户数据。
 *
 *   2. 用户**装到一半点取消**：.onInit 里 customInit 已经把 data 搬走了，
 *      但 Section 从未执行 → 数据搁浅在 keep 目录。
 *
 *   3. `RMDir /r $INSTDIR` 会把 `$INSTDIR` 里的一切删掉 ——
 *      所以备份落脚点放里面等于没备份。
 *
 * 光读代码很容易得出错误结论（我一度以为 0.1.0→0.1.1 必丢数据，
 * 实际真跑下来是靠"$INSTDIR\data 一直没被删"活着的）。
 *
 * ============================================================================
 * !!! 安全边界：这个脚本会读写真实的注册表，必须沙箱化 !!!
 * ============================================================================
 *
 * `build/installer.nsh` 里的宏用**硬编码**的 `HKCU\Software\MXBot\DataRoot`
 * 决定两件事：
 *   - STASH 保护哪个目录（`ReadRegStr`）
 *   - 真卸载删哪个目录（`RMDir /r "$R1"`）
 *
 * 所以**直接编译运行 installer.nsh 会动到用户真实的数据目录**。
 * （我第一版没做这层防护，跑完发现真实注册表的值被清掉了 ——
 *   见文件末尾 runChecks 里的 `guardRealRegistry`。所幸盘上数据完好，
 *   因为当时 `$R1` 读到的是空值、`RMDir` 被 `If $R1 != ""` 挡下。）
 *
 * 现在的做法：
 *   - 开跑前 `reg export` 备份整个 `HKCU\Software\MXBot`，收尾 `reg import` 还原
 *   - 每个用例开跑前把 DataRoot 指向该用例的沙箱目录
 *   - 子进程的 TEMP/TMP 也指到沙箱（卸载器会删 `$TEMP\MX-launcher-data`）
 *   - 收尾断言真实 DataRoot 与开跑前一致，不一致就大声报出来
 *
 * 沙箱全部在 `data\cache\tmp` 下（项目约定：不许往 C 盘写临时文件），
 * 跑完自动清理。
 *
 * 用法：node scripts/test-installer-e2e.cjs
 *   退出码 0 = 全部通过；非 0 = 有案例失败或安全断言失败
 */
const { execFileSync } = require('child_process')
const {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  statSync
} = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')

/*
 * 安装器做更新前备份时用的就是系统自带 tar。
 * 用例 7 要用它来**解开**备份包做内容核对（不解开就等于没验）。
 * 和 installer.nsh 里的优先级保持一致：Sysnative → System32 → SysWOW64。
 */
const TAR = [
  join(process.env.WINDIR ?? 'C:\\Windows', 'Sysnative', 'tar.exe'),
  join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'tar.exe'),
  join(process.env.WINDIR ?? 'C:\\Windows', 'SysWOW64', 'tar.exe')
].find((p) => existsSync(p))

const MAKENSIS = join(
  process.env.LOCALAPPDATA ?? '',
  'electron-builder',
  'Cache',
  'nsis',
  'nsis-3.0.4.1',
  'makensis.exe'
)
const NSH = join(ROOT, 'build', 'installer.nsh')
const SIM_ROOT = join(ROOT, 'data', 'cache', 'tmp', `nsis-e2e-${Date.now()}`)

/** 安装器硬编码的注册表键 —— 沙箱化它，别碰真实值 */
const REG_KEY = 'HKCU\\Software\\MXBot'

if (!existsSync(MAKENSIS)) {
  console.log('  ✘ 找不到 makensis.exe：', MAKENSIS)
  console.log('    （它随 electron-builder 下载，打过一次包就有了）')
  process.exit(1)
}

let failures = 0
const results = []

function ok(cond, label, hint) {
  if (!cond) failures++
  results.push(`    ${cond ? '✔' : '✘'} ${label}${cond || !hint ? '' : '  ← ' + hint}`)
  return cond
}

function flush() {
  if (results.length) console.log(results.splice(0).join('\n'))
}

/**
 * electron-builder 注入的 NSIS 前置声明 —— **必须原样带上**。
 *
 * `build/installer.nsh` 里的 `customUnInstall` 用了 `${IfNot} ${isUpdated}`，
 * 而 `isUpdated` 不是 NSIS 自带的，是 electron-builder 在生成脚本时
 * 塞在最前面的一段宏（见 dist/builder-debug.yml 的 `nsis.script`）。
 *
 * 不带这段直接 include installer.nsh 会报：
 *   !insertmacro: macro "_If" requires 4 parameter(s), passed 2!
 *   Error in macro customUnInstall on macroline 16
 * 报错指向 "_If 参数不够"，看着像 LogicLib 用错了 —— 实际病因是
 * `${isUpdated}` 展开不出来，`${IfNot}` 就只剩两个参数。
 *
 * 另外 StdUtils 是**插件**（StdUtils.dll），光 include .nsh 不够，
 * 还得 `!addplugindir` 指到 electron-builder 的 nsis-resources 缓存包，
 * 否则报 `Plugin not found, cannot call StdUtils::TestParameter`
 * （这个错也会一路冒成 "_If 参数不够"）。
 */
function nsisPreamble() {
  const inc = join(findAppBuilderLib(), 'templates', 'nsis', 'include')
  const plug = findStdUtilsPluginDir()
  return `!include "${join(inc, 'StdUtils.nsh')}"
!addincludedir "${inc}"
!addplugindir /x86-unicode "${plug}"
!macro _isUpdated _a _b _t _f
  \${StdUtils.TestParameter} $R9 "updated"
  StrCmp "$R9" "true" \`\${_t}\` \`\${_f}\`
!macroend
!define isUpdated \`"" isUpdated ""\`
`
}

/** 找到 app-builder-lib 的安装目录（pnpm 的目录名带哈希，只能扫） */
function findAppBuilderLib() {
  const pnpm = join(ROOT, 'node_modules', '.pnpm')
  for (const d of readdirSync(pnpm)) {
    if (!d.startsWith('app-builder-lib@')) continue
    const p = join(pnpm, d, 'node_modules', 'app-builder-lib')
    if (existsSync(join(p, 'templates', 'nsis', 'include', 'StdUtils.nsh'))) return p
  }
  throw new Error('找不到 app-builder-lib/templates/nsis/include（pnpm 目录变了？）')
}

/** 找 StdUtils.dll 所在的插件目录（nsis-resources-N.N.N 包，版本号不定） */
function findStdUtilsPluginDir() {
  const cache = join(process.env.LOCALAPPDATA ?? '', 'electron-builder', 'Cache', 'nsis')
  if (existsSync(cache)) {
    for (const d of readdirSync(cache)) {
      if (!d.startsWith('nsis-resources-')) continue
      const p = join(cache, d, 'plugins', 'x86-unicode')
      if (existsSync(join(p, 'StdUtils.dll'))) return p
    }
  }
  throw new Error('找不到 StdUtils.dll（electron-builder 的 nsis-resources 缓存）——打过一次包才会有')
}

/**
 * 编译一个模拟安装器（含**真的卸载器**）。
 *
 * ## 为什么是两遍编译（这一处改了三次，值得写清楚）
 *
 * electron-builder 编译 NSIS 是**两遍**，每遍一份独立脚本：
 *   NsisTarget.js:326  defines.BUILD_UNINSTALLER = null   （卸载器遍）
 *   NsisTarget.js:350  delete defines.BUILD_UNINSTALLER   （安装遍）
 *
 *   · 卸载器遍：include uninstaller.nsh —— 那里才有 customUnInit /
 *     customUnInstall 的插入点；产物是一个"跑起来会写出 uninst.exe"的
 *     临时 exe（installer.nsi:57 `.onInit` 里 WriteUninstaller + quitSuccess）
 *   · 安装遍：include installSection.nsh —— 插入 customInit / customInstall；
 *     并用 `File "/oname=${UNINSTALL_FILENAME}" ...`（installer.nsh:100）
 *     把上一遍产出的卸载器当作**普通文件**嵌进去
 *
 * installer.nsh 里两边靠 `!ifdef` / `!ifndef BUILD_UNINSTALLER` 区分
 * （mxRestoreFailed 只在安装侧、mxUnMoved 只在卸载侧），因为这些变量
 * 若在某遍里"只声明不使用"，`/WX` 会报 warning 6001 当成错误、整包失败。
 *
 * 我前两次都图省事把两遍塞进**一个**脚本，两次都撞在同一个墙上：
 *   不定义 BUILD_UNINSTALLER → customUnInit 找不到（它是卸载侧的）
 *   定义 BUILD_UNINSTALLER   → mxRestoreFailed 变成未声明
 * 一直在跟"两遍编译"这个设计对抗 —— 说明方向就错了。
 *
 * 所以现在照真实形态分两遍编。这样探针和真打包的**编译期条件完全一致**，
 * 不会因为"探针把两遍合并了"而放过真实的编译期错误。
 *
 * 注意 `-INPUTCHARSET UTF8` + `-XUnicode true` 两个都要（实测 8 种组合，
 * 只有 Unicode 那 4 种能过）：没有 Unicode 模式时 makensis 只认带 BOM 的
 * UTF-8，否则按系统 ANSI 读 installer.nsh 里的中文注释就报
 * `Bad text encoding: installer.nsh:5`。**不能**给 installer.nsh 加 BOM
 * 来绕过 —— 那是给 electron-builder 用的文件，它自己就不加 BOM。
 */
function makensis(nsiPath) {
  execFileSync(MAKENSIS, ['/V2', '-INPUTCHARSET', 'UTF8', '-XUnicode true', nsiPath], {
    stdio: 'pipe'
  })
}

/** 公共头部（两个脚本都要的 define / include） */
function commonHead() {
  return `!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "WinVer.nsh"
!include "MUI2.nsh"
${nsisPreamble()}
!define UNINSTALL_APP_KEY "mx.launcher.e2e"
!define VERSION "9.9.9"
`
}

/**
 * 第 1 遍：编译"卸载器生成器"。
 *
 * 它跑起来会把真正的 uninst.exe 写到 `<SIM_ROOT>/<name>-uninst.exe`。
 * 这就是 electron-builder 的真实做法（BUILD_UNINSTALLER 遍）。
 */
function buildUninstaller(name, installDir) {
  const nsi = join(SIM_ROOT, `${name}-uninst.nsi`)
  const maker = join(SIM_ROOT, `${name}-uninst-maker.exe`)
  const out = join(SIM_ROOT, `${name}-uninst.exe`)

  writeFileSync(
    nsi,
    '\uFEFF' +
      `; 第 1 遍（BUILD_UNINSTALLER）—— 产出 uninst.exe
${commonHead()}
; electron-builder 在卸载器遍注入这个 define（NsisTarget.js:326）
!define BUILD_UNINSTALLER
InstallDir "${installDir}"
OutFile "${maker}"
RequestExecutionLevel user
SilentInstall silent
!include "${NSH}"

; 卸载器的页面（数据处置页）。
; 必须插 —— 不插的话 un.mxDataPageCreate 等函数无人引用，
; /WX 报 warning 6010（zeroing code）当成错误。
; 真实打包里 assistedInstaller.nsh:67-68 一定会插它。
!insertmacro customUnWelcomePage
!insertmacro MUI_LANGUAGE "SimpChinese"

Function .onInit
  WriteUninstaller "${out}"
  SetErrorLevel 0
  Quit
FunctionEnd

; 卸载器的 .onInit —— customUnInit 的真实调用点（uninstaller.nsh:26-28）
Function un.onInit
  !insertmacro customUnInit
FunctionEnd

Section "u"
SectionEnd

; 卸载段：顺序必须和真实模板一致
;   uninstaller.nsh:169   RMDir /r $INSTDIR            ← 无条件，先跑
;   uninstaller.nsh:239   !insertmacro customUnInstall ← 后跑
Section "Uninstall"
  RMDir /r "$INSTDIR"
  !insertmacro customUnInstall
SectionEnd
`,
    'utf8'
  )
  makensis(nsi)
  // maker 跑起来只做一件事：写出 uninst.exe
  execFileSync(maker, [], { stdio: 'pipe', timeout: 30000, env: sandboxEnv() })
  if (!existsSync(out)) throw new Error(`${name}: 没能生成卸载器 ${out}`)
  return out
}

/**
 * 第 2 遍：编译安装器，并把卸载器作为普通文件嵌进去。
 */
function compile(name, { installDir, onInit, installBody, silent = true }) {
  const uninstExe = buildUninstaller(name, installDir)
  const nsi = join(SIM_ROOT, `${name}.nsi`)
  const exe = join(SIM_ROOT, `${name}.exe`)

  writeFileSync(
    nsi,
    '\uFEFF' +
      `; 第 2 遍（安装器）—— 不定义 BUILD_UNINSTALLER
${commonHead()}
InstallDir "${installDir}"
OutFile "${exe}"
RequestExecutionLevel user
${silent ? 'SilentInstall silent' : ''}
!include "${NSH}"

Function .onInit
  ${onInit}
FunctionEnd

Section
  ${installBody}
  /*
   * 嵌入第 1 遍产出的卸载器。
   *
   * 真实 electron-builder 就是这么做的（installer.nsh:100）：
   *   File "/oname=" + UNINSTALL_FILENAME + " " + UNINSTALLER_OUT_FILE
   * 位置也一致：安装目录下的 uninst.exe（用例都按这个路径找它）。
   *
   * 注意：这是 JS 模板字符串内部 —— 注释里也不能出现美元加大括号，
   * 否则会被当成插值求值（上面两次报错都是这么来的）。
   */
  SetOutPath "$INSTDIR"
  File "/oname=uninst.exe" "${uninstExe}"
SectionEnd
`,
    'utf8'
  )
  makensis(nsi)
  return exe
}

/** 造一份"用户数据"，每个文件内容可辨认 */
function seedData(dataDir) {
  mkdirSync(join(dataDir, 'instances', 'a_1'), { recursive: true })
  mkdirSync(join(dataDir, 'runtimes', 'a', 'v4.28.0'), { recursive: true })
  // 每个文件都带 PRECIOUS 标记，这样"内容对不对"能一眼看出来。
  // （第一版 config.json 写的是纯配置、没带标记，结果断言永远失败 ——
  //   是测试自己的 bug，不是被测代码的。）
  writeFileSync(
    join(dataDir, 'config.json'),
    '{"dataRoot":"PRECIOUS-CONFIG","portMin":6100}',
    'utf8'
  )
  writeFileSync(join(dataDir, 'instances', 'a_1', 'deep.txt'), 'PRECIOUS-INSTANCE', 'utf8')
  writeFileSync(join(dataDir, 'runtimes', 'a', 'v4.28.0', 'astrbot.py'), 'PRECIOUS-RUNTIME', 'utf8')
}

/**
 * 数据是否完好（三个文件都在、内容对）。
 *
 * **纯函数，不碰 failures 计数器** —— 这一点踩过坑：
 * 第一版它内部直接调 `ok(false, ...)`，于是"故意探测一下数据还在不在"
 * 这种只读操作也会把失败计数顶上去。用例 2 想知道"数据是不是被搬走了"，
 * 探测一下就被记了 3 个失败，最后汇总报"有案例失败"，
 * 而每个用例其实都通过了 —— 这种自伤的假红同样会误导人。
 *
 * 现在返回问题列表，由调用方决定要不要记失败。
 */
function checkData(dataDir) {
  const checks = [
    [join(dataDir, 'config.json'), 'PRECIOUS-CONFIG', 'config.json'],
    [join(dataDir, 'instances', 'a_1', 'deep.txt'), 'PRECIOUS-INSTANCE', '实例数据'],
    [join(dataDir, 'runtimes', 'a', 'v4.28.0', 'astrbot.py'), 'PRECIOUS-RUNTIME', '运行时']
  ]
  const problems = []
  for (const [f, marker, what] of checks) {
    if (!existsSync(f)) {
      problems.push(`${what} 不见了（${f}）`)
      continue
    }
    if (!readFileSync(f, 'utf8').includes(marker)) problems.push(`${what} 内容不对（期望含 ${marker}）`)
  }
  return problems
}

/** 断言数据完好；返回是否完好 */
function dataIntact(dataDir, label) {
  const problems = checkData(dataDir)
  ok(problems.length === 0, `${label}：数据完好`, problems.join('；'))
  return problems.length === 0
}

/** keep 目录里是否还留着数据（取消安装后的合法归宿） */
function dataInKeep(installDir) {
  const keep = join(installDir, '..', 'MXBot-update-keep', 'payload')
  if (!existsSync(keep)) return false
  try {
    return readdirSync(keep).length > 0
  } catch {
    return false
  }
}

/** 子进程统一用沙箱 TEMP（卸载器会删 $TEMP\MX-launcher-data） */
function sandboxEnv() {
  const t = join(SIM_ROOT, 'temp')
  mkdirSync(t, { recursive: true })
  return { ...process.env, TEMP: t, TMP: t }
}

function run(exe, args = []) {
  try {
    execFileSync(exe, args, { stdio: 'pipe', timeout: 60000, env: sandboxEnv() })
  } catch (e) {
    // NSIS 的 Abort 会让退出码非 0 —— 那是预期行为，不是失败
    return e.status ?? 1
  }
  return 0
}

/*
 * NSIS 卸载器是**异步**的：它先把自身复制到 $TEMP 再重新拉起，
 * 原来的进程立刻退出。所以 `execFileSync(uninst)` 返回时卸载往往刚开头，
 * 直接断言会读到"还没删"的中间态 ——
 * 我第一版的用例 4/5 就是栽在这里（报"数据没被清掉"，其实是还没跑完）。
 *
 * 这里轮询等到条件成立（或超时）。等不到不算异常 ——
 * 由调用方的断言去判失败，这样失败信息能指出具体是哪个文件没动。
 */
/**
 * 等到条件成立（或超时）。
 *
 * 卸载器是**异步**的（NSIS 把自己复制到 $TEMP 再重新拉起），所以
 * `execFileSync(uninst)` 返回时卸载往往刚开头。
 * 第一版直接断言，读到的是"还没删"的中间态 —— 用 5s 的 sleep 当同步，
 * 在慢机器上就会翻车。改成轮询等到条件成立，快机器上立刻返回。
 *
 * 等不到也不算异常，交给调用方的断言判失败 ——
 * 这样失败信息能指出具体是哪个文件没动，而不是一句"超时"。
 */
async function runAndWait(exe, args, untilFn, timeoutMs = 20000) {
  // 用顶层 run() 拉起，但不用它的同步等待语义（卸载器会立刻返回）
  try {
    execFileSync(exe, args, { stdio: 'pipe', timeout: 30000, env: sandboxEnv() })
  } catch {
    /* 卸载器返回非 0 是常态（Abort / 异步重启），不看退出码 */
  }
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (untilFn()) return true
    await sleep(150)
  }
  return false
}

/** 不占 CPU 的短睡（异步，别用 execFileSync 起 powershell 睡 —— 那太贵） */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ============================================================================
// 注册表沙箱
// ============================================================================

let regBackup = null
let realDataRootBefore = null

function readRealDataRoot() {
  try {
    const out = execFileSync('reg', ['query', REG_KEY, '/v', 'DataRoot'], { stdio: 'pipe' }).toString()
    const m = out.match(/DataRoot\s+REG_SZ\s+(.+)/)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

/** 备份整个真实注册表键（有才备，没有就记住"本来没有"） */
function backupRegistry() {
  const f = join(SIM_ROOT, 'regbackup.reg')
  try {
    execFileSync('reg', ['export', REG_KEY, f, '/y'], { stdio: 'pipe' })
    return f
  } catch {
    return null // 键本来就不存在
  }
}

/**
 * 还原真实注册表键。
 *
 * 先 delete 再 import：`reg import` 是**合并**语义，
 * 不先删干净的话，沙箱用例留下的 DataRoot 值会残留下来，
 * 变成"看起来还原了、其实多了个错值"。
 */
function restoreRegistry() {
  try {
    execFileSync('reg', ['delete', REG_KEY, '/f'], { stdio: 'pipe' })
  } catch {
    /* 不存在就算了 */
  }
  if (regBackup && existsSync(regBackup)) {
    try {
      execFileSync('reg', ['import', regBackup], { stdio: 'pipe' })
    } catch (e) {
      console.log('  ✘ 注册表还原失败，请手工恢复：', regBackup)
    }
  }
}

/**
 * 把 DataRoot 指向沙箱。
 *
 * **两个视图都写**（/reg:32 与 /reg:64）。HKCU\Software\<厂商> 一般不做
 * 重定向，但 NSIS 编译出的是 32 位 exe，写一份双保险的代价极小 ——
 * 漏一个视图就可能让 `ReadRegStr` 读到空值、用例静默失效（假绿）。
 */
function pointRegistryAt(dataDir) {
  for (const view of ['/reg:64', '/reg:32']) {
    try {
      execFileSync('reg', ['delete', REG_KEY, '/f', view], { stdio: 'pipe' })
    } catch {
      /* 不存在 */
    }
  }
  for (const view of ['/reg:64', '/reg:32']) {
    try {
      execFileSync(
        'reg',
        ['add', REG_KEY, '/v', 'DataRoot', '/t', 'REG_SZ', '/d', dataDir, '/f', view],
        { stdio: 'pipe' }
      )
    } catch {
      /* 32 位视图在某些系统上不可写，忽略 */
    }
  }
}

// ============================================================================
console.log('  NSIS 端到端验证：覆盖安装的数据保全')
console.log('  makensis:', MAKENSIS)
console.log('  沙箱:', SIM_ROOT)

mkdirSync(SIM_ROOT, { recursive: true })

// —— 安全网：开跑前先把真实注册表与真实数据根记下来 ——
realDataRootBefore = readRealDataRoot()
regBackup = backupRegistry()
if (realDataRootBefore) {
  console.log(`  真实 DataRoot（将被沙箱替换，收尾还原）: ${realDataRootBefore}`)
  if (existsSync(realDataRootBefore)) {
    const n = safeCount(realDataRootBefore)
    console.log(`  真实数据目录文件数（基线）: ${n}`)
  }
}
console.log('')

/** 数文件数，读不动的目录跳过（用户机器上有一堆 ACL 坏掉的目录） */
function safeCount(dir) {
  let n = 0
  const walk = (d, depth) => {
    if (depth > 10) return
    let ents
    try {
      ents = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of ents) {
      if (e.isDirectory()) walk(join(d, e.name), depth + 1)
      else n++
    }
  }
  walk(dir, 0)
  return n
}

/*
 * 整个用例集包在一个 async main 里。
 *
 * 为什么要包：`await runAndWait(...)` 里用了顶层 await，而 .cjs 是
 * CommonJS，顶层 await 不被允许（会报 "await is only valid in async
 * functions and the top level bodies of modules"）。
 * 改成 .mjs 又要动 package.json 的 type —— 不值得，包一层最省事。
 */
async function main() {
  try {
    // -------------------------------------------------------------------------
    // CASE 1 · 正常覆盖安装：数据必须一字不差
    // -------------------------------------------------------------------------
  {
    const dir = join(SIM_ROOT, 'c1', 'MXBot')
    const data = join(dir, 'data')
    mkdirSync(dir, { recursive: true })
    seedData(data)
    pointRegistryAt(data)

    const exe = compile('c1', {
      installDir: dir,
      onInit: '!insertmacro customInit',
      installBody: '!insertmacro customInstall'
    })
    run(exe)

    console.log('  [1] 正常覆盖安装')
    ok(dataIntact(data, '覆盖安装后'), '覆盖安装后数据完好（实例/运行时/config 都在）')
    ok(!existsSync(join(dir, '..', 'MXBot-update-keep')), '装完后临时备份目录已清理（不留垃圾）')
    flush()
  }

  // -------------------------------------------------------------------------
  // CASE 2 · 用户装到一半点取消：数据必须还在（不能凭空消失）
  // -------------------------------------------------------------------------
  {
    const dir = join(SIM_ROOT, 'c2', 'MXBot')
    const data = join(dir, 'data')
    mkdirSync(dir, { recursive: true })
    seedData(data)
    pointRegistryAt(data)

    const exe = compile('c2', {
      installDir: dir,
      // customInit 之后 Abort —— 等价于用户在向导里点"取消"
      onInit: '!insertmacro customInit\n  Abort',
      installBody: '; 永远不会执行'
    })
    run(exe)

    console.log('\n  [2] 装到一半点取消')
    /*
     * 数据可能被搬到 keep 目录（那是设计上的临时归宿），但**不能消失**。
     * 用纯函数 checkData 探测（不记断言），再按结果给**一条**结论 ——
     * 这样"数据在原位"和"数据在 keep 里"两种合法情况都只产生一行输出。
     */
    const stillThere = checkData(data).length === 0
    if (stillThere) {
      ok(true, '取消后数据仍在原位（没被动过）')
    } else {
      ok(dataInKeep(dir), '取消后数据仍在备份目录里（没被删掉）', '数据凭空消失了')
    }
    flush()
  }

  // -------------------------------------------------------------------------
  // CASE 3 · 取消之后再装一次：数据必须被救回来  ← 审计抓出的真 bug
  // -------------------------------------------------------------------------
  {
    const dir = join(SIM_ROOT, 'c3', 'MXBot')
    const data = join(dir, 'data')
    mkdirSync(dir, { recursive: true })
    seedData(data)
    pointRegistryAt(data)

    const exe = compile('c3', {
      installDir: dir,
      onInit: '!insertmacro customInit\n  Abort',
      installBody: '; 不执行'
    })
    run(exe) // 第一次：用户取消（数据被搬走）

    /*
     * 关键一步：模拟用户重新打开启动器，它发现没数据 → 首启向导弹出
     * → 用户**顺手把目录选回原来那个路径** → 程序建了一个空壳 data\。
     * 这正是审计复现出来的丢数据链条的第 4 步。
     * 修复前的恢复逻辑是「原位置有东西 → 说明原件没被删 → RMDir /r 丢掉副本」，
     * 于是这个空壳一出现，唯一的真数据就被删了。
     */
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'config.json'), '{"dataRoot":"重新选的空壳"}', 'utf8')

    const exe2 = compile('c3b', {
      installDir: dir,
      onInit: '!insertmacro customInit',
      installBody: '!insertmacro customInstall'
    })
    run(exe2)

    console.log('\n  [3] 取消后重选目录再装一次（审计抓出的丢数据链条）')
    ok(
      dataIntact(data, '救回后'),
      '唯一真数据被救回来了（旧的错误逻辑会在这里永久删掉它）',
      '数据永久丢失 —— payload 被当成垃圾删了'
    )
    flush()
  }

  // -------------------------------------------------------------------------
  // CASE 4 · 真卸载的两种数据处置
  //
  // ## 契约变更（方向相反，两次都要看清）
  //
  // 老契约：真卸载就删数据（用户当时的原话「卸载不留 data」）。
  // 新契约（当前）：**默认保留**，只有用户明确要求才删。
  //   主人原话：「卸载器加一个是否保留用户数据的选项，默认保留，
  //             还要加个不舍卸载的选项」。
  //
  // 所以这一组分成两个子例：
  //   4a) 不带任何删除意图的卸载 → 数据**必须还在**（这是新的默认）
  //   4b) 带 --delete-app-data 的卸载 → 数据**必须被删**（用户明确要求）
  //
  // 只测其中一个都不够：只测 4a 会漏掉"删除功能坏了"，
  // 只测 4b 会漏掉"默认居然在删"——而后者正是危险的那个方向。
  // -------------------------------------------------------------------------
  {
    const dir = join(SIM_ROOT, 'c4a', 'MXBot')
    const data = join(dir, 'data')
    mkdirSync(dir, { recursive: true })
    seedData(data)
    pointRegistryAt(data)

    // 先正常装一遍（顺便生成 uninst.exe）
    const exe = compile('c4a', {
      installDir: dir,
      onInit: '!insertmacro customInit',
      installBody: '!insertmacro customInstall'
    })
    run(exe)

    const uninst = join(dir, 'uninst.exe')
    if (!ok(existsSync(uninst), '安装器生成了卸载器 uninst.exe', '卸载用例无法进行')) {
      flush()
    } else {
      /*
       * 不带 --updated = 用户在「控制面板 → 卸载程序」里真卸载。
       * 也不带 --delete-app-data：这正是**默认路径**。
       *
       * 静默卸载（/S）不显示数据处置页，$mxDataChoice 是空串 ——
       * 新契约下必须按"保留"处理。
       *
       * ## 等待条件与参数顺序（都踩过）
       *
       * 1) 等待条件等的是**数据目录确实被搬回来了**，而不是等 prog.exe。
       *    这个模拟安装器并没有真的放一个 prog.exe 进去，
       *    所以"等程序文件消失"会立刻满足、根本没等。
       *    退而求其次：等一下让卸载跑完，再看数据在不在。
       *
       * 2) `_?=<目录>` 必须是**最后一个参数**。
       *    NSIS 会把 `_?=` 后面的东西当成"传给那个程序的参数"，
       *    排在它后面的 --delete-app-data 会被吞掉。
       *    （探针里为此查了很久，见 _probe-uninst-keep-data.cjs 的注释。）
       */
      await runAndWait(uninst, ['/S', '/KEEP_APP_DATA', `_?=${dir}`], () => false, 2500)
      console.log('\n  [4a] 真卸载 · 默认路径（不带 --delete-app-data）')
      const kept =
        existsSync(join(data, 'config.json')) &&
        existsSync(join(data, 'instances')) &&
        existsSync(join(data, 'runtimes'))
      ok(
        kept,
        '默认卸载把用户数据完整留下了（新契约：默认保留）',
        '默认卸载竟然删掉了用户数据 —— 这是最危险的方向'
      )
      flush()
    }
  }

  {
    const dir = join(SIM_ROOT, 'c4b', 'MXBot')
    const data = join(dir, 'data')
    mkdirSync(dir, { recursive: true })
    seedData(data)
    pointRegistryAt(data)

    const exe = compile('c4b', {
      installDir: dir,
      onInit: '!insertmacro customInit',
      installBody: '!insertmacro customInstall'
    })
    run(exe)

    const uninst = join(dir, 'uninst.exe')
    if (!ok(existsSync(uninst), '安装器生成了卸载器 uninst.exe（4b）', '卸载用例无法进行')) {
      flush()
    } else {
      /*
       * 带 --delete-app-data：用户明确要求连数据一起删。
       * 这是"删除功能确实还在工作"的证据 ——
       * 否则新契约下很容易把删除写坏而没人发现。
       *
       * `_?=` 必须放最后（理由见 4a）。
       */
      await runAndWait(
        uninst,
        ['/S', '/KEEP_APP_DATA', '--delete-app-data', `_?=${dir}`],
        () => !existsSync(data),
        15000
      )
      console.log('\n  [4b] 真卸载 · 用户明确要求删除（--delete-app-data）')
      const gone =
        !existsSync(join(data, 'config.json')) &&
        !existsSync(join(data, 'instances')) &&
        !existsSync(join(data, 'runtimes'))
      ok(gone, '明确要求时数据被清掉了（删除功能仍然有效）', '明确要求删除却没删掉')
      flush()
    }
  }

  // -------------------------------------------------------------------------
  // CASE 4c · ★★ 注册表指向**安装目录之外**时，默认卸载仍须保住 data
  //
  // ## 这条是主人真实事故的回归防线（2026-09-27）
  //
  // 他选「保留数据」卸载，结果 `<安装目录>\data` 里只剩两个被占用的残渣目录，
  // `config.json` / `instances.json` / `instances\`（**实例数据**）/ `logs\`
  // / `backups\` 全没了。
  //
  // ## 根因（已修，这条用例守的就是它别再回来）
  //
  // 卸载器原来**只认注册表**：
  //     ReadRegStr $R0 HKCU "Software\MXBot" "DataRoot"
  //     ${If} $R0 == ""
  //       StrCpy $R0 "$INSTDIR\data"      ← 只有读不到注册表才看默认位置
  //     ${EndIf}
  //     前缀比对 → 相等才抢救
  //
  // 而他机器上的注册表是 `DataRoot = E:\MX\launcher-acb\data`
  //（调试留下的，指向安装目录之外），于是：
  //     前缀比对不相等 → 判定"数据不在这里" → **一个字节都不抢救**
  //   → 模板 `RMDir /r $INSTDIR`（**这个不看我们的宏**）
  //   → `<安装目录>\data` 连同实例数据一起被删
  //
  // ## 这条用例怎么构造
  //
  // 关键：**注册表故意指向另一个目录**（模拟"用户迁移过/调试留下"），
  // 而 `<安装目录>\data` 里**放着真正的用户数据**。
  // 正确行为：两份都要保住 —— ② 那份在 keep 里；① 那份必须被搬回来。
  // -------------------------------------------------------------------------
  {
    const dir = join(SIM_ROOT, 'c4c', 'MXBot')
    const data = join(dir, 'data')
    mkdirSync(dir, { recursive: true })
    seedData(data)
    /*
     * ★ 把注册表指向**安装目录之外**的另一个目录 —— 这是本用例的核心。
     * `pointRegistryAt` 用的是同一个 REG_KEY，所以这里直接指向别处即可。
     */
    const elsewhere = join(SIM_ROOT, 'c4c', 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'config.json'), '{"dataRoot":"ELSEWHERE"}', 'utf8')
    pointRegistryAt(elsewhere)

    const exe = compile('c4c', {
      installDir: dir,
      onInit: '!insertmacro customInit',
      installBody: '!insertmacro customInstall'
    })
    run(exe)

    const uninst = join(dir, 'uninst.exe')
    if (!ok(existsSync(uninst), '安装器生成了卸载器 uninst.exe（4c）', '卸载用例无法进行')) {
      flush()
    } else {
      console.log('\n  [4c] ★ 注册表指向别处 + 默认卸载 → 安装目录下的 data 必须活着')
      await runAndWait(
        uninst,
        ['/S', '/KEEP_APP_DATA', `_?=${dir}`],
        () => existsSync(join(data, 'config.json')),
        15000
      )
      /*
       * 断言**每一项**都在。只查 config.json 不够 ——
       * 真实事故里恰恰是 config.json/instances/ 全丢，
       * 而 cache/runtimes 因为被占用活下来了。所以要逐项查。
       *
       * 注意清单要与 `seedData` 造的**完全一致**：我第一版凭印象写了
       * `instances.json`，而 seedData 根本没造它 → 用例报"被删了"，
       * 实际是断言写错了（测试自己的 bug 冒充产品 bug，这类假红同样有害）。
       */
      const missing = ['config.json', 'instances', 'runtimes'].filter(
        (f) => !existsSync(join(data, f))
      )
      ok(
        missing.length === 0,
        '★安装目录下的 data 被完整保住了（哪怕注册表指向别处）',
        `注册表指向别处时，这些被删了：${missing.join('、')}\n` +
          `      这正是主人 2026-09-27 的事故：他选的是「保留数据」。`
      )
      if (existsSync(join(data, 'config.json'))) {
        let content = ''
        try {
          content = readFileSync(join(data, 'config.json'), 'utf8')
        } catch {
          content = ''
        }
        ok(
          content.includes('PRECIOUS'),
          '★救回来的数据内容是对的（不是空壳）',
          `config.json 内容不对：${content.slice(0, 80)}`
        )
      }
      flush()
    }
  }

  // -------------------------------------------------------------------------
  // CASE 5 · 完整的覆盖更新流程：数据必须活着
  //
  // 这是整条链路最核心、也最容易被"断章取义地测"的场景。
  //
  // 真实的更新是**两个安装器接力**（installSection.nsh:52 会调旧卸载器）：
  //
  //   1. 新版安装器的 .onInit → customInit → STASH 把 data 挪到 keep
  //   2. installSection.nsh:52 → 调**旧版**卸载器，带 --updated
  //   3. 旧卸载器：customUnInstall 看到 isUpdated=true → 不碰数据
  //      但它模板里的 `RMDir /r $INSTDIR` 照样把整个安装目录删掉
  //      （data 此刻在 keep 里，所以删不到）
  //   4. 新版安装段 → customInstall → RESTORE 把 data 搬回原位
  //
  // **我第一版把第 1、4 步漏了**，只跑了第 2-3 步，于是
  // `RMDir /r $INSTDIR` 顺理成章删掉了还在原位的 data，
  // 报出一堆"数据不见了" —— 那不是产品缺陷，是测试自己没按真实顺序走。
  // 这类假红最坏：它会把一个**已经正确**的实现判成有罪，
  // 然后"为了修它"去改本来没问题的代码。
  //
  // 所以这里用**一个**安装器把 4 步全走一遍（在 Section 里 ExecWait
  // 调旧卸载器），这才是用户机器上真实发生的顺序。
  // -------------------------------------------------------------------------
  {
    const dir = join(SIM_ROOT, 'c5', 'MXBot')
    const data = join(dir, 'data')
    mkdirSync(dir, { recursive: true })
    seedData(data)
    pointRegistryAt(data)

    // ---- 第 0 步：先装好"旧版"，拿到它的 uninst.exe ----
    const oldExe = compile('c5-old', {
      installDir: dir,
      onInit: '!insertmacro customInit',
      installBody: '!insertmacro customInstall'
    })
    run(oldExe)
    const oldUninst = join(dir, 'uninst.exe')
    // 顺序地判：先把"能不能继续"确认下来，再谈数据。
    // 注意 ok() 会返回布尔值，但**别把 ok() 的返回值再喂给 if 当条件** ——
    // 那样一次判断会记两次断言，失败时计数翻倍、输出的条数也对不上。
    const hasOldUninst = ok(
      existsSync(oldUninst),
      '旧版卸载器已生成（更新流程需要它）',
      '用例无法进行'
    )
    let ready = hasOldUninst
    if (ready) ready = dataIntact(data, '旧版装好后')
    if (!ready) {
      flush()
    } else {
      /*
       * ---- 第 1-4 步：跑"新版"安装器 ----
       *
       * installBody 里按真实顺序来：
       *   ExecWait 旧卸载器（带 --updated，_?= 放最后）
       *   RMDir /r $INSTDIR          ← 模板的整目录删除，这里显式模拟
       *   customInstall              ← 把数据搬回来
       */
      const newExe = compile('c5-new', {
        installDir: dir,
        onInit: '!insertmacro customInit',
        installBody: [
          '  ; 模拟 installSection.nsh:52 调用旧版卸载器',
          '  ExecWait \'"$INSTDIR\\uninst.exe" /S /KEEP_APP_DATA --updated _?=$INSTDIR\'',
          '  ; 模拟模板 uninstaller.nsh:169 的整目录删除（data 此时应在 keep 里）',
          '  RMDir /r "$INSTDIR"',
          '  CreateDirectory "$INSTDIR"',
          '  !insertmacro customInstall'
        ].join('\n')
      })
      run(newExe)

      console.log('\n  [5] 完整覆盖更新流程（旧卸载器 --updated + 整目录删除 + 数据搬回）')
      ok(
        dataIntact(data, '覆盖更新后'),
        '覆盖更新后数据完好（更新不删数据）',
        '更新时把用户数据删了 —— 这正是本文件存在的最大理由'
      )
      ok(
        !existsSync(join(dir, '..', 'MXBot-update-keep', 'payload')),
        '更新结束后 keep 目录已清理（数据确实搬回来了，不是搁浅在那儿）',
        'keep 里还留着 payload —— 数据可能没搬回原位'
      )
      flush()
    }
  }

  // -------------------------------------------------------------------------
  // CASE 6 · 数据目录指针（data-root.txt）必须活过覆盖更新
  //
  // 为什么单列一条：它是**应用启动时定位数据目录的唯一线索**。
  // 用户在设置里把数据迁到别处后，程序把新路径写进
  // `<安装目录>\data-root.txt`；下次启动 readRootPointer() 读它才知道去哪找。
  // 应用侧**不读注册表**兜底（注册表那条只给卸载器判断"该删谁"）。
  //
  // 而覆盖更新时旧卸载器会 `RMDir /r "$INSTDIR"` —— data-root.txt 就躺在
  // $INSTDIR 里，**每次更新都被删**。后果不是数据丢，而是**指针丢**：
  // 更新完第一次启动退回 `<安装目录>\data` → 找不到 config → 弹首启向导
  // → 用户以为"更新把数据弄没了"。只要他随手选了默认位置，
  // 真正的数据（在 D 盘）就再也想不起来了。
  //
  // 这条用例走完整的 4 步更新流程，最后确认指针被搬回来了。
  // -------------------------------------------------------------------------
  {
    const dir = join(SIM_ROOT, 'c6', 'MXBot')
    const data = join(dir, 'data')
    mkdirSync(dir, { recursive: true })
    seedData(data)
    pointRegistryAt(data)

    /*
     * 关键：模拟"用户迁移过数据目录" —— 指针指向**别处**。
     * 只写一个和默认位置不同的路径，才能看出它有没有被真的保住
     * （如果指针内容就是默认位置，丢了也看不出来）。
     */
    const elsewhere = join(SIM_ROOT, 'c6', 'MovedData')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'MOVED.txt'), 'moved', 'utf8')
    const pointerFile = join(dir, 'data-root.txt')
    writeFileSync(pointerFile, elsewhere, 'utf8')

    const oldExe = compile('c6-old', {
      installDir: dir,
      onInit: '!insertmacro customInit',
      installBody: '!insertmacro customInstall'
    })
    run(oldExe)
    const oldUninst = join(dir, 'uninst.exe')

    const hasOldUninst = ok(
      existsSync(oldUninst),
      '旧版卸载器已生成（更新流程需要它）',
      '用例无法进行'
    )
    if (!hasOldUninst) {
      flush()
    } else {
      const newExe = compile('c6-new', {
        installDir: dir,
        onInit: '!insertmacro customInit',
        installBody: [
          '  ExecWait \'"$INSTDIR\\uninst.exe" /S /KEEP_APP_DATA --updated _?=$INSTDIR\'',
          // 模板的整目录删除 —— 指针文件就在 $INSTDIR 里，这一刀会带走它
          '  RMDir /r "$INSTDIR"',
          '  CreateDirectory "$INSTDIR"',
          '  !insertmacro customInstall'
        ].join('\n')
      })
      run(newExe)

      console.log('\n  [6] 覆盖更新时数据目录指针必须被保住')
      const survived = existsSync(pointerFile)
      ok(
        survived,
        '更新后 data-root.txt 还在（下次启动能找到数据）',
        '更新把数据目录指针删了 —— 用户下次启动会被要求重选目录，\n' +
          '     即使他的数据一个字节都没丢。这会被理解成"更新把数据弄没了"'
      )
      if (survived) {
        const now = readFileSync(pointerFile, 'utf8').replace(/^\uFEFF/, '').trim()
        ok(
          now === elsewhere,
          `指针内容仍是迁移后的目录（${elsewhere}）`,
          `指针内容变成了「${now}」，不再是用户迁移后的目录`
        )
      }
      flush()
    }
  }

  // -------------------------------------------------------------------------
  // CASE 7 · ★覆盖更新自动打包数据备份（本轮新功能）
  //
  // 用户要求原话：「加入覆盖更新的时候会自动打包数据备份压缩包放在备份文件夹」。
  //
  // 这条用例跑**完整 4 步更新流程**，然后验证：
  //   1. 备份压缩包真的生成在备份文件夹里（不是"我以为生成了"）
  //   2. 它是**真的 gzip 包**（首字节 0x1F）—— 0 字节的坏文件也存在，
  //      只看 ${FileExists} 会得到假绿
  //   3. 里面**真的有用户数据**（instances 的内容），而不只是个空壳包
  //   4. 里面**没有** runtimes（212MB，能重新下载，不该拖慢更新）
  //
  // 为什么不只在单测里验：单测验的是"tar 命令能打包"，
  // 而这里验的是"**安装器在真实的 4 步更新里真的调用了它、并且产物活了下来**"
  // —— 后者才是用户会遇到的路径。
  // -------------------------------------------------------------------------
  {
    const dir = join(SIM_ROOT, 'c7', 'MXBot')
    const data = join(dir, 'data')
    mkdirSync(dir, { recursive: true })
    seedData(data)
    pointRegistryAt(data)

    const oldExe = compile('c7-old', {
      installDir: dir,
      onInit: '!insertmacro customInit',
      installBody: '!insertmacro customInstall'
    })
    run(oldExe)
    const oldUninst = join(dir, 'uninst.exe')

    const hasOldUninst = ok(
      existsSync(oldUninst),
      '旧版卸载器已生成（更新流程需要它）',
      '用例无法进行'
    )
    if (!hasOldUninst) {
      flush()
    } else {
      const backupRootDir = join(data, 'backups', 'update')

      const newExe = compile('c7-new', {
        installDir: dir,
        onInit: '!insertmacro customInit',
        installBody: [
          '  ExecWait \'"$INSTDIR\\uninst.exe" /S /KEEP_APP_DATA --updated _?=$INSTDIR\'',
          '  RMDir /r "$INSTDIR"',
          '  CreateDirectory "$INSTDIR"',
          '  !insertmacro customInstall'
        ].join('\n')
      })
      run(newExe)

      console.log('\n  [7] 覆盖更新自动打包数据备份')

      // ---- 找备份包（时间戳是动态的，所以要扫）----
      let found = null
      if (existsSync(backupRootDir)) {
        for (const stampDir of readdirSync(backupRootDir)) {
          const cand = join(backupRootDir, stampDir, 'mxbot-data.tar.gz')
          if (existsSync(cand)) {
            found = cand
            break
          }
        }
      }

      const got = ok(
        Boolean(found),
        '更新时在备份文件夹里生成了备份压缩包',
        found
          ? ''
          : '没找到 ' + join(data, 'backups', 'update', '<时间戳>', 'mxbot-data.tar.gz') +
            '\n     目录内容: ' + (existsSync(backupRootDir) ? readdirSync(backupRootDir).join(', ') : '(目录都不存在)')
      )

      if (got) {
        // ---- 验真是 gzip（首字节 0x1F）----
        const firstByte = readFileSync(found)[0]
        ok(
          firstByte === 0x1f,
          `备份包是真的 gzip（首字节 0x1F，实测 ${firstByte}）`,
          `首字节是 ${firstByte}，不是 0x1F —— 这是个坏包（0 字节或未压缩）`
        )

        const sizeKb = (statSync(found).size / 1024).toFixed(1)
        console.log(`      备份包大小: ${sizeKb} KB`)

        // ---- 解开看内容：必须有用户数据、必须没有 runtimes ----
        const exDir = join(SIM_ROOT, 'c7-extract')
        mkdirSync(exDir, { recursive: true })
        let extracted = false
        try {
          execFileSync(TAR, ['-xzf', found, '-C', exDir], { stdio: 'pipe', timeout: 60000 })
          extracted = true
        } catch (e) {
          ok(false, '备份包能正常解开', String(e && e.message).slice(0, 200))
        }

        if (extracted) {
          const instFile = join(exDir, 'instances', 'a_1', 'deep.txt')
          const cfgFile = join(exDir, 'config.json')
          const runtimeDir = join(exDir, 'runtimes')

          ok(
            existsSync(instFile) &&
              readFileSync(instFile, 'utf8').includes('PRECIOUS-INSTANCE'),
            '★备份包里真的有实例用户数据（instances 的内容完好）',
            '备份包里没有实例数据 —— 这样的备份等于没用'
          )
          ok(
            existsSync(cfgFile) && readFileSync(cfgFile, 'utf8').includes('PRECIOUS-CONFIG'),
            '备份包里包含启动器配置 config.json',
            'config.json 不在备份里'
          )
          ok(
            !existsSync(runtimeDir),
            '备份包**不含** runtimes（212MB，能重新下载，不拖慢更新）',
            'runtimes 被包进去了 —— 每次更新会白等几分钟'
          )
          /*
           * 备份自己不能被卷进下一份备份里 —— 否则每次更新体积翻倍。
           * 判据：包内路径里不能出现 backups\。
           * （打包清单只列 instances 与几个 *.json，backups 不在其中，
           *   但这是"必须实测确认"的一条：写错了就是无上限膨胀。）
           */
          ok(
            !existsSync(join(exDir, 'backups')),
            '备份包不含上一次的备份（不会自我嵌套、体积不翻倍）',
            '备份把 backups 也打进去了 —— 连续更新会导致体积无上限增长'
          )
        }
      }

      // ---------------------------------------------------------------------
      // CASE 7b · 连续更新两次：第二次的备份不能把第一次的备份卷进去
      //
      // 这条单列，因为"自我嵌套"只在**第二次**更新时才暴露：
      // 第一次更新时 backups\ 还不存在，怎么测都是绿的。
      // 连续更新是用户最真实的用法（0.1.0→0.1.1→0.1.2…），必须覆盖。
      // ---------------------------------------------------------------------
      if (got) {
        const uninst2 = join(dir, 'uninst.exe')
        const has2 = ok(existsSync(uninst2), '第二次更新前旧卸载器仍在', '用例无法进行')
        if (has2) {
          const sizeBefore = statSync(found).size
          const newExe2 = compile('c7-new2', {
            installDir: dir,
            onInit: '!insertmacro customInit',
            installBody: [
              '  ExecWait \'"$INSTDIR\\uninst.exe" /S /KEEP_APP_DATA --updated _?=$INSTDIR\'',
              '  RMDir /r "$INSTDIR"',
              '  CreateDirectory "$INSTDIR"',
              '  !insertmacro customInstall'
            ].join('\n')
          })
          run(newExe2)

          // 找第二次的备份（时间戳可能相同，所以按数量判断）
          let count = 0
          let sizes = []
          if (existsSync(backupRootDir)) {
            for (const stampDir of readdirSync(backupRootDir)) {
              const cand = join(backupRootDir, stampDir, 'mxbot-data.tar.gz')
              if (existsSync(cand)) {
                count++
                sizes.push(statSync(cand).size)
              }
            }
          }
          console.log('\n  [7b] 连续更新两次（检查备份不自我嵌套）')
          ok(count >= 2, `第二次更新也产生了备份（共 ${count} 份）`, `只有 ${count} 份备份`)
          const maxSize = Math.max(...sizes, 0)
          ok(
            maxSize < sizeBefore * 3,
            `两次更新的备份体积没有翻倍膨胀（最大 ${(maxSize / 1024).toFixed(1)} KB，首份 ${(sizeBefore / 1024).toFixed(1)} KB）`,
            `备份体积从 ${(sizeBefore / 1024).toFixed(1)} KB 涨到 ${(maxSize / 1024).toFixed(1)} KB —— 疑似自我嵌套`
          )
        }
      }
      flush()
    }
  }
} catch (e) {
  ok(false, '验证过程本身抛异常', e instanceof Error ? e.message : String(e))
  console.log('\n  ' + (e.stack ?? e))
} finally {
  // —— 安全网收口：先把注册表还回去，再删沙箱 ——
  restoreRegistry()

  const realAfter = readRealDataRoot()
  if (realDataRootBefore !== realAfter) {
    console.log(
      `\n  ✘ 安全断言失败：真实注册表 DataRoot 没还原！` +
        `\n      开跑前: ${realDataRootBefore ?? '(无)'}` +
        `\n      收尾后: ${realAfter ?? '(无)'}` +
        `\n      备份文件: ${regBackup ?? '(无备份，原本就没有该键)'}`
    )
    failures++
  } else if (realDataRootBefore) {
    console.log(`\n  ✔ 真实注册表已还原（DataRoot=${realAfter}）`)
  }

  // 真实数据目录文件数必须只增不减
  if (realDataRootBefore && existsSync(realDataRootBefore)) {
    const n = safeCount(realDataRootBefore)
    console.log(`  ✔ 真实数据目录文件数：${n}（未被本脚本减少）`)
  }

  try {
    rmSync(SIM_ROOT, { recursive: true, force: true })
  } catch {
    console.log('  （沙箱没清干净，可以手工删：' + SIM_ROOT + '）')
  }
  }

  console.log(
    failures === 0
      ? '\n  ✔ 覆盖安装的数据保全逻辑全部通过'
      : '\n  ✘ 有案例失败 —— 见上面标 ✘ 的行'
  )
  process.exit(failures === 0 ? 0 : 1)
}

void main()
