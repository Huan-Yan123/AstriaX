#!/usr/bin/env node
/*
 * 实测各个下载源的真实速度（主人要求：「测试各个下载源的实际下载速度」）。
 *
 * 为什么必须实测而不是看代码：源"通不通"和"快不快"是两件事。
 * 一个源可能 HTTP 200 但只有 20 KB/s（跨海/被限速），
 * 用户体感就是"卡了几分钟"；而源的**顺序**决定了默认走哪条。
 *
 * 做法：对每个源的真实文件发 Range 请求（只取前 N MB），
 * 量"首字节时间 + 传输速度"，并重复几次取中位数（网络抖动）。
 *
 * 用法：
 *   node scripts/speedtest-sources.cjs                    # 默认测上传/下载两个大文件
 *   node scripts/speedtest-sources.cjs --mb 2 --rounds 3  # 每次取 2MB、测 3 轮
 */
const https = require('https')
const http = require('http')

const MB = Number(getArg('--mb', '1'))
const ROUNDS = Number(getArg('--rounds', '3'))

function getArg(name, dflt) {
  const i = process.argv.indexOf(name)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}

/** 候选源（主人 2026-09-24 明确：官方源只有这一个） */
const BASES = [['官方源(域名+SSL)', 'https://astriax.huanyan.fun/mxbot/']]

/** 被测文件：挑真实存在且体积可观的两个 */
const FILES = [
  ['NapCat 运行时(28MB)', 'files/napcat/NapCat.Shell.zip'],
  ['全量安装包(80MB)', 'AstriaX-Setup-0.1.5.exe']
]

function head(url, timeoutMs) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http
    const req = lib.request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
      const len = Number(res.headers['content-length'] ?? 0)
      res.resume()
      resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode, len })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, status: 'timeout', len: 0 })
    })
    req.on('error', (e) => resolve({ ok: false, status: e.code || e.message, len: 0 }))
    req.end()
  })
}

/** 取前 MB 兆字节，返回 {ms, bytes, ttfb} */
function sample(url, mb, timeoutMs) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http
    const want = Math.round(mb * 1024 * 1024)
    const t0 = Date.now()
    let ttfb = 0
    let got = 0
    const req = lib.request(
      url,
      { method: 'GET', timeout: timeoutMs, headers: { Range: `bytes=0-${want - 1}` } },
      (res) => {
        ttfb = Date.now() - t0
        res.on('data', (chunk) => {
          got += chunk.length
          if (got >= want) {
            res.destroy()
            resolve({ ms: Date.now() - t0, bytes: got, ttfb })
          }
        })
        res.on('end', () => resolve({ ms: Date.now() - t0, bytes: got, ttfb }))
        res.on('error', () => resolve({ ms: Date.now() - t0, bytes: got, ttfb }))
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ ms: Date.now() - t0, bytes: got, ttfb, timeout: true })
    })
    req.on('error', () => resolve({ ms: Date.now() - t0, bytes: got, ttfb, error: true }))
    req.end()
  })
}

const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? s[Math.floor(s.length / 2)] : 0
}
const kbps = (bytes, ms) => (ms > 0 ? Math.round(bytes / 1024 / (ms / 1000)) : 0)

async function main() {
  console.log(`源速度实测（每次取 ${MB} MB，重复 ${ROUNDS} 轮取中位数）`)
  console.log('='.repeat(72))

  for (const [label, base] of BASES) {
    console.log(`\n【${label}】${base}`)
    for (const [fname, rel] of FILES) {
      const url = base + rel
      const h = await head(url, 8000)
      if (!h.ok) {
        console.log(`  ${fname}`)
        console.log(`    ✘ 不可用：${h.status}`)
        continue
      }
      const rates = []
      const ttfbs = []
      let failed = 0
      for (let i = 0; i < ROUNDS; i++) {
        const s = await sample(url, MB, 20000)
        if (s.error || s.timeout || s.bytes === 0) {
          failed++
          continue
        }
        rates.push(kbps(s.bytes, s.ms))
        ttfbs.push(s.ttfb)
      }
      console.log(`  ${fname}  (远端 ${(h.len / 1048576).toFixed(1)} MB)`)
      if (rates.length === 0) {
        console.log(`    ✘ ${ROUNDS} 轮全部失败`)
        continue
      }
      const med = median(rates)
      console.log(
        `    中位速度 ${med >= 1024 ? (med / 1024).toFixed(2) + ' MB/s' : med + ' KB/s'}` +
          `   首字节 ${median(ttfbs)}ms   成功 ${rates.length}/${ROUNDS}${failed ? `（失败 ${failed}）` : ''}`
      )
      console.log(`    各轮：${rates.map((r) => (r >= 1024 ? (r / 1024).toFixed(2) + 'MB/s' : r + 'KB/s')).join(' / ')}`)
    }
  }

  console.log('\n' + '='.repeat(72))
  console.log('结论参照：谁是"最快可用源"，就应把它排在 MX_OFFICIAL_BASES 第一位。')
}

main().catch((e) => {
  console.error('实测失败：', e)
  process.exit(1)
})
