/*
 * 全项目自检脚本 —— 把「人工排查」变成「一条命令」。
 *
 * 为什么需要它：这个项目里已经出现过好几类**编译器和单元测试都发现不了**的问题，
 * 每一次都是靠手工扫描才挖出来的：
 *   - 审计模块写好了却没接进 handler（甚至一度写在 `return` 之后成了死代码）
 *      → 类型检查通过、模块单测全绿，功能却完全没生效
 *   - `pruneBackups` 定义在同文件后被调用，我第一版扫描器把整个文件的使用都扣掉了，
 *     误报成死代码 → 说明扫描器自己也需要校验
 *   - 默认配置里 `backupKeep: 5` 与 `BACKUP_KEEP_DEFAULT = 5` 是两份独立的真相
 *   - `instances.json` 损坏时整个实例列表消失（JSON.parse 无保护）
 *
 * 用法：node scripts/self-check.cjs
 * 退出码非 0 表示发现了需要人工确认的问题。
 */
const fs = require('fs')
const path = require('path')
/*
 * 给 checkInstallerCompiles 用（真的调 makensis 编译 installer.nsh）。
 * 这条检查是本文件里唯一"会执行外部程序"的，因为它要补的正是
 * 静态检查永远看不见的那类问题：**编译不过**。
 */
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
process.chdir(ROOT)

const issues = []
const notes = []

function walk(d, exts, out = []) {
  if (!fs.existsSync(d)) return out
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'out' || e.name === 'dist')
        continue
      walk(p, exts, out)
    } else if (exts.some((x) => e.name.endsWith(x))) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/')
const read = (p) => fs.readFileSync(p, 'utf8')

// ── 1. 死代码：导出了但全项目没人用 ───────────────────────────────
// 注意精确排除**定义那一行**，不是整个文件
//（早期版本扣掉整个文件，把「定义后被同文件调用」的函数误报成死代码）
function checkDeadCode() {
  const srcFiles = walk(path.join(ROOT, 'src'), ['.ts', '.vue'])
  const allFiles = srcFiles.concat(walk(path.join(ROOT, 'tests'), ['.ts', '.vue']))
  const exported = new Map()
  for (const f of srcFiles) {
    read(f)
      .split('\n')
      .forEach((l, i) => {
        let m = l.match(/^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/)
        if (!m) m = l.match(/^export\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/)
        if (m) exported.set(m[1], { file: f, line: i + 1 })
      })
  }
  for (const [name, def] of exported) {
    const re = new RegExp('\\b' + name.replace(/[$]/g, '\\$') + '\\b')
    let hits = 0
    for (const f of allFiles) {
      read(f)
        .split('\n')
        .forEach((l, i) => {
          if (!re.test(l)) return
          if (f === def.file && i + 1 === def.line) return
          hits++
        })
    }
    if (hits === 0) issues.push(`死代码：${rel(def.file)}:${def.line} 导出 ${name} 无人使用`)
  }
  notes.push(`导出符号 ${exported.size} 个`)
}

// ── 2. 裸 JSON.parse：本地文件解析必须有保护 ─────────────────────
function checkJsonParse() {
  const files = walk(path.join(ROOT, 'src', 'main'), ['.ts'])
  for (const f of files) {
    const lines = read(f).split('\n')
    lines.forEach((l, i) => {
      /*
       * 先排除注释行。
       *
       * 踩过的坑：json-file.ts 的文档注释里**引用**了那个坏写法
       * （为了让后人看懂这个文件为什么存在），扫描器却把它当成真代码，
       * 于是常年报一条假阳性 —— 而假阳性会让真正的问题被淹没
       * （每次都是「已知的那 1 条」，真出事时看不出来）。
       */
      const trimmed = l.trim()
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
      if (!/JSON\.parse\(readFileSync/.test(l)) return
      if (/fetch|await/.test(l)) return // 远端数据，另有来源
      // 往上找 25 行内有没有 try
      let guarded = false
      for (let j = i; j >= Math.max(0, i - 25); j--) {
        if (/\btry\s*\{/.test(lines[j])) {
          guarded = true
          break
        }
      }
      if (!guarded) {
        issues.push(`裸 JSON.parse：${rel(f)}:${i + 1} 没有 try 保护（文件坏了会崩）`)
      }
    })
  }
}

// ── 3. PowerShell 单引号拼接：路径含 ' 就炸 ──────────────────────
function checkPsQuote() {
  const files = walk(path.join(ROOT, 'src', 'main'), ['.ts'])
  for (const f of files) {
    read(f)
      .split('\n')
      .forEach((l, i) => {
        if (/Expand-Archive/.test(l) && /\$\{/.test(l) && !/psQuote/.test(l)) {
          if (/^\s*(\/\/|\*)/.test(l)) return // 注释
          issues.push(
            `PowerShell 拼接：${rel(f)}:${i + 1} 直接用 \${} 塞路径，含单引号会解析失败（用 psQuote/expandArchive）`
          )
        }
      })
  }
}

// ── 4. 硬编码端口：必须引用 constants ────────────────────────────
function checkMagicPorts() {
  const files = walk(path.join(ROOT, 'src', 'main'), ['.ts'])
  for (const f of files) {
    if (rel(f).endsWith('constants.ts')) continue
    if (rel(f).endsWith('instance-repo.ts')) continue // 注释里说明分段
    read(f)
      .split('\n')
      .forEach((l, i) => {
        if (/^\s*(\/\/|\*)/.test(l)) return
        if (/\b6[12]\d\d\b/.test(l)) {
          issues.push(`硬编码端口：${rel(f)}:${i + 1} 应引用 constants 里的 PORT_RANGE_*`)
        }
      })
  }
}

// ── 5. 测试临时目录：绝不能再用 os.tmpdir()（C 盘会被吃爆）────────
function checkTmpdir() {
  const files = walk(path.join(ROOT, 'tests'), ['.ts'])
  for (const f of files) {
    const r = rel(f)
    if (r.endsWith('no-c-drive-temp.spec.ts') || r.endsWith('workdir.spec.ts')) continue
    read(f)
      .split('\n')
      .forEach((l, i) => {
        if (/^\s*(\/\/|\*)/.test(l)) return
        if (/\btmpdir\s*\(/.test(l)) {
          issues.push(`C 盘临时目录：${r}:${i + 1} 用 tmpdir()，应改用 testStage()`)
        }
      })
  }
}

// ── 6. 空 catch（只留注释）：确认是有意忽略而非漏处理 ────────────

/**
 * 把源码里的注释抹成空白，**保留行号与列位**。
 *
 * 为什么必须做这一步：这个检查器原来直接在原始文本上找 `catch ... {`，
 * 于是**注释里提到 `catch {}` 也会命中**。实际踩到了两次：
 *   - relocate.ts 的文档注释里解释「原来这些 try 全是空的 catch {}」
 *   - ipc.ts 的注释里写「失败被 relocate 的 catch {} 静默吞掉」
 * 两处都是**正在说明这个坏写法**的好注释，却被报成「完全空的 catch」。
 *
 * 这种假阳性很误导：它逼着人把注释改得含糊（不敢写出真实代码形状），
 * 而检查器本身该做的是分清"代码"和"说代码的话"。
 *
 * 用状态机逐字符扫，把注释内容替换成空格（不删字符，所以列位不变，
 * 换行原样保留，行号也不会漂）。
 *
 * 注意要处理字符串/模板串里的 `//` 和 `/*` —— 否则一个 URL（`http://x`）
 * 会被当成行注释的开始，把它后面整行代码都抹掉。
 */
function stripComments(src) {
  const out = []
  let i = 0
  const n = src.length
  // 状态：0=普通代码 1=行注释 2=块注释 3=单引号串 4=双引号串 5=反引号模板串
  let st = 0
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (st === 0) {
      if (c === '/' && d === '/') {
        st = 1
        out.push('  ')
        i += 2
        continue
      }
      if (c === '/' && d === '*') {
        st = 2
        out.push('  ')
        i += 2
        continue
      }
      if (c === "'") st = 3
      else if (c === '"') st = 4
      else if (c === '`') st = 5
      out.push(c)
      i++
      continue
    }
    if (st === 1) {
      // 行注释：到行尾为止（换行本身保留）
      if (c === '\n') {
        st = 0
        out.push(c)
      } else out.push(' ')
      i++
      continue
    }
    if (st === 2) {
      // 块注释：到 */ 为止；里面的换行**必须保留**，否则行号会漂
      if (c === '*' && d === '/') {
        st = 0
        out.push('  ')
        i += 2
        continue
      }
      out.push(c === '\n' ? '\n' : ' ')
      i++
      continue
    }
    // 字符串/模板串内部：原样保留，只关心转义和结束符
    if (c === '\\') {
      out.push(c, d ?? '')
      i += 2
      continue
    }
    if ((st === 3 && c === "'") || (st === 4 && c === '"') || (st === 5 && c === '`')) st = 0
    out.push(c)
    i++
  }
  return out.join('')
}

function checkEmptyCatch() {
  const files = walk(path.join(ROOT, 'src', 'main'), ['.ts'])
  const suspicious = []
  for (const f of files) {
    const raw = read(f)
    /*
     * 两份文本各司其职：
     *   - `codeLines`：注释被抹成空白 → 用来**定位** catch（不受注释干扰）
     *   - `rawLines` ：原文 → 用来判断 catch 体里**有没有写注释**
     *
     * 只留注释的空 catch 是**好习惯**（说明"为什么可以忽略"），不算问题；
     * 真正要提醒人的是 `catch {}` 里连一句交代都没有。
     * 原来的检查器把注释文本也算进 inner，恰好实现了这个语义 ——
     * 但它同时也把"注释里提到 catch {}"误判成了问题（见 stripComments）。
     * 所以这里分开取：定位看 codeLines，判断看 rawLines，两个语义都保住。
     */
    const codeLines = stripComments(raw).split('\n')
    const rawLines = raw.split('\n')
    codeLines.forEach((l, i) => {
      const m = l.match(/catch\s*(?:\([^)]*\))?\s*\{/)
      if (!m) return
      // 用两个版本各扫一遍花括号，保证取到的是同一段
      const grab = (lines) => {
        let depth = 0
        const startCol = lines[i].indexOf('{', m.index)
        let body = ''
        for (let j = i; j < lines.length; j++) {
          const seg = j === i ? lines[j].slice(startCol) : lines[j]
          for (const c of seg) {
            if (c === '{') depth++
            else if (c === '}') depth--
          }
          body += ' ' + seg
          if (depth === 0) break
        }
        return body.replace(/^[^{]*\{/, '').replace(/\}[^}]*$/, '').trim()
      }
      const innerCode = grab(codeLines) // 去掉注释后的实际代码
      const innerRaw = grab(rawLines) // 原文（含注释）
      /*
       * 既没有代码、也没有注释 → 真的什么都没交代。
       * 有任何一样就不报（注释同样是人类确认过的痕迹）。
       */
      if (!innerCode && !innerRaw) suspicious.push(`${rel(f)}:${i + 1} 完全空的 catch`)
    })
  }
  for (const s of suspicious) issues.push(`空 catch：${s}`)
}


// ── 7. 跨进程约定：写清单的一方和读清单的一方必须对齐 ─────────────
//
// 这一类问题最阴：约定写在注释里、生产侧写了、读取侧没实现，
// 平时不响（服务器上没这类条目时完全正常），一旦上架就炸。
// 真实案例（2026-09-13）：发布脚本 PYPI_HINT 写 `asset: "pypi:astrbot"`
// 表达「AstrBot 走 PyPI 分发」，注释里也写清楚了，
// 但 version-catalog 的 fromFilesSource 把它当普通文件路径，
// 拼出 .../pypi:astrbot 去下载 → 必然 404。
function checkCrossProcessContract() {
  const pubPath = path.join(ROOT, 'scripts', 'publish-runtime.py')
  const catPath = path.join(ROOT, 'src', 'main', 'update', 'version-catalog.ts')
  if (!fs.existsSync(pubPath) || !fs.existsSync(catPath)) return

  const pub = read(pubPath)
  const cat = read(catPath)

  // 发布侧写了 pypi: 前缀约定 → 读取侧必须真的识别它
  // 注意：必须查**代码**而不是注释。第一版写得太松（/pypi:/ 会命中注释），
  // 就算实现被删掉也照样通过 —— 那种自检等于没查。
  const declaresPypi = /asset['"]?\s*:\s*['"]pypi:/.test(pub) || /'pypi:astrbot'/.test(pub)
  const handlesPypi = /startsWith\('pypi:'\)/.test(cat)
  if (declaresPypi && !handlesPypi) {
    issues.push(
      '跨进程约定不匹配：publish-runtime.py 会上架 `pypi:` 前缀的条目，' +
        '但 version-catalog.ts 没识别它（会被当文件路径去下载 → 404）'
    )
  }
  // 发布侧会上架哪些文件名 → 读取侧/代码里是否认得（粗查关键字）
  const shellZip = /NapCat\.Shell\.zip/.test(pub)
  if (shellZip && /NapCatWinBootMain/.test(pub)) {
    // 只作提示：发布侧知道要发 Shell 形态
    notes.push('发布脚本按 Shell 形态上架 NapCat（正确）')
  }
}

/*
 * ── 8. 安装脚本（installer.nsh）的关键防线还在不在 ────────────────
 *
 * 为什么单列一项：这个文件是整个项目里**唯一会删用户数据**的东西，
 * 却既不在 TypeScript 编译范围内，也不被 vitest 覆盖 ——
 * 也就是说，上面所有检查都管不到它。
 *
 * 而它踩过的两类坑都是"编辑器/脚本一改就静默失效"：
 *
 *   1. **整数比较判 robocopy 结果**：`${If} $R6 > 7` 对字符串 "error"
 *      判假 → robocopy 起不来时走"成功"分支 → 立刻 `RMDir /r` 删掉
 *      唯一备份。改成逐串白名单（0..7）。
 *   2. **MessageBox 缺 /SD**：SilentInstall 只压向导界面、不压对话框。
 *      静默安装（`/S`、自动更新）时框会弹出来等人点 → **永久卡住**。
 *      实测：不带 /SD 3 秒超时被杀；带 /SD IDOK 132ms 自己过。
 *
 * 配平和 /SD 的判定逻辑复用 scripts/nsi-lint.cjs —— 那里踩过另外两个坑
 * （`${IfNot}`/`${Unless}` 也是开块；注释里引用的 `${If}` 不是真代码），
 * 所以不要在自检里另写一套正则。
 */
function checkInstallerScript() {
  const nsh = path.join(ROOT, 'build', 'installer.nsh')
  if (!fs.existsSync(nsh)) {
    issues.push('build/installer.nsh 不见了 —— 它是安装/覆盖更新的全部逻辑所在')
    return
  }
  const t = read(nsh)
  const isComment = (l) => /^\s*[;*]/.test(l)

  // 1) 不能用整数比较判 robocopy 结果（`$R6 > 7`）
  const badCmp = t
    .split(/\r?\n/)
    .some((l) => /\$R6\s*>\s*7/.test(l) && !isComment(l))
  if (badCmp) {
    issues.push(
      'installer.nsh 又出现了 `$R6 > 7` 整数比较判 robocopy 结果 —— ' +
        'nsExec 在程序起不来时压的是字符串 "error"，整数比较会判假、' +
        '被当成成功，紧接着 RMDir /r 删掉唯一备份。必须用白名单逐串比较。'
    )
  }
  if (!t.includes('!macro MXBOT_ROBO_VERDICT')) {
    issues.push('installer.nsh 缺少 MXBOT_ROBO_VERDICT 宏（robocopy 退出码白名单判定）')
  }

  // 2) 恢复失败的闸门必须在（否则 STASH 会删掉 RESTORE 承诺保留的备份）
  if (!t.includes('${If} $mxRestoreFailed == "1"')) {
    issues.push(
      'installer.nsh 缺少 customInit 里的 $mxRestoreFailed 闸门 —— ' +
        '恢复失败后仍会跑 STASH，把弹框刚承诺"还在"的那份唯一备份删掉'
    )
  }
  if (!t.includes('${If} $mxRestoreFailed != "1"')) {
    issues.push('installer.nsh 缺少 MXBOT_STASH_KEEP 内部闸门（单靠 customInit 那道不够）')
  }

  // 3) $mxKeepDir 必须幂等（各调用点重算会导致数据搁浅）
  if (!t.includes('${If} $mxKeepDir == ""')) {
    issues.push(
      'installer.nsh 的 MXBOT_SET_KEEP 不是幂等的 —— ' +
        'RESTORE/STASH 各自按当前 $INSTDIR 重算落脚点，改过安装目录时数据会搁浅'
    )
  }

  // 4) 结构配平 + MessageBox 的 /SD（复用 nsi-lint，那边踩过坑）
  let lint
  try {
    lint = require('./nsi-lint.cjs')
  } catch {
    issues.push('scripts/nsi-lint.cjs 不见了，无法校验 NSIS 结构')
    return
  }
  const logic = lint.checkLogicBalance(t)
  if (!logic.ok) {
    issues.push(`installer.nsh 的 LogicLib 块不配平：${logic.problems.join('；')}`)
  }
  const macros = lint.checkMacroBalance(t)
  if (!macros.ok) {
    issues.push(`installer.nsh 的宏不配平：${macros.problems.join('；')}`)
  }
  const mb = lint.checkMessageBoxSD(t)
  if (!mb.ok) {
    issues.push(
      `installer.nsh 有 MessageBox 缺 /SD（${mb.problems.join('；')}）—— ` +
        '静默安装时对话框仍会弹出并永久等待，自动更新会卡死'
    )
  } else if (mb.detail.total > 0) {
    notes.push(`installer.nsh 的 ${mb.detail.total} 个 MessageBox 都带 /SD`)
  }

  notes.push(`installer.nsh LogicLib 开 ${logic.detail.totalOpen} / 收 ${logic.detail.ends}`)
}

/**
 * 真的用 makensis 编译一遍 installer.nsh —— **两遍**（安装器 / 卸载器）。
 * ==================================================================
 *
 * ## 为什么必须补这一条（打包实机踩到的）
 *
 * 上面 checkInstallerScript 全是**静态文本检查**：找关键字、数括号、
 * 看 MessageBox 有没有 /SD。它能发现"写错了"，但发现不了
 * **"根本编译不过"**。
 *
 * 实机教训：我给 RESTORE 失败加了一个 `$mxRestoreFailed` 变量，
 * 声明在顶层 `Var /GLOBAL mxRestoreFailed`。静态检查全绿 ——
 * 变量在、两个闸门都在、括号也配平。于是自检打印「未发现问题。」
 *
 * 然后 `electron-builder` 打包**直接失败**：
 *
 *     warning 6001: Variable "mxRestoreFailed" not referenced or never set,
 *                   wasting memory!
 *     Error: warning treated as error
 *
 * 因为 electron-builder 给 makensis 传了 **`/WX`**，而且它把 NSIS 编译
 * **跑两遍**：第一遍 `BUILD_UNINSTALLER` 只生成卸载器。那一遍里
 * 只编译 customUnInstall，安装侧的宏都不展开 —— 于是那个变量
 * "声明了却没被引用"，撞上 /WX 就成了硬错误。
 *
 * 静态检查永远看不见这种"只在某一编译遍里成立"的问题。
 * 所以这里补一条**真编译**：两遍都跑，任何 warning 都算问题。
 *
 * ## 找不到 makensis 时怎么办
 *
 * **不能静默跳过**。跳过就等于把"打包能不能过"这件事重新变成盲区，
 * 而这次正是被它坑的。所以：找不到 makensis 时**报 issue**
 * （并说明怎么找到它），而不是记一条 notes 就过。
 *
 * makensis 通常在 electron-builder 的缓存里（本机没独立装 NSIS）：
 *   %LOCALAPPDATA%\electron-builder\Cache\nsis\nsis-<ver>\makensis.exe
 */
function checkInstallerCompiles() {
  const nsh = path.join(ROOT, 'build', 'installer.nsh')
  if (!fs.existsSync(nsh)) return // 上面已经报过

  // 1) 找 makensis（系统安装位置 + electron-builder 缓存）
  const candidates = [
    'C:\\Program Files (x86)\\NSIS\\makensis.exe',
    'C:\\Program Files\\NSIS\\makensis.exe',
    process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, 'Programs', 'NSIS', 'makensis.exe')
      : ''
  ].filter(Boolean)
  let makensis = candidates.find((c) => fs.existsSync(c))

  if (!makensis && process.env.LOCALAPPDATA) {
    const cacheRoot = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis')
    if (fs.existsSync(cacheRoot)) {
      try {
        const dirs = fs
          .readdirSync(cacheRoot)
          .filter((n) => n.startsWith('nsis-'))
          .sort()
          .reverse()
        for (const d of dirs) {
          for (const rel of ['makensis.exe', path.join('Bin', 'makensis.exe')]) {
            const p = path.join(cacheRoot, d, rel)
            if (fs.existsSync(p)) {
              makensis = p
              break
            }
          }
          if (makensis) break
        }
      } catch {
        /* 读不了就继续 */
      }
    }
  }

  if (!makensis) {
    issues.push(
      '找不到 makensis，无法验证 installer.nsh 能否编译 —— ' +
        '这正是上次打包失败的盲区（静态检查全绿但 makensis 报 warning 6001，' +
        'electron-builder 用 /WX 把警告当错误，整条打包直接失败）。' +
        '装 NSIS，或让 electron-builder 先下好缓存。'
    )
    return
  }

  /*
   * 1.5) 找 StdUtils.nsh 与它的插件目录。
   *
   * ## 为什么必须带上它
   *
   * 探针原来用一条假的 isUpdated（`StrCmp "x" "y"`）绕开 StdUtils，
   * 结果**连 installer.nsh 里真实的 StdUtils 调用也一起绕过了**：
   * 我新加的 `${StdUtils.TestParameter} $R9 "delete-app-data"`
   * 在探针里报 "Invalid command"，而真实打包是有的。
   *
   * 真实打包（NsisTarget.js:530-538）明确会：
   *   include(nsisTemplatesDir/include/StdUtils.nsh)
   *   addPluginDir("x86-unicode", nsisResourcePath/plugins/x86-unicode)
   *
   * 所以探针也要 include 它。
   *
   * 注意两者的来源不同：
   *   StdUtils.nsh  → electron-builder 自己的 templates 目录（npm 包里）
   *   插件 dll      → electron-builder 的 nsis-resources 缓存
   * NSIS 本体缓存里**没有** StdUtils.nsh（那是第三方插件，不在 NSIS 里）。
   */
  let stdUtilsNsh = null
  let stdUtilsPluginDir = null
  const pnpmDir = path.join(ROOT, 'node_modules', '.pnpm')
  if (fs.existsSync(pnpmDir)) {
    for (const d of fs.readdirSync(pnpmDir)) {
      if (!d.startsWith('app-builder-lib@')) continue
      const p = path.join(
        pnpmDir,
        d,
        'node_modules',
        'app-builder-lib',
        'templates',
        'nsis',
        'include',
        'StdUtils.nsh'
      )
      if (fs.existsSync(p)) stdUtilsNsh = p
    }
  }
  if (process.env.LOCALAPPDATA) {
    const nsisCache = path.join(process.env.LOCALAPPDATA, 'electron-builder', 'Cache', 'nsis')
    if (fs.existsSync(nsisCache)) {
      for (const d of fs.readdirSync(nsisCache)) {
        const p = path.join(nsisCache, d, 'plugins', 'x86-unicode')
        if (fs.existsSync(p)) stdUtilsPluginDir = p
      }
    }
  }

  /*
   * 2) 造一个最小外壳去 include 目标文件。
   *
   * 不能只把 installer.nsh 直接喂给 makensis —— 它依赖 electron-builder
   * 注入的一堆 !define（VERSION / UNINSTALL_APP_KEY / isUpdated 宏 …），
   * 缺了会报一堆无关错误，把真正的问题埋掉。
   *
   * 所以这里把**必须的 define 补齐**，尽量贴近真实环境。
   * 关键是 `BUILD_UNINSTALLER` 那一遍：那才是这次踩到的地方。
   */
  const os = require('os')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mxbot-selfcheck-nsis-'))
  /*
   * `MUI_ICON` 必须指向**真实存在**的 ico。
   *
   * 我第一版填了个占位 "x.ico"，于是 MUI_PAGE_INIT → MUI_INTERFACE
   * 在加载图标时直接失败（can't open file），报出来一堆
   * "Error in macro MUI_PAGE_DIRECTORY" —— 又是**探针自己造的假问题**。
   * 探针里的每一处占位都必须是真的能打开的东西，否则测的就不是产品代码。
   *
   * 优先用项目真实图标；找不到就现场造一个最小合法 ico（1x1）。
   */
  let iconPath = path.join(ROOT, 'build', 'icon.ico')
  if (!fs.existsSync(iconPath)) {
    // 最小合法 .ico：ICONDIR + 1 个 1x1 32bpp 条目
    const ico = Buffer.from([
      0, 0, 1, 0, 1, 0, // ICONDIR: reserved=0, type=1, count=1
      1, 1, 0, 0, 1, 0, 32, 0, // ICONDIRENTRY: 1x1, 1 plane, 32bpp
      48, 0, 0, 0, // size = 48
      22, 0, 0, 0 // offset = 22
      // 后面跟 BITMAPINFOHEADER(40) + 像素(4) + AND 掩码(4) = 48 字节
    ])
    const body = Buffer.alloc(48)
    body.writeUInt32LE(40, 0) // biSize
    body.writeInt32LE(1, 4) // biWidth
    body.writeInt32LE(2, 8) // biHeight (含掩码)
    body.writeUInt16LE(1, 12) // biPlanes
    body.writeUInt16LE(32, 14) // biBitCount
    // biSizeImage = 40
    body.writeUInt32LE(40, 20)
    iconPath = path.join(tmp, 'probe.ico')
    fs.writeFileSync(iconPath, Buffer.concat([ico, body]))
  }
  let bad = 0
  try {
    /*
     * 两遍：正常安装器 + 卸载器。
     *
     * `BUILD_UNINSTALLER` 那一遍定义了 /WX 会抓到的"未引用变量"，
     * 是这次的真实成因，必须覆盖。
     */
    for (const pass of ['install', 'uninstaller']) {
      // 图标路径要**转义反斜杠**再进 NSIS 字符串（Windows 路径里有 \）
      const iconDef = `!define MUI_ICON "${iconPath.replace(/\\/g, '\\\\')}"`
      /*
       * ── 为什么要补 PRODUCT_FILENAME / APP_EXECUTABLE_FILENAME ─────────
       *
       * 探针原来只给 VERSION / UNINSTALL_APP_KEY / PRODUCT_NAME，
       * 于是 installer.nsh 里用到的 `${APP_EXECUTABLE_FILENAME}` 报
       *   warning 6000: unknown variable/constant
       * 被 /WX 变成 error —— 而**真实打包根本没这个问题**：
       *
       *   NsisTarget.js:149-162   defines 里**无条件**含
       *                           PRODUCT_FILENAME = appInfo.productFilename
       *                           （BUILD_UNINSTALLER 是 326 行加、350 行删，
       *                             所以安装器和卸载器**两遍都有**它）
       *   common.nsh:16           !define APP_EXECUTABLE_FILENAME
       *                                    "${PRODUCT_FILENAME}.exe"
       *   installer.nsi:8         !include "common.nsh"   ← 无条件，两遍都 include
       *
       * 而探针自己拼的最小 .nsi 只 include LogicLib / MUI2，**不含 common.nsh**，
       * 所以这两个 define 一个都没有。
       *
       * 也就是说：这是**探针环境缺定义**，不是 installer.nsh 的问题。
       * 正确的修法是让探针更贴近真实环境（补上真实存在的 define），
       * 而**不是**把检查删掉、也不是把 installer.nsh 里正确的写法改坏。
       *
       * 补的是「NsisTarget 注入 + common.nsh 派生」的最小集合，
       * 值也照着真实取名（executableName 未设时 = productName = AstriaX）。
       */
      const realDefs = [
        '!define PRODUCT_FILENAME "AstriaX"',
        '!define APP_FILENAME "AstriaX"',
        '!define APP_PACKAGE_NAME "mxbot-launcher"',
        '!define APP_GUID "11111111-2222-3333-4444-555555555555"',
        // common.nsh:16 的等价物（探针不含 common.nsh，所以在这里补上）
        '!define APP_EXECUTABLE_FILENAME "${PRODUCT_FILENAME}.exe"'
      ]
      const defs =
        pass === 'uninstaller'
          ? [
              '!define BUILD_UNINSTALLER',
              // 卸载器那一遍 electron-builder 不注入安装侧的 define，
              // 补最小集合让 include 能过
              '!define VERSION "0.1.0"',
              '!define UNINSTALL_APP_KEY "mx-key"',
              '!define PRODUCT_NAME "AstriaX"',
              ...realDefs,
              iconDef
            ]
          : [
              '!define VERSION "0.1.0"',
              '!define UNINSTALL_APP_KEY "mx-key"',
              '!define PRODUCT_NAME "AstriaX"',
              ...realDefs,
              iconDef
            ]

      const nsi = [
        'Unicode true',
        'RequestExecutionLevel user',
        `OutFile "${path.join(tmp, `probe-${pass}.exe`).replace(/\\/g, '\\\\')}"`,
        'Name "probe"',
        `InstallDir "${path.join(tmp, 'inst').replace(/\\/g, '\\\\')}"`,
        ...(stdUtilsPluginDir ? [`!addplugindir "${stdUtilsPluginDir.replace(/\\/g, '\\\\')}"`] : []),
        '!include "LogicLib.nsh"',
        ...(stdUtilsNsh ? [`!include "${stdUtilsNsh.replace(/\\/g, '\\\\')}"`] : []),
        ...defs,
        /*
         * electron-builder 注入的 isUpdated 宏（customUnInstall 依赖它）。
         *
         * 有 StdUtils 就用**真实实现**（和 NsisTarget 注入的逐字一致），
         * 这样 installer.nsh 里其它 StdUtils 调用（比如我新加的
         * ${StdUtils.TestParameter} 判 --delete-app-data）才会被真正编译到。
         * 没有 StdUtils 才退回假的 —— 但那意味着这条检查的覆盖面缩水，
         * 所以下面会在 notes 里说明。
         */
        ...(stdUtilsNsh
          ? [
              '!macro _isUpdated _a _b _t _f',
              '  ${StdUtils.TestParameter} $R9 "updated"',
              '  StrCmp "$R9" "true" `${_t}` `${_f}`',
              '!macroend'
            ]
          : [
              '!macro _isUpdated _a _b _t _f',
              '  StrCmp "x" "y" `${_t}` `${_f}`',
              '!macroend'
            ]),
        '!define isUpdated `"" isUpdated ""`',
        /*
         * ── ★★ include 顺序必须和真实打包**完全一致** ★★ ────────────────
         *
         * 真实顺序（NsisTarget.js:274 → 280）：
         *   sharedHeader = computeCommonInstallerScriptHeader()
         *       └─ StdUtils.nsh → installer.nsh（我们的）
         *   然后才 sharedHeader + computeFinalScript(installer.nsi)
         *       └─ installer.nsi:8-9  !include "common.nsh" / "MUI2.nsh"
         *
         * 结论：**我们的 installer.nsh 比 MUI2 还早**。
         *
         * 这一条被踩了两次，都造成"探针绿、打包红"：
         *   1) 探针原来把 installer.nsh 放在页面宏**之后** ——
         *      宏是文本替换，必须先定义后插入，于是自定义页面一个都插不进去
         *      （等于没测到我写的界面代码）。
         *   2) 探针把 MUI2 放在 installer.nsh **之前** ——
         *      于是 `Var mui.Button.Next`（Interface.nsh:23）在探针里已存在，
         *      而真实打包时**还不存在**，报
         *        warning 6000: unknown variable/constant "mui.Button.Next"
         *      被 /WX 当错误、打包失败。
         *
         * 所以现在严格照真实顺序：StdUtils → installer.nsh → MUI2。
         * 任何"依赖 MUI 变量/宏"的写法都会在这里就暴露。
         */
        `!include "${nsh.replace(/\\/g, '\\\\')}"`,
        '!include "MUI2.nsh"',
        /*
         * `launchLink` 是真实 installer.nsi:27 声明的变量，customFinishPage
         * 里的 mxStartApp 会用它（启动程序）。探针必须声明，否则那条
         * 路径编译不过。
         *
         * `appExe`（installer.nsi:26）**故意不声明** —— 它只在
         * installSection.nsh 里被赋值/使用，而探针不含那个文件，
         * 声明了反而触发 `/WX` 的 warning 6001（"not referenced or
         * never set, wasting memory"）。多声明一个用不到的变量
         * 是探针自己的问题，不该让它变成红灯。
         */
        ...(pass === 'install' ? ['Var launchLink'] : []),
        /*
         * ── 页面宏 ────────────────────────────────────────────────────────
         *
         * MUI 页面宏必须**先于** MUI_LANGUAGE：
         *   MUI_LANGUAGE 里有自检 "should be inserted after the MUI_[UN]PAGE_* macros"，
         *   /WX 会把这条 warning 变成 error。
         *
         * 顺序照着 assistedInstaller.nsh 的真实形态：
         *   安装：customWelcomePage → （license）→ （installmode）→ DIRECTORY
         *         → INSTFILES → customFinishPage
         *   卸载：customUnWelcomePage → （installmode）→ UNPAGE_INSTFILES → FINISH
         *
         * 插入 customWelcomePage / customFinishPage 不只是为了对齐形态 ——
         * 它们现在是我新写的界面代码（品牌欢迎页 / 完成页），
         * 插进来才真的会被 makensis 编译到，错了才抓得住。
         */
        ...(pass === 'install'
          ? [
              '!insertmacro customWelcomePage',
              '!insertmacro MUI_PAGE_DIRECTORY',
              '!insertmacro MUI_PAGE_INSTFILES',
              '!insertmacro customFinishPage'
            ]
          : [
              /*
               * 卸载器那一遍插 customUnWelcomePage —— 它里面是
               * `UninstPage custom un.mxDataPageCreate un.mxDataPageLeave`，
               * 也就是我新写的数据处置页。
               *
               * 这一步还有一个**必须**的理由：不插它，那两个 un. 函数
               * 就没人引用，/WX 会报
               *   warning 6010: uninstall function "un.mxDataPageCreate"
               *                 not referenced - zeroing code
               * 把它当错误、整条打包失败。
               * 真实打包里 assistedInstaller.nsh:67-68 一定会插它，所以
               * 探针也必须插 —— 这不是"为了让探针变绿"，而是复刻真实环境。
               */
              '!insertmacro customUnWelcomePage',
              '!insertmacro MUI_UNPAGE_INSTFILES'
            ]),
        '!insertmacro MUI_LANGUAGE "SimpChinese"',
        /*
         * ── Section ───────────────────────────────────────────────────────
         *
         * 安装那一遍：**不调 WriteUninstaller**。
         *
         * electron-builder 的安装遍并不生成卸载器 —— 卸载器是**另一遍**
         * 用 `WriteUninstaller "${UNINSTALLER_OUT_FILE}"`（installer.nsi:57，
         * 在 .onInit 里）单独编译出来的，然后安装遍用
         * `File "/oname=${UNINSTALL_FILENAME}" "${UNINSTALLER_OUT_FILE}"`
         * （installer.nsh:100）把它作为**普通文件**嵌进去。
         *
         * 探针原来在安装遍也调 WriteUninstaller，于是报
         *   "no Uninstall section specified, but WriteUninstaller used"
         * —— 又是探针造出来的假问题。
         *
         * 卸载那一遍保留 WriteUninstaller + Section "Uninstall"：
         * 那两样在真实卸载器里都有（installer.nsi:57 / uninstaller.nsh:134）。
         */
        ...(pass === 'install'
          ? [
              'Section "s"',
              '  !insertmacro customInit',
              '  !insertmacro customInstall',
              /*
               * 把 $launchLink 真的设上。
               *
               * customFinishPage 里的 mxStartApp 会用它启动程序
               * （`${StdUtils.ExecShellAsUser} $0 "$launchLink" ...`）。
               * 但在真实 electron-builder 里，赋值发生在
               * installSection.nsh:74：
               *     StrCpy $launchLink "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
               * 而探针不含那个文件，于是变量"只读不写"，/WX 报
               *   warning 6001: Variable "launchLink" not referenced or
               *                 never set, wasting memory!
               *
               * 这里照抄真实那一行来赋值 —— 既是复刻真实环境，
               * 也顺带让"装完启动"这条路径真的被编译到。
               */
              '  StrCpy $launchLink "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"',
              'SectionEnd'
            ]
          : [
              'Section "u"',
              /*
               * ★ customUnInit 必须被插入。
               *
               * 真实模板在 un.onInit 里调它（uninstaller.nsh:26-28），
               * 而它负责把数据从 $INSTDIR\data 抢在模板 RMDir 之前
               * 搬到 $INSTDIR\..\AstriaX-uninst-keep\payload。
               *
               * 探针原来没插它，于是 mxUnKeepDir / mxUnMoved
               * 这两个 Var "never set" —— /WX 报
               *   warning 6001: Variable "mxUnKeepDir" not referenced...
               * 那是探针没复刻真实调用，不是产品的问题。
               *
               * Section "u" 在 Section "Uninstall" 之前执行，
               * 正好等价于"卸载段之前"，与真实时机一致。
               */
              '  !insertmacro customUnInit',
              '  WriteUninstaller "$INSTDIR\\uninst.exe"',
              'SectionEnd',
              'Section "Uninstall"',
              '  !insertmacro customUnInstall',
              'SectionEnd'
            ]),
        ''
      ].join('\n')

      const f = path.join(tmp, `probe-${pass}.nsi`)
      fs.writeFileSync(f, '\uFEFF' + nsi, 'utf8')
      let out = ''
      try {
        /*
         * `/WX` 是关键：electron-builder 就是用它把 warning 变成 error 的。
         * 不加的话这条检查会漏掉真正的失败模式。
         */
        execFileSync(makensis, ['/WX', '/INPUTCHARSET', 'UTF8', f], {
          stdio: 'pipe',
          cwd: tmp,
          timeout: 120000
        })
      } catch (e) {
        bad++
        out = String(e.stdout ?? '') + String(e.stderr ?? '')
        const lines = out
          .split(/\r?\n/)
          .filter((l) => /warning|error/i.test(l))
          .slice(0, 6)
          .map((l) => l.trim())
          .join('；')
        issues.push(
          `installer.nsh 在 ${pass === 'uninstaller' ? '卸载器（BUILD_UNINSTALLER）' : '安装器'}` +
            `编译遍里过不了 makensis /WX：${lines || '（无诊断行，看原始输出）'}`
        )
      }
    }
    if (bad === 0) notes.push('installer.nsh 两遍（安装器 / 卸载器）都能被 makensis /WX 编译通过')
    if (!stdUtilsNsh) {
      // 覆盖面缩水必须说出来，不能默默降级成"绿了"
      issues.push(
        '没找到 StdUtils.nsh，NSIS 探针用假的 isUpdated 顶替 —— ' +
          'installer.nsh 里真实的 ${StdUtils.TestParameter} 调用**没有被编译到**，' +
          '这类问题会漏到真实打包才炸。请确认 node_modules 里有 app-builder-lib。'
      )
    }
    if (!stdUtilsPluginDir) {
      issues.push(
        '没找到 StdUtils 插件目录（nsis-resources/plugins/x86-unicode）—— ' +
          '探针可能编不过 StdUtils 调用。清一下 electron-builder 缓存再跑。'
      )
    }
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 同步阻塞调用审计（指导书 0.1.3 自检 3 的产品化）。
 *
 * 为什么放在自检里而不是单独跑：这类问题**必然会回潮** ——
 * 半年后有人为了图快写一句 `spawnSync('netstat')`，
 * 界面就开始"点什么都卡一下"，而那时代码早就没人记得这条教训了。
 * 挂进自检 + 例外表带理由，改动者要么改异步、要么补一条论证。
 *
 * 实现直接复用 scripts/audit-sync-calls.cjs（单一实现，避免两处漂移）：
 * 以子进程方式跑它，非 0 就把它的结论收进 issues。
 */
function checkSyncCalls() {
  const script = path.join(__dirname, 'audit-sync-calls.cjs')
  if (!fs.existsSync(script)) {
    issues.push('scripts/audit-sync-calls.cjs 不见了 —— 它是同步阻塞的守门人')
    return
  }
  try {
    const out = execFileSync(process.execPath, [script], { encoding: 'utf8' })
    const m = /LIGHT（[^）]*）：(\d+) 处/.exec(out)
    notes.push(`同步调用审计通过${m ? `（重调用全部有论证例外；轻量 ${m[1]} 处）` : ''}`)
  } catch (e) {
    /*
     * 失败时把脚本的输出原样带出来 —— 它会明确列出"未论证"的 file:line，
     * 那才是有用的信息；只说一句"审计失败"等于让下一个人重新查一遍。
     */
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    const bad = out
      .split('\n')
      .filter((l) => l.includes('✘'))
      .map((l) => l.trim())
    issues.push(
      `同步阻塞审计未通过（指导书 P0-4）：${bad.length ? bad.join('；') : '见 scripts/audit-sync-calls.cjs 输出'}`
    )
  }
}

/**
 * 守卫：Vue 模板注释必须合法。
 *
 * ★ 为什么需要它（2026-09-27 实测踩过，代价是界面直接炸）
 *
 * 我在 App.vue 的 `<AppDialog>` 上方写了段 HTML 注释，里面为了说明
 * "Vue 模板只认某种注释写法"，把那种写法的**字面量**写了进去 ——
 * 而它**包含连续两个短横线**，那正是 HTML 注释的终止序列的一部分。
 * 于是注释在那里提前结束，后面的文字全被当成正文渲染到界面上：
 * 窗口顶部出现一大段乱码般的说明，布局被撑坏。
 *
 * 最阴的地方：**编译通过、单测全绿**，只有真打开软件才看得见。
 * 所以它必须挂进自检 —— 静态能查的事，不该留给"下次记得看一眼"。
 *
 * 同时扫另外两条同样踩过的坑：
 *   · 注释放在标签属性列表中间（被当成属性名，报 Attribute name cannot contain U+0022）
 *   · 注释里嵌注释（非法）
 *
 * 实现复用 scripts/audit-vue-comments.cjs（单一实现，避免两处漂移）。
 */
function checkVueComments() {
  const script = path.join(__dirname, 'audit-vue-comments.cjs')
  if (!fs.existsSync(script)) {
    issues.push('scripts/audit-vue-comments.cjs 不见了 —— 它是模板注释的守门人')
    return
  }
  try {
    const out = execFileSync(process.execPath, [script], { encoding: 'utf8' })
    const m = /扫描了 (\d+) 个/.exec(out)
    notes.push(`Vue 模板注释审计通过${m ? `（${m[1]} 个文件）` : ''}`)
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    const lines = out
      .split('\n')
      .filter((l) => l.trim().startsWith('src') || l.includes('注释'))
      .map((l) => l.trim())
      .slice(0, 6)
    issues.push(
      `Vue 模板注释审计未通过：${lines.length ? lines.join('；') : '见 scripts/audit-vue-comments.cjs 输出'}`
    )
  }
}

/**
 * 守卫：生产装配**不得**注入 updateManifestUrl（否则双源回落失效）。
 *
 * ## 为什么值得专门守一条
 *
 * `updateManifestUrl` 是给单测的注入口；一旦生产也注入，
 * `safeCheck` 就只试那一个 url，`MX_OFFICIAL_BASES` 的备用源永远轮不到：
 * 主源一挂 → 检查更新失败 → 按用户要求收敛成"已是最新版" →
 * **用户界面显示最新，而备用源上明明有新版本**。
 *
 * 这种"保险实际上是死代码"的 bug 极难从现象反推（没有报错、没有日志），
 * 靠人记住是不现实的 —— 所以用一条机械检查钉住：
 * registerIpcHandlersReal 的装配对象里不许出现 updateManifestUrl。
 * （测试文件自己想注入随便注入，这里只看 src/main。）
 */
function checkNoInjectedManifestUrl() {
  const f = path.join(ROOT, 'src', 'main', 'ipc.ts')
  if (!fs.existsSync(f)) return
  const src = fs.readFileSync(f, 'utf8')
  // 只找"赋值/传参"形态：updateManifestUrl: <非注释>
  const lines = src.split(/\r?\n/)
  lines.forEach((line, i) => {
    const t = line.trim()
    if (t.startsWith('*') || t.startsWith('//')) return
    if (/^updateManifestUrl\s*:/.test(t)) {
      issues.push(
        `ipc.ts:${i + 1} 生产装配注入了 updateManifestUrl —— 这会让双源回落失效` +
          `（主源挂掉时静默显示"已是最新版"）。删掉这行，让它按 MX_OFFICIAL_BASES 顺序回落。`
      )
    }
  })
}

/**
 * 守卫：不许调**审计对象上不存在的方法**。
 *
 * ## 为什么值得专门守
 *
 * 代码里有 4 处写着 `opts.audit?.write?.(...)` —— 而 `AuditLog` 接口上
 * 只有 `record / fileFor / read`，根本没有 `write`。因为用的是**可选调用**
 * （`?.`），运行时既不会抛错、也不会有任何效果：那几句审计记录
 * **静默地什么都没做**（下载更新、切换运行时版本、手动更新实例都没进审计）。
 *
 * TypeScript 早就报了 `Property 'write' does not exist`，但项目没把 tsc
 * 当门禁，所以一直没人看见 —— 属于"编译能过、测试能过、功能没有了"。
 *
 * 这条检查把"审计对象上允许出现的方法名"钉成白名单：出现别的名字就红。
 */
function checkAuditMethodNames() {
  const allowed = new Set(['record', 'fileFor', 'read'])
  const files = []
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) files.push(p)
    }
  }
  walk(path.join(ROOT, 'src', 'main'))

  for (const f of files) {
    const raw = fs.readFileSync(f, 'utf8')
    // 先剥注释：注释里写示例不算违规
    const code = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split(/\r?\n/)
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n')
    const re = /\baudit\?\.(\w+)/g
    let m
    while ((m = re.exec(code)) !== null) {
      if (!allowed.has(m[1])) {
        issues.push(
          `${path.relative(ROOT, f)}: 调用了 audit.${m[1]} —— 审计对象上只有 ` +
            `${[...allowed].join(' / ')}。可选调用（?.）不会报错，会**静默什么都不做**。`
        )
      }
    }
  }
}

/**
 * 守卫：`appConfig.` 必须写成 `appConfig?.`（全新安装时它是 undefined）。
 *
 * ## 为什么（拿用户的"启动不了"换来的）
 *
 * 0.1.4 用户实测：卸载重装之后**双击没反应**，进程列表里有 AstriaX
 * 却不出现界面。根因是一行代码：
 *
 *     const crashDeps = { dataRoot: appConfig.dataRoot, ... }
 *
 * 全新安装（还没有 config.json）时 `getConfig()` 返回 undefined，
 * 这一行直接抛 TypeError。而它位于 `createWindow()` **之前**：
 *   · 窗口压根没建 → 用户什么都看不到
 *   · 异常发生在 whenReady 的 async 回调里 → 静默变成 rejected promise
 *   · 进程还活着并**占着单实例锁** → 再双击多少次都只是默默退出
 * 三条叠起来就是"软件彻底坏了、还关不掉"。
 *
 * 修法是取不到就回落；但"下次别人再写一行 appConfig.xxx"照样会复发，
 * 所以加这条机械检查：**裸的 appConfig. 一律不许出现**。
 */
function checkAppConfigOptional() {
  const f = path.join(ROOT, 'src', 'main', 'index.ts')
  if (!fs.existsSync(f)) return
  const raw = fs.readFileSync(f, 'utf8')
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n')
  code.split(/\r?\n/).forEach((line, i) => {
    if (/\bappConfig\.(?!\?)/.test(line)) {
      issues.push(
        `index.ts:${i + 1} 出现裸的 appConfig. —— 全新安装时它是 undefined，` +
          `会抛 TypeError 并导致"双击没反应"（0.1.4 的真实事故）。请写成 appConfig?.`
      )
    }
  })
}

console.log('MXBot 自检')
console.log('='.repeat(56))
checkDeadCode()
checkJsonParse()
checkPsQuote()
checkMagicPorts()
checkTmpdir()
checkEmptyCatch()
checkCrossProcessContract()
checkInstallerScript()
checkInstallerCompiles()
checkSyncCalls()
/* 模板注释合法性（注释里两个短横线会让注释提前结束、界面渲染出多余文字） */
checkVueComments()
checkNoInjectedManifestUrl()
checkAuditMethodNames()
checkAppConfigOptional()

for (const n of notes) console.log('  · ' + n)
console.log('')
if (!issues.length) {
  console.log('未发现问题。')
  process.exit(0)
}
console.log(`发现 ${issues.length} 处需要确认：`)
for (const x of issues) console.log('  - ' + x)
process.exit(1)
