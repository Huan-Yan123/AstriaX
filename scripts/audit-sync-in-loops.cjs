#!/usr/bin/env node
/*
 * 找出"**藏在递归函数里的同步调用**"（会冻结主进程的那类）。
 *
 * ## 为什么要单独写这个
 *
 * 项目里已有 scripts/audit-sync-calls.cjs，但它的 LIGHT 档是**全放行**的：
 * existsSync / readFileSync / statSync 单次都是微秒级，确实无害。
 *
 * 问题在**量**：一次 IPC 里循环 5000 次 readFileSync 就是几百毫秒冻结，
 * 而 LIGHT 档按"单次调用"判，看不出来。
 *
 * 本脚本按**上下文**分两级：
 *   SEVERE = 同步调用位于**有递归自调用的函数**里（遍历整棵目录树）
 *            → 文件数可达几万，必须异步。这是真正要改的。
 *   LOOP   = 只是在循环里，但循环上界通常很小（几个固定项）
 *            → 记录备查，不必动。
 *
 * 退出码：有 SEVERE 时非 0（可直接当门禁用）。
 *
 * 用法：
 *   node scripts/audit-sync-in-loops.cjs
 *   node scripts/audit-sync-in-loops.cjs --json
 *   node scripts/audit-sync-in-loops.cjs --severe-only
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src', 'main')
const SEVERE_ONLY = process.argv.includes('--severe-only')

/** 同步 fs / 子进程 API（只在"循环里"才有害的那些） */
const SYNC_CALLS = [
  'existsSync', 'readFileSync', 'writeFileSync', 'readdirSync', 'statSync',
  'mkdirSync', 'rmSync', 'copyFileSync', 'renameSync', 'unlinkSync',
  'appendFileSync', 'realpathSync', 'lstatSync', 'readlinkSync', 'cpSync',
  'execSync', 'spawnSync', 'sendSync'
]

function listTs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) listTs(p, out)
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

const indentOf = (s) => (s.match(/^\s*/) || [''])[0].length

/** 往上找最近的循环/迭代头 */
function inLoop(lines, idx) {
  const myIndent = indentOf(lines[idx])
  for (let i = idx - 1; i >= 0 && idx - i < 80; i--) {
    const line = lines[i]
    if (!line.trim()) continue
    if (indentOf(line) < myIndent) {
      if (/\b(for|while)\s*\(/.test(line)) return line.trim()
      if (/\.(forEach|map|filter|reduce|some|every|flatMap)\s*\(/.test(line)) return line.trim()
    }
  }
  return null
}

/** 剥掉注释与字符串字面量（判定递归时必须先做，否则注释里提到函数名就误报） */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释
    .replace(/(^|[^:])\/\/.*$/gm, '$1')  // 行注释（避开 http:// 这种）
    .replace(/'(?:[^'\\]|\\.)*'/g, "''") // 单引号字符串
    .replace(/"(?:[^"\\]|\\.)*"/g, '""') // 双引号字符串
    .replace(/`(?:[^`\\]|\\.)*`/g, '``') // 模板串
}

/**
 * 往上找**直接包含**这一行的函数（不跨函数体），并判断它是否递归自调用。
 *
 * ★ 这里踩过假阳性的坑：第一版是"往上找最近的一个 function 声明"，
 * 结果 `recomputeOneSize` 明明不递归，却因为它**后面**的 register/remove
 * 里提到过这个名字，就被判成递归 —— 一整批误报。
 * 现在改成：逐个往上找，**函数体必须真的罩住这一行**（缩进范围判定），
 * 再在它自己的函数体里找"直接调用自己"。
 */
function enclosingFn(lines, idx) {
  const myIndent = indentOf(lines[idx])
  for (let i = idx; i >= 0 && idx - i < 400; i--) {
    const m = lines[i].match(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/)
    if (!m) continue
    const fnIndent = indentOf(lines[i])
    if (fnIndent >= myIndent) continue // 这个函数没罩住目标行
    // 函数体范围：从声明行往下，直到缩进回到 <= fnIndent 的非空行
    let end = lines.length
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && indentOf(lines[j]) <= fnIndent) {
        end = j
        break
      }
    }
    if (idx >= end) continue // 目标行不在这个函数体里 → 继续往上找
    /*
     * 判递归：剥掉注释与字符串之后，函数体里出现 `函数名(`。
     * 不剥的话，注释里提到自己的函数名就会误报（真踩过）。
     */
    const body = stripComments(lines.slice(i + 1, end).join('\n'))
    return { name: m[1], recursive: new RegExp(`\\b${m[1]}\\s*\\(`).test(body) }
  }
  return null
}

function main() {
  const findings = []
  for (const f of listTs(SRC)) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/')
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/)
    let inBlock = false
    lines.forEach((line, i) => {
      const t = line.trim()
      if (inBlock) {
        if (t.includes('*/')) inBlock = false
        return
      }
      if (t.startsWith('/*')) {
        if (!t.includes('*/')) inBlock = true
        return
      }
      if (t.startsWith('//') || t.startsWith('*')) return

      for (const call of SYNC_CALLS) {
        if (!new RegExp(`\\b${call}\\s*\\(`).test(line)) continue
        const loop = inLoop(lines, i)
        if (!loop) continue
        const fn = enclosingFn(lines, i)
        findings.push({
          severe: Boolean(fn && fn.recursive),
          file: rel,
          line: i + 1,
          call,
          fn: fn ? fn.name : '(顶层)',
          loop: loop.slice(0, 70),
          code: t.slice(0, 90)
        })
      }
    })
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(findings, null, 2))
    return findings
  }

  const severe = findings.filter((x) => x.severe)
  const rest = findings.filter((x) => !x.severe)

  console.log('=== 循环里的同步调用 ===')
  console.log(`共 ${findings.length} 处；其中**递归函数里 ${severe.length} 处**（必须异步）\n`)

  if (severe.length) {
    console.log('★ SEVERE —— 递归遍历，文件数可达几万，必须改成异步：')
    for (const it of severe) {
      console.log(`  ${it.file}:${it.line}  ${it.call}()   [函数 ${it.fn}]`)
      console.log(`        ${it.code}`)
    }
    console.log('')
  } else {
    console.log('✔ 没有"递归函数里的同步调用"（这一类已清零）\n')
  }

  if (rest.length && !SEVERE_ONLY) {
    const byFile = {}
    for (const it of rest) (byFile[it.file] ||= []).push(it)
    console.log(`其余 ${rest.length} 处（循环上界通常很小，可留）：`)
    for (const [file, items] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) {
      const kinds = [...new Set(items.map((x) => x.call))].slice(0, 4).join(', ')
      console.log(`  ${file}  (${items.length})  ${kinds}${items.length > 4 ? ' …' : ''}`)
    }
  }
  return findings
}

const all = main()
process.exit(all.some((x) => x.severe) ? 1 : 0)
