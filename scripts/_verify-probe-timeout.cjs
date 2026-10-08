#!/usr/bin/env node
/*
 * 实测：`probePort` 的并发行为与超时取值。
 *
 * 目的：验证「删除卡主进程」的修复到底能省多少。
 * 对应用户日志：
 *     [ERROR] [perf] IPC runtimes:remove 耗时 3252ms（严重）
 *     [WARN] [perf] 主进程事件循环疑似被同步代码阻塞：… 3232ms …
 */
const net = require('net')

function probePort(port, timeoutMs) {
  return new Promise((resolve) => {
    const s = new net.Socket()
    let done = false
    const fin = (ok) => {
      if (done) return
      done = true
      s.destroy()
      resolve(ok)
    }
    s.setTimeout(timeoutMs)
    s.once('connect', () => fin(true))
    s.once('timeout', () => fin(false))
    s.once('error', () => fin(false))
    s.connect(port, '127.0.0.1')
  })
}

async function bench(label, n, timeoutMs) {
  // 取一批"肯定没人监听"的端口：最坏情况（每个都等满超时）
  const ports = Array.from({ length: n }, (_, i) => 51000 + i)
  const t0 = Date.now()
  await Promise.all(ports.map((p) => probePort(p, timeoutMs)))
  const ms = Date.now() - t0
  console.log(`  ${label}: ${n} 个端口并发，超时 ${timeoutMs}ms → ${ms} ms`)
  return ms
}

;(async () => {
  console.log('=== probePort 并发实测（全部端口无人监听 = 最坏情况）===')
  const n = 25
  const a = await bench('修复前', n, 1200)
  const b = await bench('修复后', n, 300)

  // 再测一个真实在监听的端口（证明 300ms 足够连上本地回环）
  const srv = net.createServer(() => {})
  await new Promise((r) => srv.listen(51999, '127.0.0.1', r))
  const t1 = Date.now()
  const ok = await probePort(51999, 300)
  const liveMs = Date.now() - t1
  srv.close()
  console.log(`\n  真实监听端口探测: ${ok ? '连上' : '没连上'}，耗时 ${liveMs} ms（300ms 超时）`)

  const saved = a - b
  console.log(`\n结论：并发最坏情况 ${a} ms → ${b} ms，省了 ${saved} ms（${Math.round((saved / a) * 100)}%）`)
  console.log(`      本地回环真实连接 ${liveMs} ms —— 300ms 超绰绰有余`)
  process.exit(ok && liveMs < 100 ? 0 : 1)
})()
