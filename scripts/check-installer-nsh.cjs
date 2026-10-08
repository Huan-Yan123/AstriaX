/*
 * build/installer.nsh 的完整性检查。
 *
 * ============================================================================
 * 为什么需要这个脚本
 * ============================================================================
 *
 * installer.nsh 有 580+ 行手写 NSIS，是整个项目里**唯一会删用户数据**
 * 的文件，但它不在 TypeScript 编译范围内、也不被 vitest 覆盖。
 * 一旦它被误编辑（我本人就用 PowerShell 正则误伤过一次），
 * 后果是安装时把用户的实例和运行时删掉。
 *
 * 这个脚本做三类检查：
 *   1. 文件本身健康（非空、无 BOM、行尾不混用）
 *   2. 关键修复点还在（白名单判定、两道恢复闸门、/SD）
 *   3. 结构配平（宏、LogicLib 块）
 *
 * 配平和 /SD 检查复用 scripts/nsi-lint.cjs —— 那里的逻辑踩过坑：
 *   - `${IfNot}` / `${Unless}` 也是开块，只数 `${If}` 会误报
 *   - 注释里引用的 `${If}` 不是真代码
 *
 * ## 关于行尾
 *
 * 只要求**一致**，不要求特定一种。本文件在 HEAD 里就是 LF
 * （`git show HEAD:build/installer.nsh` → 0 个 CRLF），
 * 而仓库里 src/main/ipc.ts 是 CRLF，两种并存。
 * 实测 makensis 用 LF 的 .nsh 编译完全正常（e2e 5 个用例全过）。
 * 真正该防的是**混用**：同一文件两种行尾交织会让 diff 全是噪声。
 *
 * ## 关于 BOM
 *
 * **故意不能加 BOM**。electron-builder 会用 `-INPUTCHARSET UTF8` 编译，
 * 我们自己在 scripts/test-installer-e2e.cjs 里生成 .nsi 时才需要给它加 BOM。
 * 给 .nsh 加 BOM 反而会让某些 include 路径解析出错。
 */
const { readFileSync } = require('fs')
const { join } = require('path')
const { checkLogicBalance, checkMacroBalance, checkMessageBoxSD } = require('./nsi-lint.cjs')

const P = join(__dirname, '..', 'build', 'installer.nsh')
const buf = readFileSync(P)
const t = buf.toString('utf8')

const crlf = (t.match(/\r\n/g) || []).length
const lfTotal = (t.match(/\n/g) || []).length
const lfOnly = lfTotal - crlf
const consistent = crlf === 0 || lfOnly === 0

/** 判定某行是不是注释（`;` 开头或块注释延续的 `*`） */
const isComment = (l) => /^\s*[;*]/.test(l)

const checks = [
  ['文件非空', buf.length > 10000, `${buf.length} 字节`],
  ['故意不加 BOM', buf[0] !== 0xef, `首字节 0x${buf[0].toString(16)}`],
  [
    '行尾统一（不混用）',
    consistent,
    crlf === 0 ? `全 LF（${lfTotal} 行）` : `全 CRLF（${crlf} 行）`
  ],

  // ---- 关键修复点必须还在 ----
  ['robocopy 判定宏存在', t.includes('!macro MXBOT_ROBO_VERDICT'), ''],
  ['白名单比较到 "7"', t.includes('$R6 == "7"'), ''],
  [
    '无残留整数比较 $R6 > 7（注释引用不算）',
    !t.split(/\r?\n/).some((l) => l.includes('$R6 > 7') && !isComment(l)),
    ''
  ],
  ['含 customInit 恢复闸门', t.includes('${If} $mxRestoreFailed == "1"'), ''],
  ['含 STASH 内部闸门', t.includes('${If} $mxRestoreFailed != "1"'), ''],
  ['含 keep 目录幂等初始化', t.includes('${If} $mxKeepDir == ""'), ''],
  ['保留分支有提示文案', t.includes('避免删掉唯一备份'), ''],
  ['含 ${isUpdated} 更新判定', t.includes('${IfNot} ${isUpdated}'), '']
]

let bad = 0
console.log('  build/installer.nsh 完整性\n')
for (const [name, ok, extra] of checks) {
  if (!ok) bad++
  console.log(`  ${ok ? '✔' : '✘'} ${name}${extra ? `（${extra}）` : ''}`)
}

// ---- 结构检查（复用 nsi-lint）----
const logic = checkLogicBalance(t)
const macros = checkMacroBalance(t)
const mb = checkMessageBoxSD(t)

console.log(
  `  ${logic.ok ? '✔' : '✘'} LogicLib 配平：If=${logic.detail.If} IfNot=${logic.detail.IfNot} ` +
    `Unless=${logic.detail.Unless} → 开 ${logic.detail.totalOpen} / 收 ${logic.detail.ends}`
)
logic.problems.forEach((p) => console.log(`        · ${p}`))
if (!logic.ok) bad++

console.log(`  ${macros.ok ? '✔' : '✘'} 宏配平：${macros.detail.opens} / ${macros.detail.closes}`)
macros.problems.forEach((p) => console.log(`        · ${p}`))
if (!macros.ok) bad++

console.log(`  ${mb.ok ? '✔' : '✘'} ${mb.detail.total} 个 MessageBox 都带 /SD`)
mb.problems.forEach((p) => console.log(`        · ${p}`))
if (!mb.ok) bad++

console.log(bad === 0 ? '\n  ✔ installer.nsh 完整' : `\n  ✘ 有 ${bad} 项异常`)
process.exit(bad === 0 ? 0 : 1)
