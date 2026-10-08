#!/usr/bin/env node
/**
 * 配色对比度检查器（零依赖）。
 *
 * ## 为什么需要它
 *
 * 「参考图标风格」最容易犯的错，是照着图标的主色直接往按钮上刷。
 * 图标的主色是在**近白背景**上展示图形用的，而界面主色要**承载白字** ——
 * 这两个场景对亮度的要求完全相反。实测图标主色 #3898f8 上的白字
 * 对比度只有 2.99，远低于 WCAG AA 的 4.5，按钮文字会"发飘"。
 *
 * 眼睛看不出来（颜色确实好看），但对比度是能算出来的硬数字。
 * 所以这里先把数字摆出来，再决定用哪个色。
 *
 * ## 两种用法
 *
 *   1. 体检当前 tokens.css：
 *        node scripts/_contrast-check.cjs
 *
 *   2. 反查候选色：在 hue 区间内、满足对比度门槛的**最鲜艳**的颜色：
 *        node scripts/_contrast-check.cjs --hue 205 213 --min 4.5
 *
 *     「最鲜艳」= 色度 (max-min) 最大。原因：图标是饱和的天蓝，
 *     如果只按对比度挑，算出来的往往是发灰的深蓝，跟图标不像。
 *     在同一对比度门槛下取最大色度，才能既过线又保留图标的鲜亮感。
 */
const fs = require('fs')
const path = require('path')

/** sRGB 分量 → 线性光（WCAG 2.1 定义） */
function lin(c) {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

/** 相对亮度 */
function lum(r, g, b) {
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** WCAG 对比度（1..21） */
function contrast(a, b) {
  const la = lum(...a)
  const lb = lum(...b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

function hex2rgb(h) {
  const s = h.replace('#', '').trim()
  const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s
  return [parseInt(f.slice(0, 2), 16), parseInt(f.slice(2, 4), 16), parseInt(f.slice(4, 6), 16)]
}

function rgb2hex(r, g, b) {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** 色相（0..360）；灰阶返回 -1 */
function hue(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return -1
  const d = max - min
  let h
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return ((h * 60) % 360 + 360) % 360
}

/** 读 tokens.css 的 :root 变量（只做 var 名→值，够用） */
function readTokens(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const out = {}
  for (const m of src.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}

function main() {
  const argv = process.argv.slice(2)
  const hueIdx = argv.indexOf('--hue')
  const testIdx = argv.indexOf('--test')

  // ── 模式 3：试算指定色值 ──────────────────────────────────────────────
  /*
   * 用法：node scripts/_contrast-check.cjs --test "#2f6bd8 on #ffffff"
   * 支持多组，每组的 "on" 前后是前景/背景。
   * 用来在设计 palette 时逐个验证，而不是等写进 CSS 再发现不达标。
   */
  if (testIdx >= 0) {
    let bad = 0
    for (const spec of argv.slice(testIdx + 1)) {
      const m = /^(#[0-9a-fA-F]{3,8})\s+on\s+(#[0-9a-fA-F]{3,8})$/.exec(spec.trim())
      if (!m) {
        console.error(`跳过一个看不懂的参数：${spec}（应为 "#aaaaaa on #bbbbbb"）`)
        continue
      }
      const c = contrast(hex2rgb(m[1]), hex2rgb(m[2]))
      const ok = c >= 4.5
      if (!ok) bad++
      console.log(`  ${m[1]} on ${m[2]}   ${c.toFixed(2)}   ${ok ? 'AA 正文达标' : '未达 4.5'}`)
    }
    if (bad) process.exit(1)
    return
  }

  // ── 模式 2：反查候选色 ────────────────────────────────────────────────
  if (hueIdx >= 0) {
    const lo = Number(argv[hueIdx + 1])
    const hi = Number(argv[hueIdx + 2])
    const minIdx = argv.indexOf('--min')
    const minC = minIdx >= 0 ? Number(argv[minIdx + 1]) : 4.5
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      console.error('用法：--hue <lo> <hi> [--min 4.5]')
      process.exit(2)
    }
    const found = []
    for (let r = 0; r < 256; r++) {
      for (let g = 0; g < 256; g++) {
        for (let b = 0; b < 256; b++) {
          const h = hue(r, g, b)
          if (h < lo || h > hi) continue
          const c = contrast([r, g, b], [255, 255, 255])
          if (c < minC) continue
          found.push({ hex: rgb2hex(r, g, b), c, chroma: Math.max(r, g, b) - Math.min(r, g, b), h })
        }
      }
    }
    found.sort((a, b) => b.chroma - a.chroma || b.c - a.c)
    console.log(`色相 ${lo}–${hi}°、白字对比度 ≥ ${minC} 的候选（按鲜艳度排序，前 10）：\n`)
    console.log('  色值      白字对比度   色度   色相')
    for (const f of found.slice(0, 10)) {
      console.log(`  ${f.hex}   ${f.c.toFixed(2)}       ${String(f.chroma).padStart(3)}   ${f.h.toFixed(0)}°`)
    }
    if (!found.length) console.log('  （该区间内没有满足门槛的颜色 —— 说明门槛或色相区间需要放宽）')
    return
  }

  // ── 模式 1：体检 tokens.css ──────────────────────────────────────────
  const file = argv.find((a) => a.endsWith('.css')) || path.join('src', 'renderer', 'src', 'styles', 'tokens.css')
  const t = readTokens(file)
  const get = (k) => {
    if (!t[k]) throw new Error(`tokens.css 里没有 ${k}`)
    return hex2rgb(t[k])
  }

  /*
   * 要检查的「前景 on 背景」组合，以及各自的门槛。
   *
   * 4.5 = WCAG AA 正文文字；3.0 = AA 大字号/非文字 UI 元件。
   * 门槛不是随便定的：界面上这些地方都是 12–13px 的小字，
   * 属于「正文」，所以按 4.5 卡，而不是按大字的 3.0 放过。
   */
  const pairs = [
    ['白字 on 主色按钮', [255, 255, 255], get('--primary'), 4.5],
    ['白字 on 主色 hover', [255, 255, 255], get('--primary-deep'), 4.5],
    ['主色深字 on 主色浅底', get('--primary-deep'), get('--primary-soft'), 4.5],
    ['正文 on 背景', get('--ink'), get('--bg'), 4.5],
    ['正文 on 卡片', get('--ink'), get('--card-a'), 4.5],
    ['次级字 on 卡片', get('--ink-soft'), get('--card-a'), 4.5],
    ['次级字 on 背景', get('--ink-soft'), get('--bg'), 4.5],
    ['主色 on 卡片', get('--primary'), get('--card-a'), 3.0],
    ['正文 on 主色浅底', get('--ink'), get('--primary-soft'), 4.5],
    ['白字 on 危险色', [255, 255, 255], get('--danger'), 4.5],
    ['白字 on 危险 hover', [255, 255, 255], get('--danger-deep'), 4.5],
    ['白字 on 运行绿', [255, 255, 255], get('--ribbon-run'), 4.5]
  ]

  console.log(`体检：${file}\n`)
  console.log('  检查项                     对比度   门槛   结果')
  let fail = 0
  for (const [name, fg, bg, need] of pairs) {
    const c = contrast(fg, bg)
    const ok = c >= need
    if (!ok) fail++
    console.log(
      `  ${name.padEnd(24)}  ${c.toFixed(2).padStart(5)}   ${String(need).padStart(4)}   ${ok ? 'PASS' : 'FAIL'}`
    )
  }
  console.log(`\n${fail === 0 ? '全部通过' : fail + ' 项未达标'}`)
  if (fail) process.exit(1)
}

main()
