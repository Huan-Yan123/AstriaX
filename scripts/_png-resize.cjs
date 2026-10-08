#!/usr/bin/env node
/**
 * 纯 Node 的 PNG 缩放器（零第三方依赖）
 *
 * ## 为什么不用现成库
 *
 * 这个仓库里没有 sharp / jimp / pngjs，装一个只为缩一张图不划算，
 * 而且 pnpm 的 minimumReleaseAge 会拦新包（happy-dom 就被拦过）。
 *
 * ## 为什么不用 PowerShell + System.Drawing
 *
 * 本项目的铁律：**中文文件绝不走 PowerShell 的 Get-Content/Set-Content**，
 * 会被按 GBK 解码成 U+FFFD 并吃掉换行。虽然图片是二进制、表面上看无风险，
 * 但既然能用纯 Node 做得又稳又可验证，就不要给这条铁律开后门。
 *
 * ## 缩放算法：面积平均（area averaging），且在**预乘 alpha** 空间做
 *
 * 直接对 RGB 做平均是错的：透明像素的 RGB 往往是 0（黑），
 * 混进平均值会把边缘拖暗，出现一圈脏黑边。
 * 所以先乘 alpha 求加权和，最后再除以 alpha 总和还原颜色。
 *
 * 用法：
 *   node scripts/_png-resize.cjs <输入.png> <输出.png> <目标边长>
 */
const fs = require('fs')
const zlib = require('zlib')

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function decodePng(file) {
  const buf = fs.readFileSync(file)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是合法的 PNG：' + file)
  let off = 8
  let w = 0
  let h = 0
  let depth = 0
  let ctype = 0
  let interlace = 0
  const idat = []
  let sawIhdr = false
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
      sawIhdr = true
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    off += 12 + len
  }
  if (!sawIhdr) throw new Error('缺少 IHDR')
  if (depth !== 8) throw new Error('只支持 8 位深，当前 = ' + depth)
  if (interlace !== 0) throw new Error('不支持交错（Adam7）PNG')
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ctype]
  if (!channels) throw new Error('只支持灰度/RGB/RGBA，当前色型 = ' + ctype)
  if (!idat.length) throw new Error('缺少 IDAT')

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = w * channels
  if (raw.length < h * (stride + 1)) {
    throw new Error(`IDAT 解压后长度不足：期望 ≥ ${h * (stride + 1)}，实际 ${raw.length}`)
  }
  const out = Buffer.alloc(h * stride)
  let p = 0
  for (let y = 0; y < h; y++) {
    const ft = raw[p++]
    if (ft > 4) throw new Error(`第 ${y} 行过滤器非法：${ft}`)
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
  return { w, h, channels, data: out }
}

/** 从源图取一个像素的 [r,g,b,a] */
function pixelAt(img, x, y) {
  const i = (y * img.w + x) * img.channels
  const d = img.data
  if (img.channels === 4) return [d[i], d[i + 1], d[i + 2], d[i + 3]]
  if (img.channels === 3) return [d[i], d[i + 1], d[i + 2], 255]
  if (img.channels === 2) return [d[i], d[i], d[i], d[i + 1]]
  return [d[i], d[i], d[i], 255]
}

function resizeArea(img, dw, dh) {
  const dst = Buffer.alloc(dw * dh * 4)
  const xr = img.w / dw
  const yr = img.h / dh
  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * yr
    const y1 = (dy + 1) * yr
    const syStart = Math.floor(y0)
    const syEnd = Math.min(Math.ceil(y1), img.h)
    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * xr
      const x1 = (dx + 1) * xr
      const sxStart = Math.floor(x0)
      const sxEnd = Math.min(Math.ceil(x1), img.w)
      let r = 0
      let g = 0
      let b = 0
      let aSum = 0
      let wSum = 0
      for (let sy = syStart; sy < syEnd; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
        if (wy <= 0) continue
        for (let sx = sxStart; sx < sxEnd; sx++) {
          const wx = Math.min(x1, sx + 1) - Math.max(x0, sx)
          if (wx <= 0) continue
          const wt = wx * wy
          const [pr, pg, pb, pa] = pixelAt(img, sx, sy)
          const af = pa / 255
          r += pr * af * wt
          g += pg * af * wt
          b += pb * af * wt
          aSum += pa * wt
          wSum += wt
        }
      }
      const o = (dy * dw + dx) * 4
      if (wSum > 0 && aSum > 0) {
        // r/g/b 累积的是 颜色*alpha*wt，除以 alpha 总和即还原回 unpremultiplied 颜色
        dst[o] = Math.min(255, Math.round(r / (aSum / 255)))
        dst[o + 1] = Math.min(255, Math.round(g / (aSum / 255)))
        dst[o + 2] = Math.min(255, Math.round(b / (aSum / 255)))
        dst[o + 3] = Math.min(255, Math.round(aSum / wSum))
      }
    }
  }
  return dst
}

function encodePng(w, h, rgba) {
  const stride = w * 4
  const raw = Buffer.alloc(h * (stride + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0 // 过滤器类型 0（None）
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 6 // 色型 RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function main() {
  const [inFile, outFile, sizeArg] = process.argv.slice(2)
  if (!inFile || !outFile || !sizeArg) {
    console.error('用法：node scripts/_png-resize.cjs <输入.png> <输出.png> <目标边长>')
    process.exit(2)
  }
  const size = Number(sizeArg)
  if (!Number.isInteger(size) || size < 16 || size > 4096) {
    console.error('目标边长必须是 16..4096 的整数，实际 = ' + sizeArg)
    process.exit(2)
  }
  const img = decodePng(inFile)
  console.log(`源：${inFile}  ${img.w}x${img.h}  通道=${img.channels}`)
  const rgba = resizeArea(img, size, size)
  const png = encodePng(size, size, rgba)
  fs.writeFileSync(outFile, png)
  console.log(`出：${outFile}  ${size}x${size}  ${(png.length / 1024).toFixed(1)} KB`)
}

main()
