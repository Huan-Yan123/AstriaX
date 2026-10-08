// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { run } from '../../src/main/util/async-exec'
import { defaultFetchToFile, downloadRuntime } from '../../src/main/update/runtime-download'
import { createServer } from 'http'
import { existsSync, rmSync } from 'fs'
import { join } from 'path'

/**
 * ★ 取消必须**立刻**生效（主人 2026-10-08）
 *
 * 主人原话：「取消了，延迟性巨大」「无论怎样我都没办法取消安装进度」
 *
 * 日志实据（用户提供的 app 日志）：
 *     [ERROR] [perf] IPC python:install 耗时 93389ms（严重）
 * 93 秒 —— 而用户早就点了取消。
 *
 * 根因在 `defaultFetchToFile`：它**完全不接受**外部取消信号，
 * 自己 new 了一个 30 分钟超时的 controller。于是上层 abort 了，
 * 正在传输的那次 HTTP 请求**根本不知道**，会一直下到自然结束。
 *
 * 这个文件用**真实 HTTP 服务**验证：abort 后请求要立刻断开。
 */
describe('★ 取消子进程的延迟', () => {
  it('abort 之后必须很快 resolve（不是等到进程自己结束）', async () => {
    const ac = new AbortController()
    const t0 = Date.now()

    /* 起一个"跑 60 秒"的进程，模拟 pip 那种长活 */
    const p = run(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], {
      signal: ac.signal,
      timeoutMs: 120000
    })

    /* 给它 300ms 真的起来 */
    await new Promise((r) => setTimeout(r, 300))
    const abortAt = Date.now()
    ac.abort()

    const r = await p
    const elapsed = Date.now() - abortAt

    expect(r.status, '取消后应当返回非 0').not.toBe(0)
    expect(
      elapsed,
      `abort 到 resolve 用了 ${elapsed}ms —— 太久了。\n` +
        '用户点取消后界面会一直显示"取消中"直到这里返回。'
    ).toBeLessThan(6000)
    void t0
  }, 30000)

  it('★ 取消时子进程真的死了（不能只是 Promise 返回了）', async () => {
    const ac = new AbortController()
    const marker = `${process.cwd()}\\data\\cache\\__cancel-test-${Date.now()}.txt`

    /* 进程每秒写一个文件 —— 如果没被杀掉，取消后还会继续写 */
    const script = `
      const fs = require('fs');
      const f = ${JSON.stringify(marker)};
      let n = 0;
      setInterval(() => { try { fs.writeFileSync(f, String(++n)) } catch {} }, 200);
    `
    const p = run(process.execPath, ['-e', script], { signal: ac.signal, timeoutMs: 60000 })
    await new Promise((r) => setTimeout(r, 1200))
    ac.abort()
    await p

    /* 等一下，看它是否还在写 */
    const fs = await import('fs')
    let v1 = ''
    try { v1 = fs.readFileSync(marker, 'utf8') } catch { /* 没写过 */ }
    await new Promise((r) => setTimeout(r, 900))
    let v2 = ''
    try { v2 = fs.readFileSync(marker, 'utf8') } catch { /* 没写过 */ }

    try { fs.unlinkSync(marker) } catch { /* 清理 */ }

    expect(
      v2,
      `取消后子进程**还在跑**（文件从 ${v1} 变成 ${v2}）—— 那意味着它继续占着磁盘和句柄`
    ).toBe(v1)
  }, 30000)

  it('★★ 取消进行中的 HTTP 下载：必须立刻断开（这是"延迟 93 秒"的根因）', async () => {
    /*
     * 起一个"永远下不完"的服务：每 50ms 发一块，永不断开。
     * 这精确模拟用户遇到的情况 —— 包在传、用户点了取消。
     *
     * ══════════════════════════════════════════════════════════════════
     * ★★ 必须走 `downloadRuntime`，不能直接调 `defaultFetchToFile`
     * ══════════════════════════════════════════════════════════════════
     *
     * 我第一版直接调 `defaultFetchToFile(url, dest, undefined, ac.signal)`
     * —— 那条路**只**验证了第 4 个参数本身能用，完全照不到
     * "`downloadRuntime` 有没有把它传下去"。
     *
     * 实测确认过这个漏洞：把 `fetchToFileWithRetry` 里的
     * `fetchToFile(url, dest, onProgress, signal)` 改回不传 signal，
     * 第一版测试**照样全绿**。而真实调用方走的正是 `downloadRuntime`，
     * 所以那个测试等于没守。
     *
     * 现在从 `downloadRuntime` 进入，signal 必须穿过三层
     * （downloadRuntime → fetchToFileWithRetry → defaultFetchToFile）才通过。
     */
    const chunk = Buffer.alloc(512 * 1024)
    let closed = false
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(512 * 1024 * 200) }) // 谎报 100MB，永远发不完
      const t = setInterval(() => {
        if (closed) { clearInterval(t); return }
        res.write(chunk)
      }, 50)
      res.on('close', () => { closed = true; clearInterval(t) })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port

    const dataRoot = `${process.cwd()}\\data`
    const dest = join(dataRoot, 'cache', `__dl-cancel-${Date.now()}.part`)
    const ac = new AbortController()

    const dl = downloadRuntime({
      dataRoot,
      type: 'n',
      release: { tag: 'v9.9.9', assetName: 'big.bin', assetUrl: `http://127.0.0.1:${port}/big` },
      destFile: dest,
      sources: [`http://127.0.0.1:${port}/big`],
      signal: ac.signal
    })
    /* 等它真的开始传 */
    await new Promise((r) => setTimeout(r, 400))

    const abortAt = Date.now()
    ac.abort()

    await expect(dl, '取消后下载应当抛错').rejects.toThrow()
    const elapsed = Date.now() - abortAt

    server.close()
    try { rmSync(dest, { force: true }) } catch { /* 清理 */ }
    try { rmSync(`${dest}.part`, { force: true }) } catch { /* 清理 */ }

    expect(
      elapsed,
      `abort 到下载中断用了 ${elapsed}ms —— 太久了。\n` +
        '说明取消信号没有穿过 downloadRuntime → 重试包装 → 实际 fetch，\n' +
        '这正是用户看到的"点了取消但进度还在走"。'
    ).toBeLessThan(3000)
  }, 30000)

  it('★ 已经取消的信号：根本不该发起请求', async () => {
    const ac = new AbortController()
    ac.abort()
    const dataRoot = `${process.cwd()}\\data`
    const dest = join(dataRoot, 'cache', `__dl-precancel-${Date.now()}.part`)

    await expect(
      downloadRuntime({
        dataRoot,
        type: 'n',
        release: { tag: 'v9.9.9', assetName: 'never.bin', assetUrl: 'http://127.0.0.1:1/never' },
        destFile: dest,
        sources: ['http://127.0.0.1:1/never'],
        signal: ac.signal
      })
    ).rejects.toThrow(/取消|abort/i)

    expect(existsSync(dest), '取消状态不该留下半成品文件').toBe(false)
  }, 15000)

  it('★★ 镜像路径（NapCat/AstrBot 走的就是这条）取消也必须立刻生效', async () => {
    /*
     * ══════════════════════════════════════════════════════════════════
     * 这条是主人第二次实测才暴露的（「napcat 和 astrbot 依旧取消不了」）
     * ══════════════════════════════════════════════════════════════════
     *
     * 我先前只修了 `sources` 分支（内置 Python 走的那条），
     * 而 NapCat/AstrBot 走的是**镜像分支** —— 那是另一份独立调用，
     * 同样漏传了 signal。于是 python 能取消了，它俩依旧不能。
     *
     * 根因有两层，两层都要接上：
     *   ① `ipc.ts` 的 `runtime:install` 调 `downloadRuntime` 时
     *      **只传了 `isCancelled`（轮询式），没传 `signal`（事件式）**
     *   ② 镜像分支的 `fetchToFile(url, tmp, onProgress)` 也漏了第 4 个参数
     *
     * 本测试从 `downloadRuntime` 进入、走**镜像路径**（不传 sources，
     * 让候选来自 mirrorOrderFor），验证信号能穿到底。
     */
    const chunk = Buffer.alloc(512 * 1024)
    let closed = false
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': String(512 * 1024 * 200) })
      const t = setInterval(() => {
        if (closed) { clearInterval(t); return }
        res.write(chunk)
      }, 50)
      res.on('close', () => { closed = true; clearInterval(t) })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port

    const dataRoot = `${process.cwd()}\\data`
    const dest = join(dataRoot, 'cache', `__dl-mirror-${Date.now()}.part`)
    const ac = new AbortController()

    /*
     * 不传 sources → 走镜像分支。
     * `onlyBase` 指到我们的测试服务器，候选就只剩这一个（proxy 模式
     * 会把 base 当前缀拼到 assetUrl 上）。
     */
    const dl = downloadRuntime({
      dataRoot,
      type: 'n',
      release: {
        tag: 'v9.9.9',
        assetName: 'big.bin',
        assetUrl: `http://127.0.0.1:${port}/big`
      },
      destFile: dest,
      onlyBase: `http://127.0.0.1:${port}/`,
      signal: ac.signal,
      isCancelled: () => ac.signal.aborted
    })
    await new Promise((r) => setTimeout(r, 400))

    const abortAt = Date.now()
    ac.abort()

    await expect(dl, '取消后应当抛错').rejects.toThrow()
    const elapsed = Date.now() - abortAt

    server.close()
    try { rmSync(dest, { force: true }) } catch { /* 清理 */ }
    try { rmSync(`${dest}.part`, { force: true }) } catch { /* 清理 */ }

    expect(
      elapsed,
      `镜像路径 abort 到中断用了 ${elapsed}ms —— 太久了。\n` +
        'NapCat/AstrBot 走的就是这条，说明信号没穿到实际 fetch。'
    ).toBeLessThan(3000)
  }, 30000)
})
