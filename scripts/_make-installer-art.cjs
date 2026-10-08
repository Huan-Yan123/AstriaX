#!/usr/bin/env node
/**
 * 生成安装器 / 卸载器的向导图（24 位 BMP，纯 Node，零依赖）。
 *
 * ## 为什么需要它
 *
 * 主人要求「安装器和卸载器的界面也改成软件风格的，而不是默认的」。
 * electron-builder 的 NSIS 向导默认用的是 `${NSISDIR}\Contrib\Graphics\
 * Wizard\nsis3-metro.bmp` —— 一张跟本产品毫无关系的通用灰图。
 *
 * 要换成自家的图，得喂给它：
 *   MUI_WELCOMEFINISHPAGE_BITMAP / MUI_UNWELCOMEFINISHPAGE_BITMAP  164×314
 *   MUI_HEADERIMAGE_BITMAP                                         150×57
 * （尺寸是 MUI2 写死的，给错尺寸运行时会报 bitmap size mismatch）
 *
 * ## 为什么不用 System.Drawing / sharp
 *
 * 仓库里没有图像库，pnpm 的 minimumReleaseAge 还会拦新包。
 * 而且本项目的铁律是中文内容绝不走 PowerShell 的文本管线 ——
 * 图片是二进制、表面无风险，但既然纯 Node 能做得又稳又可验证，
 * 就不给那条铁律开后门。
 *
 * ## 关键难点：logo 是「近白底上的圆形徽章」
 *
 * 直接把整张 logo 貼到深蓝渐变上，会出现一个**白方块**（很难看）。
 * 但也不能简单地「把白色抠成透明」—— 徽章内部的裙子、高光本身就是白的，
 * 抠白色会在人物身上打出一堆洞。
 *
 * 所以走**几何遮罩**：先探测出非背景像素的包围盒（= 徽章圆的外接框），
 * 再按圆裁切、边缘 1.5px 抗锯齿。圆内的白色一律保留
 * （那是徽章自己的底色，正是想要的效果），圆外的近白底一律丢弃。
 *
 * 用法：
 *   node scripts/_make-installer-art.cjs --probe   # 只探测徽章边界
 *   node scripts/_make-installer-art.cjs --write   # 生成三张 BMP
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// ── PNG 解码（与 _png-resize.cjs 同一套，支持 8 位 0/2/4/6 型、非交错） ──
function decodePng(file) {
  const buf = fs.readFileSync(file)
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG：' + file)
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
  if (depth !== 8) throw new Error('只支持 8 位深，实际 ' + depth)
  if (interlace !== 0) throw new Error('不支持交错 PNG')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype]
  if (!channels) throw new Error('不支持的色型 ' + ctype)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * channels
  const out = Buffer.alloc(h * stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const ft = raw[p++]
    const line = raw.subarray(p, p + stride)
    p += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev ? prev[i] : 0
      const c = prev && i >= channels ? prev[i - channels] : 0
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
  // 统一成 RGBA
  const rgba = Buffer.alloc(w * h * 4)
  for (let i = 0, n = w * h; i < n; i++) {
    let r
    let g
    let b
    let a
    if (channels === 4) {
      r = out[i * 4]
      g = out[i * 4 + 1]
      b = out[i * 4 + 2]
      a = out[i * 4 + 3]
    } else if (channels === 3) {
      r = out[i * 3]
      g = out[i * 3 + 1]
      b = out[i * 3 + 2]
      a = 255
    } else if (channels === 2) {
      r = g = b = out[i * 2]
      a = out[i * 2 + 1]
    } else {
      r = g = b = out[i]
      a = 255
    }
    rgba[i * 4] = r
    rgba[i * 4 + 1] = g
    rgba[i * 4 + 2] = b
    rgba[i * 4 + 3] = a
  }
  return { w, h, rgba }
}

/** 是否接近背景白（各通道都亮、且饱和度低） */
function isNearWhite(r, g, b) {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  return min >= 232 && max - min <= 14
}

/** 探测徽章包围盒：非近白、且不透明的像素范围 */
function probeBadge(img) {
  const { w, h, rgba } = img
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  let opaque = 0
  let transparent = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      if (rgba[i + 3] < 128) {
        transparent++
        continue
      }
      opaque++
      if (isNearWhite(rgba[i], rgba[i + 1], rgba[i + 2])) continue
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  // 四角采样：判断原图是不是「圆外透明」
  const corners = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1]
  ].map(([x, y]) => {
    const i = (y * w + x) * 4
    return { x, y, a: rgba[i + 3], rgb: [rgba[i], rgba[i + 1], rgba[i + 2]] }
  })
  return { x0, y0, x1, y1, opaque, transparent, corners }
}

/** alpha 包围盒（alpha >= 128 的范围） */
function alphaBBox(img) {
  const { w, h, rgba } = img
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (rgba[(y * w + x) * 4 + 3] < 128) continue
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x > x1) x1 = x
      if (y > y1) y1 = y
    }
  }
  return { x0, y0, x1, y1 }
}

/** 面积平均缩放（预乘 alpha，避免透明边缘拖出黑边） */
function resizeArea(img, tw, th) {
  const { w, h, rgba } = img
  const out = Buffer.alloc(tw * th * 4)
  const sx = w / tw
  const sy = h / th
  for (let ty = 0; ty < th; ty++) {
    const y0 = Math.floor(ty * sy)
    const y1 = Math.min(h, Math.max(y0 + 1, Math.ceil((ty + 1) * sy)))
    for (let tx = 0; tx < tw; tx++) {
      const x0 = Math.floor(tx * sx)
      const x1 = Math.min(w, Math.max(x0 + 1, Math.ceil((tx + 1) * sx)))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * w + x) * 4
          const al = rgba[i + 3] / 255
          r += rgba[i] * al
          g += rgba[i + 1] * al
          b += rgba[i + 2] * al
          a += al
          n++
        }
      }
      const o = (ty * tw + tx) * 4
      if (a > 0) {
        out[o] = Math.round(r / a)
        out[o + 1] = Math.round(g / a)
        out[o + 2] = Math.round(b / a)
        out[o + 3] = Math.round((a / n) * 255)
      }
    }
  }
  return out
}

const lerp = (a, b, t) => a + (b - a) * t

/**
 * 把 logo 合成到目标画布（**直接用 alpha 通道**，不加几何遮罩）。
 *
 * ## 为什么放弃几何圆遮罩
 *
 * 第一版我假设 logo 是「近白底上的圆形徽章」，于是写了个几何圆去裁。
 * 实测（scripts/_probe-logo-alpha.cjs）推翻了这个假设：
 *
 *     alpha>=128 区域 = 483 x 489，几乎铺满整张 512 画布
 *     圆公式比对平均偏差 45.55 px，最大 151.11 px
 *
 * 也就是说 alpha 不是圆，而是**铺满画布的圆角形状**；
 * 圆形徽章（那个白底蓝边圆圈）在图片**内部**，靠它自己的白色底显出来。
 * 四角 alpha=0 是圆角/描边外的那一点点。
 *
 * 结论：任何几何遮罩都会**切错**。最忠实的做法是直接用 alpha 合成 ——
 * PNG 自带的 alpha 就是作者画出来的形状，不需要我再去猜。
 *
 * 唯一的处理：把画布外缘那圈**接近全透明**的像素压成完全透明，
 * 免得缩到 104px 时残留一圈若有若无的脏边（半透明像素占实心区 2.0%，
 * 主要就是边缘抗锯齿）。
 */
function drawLogo(canvas, cw, ch, logo, dx, dy, dw, dh, crop) {
  const scaled = resizeArea({ w: crop.w, h: crop.h, rgba: crop.rgba }, dw, dh)
  for (let y = 0; y < dh; y++) {
    const py = Math.round(dy + y)
    if (py < 0 || py >= ch) continue
    for (let x = 0; x < dw; x++) {
      const px = Math.round(dx + x)
      if (px < 0 || px >= cw) continue
      const si = (y * dw + x) * 4
      let a = scaled[si + 3] / 255
      if (a <= 0) continue
      /*
       * 极低 alpha 直接丢弃。
       * 阈值 0.06：低于它的像素在最终图上贡献不到 6% 的白色，
       * 肉眼看不见，但缩小时会和外层渐变混成一条浅灰脏边。
       */
      if (a < 0.06) continue
      const di = (py * cw + px) * 4
      canvas[di] = Math.round(canvas[di] * (1 - a) + scaled[si] * a)
      canvas[di + 1] = Math.round(canvas[di + 1] * (1 - a) + scaled[si + 1] * a)
      canvas[di + 2] = Math.round(canvas[di + 2] * (1 - a) + scaled[si + 2] * a)
    }
  }
}

/** 径向柔光（让徽章后面有一点呼吸感，不至于贴在平渐变上） */
function radialGlow(canvas, cw, ch, cx, cy, radius, strength) {
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      const dx = x - cx
      const dy = y - cy
      const d = Math.sqrt(dx * dx + dy * dy)
      if (d >= radius) continue
      const t = 1 - d / radius
      const a = t * t * strength
      const i = (y * cw + x) * 4
      canvas[i] = Math.round(canvas[i] * (1 - a) + 255 * a)
      canvas[i + 1] = Math.round(canvas[i + 1] * (1 - a) + 255 * a)
      canvas[i + 2] = Math.round(canvas[i + 2] * (1 - a) + 255 * a)
    }
  }
}

/** 四角星（呼应 logo 里的星星），纯像素运算 */
function sparkle(canvas, cw, ch, cx, cy, size, alpha) {
  for (let y = -size; y <= size; y++) {
    for (let x = -size; x <= size; x++) {
      // 菱形 + 细长的四角，用 |x|+|y| 与主轴距离构造
      const ax = Math.abs(x)
      const ay = Math.abs(y)
      const onAxis = ax < 1.2 || ay < 1.2
      const d = ax + ay
      if (d > size) continue
      let a = alpha * (1 - d / size)
      if (!onAxis) a *= 0.45
      if (a <= 0) continue
      const px = Math.round(cx + x)
      const py = Math.round(cy + y)
      if (px < 0 || py < 0 || px >= cw || py >= ch) continue
      const i = (py * cw + px) * 4
      canvas[i] = Math.round(canvas[i] * (1 - a) + 255 * a)
      canvas[i + 1] = Math.round(canvas[i + 1] * (1 - a) + 250 * a)
      canvas[i + 2] = Math.round(canvas[i + 2] * (1 - a) + 235 * a)
    }
  }
}

/**
 * 底部叠一道海浪（呼应 logo 里的鲸鱼与海水）。
 *
 * ## 为什么要加
 *
 * 侧栏图是 164x314 的竖长条，而徽章贴上去只占上半部分 ——
 * 下面 140 多像素全是空渐变，整体头重脚轻、像没做完。
 *
 * 直接用渐变填满不行（那只是"空"）；放第二张图又太重。
 * 用正弦曲线画一道水波成本极低（纯像素运算），而且**有语义**：
 * logo 里就有鲸鱼和溅起的水花，这道波纹是它的延续，不是装饰。
 *
 * 两条波错开相位与深浅，做出一点前后层次。
 */
function makeWaves(canvas, cw, ch, baseY, amp, color, alpha) {
  for (let x = 0; x < cw; x++) {
    // 两个不同频率叠加，避免规则的正弦看着太"数学"
    const t = x / cw
    const wave = Math.sin(t * Math.PI * 2.2) * amp + Math.sin(t * Math.PI * 5.7 + 1.1) * amp * 0.32
    const surface = baseY + wave
    for (let y = Math.ceil(surface); y < ch; y++) {
      // 越往下越实，做出水的层次
      const depth = Math.min(1, (y - surface) / 26)
      const a = alpha * (0.45 + depth * 0.55)
      const i = (y * cw + x) * 4
      canvas[i] = Math.round(canvas[i] * (1 - a) + color[0] * a)
      canvas[i + 1] = Math.round(canvas[i + 1] * (1 - a) + color[1] * a)
      canvas[i + 2] = Math.round(canvas[i + 2] * (1 - a) + color[2] * a)
    }
  }
}


/** 24 位 BMP 编码（自下而上、BGR、行按 4 字节对齐） */
function encodeBmp24(canvas, w, h) {
  const rowSize = Math.ceil((w * 3) / 4) * 4
  const pixelBytes = rowSize * h
  const fileHeader = Buffer.alloc(14)
  fileHeader.write('BM', 0, 'ascii')
  fileHeader.writeUInt32LE(14 + 40 + pixelBytes, 2)
  fileHeader.writeUInt32LE(0, 6)
  fileHeader.writeUInt32LE(14 + 40, 10)
  const info = Buffer.alloc(40)
  info.writeUInt32LE(40, 0)
  info.writeInt32LE(w, 4)
  info.writeInt32LE(h, 8) // 正数 = 自下而上
  info.writeUInt16LE(1, 12)
  info.writeUInt16LE(24, 14)
  info.writeUInt32LE(0, 16) // BI_RGB
  info.writeUInt32LE(pixelBytes, 20)
  info.writeInt32LE(2835, 24)
  info.writeInt32LE(2835, 28)
  info.writeUInt32LE(0, 32)
  info.writeUInt32LE(0, 36)
  const px = Buffer.alloc(pixelBytes)
  for (let y = 0; y < h; y++) {
    // BMP 自下而上：文件第 0 行是图像最后一行
    const srcY = h - 1 - y
    for (let x = 0; x < w; x++) {
      const si = (srcY * w + x) * 4
      const di = y * rowSize + x * 3
      px[di] = canvas[si + 2] // B
      px[di + 1] = canvas[si + 1] // G
      px[di + 2] = canvas[si] // R
    }
  }
  return Buffer.concat([fileHeader, info, px])
}

/** 画布：竖向渐变（deep → bright），并写入初始像素 */
function makeGradient(w, h, top, bottom, horizontal) {
  const c = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = horizontal ? x / Math.max(1, w - 1) : y / Math.max(1, h - 1)
      const i = (y * w + x) * 4
      c[i] = Math.round(lerp(top[0], bottom[0], t))
      c[i + 1] = Math.round(lerp(top[1], bottom[1], t))
      c[i + 2] = Math.round(lerp(top[2], bottom[2], t))
      c[i + 3] = 255
    }
  }
  return c
}

const DEEP = [0x1b, 0x3f, 0x7d] // 比 --primary-deep(#2858a8) 更深一档
const MID = [0x2f, 0x6b, 0xd8] // --primary
const SKY = [0x4a, 0x8f, 0xe6] // 偏天蓝，呼应 logo 的 #3898f8

function main() {
  const doProbe = process.argv.includes('--probe')
  const doWrite = process.argv.includes('--write')
  const root = path.join(__dirname, '..')
  const logoPath = path.join(root, 'build', 'icon.png')
  const logo = decodePng(logoPath)
  const badge = probeBadge(logo)

  console.log(`logo：${logoPath}  ${logo.w}x${logo.h}`)
  console.log(
    `  非白像素包围盒 = x[${badge.x0}..${badge.x1}] y[${badge.y0}..${badge.y1}]  ` +
      `= ${badge.x1 - badge.x0 + 1}x${badge.y1 - badge.y0 + 1}`
  )
  console.log(`  不透明像素 ${badge.opaque}，透明像素 ${badge.transparent}`)
  console.log(
    `  四角 alpha = ${badge.corners.map((c) => `${c.a}@${c.x},${c.y}`).join('  ')}`
  )
  if (doProbe && !doWrite) return

  /*
   * 裁剪框取 **alpha 包围盒**，不是「非白包围盒」。
   *
   * 第一版用 `badge.x0..x1`（非近白像素的范围）当裁剪框，实测 x[21..501]
   * y[4..490] —— 但它被边角那些**孤立的深色描边像素**带偏了，
   * 并不是徽章的真实范围。
   *
   * alpha 包围盒才是「作者画出来的东西」的边界（_probe-logo-alpha.cjs 实测
   * 是覆盖几乎整张画布的圆角形状）。按它裁剪，缩放到目标尺寸时
   * 才能真正占满、不留多余空白。
   */
  const ab = alphaBBox(logo)
  const bx = ab.x0
  const by = ab.y0
  const bw = ab.x1 - ab.x0 + 1
  const bh = ab.y1 - ab.y0 + 1
  const cropRgba = Buffer.alloc(bw * bh * 4)
  for (let y = 0; y < bh; y++) {
    const src = ((by + y) * logo.w + bx) * 4
    logo.rgba.copy(cropRgba, y * bw * 4, src, src + bw * 4)
  }
  const crop = { w: bw, h: bh, rgba: cropRgba }
  console.log(`  alpha 包围盒 ${bw}x${bh}（裁剪框，保持长宽比）`)

  /**
   * 徽章是圆形，但外接框是正方形；圆内四角本来就是「近白底」。
   * 圆形遮罩会把四角切掉，所以这里不需要再做颜色抠除 ——
   * 保留圆内所有像素（含徽章自身的白色底）正是想要的「贴纸」效果。
   */
  const outputs = []

  // ── 侧栏图：164×314（MUI 欢迎/完成页） ──
  {
    const w = 164
    const h = 314
    const c = makeGradient(w, h, DEEP, SKY, false)
    const cx = w / 2
    const cy = 108
    radialGlow(c, w, h, cx, cy, 92, 0.16)
    const d = 112
    drawLogo(c, w, h, logo, cx - d / 2, cy - d / 2, d, d, crop)
    // 呼应 logo 里星星的点缀（错开位置，避免呆板对称）
    sparkle(c, w, h, 26, 40, 7, 0.5)
    sparkle(c, w, h, 140, 56, 4.5, 0.4)
    sparkle(c, w, h, 34, 196, 5, 0.38)
    sparkle(c, w, h, 132, 158, 3.5, 0.3)
    /*
     * 两道海浪压住下半部分。
     * 徽章底缘约在 y=108+56=164，所以第一道波从 196 起，
     * 中间留 30 多像素的呼吸，不至于贴在一起。
     */
    makeWaves(c, w, h, 196, 7, [0x1b, 0x3f, 0x7d], 0.5) // 后浪：深、更实
    makeWaves(c, w, h, 226, 5, [0x3d, 0x7d, 0xd0], 0.34) // 前浪：亮、更透
    outputs.push({ file: 'installerSidebar.bmp', w, h, buf: encodeBmp24(c, w, h) })
    outputs.push({ file: 'uninstallerSidebar.bmp', w, h, buf: encodeBmp24(c, w, h) })
  }

  // ── 页头图：150×57（MUI 内页 header） ──
  {
    const w = 150
    const h = 57
    const c = makeGradient(w, h, DEEP, MID, true)
    const cx = 122
    const cy = h / 2
    radialGlow(c, w, h, cx, cy, 34, 0.2)
    const d = 42
    drawLogo(c, w, h, logo, cx - d / 2, cy - d / 2, d, d, crop)
    sparkle(c, w, h, 18, 15, 5, 0.42)
    sparkle(c, w, h, 42, 43, 3.5, 0.32)
    sparkle(c, w, h, 16, 44, 3, 0.26)
    outputs.push({ file: 'installerHeader.bmp', w, h, buf: encodeBmp24(c, w, h) })
  }

  const dir = path.join(root, 'build')
  for (const o of outputs) {
    const p = path.join(dir, o.file)
    fs.writeFileSync(p, o.buf)
    console.log(`出：${o.file}  ${o.w}x${o.h}  24 位 BMP  ${(o.buf.length / 1024).toFixed(1)} KB`)
  }

  // ── 回读校验：确认写出去的 BMP 头与像素布局真的是 NSIS 要的形态 ──
  let bad = 0
  for (const o of outputs) {
    const p = path.join(dir, o.file)
    const b = fs.readFileSync(p)
    const check = (cond, msg) => {
      if (!cond) {
        bad++
        console.log(`  ✘ ${o.file}：${msg}`)
      }
    }
    check(b.toString('ascii', 0, 2) === 'BM', '缺少 BM 签名')
    check(b.readUInt32LE(14) === 40, 'DIB 头长度不是 40')
    check(b.readInt32LE(18) === o.w, `宽度应为 ${o.w}，实际 ${b.readInt32LE(18)}`)
    check(b.readInt32LE(22) === o.h, `高度应为 ${o.h}，实际 ${b.readInt32LE(22)}`)
    check(b.readUInt16LE(28) === 24, '位深应为 24')
    check(b.readUInt32LE(30) === 0, '压缩方式应为 BI_RGB(0)')
    const rowSize = Math.ceil((o.w * 3) / 4) * 4
    const expectSize = 14 + 40 + rowSize * o.h
    check(b.length === expectSize, `文件长度应为 ${expectSize}，实际 ${b.length}`)
    check(b.readUInt32LE(10) === 54, '像素起始偏移应为 54')
  }
  console.log(bad === 0 ? '\nBMP 回读校验：全部通过' : `\nBMP 回读校验：${bad} 项不合格`)
  if (bad) process.exit(1)
}

main()
