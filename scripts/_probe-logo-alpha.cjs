#!/usr/bin/env node
/**
 * 验证 logo 的 alpha 通道是不是一个**干净的圆**。
 *
 * ## 为什么要单独验证
 *
 * 上一版合成脚本用「几何圆遮罩」去裁 logo，理由是「近白底上的圆形徽章」。
 * 但实测发现四角 alpha = 0 —— 也就是说 PNG **自带透明遮罩**，
 * 圆外本来就是透明的。
 *
 * 这时候再用几何圆去裁是错的：
 *   1. 多余 —— 圆外的像素 alpha 已经是 0，几何遮罩什么也没多切
 *   2. 有害 —— 几何圆的半径/圆心只要估偏一点点，
 *      就会把徽章真实的边缘（抗锯齿那一圈，或者不是正圆的部分）切掉，
 *      看起来像被刀切过
 *
 * 直接用 alpha 通道合成才是忠实的做法。但前提是：
 * **alpha 得真的是个圆**，而不是别的奇怪形状。
 * 万一它是个椭圆、或者带着一圈透明光晕，直接用会出问题。
 *
 * ## 判定方法
 *
 * 逐行取 alpha >= 128 的像素左右边界，得到该行实际宽度 w(y)。
 * 若是半径 R、圆心 cy 的圆，应有
 *     w(y) = 2 * sqrt(R^2 - (y-cy)^2)
 * 用最小二乘拟出 R、cy，再看实际宽度与预测值的偏差。
 * 同时统计「上下左右四个方向的边缘点是否落在同一半径上」。
 *
 * 用法：node scripts/_probe-logo-alpha.cjs [图片.png]
 */
const fs = require('fs')
const zlib = require('zlib')
const path = require('path')

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function decode(file) {
  const buf = fs.readFileSync(file)
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG')
  let off = 8
  let w = 0
  let h = 0
  let depth = 0
  let ctype = 0
  let interlace = 0
  const idat = []
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    const data = buf.subarray(off + 8, off + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      depth = data[8]
      ctype = data[9]
      interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (depth !== 8) throw new Error('只支持 8 位深')
  if (interlace !== 0) throw new Error('不支持交错')
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype]
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * ch
  const out = Buffer.alloc(h * stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const ft = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= ch ? prev[i - ch] : 0
      let v = line[i]
      if (ft === 1) v += a
      else if (ft === 2) v += b
      else if (ft === 3) v += (a + b) >> 1
      else if (ft === 4) {
        const pa = Math.abs(b - c)
        const pb = Math.abs(a - c)
        const pc = Math.abs(a + b - 2 * c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[i] = v & 0xff
    }
  }
  const alpha = Buffer.alloc(w * h)
  for (let i = 0; i < w * h; i++) {
    alpha[i] = ch === 4 ? out[i * 4 + 3] : ch === 2 ? out[i * 2 + 1] : 255
  }
  return { w, h, alpha }
}

const file = process.argv[2] || path.join(__dirname, '..', 'build', 'icon.png')
const img = decode(file)
console.log(`图：${file}  ${img.w}x${img.h}`)

// 逐行左右边界
const rows = []
for (let y = 0; y < img.h; y++) {
  let l = -1
  let r = -1
  for (let x = 0; x < img.w; x++) {
    if (img.alpha[y * img.w + x] >= 128) {
      if (l < 0) l = x
      r = x
    }
  }
  if (l >= 0) rows.push({ y, l, r, w: r - l + 1 })
}
if (!rows.length) {
  console.log('没有任何 alpha>=128 的像素')
  process.exit(1)
}
const top = rows[0].y
const bottom = rows[rows.length - 1].y
let widest = rows[0]
for (const r of rows) if (r.w > widest.w) widest = r
console.log(`alpha>=128 区域：y ${top}..${bottom}（高 ${bottom - top + 1}）`)
console.log(`最宽一行：y=${widest.y}  宽 ${widest.w}  x ${widest.l}..${widest.r}`)

/*
 * 圆心 y 取「最宽行」，半径取 最宽宽/2。
 * 若这个假设成立，则对每行应有 w(y) ≈ 2*sqrt(R^2-(y-cy)^2)。
 * 用真实数据反过来解 cy 与 R：对上边缘与下边缘各取一点联立。
 *   在 y=top 处：w≈0  →  cy ≈ top + R        （圆顶）
 *   在 y=bottom：     →  cy ≈ bottom - R
 * 两式相加：cy = (top+bottom)/2，R = (bottom-top)/2
 */
const cy = (top + bottom) / 2
const Rv = (bottom - top + 1) / 2
const Rh = widest.w / 2
console.log(`\n按上下边缘解：圆心 y=${cy.toFixed(1)}  半径(纵)=${Rv.toFixed(1)}`)
console.log(`按最宽行解：  半径(横)=${Rh.toFixed(1)}`)
console.log(`横纵半径差 = ${Math.abs(Rh - Rv).toFixed(1)} px（越小越接近正圆）`)

// 逐行比对圆公式
let maxDev = 0
let sumDev = 0
let n = 0
let worstY = 0
for (const r of rows) {
  const dy = r.y + 0.5 - cy
  const inside = Rv * Rv - dy * dy
  if (inside <= 0) continue
  const predicted = 2 * Math.sqrt(inside)
  const dev = Math.abs(predicted - r.w)
  // 只在圆的中段比较（两端宽度接近 0，几像素的偏差没有意义）
  if (predicted > 8) {
    if (dev > maxDev) {
      maxDev = dev
      worstY = r.y
    }
    sumDev += dev
    n++
  }
}
console.log(`\n圆公式比对（仅统计预测宽度 > 8px 的行，共 ${n} 行）：`)
console.log(`  平均偏差 ${(sumDev / Math.max(1, n)).toFixed(2)} px`)
console.log(`  最大偏差 ${maxDev.toFixed(2)} px（在 y=${worstY}）`)

// 结论
const radiusMismatch = Math.abs(Rh - Rv)
if (radiusMismatch <= 4 && maxDev <= 6) {
  console.log('\n结论：alpha 通道是一个**干净的圆** —— 直接用 alpha 合成即可，')
  console.log('      不需要再加几何圆遮罩（加了反而可能切坏真实边缘）。')
} else if (radiusMismatch <= 8 && maxDev <= 14) {
  console.log('\n结论：接近圆，但不是严格的圆（可能是手绘徽章/带轻微外扩）。')
  console.log('      仍建议直接用 alpha 合成 —— 它是**忠实**的形状。')
} else {
  console.log('\n结论：**不是圆**（横纵半径差或偏差过大）。')
  console.log('      必须直接用 alpha 合成，任何几何遮罩都会切错。')
}

// 检查有没有「半透明光晕」（alpha 介于 1..127 的大片区域）
let glow = 0
let solid = 0
for (let i = 0; i < img.w * img.h; i++) {
  const a = img.alpha[i]
  if (a > 0 && a < 128) glow++
  else if (a >= 128) solid++
}
console.log(`\n半透明像素 ${glow}（占实心区 ${((glow / solid) * 100).toFixed(1)}%）`)
console.log(
  glow / solid < 0.06
    ? '  → 只有边缘抗锯齿那一圈，属于正常'
    : '  → 存在大片半透明，可能是柔光/阴影，合成时要留意'
)
