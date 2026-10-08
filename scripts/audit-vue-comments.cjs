#!/usr/bin/env node
/*
 * ★ 扫描 Vue 模板注释里的非法内容（实测踩过，代价是界面直接炸）
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ## 事故经过（2026-09-27）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 我在 App.vue 的 `<AppDialog>` 上方写了这样一段 HTML 注释：
 *
 *     <!--
 *       注意两条 HTML 模板的硬约束：
 *         · 注释里不能写 `/* *​/`（Vue 模板只认 `<!-- -->`，否则 Illegal '/' in tags）
 *         · 注释不能放在标签属性列表中间
 *     -->
 *
 * 里面那句「只认 `<!-- -->`」**字面量地包含了连续两个短横线** ——
 * 而连续短横线是 HTML 注释的终止序列的一部分。于是注释在那里**提前结束**，
 * 后面的文字全被当成**正文渲染到了界面上**：窗口顶部出现一大段乱码般的说明文字，
 * 整个布局被撑坏。
 *
 * 更阴的是：**编译完全通过**（Vue 编译器不报错），单测也全绿 ——
 * 只有真打开软件看一眼才发现。这正是本项目反复强调的
 *「静态检查全绿 ≠ 能用」的又一例。
 *
 * ## 这条检查防什么
 *
 * 1. **注释内部出现连续两个短横线**（会让注释提前结束）
 * 2. **注释里出现注释的起始序列**（嵌套注释不被允许）
 * 3. 注释放在**标签属性列表中间**（会被当成属性名）
 *
 * 第 1 条是刚踩的那个；第 2、3 条是我在同一次改动里先后踩的。
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

const files = walk(SRC)
const issues = []
/** 终止序列本身是「两个短横线 + 大于号」，单独两个短横线也危险 */
const DOUBLE_DASH = /--/
const COMMENT_OPEN = /<!--/

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8')
  const rel = path.relative(ROOT, f)
  const lines = src.split(/\r?\n/)

  /* 只扫 <template> 段（script/style 里的注释是 JS/CSS 规则，与 HTML 无关） */
  const tplStart = lines.findIndex((l) => /^\s*<template>/.test(l))
  if (tplStart < 0) continue
  const tplEnd = lines.findIndex((l, i) => i > tplStart && /^\s*<\/template>/.test(l))
  const tpl = lines.slice(tplStart, tplEnd < 0 ? lines.length : tplEnd)

  let inComment = false
  let commentStartLine = 0
  for (let i = 0; i < tpl.length; i++) {
    const line = tpl[i]
    const lineNo = tplStart + i + 1

    if (!inComment) {
      const open = line.indexOf('<!--')
      if (open < 0) continue
      /*
       * 情况 3：注释出现在**标签属性列表中间**。
       *
       * 判据：同一行里，`<!--` 之前有"未闭合的标签开头"痕迹 ——
       *   · 前面有 `<TagName` 但没有该行内闭合的 `>`
       * 简单可靠的近似：这一行以属性形式开头（缩进 + `:` 或 `@` 或 `v-`），
       * 或者 `<!--` 前面出现过 `<` 且没有 `>`。
       */
      const before = line.slice(0, open)
      const looksLikeAttr =
        /^\s*[:@v-week]|^\s*[a-zA-Z-]+\s*=/.test(before) ||
        (/</.test(before) && !/>/.test(before) && !/^\s*$/.test(before))
      if (looksLikeAttr) {
        issues.push(
          `${rel}:${lineNo} 注释出现在标签属性列表中间 —— ` +
            `会被当成属性名，编译报 Attribute name cannot contain U+0022。\n` +
            `    请把注释移到标签外面。`
        )
      }
      inComment = !/-->/.test(line.slice(open))
      commentStartLine = lineNo
      /* 同行的注释体也要查 */
      const bodyStart = open + 4
      const bodyEnd = line.indexOf('-->', bodyStart)
      const body = bodyEnd >= 0 ? line.slice(bodyStart, bodyEnd) : line.slice(bodyStart)
      if (DOUBLE_DASH.test(body)) {
        issues.push(
          `${rel}:${lineNo} 注释内部出现连续两个短横线（--）—— ` +
            `那是注释终止序列的一部分，会让注释**提前结束**，\n` +
            `    剩下的字被当成正文渲染到界面上（实测：界面直接炸）。\n` +
            `    片段：${body.trim().slice(0, 60)}`
        )
      }
      if (COMMENT_OPEN.test(body)) {
        issues.push(`${rel}:${lineNo} 注释里又出现了注释起始序列（嵌套注释非法）`)
      }
    } else {
      /* 多行注释内部：查连续短横线（排除终止序列自身） */
      const end = line.indexOf('-->')
      const body = end >= 0 ? line.slice(0, end) : line
      if (DOUBLE_DASH.test(body)) {
        issues.push(
          `${rel}:${lineNo}（注释从第 ${commentStartLine} 行开始）注释内部出现连续两个短横线 —— ` +
            `会让注释提前结束，界面会渲染出多余文字。\n` +
            `    片段：${body.trim().slice(0, 60)}`
        )
      }
      if (COMMENT_OPEN.test(body)) {
        issues.push(`${rel}:${lineNo} 注释里又出现了注释起始序列（嵌套注释非法）`)
      }
      if (end >= 0) inComment = false
    }
  }
}

if (issues.length) {
  console.error('[FAIL] Vue 模板注释有问题：\n')
  for (const s of issues) console.error('  ' + s + '\n')
  process.exit(1)
}
console.log(`[OK] 扫描了 ${files.length} 个 .vue 文件，模板注释全部合法`)
