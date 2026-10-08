/*
 * NSIS 脚本（.nsh/.nsi）的静态检查工具。
 *
 * 抽成独立模块，是因为"数 ${If}/${EndIf} 配平"这件事我在两个脚本里
 * 各错过一次，错法还不同：
 *
 *   1. 忘了 `${IfNot}` / `${Unless}` 也是开块 —— 只数 `${If}` 会得到
 *      "23 开 / 22 收"，然后去文件里找一个**根本不存在的**多余 `${EndIf}`。
 *   2. 把注释里引用的 `${If}` 当成真代码 —— 本文件为了解释
 *      "为什么不能写 `$R6 > 7`"，注释里原样写了 `${If} $R6 > 7`，
 *      正则一扫就多算一个开块。
 *
 * 这和第二轮自查里那个"空 catch 检查被注释骗了"的坑是同一类问题：
 * **结构判断必须在剥掉注释的文本上做，内容判断才在原文上做。**
 * 所以这里提供 stripComments()，让调用方各取所需。
 */

/**
 * 去掉 `;` 行注释与块注释，保留换行以维持行号。
 *
 * 用状态机而不是正则：正则会误伤字符串里的分号、处理不了跨行块注释，
 * 也分不清反引号串（NSIS 里 `` ` `` 常用于宏定义里的代码片段）。
 */
function stripComments(src) {
  let out = ''
  let i = 0
  let inBlock = false
  let inBacktick = false
  let inDouble = false
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '\n') {
      out += c
      i++
      continue
    }
    if (inBlock) {
      if (c === '*' && n === '/') {
        inBlock = false
        i += 2
        continue
      }
      i++
      continue
    }
    if (inBacktick) {
      if (c === '`') inBacktick = false
      i++
      continue
    }
    if (inDouble) {
      if (c === '"') inDouble = false
      i++
      continue
    }
    if (c === '"') {
      inDouble = true
      out += c
      i++
      continue
    }
    if (c === '`') {
      inBacktick = true
      out += c
      i++
      continue
    }
    if (c === ';') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && n === '*') {
      inBlock = true
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

const count = (s, re) => (s.match(re) || []).length

/**
 * 检查 LogicLib 块配平。
 * @returns {{ok:boolean, detail:object, problems:string[]}}
 */
function checkLogicBalance(rawSrc) {
  const code = stripComments(rawSrc)
  const opens = {
    If: count(code, /\$\{If\}/g),
    IfNot: count(code, /\$\{IfNot\}/g),
    Unless: count(code, /\$\{Unless\}/g)
  }
  const ends = count(code, /\$\{EndIf\}/g)
  const totalOpen = opens.If + opens.IfNot + opens.Unless

  const problems = []
  let depth = 0
  const rawLines = rawSrc.split(/\r?\n/)
  code.split('\n').forEach((l, i) => {
    const o =
      count(l, /\$\{If\}/g) + count(l, /\$\{IfNot\}/g) + count(l, /\$\{Unless\}/g)
    const e = count(l, /\$\{EndIf\}/g)
    depth += o - e
    if (depth < 0) {
      problems.push(`第 ${i + 1} 行起深度为负：${(rawLines[i] || '').trim().slice(0, 70)}`)
    }
  })
  if (depth !== 0) problems.push(`文件结束深度 = ${depth}（应为 0）`)
  if (totalOpen !== ends) problems.push(`开块 ${totalOpen} ≠ 收块 ${ends}`)

  return {
    ok: problems.length === 0,
    detail: { ...opens, totalOpen, ends },
    problems
  }
}

/** 检查宏配平（!macro / !macroend） */
function checkMacroBalance(rawSrc) {
  const code = stripComments(rawSrc)
  const opens = count(code, /!macro\s+\S+/g)
  const closes = count(code, /!macroend/g)
  return {
    ok: opens === closes,
    detail: { opens, closes },
    problems: opens === closes ? [] : [`!macro ${opens} 个 / !macroend ${closes} 个`]
  }
}

/** 检查所有 MessageBox 是否都带 /SD（静默安装下没有它会永久卡住） */
function checkMessageBoxSD(rawSrc) {
  const code = stripComments(rawSrc)
  const lines = code.split('\n')
  const rawLines = rawSrc.split(/\r?\n/)
  const problems = []
  let total = 0
  lines.forEach((l, i) => {
    if (!/^\s*MessageBox\b/.test(l)) return
    total++
    // 命令可能用 `\` 续行，往后看几行
    const seg = lines.slice(i, i + 8).join('\n')
    if (!/\/SD\s+ID\w+/.test(seg)) {
      problems.push(`第 ${i + 1} 行 MessageBox 缺少 /SD：${(rawLines[i] || '').trim().slice(0, 60)}`)
    }
  })
  return { ok: problems.length === 0, detail: { total }, problems }
}

module.exports = {
  stripComments,
  checkLogicBalance,
  checkMacroBalance,
  checkMessageBoxSD
}
