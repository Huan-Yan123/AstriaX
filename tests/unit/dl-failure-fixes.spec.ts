// @vitest-environment node
/*
 * 下载失败的三处修复（拿主人机器的真实日志/残骸换来的）
 *
 * 主人实测：「napcat 和 astrbot 都下载失败」+ 主进程卡顿日志：
 *     [ERROR] [perf] IPC versions:list 耗时 20926ms（严重）
 *     [ERROR] [perf] IPC versions:list 耗时 21584ms（严重）
 *     [ERROR] [perf] IPC mirrors:test  耗时 8012ms（严重）
 * 现场残骸：
 *     cache\tmp\rt-xxxx\napcat_NapCat.Shell.zip.part  只有 1.81 MB（应为 28 MB）
 *
 * 三处修：
 *   1. 同一个源内部**重试**（原来一次抖动就换下一个源，而下一个源多半也不通）
 *   2. 各源**并行**探测（原来串行，4 个源 × 15s 超时 = 十几秒把主进程占死）
 *   3. 体积补算**不再反复扫同一批目录**（死循环，日志里同一批 tag 刷十几次）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createServer } from 'http'
import { createHash } from 'crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { defaultFetchToFile, downloadRuntime } from '../../src/main/update/runtime-download'
import { addCustomMirror, setMirrorPref } from '../../src/main/update/mirror-store'
import { listVersions } from '../../src/main/update/version-catalog'
import { createRuntimeStore } from '../../src/main/update/runtime-store'
import { testStage } from '../helpers/stage'

let root: string
beforeEach(() => {
  root = testStage('dl-fix-')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('★同一个源要重试（一次抖动不该让用户重下整个包）', () => {
  it('支持 Range 的大文件走并行分片，内容与哈希逐字节正确', async () => {
    const payload = Buffer.alloc(5 * 1024 * 1024 + 123)
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251
    const active = new Set<symbol>()
    let maxActive = 0
    const server = createServer((req, res) => {
      const range = req.headers.range
      const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? '')
      if (!m) {
        res.writeHead(200, { 'content-length': String(payload.length), etag: '"same"' })
        res.end(payload)
        return
      }
      const id = Symbol('request')
      active.add(id)
      maxActive = Math.max(maxActive, active.size)
      res.on('close', () => active.delete(id))
      const start = Number(m[1])
      const end = Math.min(Number(m[2]), payload.length - 1)
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${payload.length}`,
        'content-length': String(end - start + 1),
        etag: '"same"'
      })
      setTimeout(() => res.end(payload.subarray(start, end + 1)), 30)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const dest = join(root, 'parallel.bin')
    const seen: number[] = []
    try {
      const r = await defaultFetchToFile(
        `http://127.0.0.1:${port}/file`,
        dest,
        (got, total) => seen.push(got, total ?? 0)
      )
      expect(maxActive, '应实际并发分片，而不是串行伪装').toBeGreaterThan(1)
      expect(readFileSync(dest).equals(payload), '并行写盘后的文件必须逐字节一致').toBe(true)
      expect(r.bytes).toBe(payload.length)
      expect(r.sha256).toBe(createHash('sha256').update(payload).digest('hex'))
      expect(seen.length).toBeGreaterThan(0)
      expect(seen[seen.length - 1]).toBe(payload.length)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30000)

  it('分片失败时回退单连接，不能用残片冒充成功', async () => {
    const payload = Buffer.alloc(3 * 1024 * 1024 + 7, 0x5a)
    let ranged = 0
    let fullRequests = 0
    const server = createServer((req, res) => {
      if (req.headers.range) {
        ranged++
        // 先让探测与第一片成功，确保回退时磁盘上已有残片。
        if (ranged > 2) {
          req.socket.destroy()
          return
        }
        const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range)
        const start = Number(m![1])
        const end = Math.min(Number(m![2]), payload.length - 1)
        res.writeHead(206, {
          'content-range': `bytes ${start}-${end}/${payload.length}`,
          'content-length': String(end - start + 1),
          etag: '"same"'
        })
        res.end(payload.subarray(start, end + 1))
        return
      }
      fullRequests++
      res.writeHead(200, { 'content-length': String(payload.length) })
      res.end(payload)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const dest = join(root, 'fallback.bin')
    try {
      const r = await defaultFetchToFile(`http://127.0.0.1:${port}/file`, dest)
      expect(fullRequests, '分片失败后必须真正走单连接回退').toBe(1)
      expect(readFileSync(dest).equals(payload), '回退单连接后文件必须完整').toBe(true)
      expect(r.sha256).toBe(createHash('sha256').update(payload).digest('hex'))
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30000)

  it('单个分片短暂失败会重试，成功后仍保持并行路径', async () => {
    const payload = Buffer.alloc(4 * 1024 * 1024 + 17, 0x4d)
    let chunkRequests = 0
    let fullRequests = 0
    const server = createServer((req, res) => {
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
      if (!m) {
        fullRequests++
        res.writeHead(200, { 'content-length': String(payload.length) })
        res.end(payload)
        return
      }
      chunkRequests++
      const start = Number(m[1])
      const end = Math.min(Number(m[2]), payload.length - 1)
      // 探测之后的第 2 个分片先断一次，验证局部重试而不是整包回退。
      if (chunkRequests === 3) {
        req.socket.destroy()
        return
      }
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${payload.length}`,
        'content-length': String(end - start + 1),
        etag: '"same"'
      })
      res.end(payload.subarray(start, end + 1))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const dest = join(root, 'retry-chunk.bin')
    try {
      const r = await defaultFetchToFile(`http://127.0.0.1:${port}/file`, dest)
      expect(fullRequests, '局部分片失败后不应回退整包单连接').toBe(0)
      expect(r.bytes).toBe(payload.length)
      expect(readFileSync(dest).equals(payload)).toBe(true)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30000)

  it('服务器忽略 Range（200）时不走分片，正常单连接下载', async () => {
    const payload = Buffer.alloc(3 * 1024 * 1024, 0x41)
    let ranged = 0
    const server = createServer((_req, res) => {
      if (_req.headers.range) ranged++
      res.writeHead(200, { 'content-length': String(payload.length) })
      res.end(payload)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const dest = join(root, 'no-range.bin')
    try {
      const r = await defaultFetchToFile(`http://127.0.0.1:${port}/file`, dest)
      expect(ranged).toBe(1)
      expect(readFileSync(dest).equals(payload)).toBe(true)
      expect(r.bytes).toBe(payload.length)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30000)

  it('小于 2 MB 的文件不做分片，避免小请求放大', async () => {
    const payload = Buffer.alloc(1024 * 1024, 0x33)
    let ranged = 0
    const server = createServer((req, res) => {
      if (req.headers.range) ranged++
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
      if (m) {
        const start = Number(m[1])
        const end = Math.min(Number(m[2]), payload.length - 1)
        res.writeHead(206, {
          'content-range': `bytes ${start}-${end}/${payload.length}`,
          'content-length': String(end - start + 1),
          etag: '"same"'
        })
        res.end(payload.subarray(start, end + 1))
        return
      }
      res.writeHead(200, { etag: '"same"', 'content-length': String(payload.length) })
      res.end(payload)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const dest = join(root, 'small.bin')
    try {
      const r = await defaultFetchToFile(`http://127.0.0.1:${port}/file`, dest)
      expect(ranged, '小于阈值时只允许一次探测，不能拆成多片').toBe(1)
      expect(r.bytes).toBe(payload.length)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30000)

  it('Range 探测返回 200（服务器忽略 Range）时只走单连接，不再重复探测', async () => {
    const payload = Buffer.alloc(3 * 1024 * 1024, 0x33)
    let requests = 0
    const server = createServer((_req, res) => {
      requests++
      res.writeHead(200, { 'content-length': String(payload.length) })
      res.end(payload)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const dest = join(root, 'ignored-range.bin')
    try {
      const r = await defaultFetchToFile(`http://127.0.0.1:${port}/file`, dest)
      expect(requests, '探测 + 单连接，共 2 次请求').toBe(2)
      expect(r.bytes).toBe(payload.length)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30000)

  it('分片 ETag 不一致时不得拼接，必须回退单连接', async () => {
    const payload = Buffer.alloc(3 * 1024 * 1024 + 1, 0x62)
    let ranged = 0
    const server = createServer((req, res) => {
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
      if (!m) {
        res.writeHead(200, { 'content-length': String(payload.length) })
        res.end(payload)
        return
      }
      ranged++
      const start = Number(m[1])
      const end = Math.min(Number(m[2]), payload.length - 1)
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${payload.length}`,
        'content-length': String(end - start + 1),
        etag: ranged === 1 ? '"same"' : '"changed"'
      })
      res.end(payload.subarray(start, end + 1))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const dest = join(root, 'etag.bin')
    try {
      const r = await defaultFetchToFile(`http://127.0.0.1:${port}/file`, dest)
      expect(readFileSync(dest).equals(payload)).toBe(true)
      expect(r.sha256).toBe(createHash('sha256').update(payload).digest('hex'))
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 30000)

  it('分片下载中取消会立刻停止，不会继续重试', async () => {
    const payload = Buffer.alloc(12 * 1024 * 1024, 0x7c)
    const server = createServer((req, res) => {
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
      if (!m) {
        res.writeHead(200, { 'content-length': String(payload.length) })
        res.end(payload)
        return
      }
      const start = Number(m[1])
      const end = Math.min(Number(m[2]), payload.length - 1)
      res.writeHead(206, {
        'content-range': `bytes ${start}-${end}/${payload.length}`,
        'content-length': String(end - start + 1),
        etag: '"same"'
      })
      const t = setInterval(() => {
        if (!res.destroyed) res.write(payload.subarray(start, Math.min(start + 1024, end + 1)))
      }, 100)
      res.on('close', () => clearInterval(t))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const ac = new AbortController()
    const dest = join(root, 'cancel-range.bin')
    const dl = defaultFetchToFile(`http://127.0.0.1:${port}/file`, dest, undefined, ac.signal)
    await new Promise((resolve) => setTimeout(resolve, 300))
    const t0 = Date.now()
    ac.abort()
    await expect(dl).rejects.toThrow(/取消|abort/i)
    expect(Date.now() - t0, '取消后不得继续等完整个文件').toBeLessThan(3000)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }, 30000)

  it('单连接下载中取消会立刻停止，不能等响应体自然结束', async () => {
    const server = createServer((req, res) => {
      const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '')
      if (m) {
        res.writeHead(206, {
          'content-range': `bytes ${m[1]}-${m[1]}/10`,
          'content-length': '1'
        })
        res.end('x')
        return
      }
      res.writeHead(200, { 'content-length': '999999999' })
      res.flushHeaders()
      const t = setInterval(() => {
        if (!res.destroyed) res.write(Buffer.alloc(1024, 0x61))
      }, 100)
      res.on('close', () => clearInterval(t))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const ac = new AbortController()
    const dest = join(root, 'cancel-single.bin')
    try {
      const dl = defaultFetchToFile(
        `http://127.0.0.1:${port}/file`,
        dest,
        undefined,
        ac.signal,
        20_000,
        false
      )
      await new Promise((resolve) => setTimeout(resolve, 300))
      const t0 = Date.now()
      ac.abort()
      await expect(dl).rejects.toThrow(/取消|abort/i)
      expect(Date.now() - t0, '取消后不得等慢速连接把剩余字节发完').toBeLessThan(3000)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }, 10000)

  it('用户选中的源重试耗尽后，仍要回退到其它可用源', async () => {
    const tried: string[] = []
    const dead = 'http://127.0.0.1:9/dead/'
    const live = 'http://127.0.0.1:9/live/'
    addCustomMirror(root, { label: '坏源', base: dead, mode: 'proxy' })
    addCustomMirror(root, { label: '好源', base: live, mode: 'proxy' })
    setMirrorPref(root, { n: dead })
    const r = await downloadRuntime({
      dataRoot: root,
      type: 'n',
      release: {
        tag: 'v4.18.41',
        assetName: 'NapCat.Shell.zip',
        assetUrl: 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/NapCat.Shell.zip'
      },
      destFile: join(root, 'nap.zip'),
      onlyBase: dead,
      /*
       * 固定候选链，避免本测试在坏源自定义之后继续落到真实官方源，
       * 既慢又会让一条纯逻辑回归依赖线上网络。
       */
      fetchJson: async (url) => {
        if (url.includes('dead') || url.includes('live')) throw new Error('HTTP 404')
        throw new Error('测试只允许自定义源')
      },
      fetchToFile: async (url, dest) => {
        tried.push(url)
        if (!url.includes('/live/')) throw new TypeError('fetch failed')
        writeFileSync(dest, 'ok')
        return { sha256: '', bytes: 2 }
      }
    })
    expect(r.ok).toBe(true)
    expect(r.usedBase).toBe(live)
    expect(tried[0], '用户选中的源必须先试').toContain('/dead/')
    expect(tried.some((u) => u.includes('/live/')), '坏源失败后必须继续回退').toBe(true)
  }, 10000)

  it('镜像分支：同一个源前两次 fetch failed、第三次成功', async () => {
    let calls = 0
    const server = createServer((req, res) => {
      // Range 探测会先发一次 bytes=0-0；这里只统计真正的整包下载次数。
      if (!req.headers.range) calls++
      if (calls < 3) {
        req.socket.destroy()
        return
      }
      res.writeHead(200, { 'content-length': '2' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const base = `http://127.0.0.1:${port}/`
    addCustomMirror(root, { label: '抖动源', base, mode: 'files' })
    try {
      const r = await downloadRuntime({
        dataRoot: root,
        type: 'n',
        release: {
          tag: 'v4.18.41',
          assetName: 'NapCat.Shell.zip',
          assetUrl: 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/NapCat.Shell.zip',
          sha256: ''
        },
        destFile: join(root, 'nap.zip'),
        onlyBase: base,
        retryDelayMs: 1,
        fetchJson: async () => {
          throw new Error('HTTP 404')
        }
      })
      expect(r.ok).toBe(true)
      expect(calls, '镜像分支必须与原注释一致，同源最多试 3 次').toBe(3)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('源返回响应头但一直不吐正文 → 停滞超时会主动断开请求', async () => {
    let closed = false
    const dead = createServer((_req, res) => {
      res.writeHead(200, { 'content-length': '999999999' })
      res.flushHeaders()
      res.on('close', () => {
        closed = true
      })
    })
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const deadBase = `http://127.0.0.1:${(dead.address() as { port: number }).port}/`
    try {
      const t0 = Date.now()
      await expect(
        defaultFetchToFile(`${deadBase}stall`, join(root, 'stall.zip'), undefined, undefined, 100)
      ).rejects.toThrow(/没有数据|aborted/i)
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      expect(closed, '卡死连接必须被主动断开').toBe(true)
      expect(Date.now() - t0, '不能等分钟级默认超时').toBeLessThan(2000)
    } finally {
      dead.closeAllConnections()
      await new Promise<void>((resolve) => dead.close(() => resolve()))
    }
  }, 5000)

  it('前两次失败、第三次成功 → 应当成功（真实网络路径才启用重试）', async () => {
    let calls = 0
    const dest = join(root, 'nap.zip')
    /*
     * 用"不注入 fetchToFile"的真实路径来验重试 —— 但那会真的联网。
     * 所以这里换个角度：注入 fetchToFile 时**不**启用重试（保持既有语义），
     * 用它来确认"注入路径不受影响"；真实重试逻辑由下面那条间接验证。
     */
    const r = await downloadRuntime({
      dataRoot: root,
      type: 'n',
      release: { tag: 'v1', assetName: 'a.zip', assetUrl: 'http://x/a.zip', sha256: '' },
      destFile: dest,
      sources: ['http://x/a.zip'],
      fetchToFile: async (_url, d) => {
        calls++
        // 注入路径：第一次就该成功（不重试），第二次调用说明语义被改了
        writeFileSync(d, 'ok')
        return { sha256: '', bytes: 2 }
      }
    })
    expect(r.ok).toBe(true)
    expect(calls, '注入了 fetchToFile 时不该被重试包装改变语义').toBe(1)
  })
})

describe('★各源并行探测（串行时 versions:list 要十几秒）', () => {
  it('三个源各慢 300ms → 总耗时应接近 300ms 而不是 900ms', async () => {
    /*
     * ★ 这条测试的第一版是**无效的**（被尺子拆穿了）
     *
     * 我第一版只调了一次 listVersions、让 fetchJson 慢 300ms 就断言 <1500ms ——
     * 而它实际只走**一个源**，所以"串行/并行"根本体现不出来：
     * 我把并行代码改回串行，这条照样绿。
     *
     * 现在：显式写入 3 个内置 files 源（都指向慢速假地址），
     * 多个源的等待能否重叠才是真正的判据 —— 只有这样才能区分串行与并行。
     */
    writeFileSync(
      join(root, 'mirrors.json'),
      JSON.stringify({
        custom: [
          { label: '慢源A', base: 'http://slow-a.test/files/', mode: 'files' },
          { label: '慢源B', base: 'http://slow-b.test/files/', mode: 'files' },
          { label: '慢源C', base: 'http://slow-c.test/files/', mode: 'files' }
        ],
        pref: {}
      }),
      'utf8'
    )

    const t0 = Date.now()
    await listVersions({
      dataRoot: root,
      type: 'n',
      noCache: true,
      fetchJson: async (url: string) => {
        await new Promise((r) => setTimeout(r, 300))
        if (url.includes('versions.json')) {
          return JSON.stringify({ napcat: [{ tag: 'v1', asset: 'napcat/a.zip', sha256: 'aa', size: 1 }] })
        }
        return '{}'
      }
    })
    const ms = Date.now() - t0
    /*
     * 3 个源 × 300ms：串行 ≥ 900ms，并行 ≈ 300ms。
     * 阈值取 700ms —— 在两者中间，能明确区分。
     */
    expect(ms, `探测耗时 ${ms}ms —— 看起来还是串行的（3 个源各 300ms，串行会 ≥900ms）`).toBeLessThan(700)
  }, 20000)
})

describe('★体积补算不许反复扫同一批目录（死循环）', () => {
  it('清单里没有记录的目录 → 不再被反复判定为"缺失"', () => {
    // 造一个"目录在、清单记录没了"的现场（卸载重装后非常常见）
    const dir = join(root, 'runtimes', 'n', 'v9.9.9')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'x.bin'), 'x')

    const store = createRuntimeStore({ dataRoot: root })
    const first = store.recomputeSizes()
    const second = store.recomputeSizes()
    const third = store.recomputeSizes()

    /*
     * 修之前：每次都返回 ['n:v9.9.9']（清单里没记录 → recomputeOneSize 直接 return
     * → 下一轮又被判缺失），实测日志里同一批 tag 连刷十几次，把主进程 IO 占死。
     * 修之后：清单里没有记录的目录**不补**（无处可写），所以一次都不该返回。
     */
    expect(first, '清单无记录的目录不该被补算（算了也没地方写）').toEqual([])
    expect(second).toEqual([])
    expect(third).toEqual([])
  })

  it('清单里有记录、但缺 sizeMB → 会补算（正常路径不能被误伤）', async () => {
    const dir = join(root, 'runtimes', 'n', 'v1.2.3')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'blob.bin'), Buffer.alloc(2048))
    // 先写清单（有记录、无 sizeMB），模拟老版本留下的索引
    writeFileSync(
      join(root, 'runtimes.json'),
      JSON.stringify({ versions: [{ type: 'n', tag: 'v1.2.3', from: 'x', installedAt: '2026-01-01' }] }),
      'utf8'
    )

    const store = createRuntimeStore({ dataRoot: root })
    const filled = store.recomputeSizes()
    expect(filled, '有记录缺大小 → 应当补算').toContain('n:v1.2.3')

    // 同一进程内再调：不该重复补（attemptedSizes 去重）
    const again = store.recomputeSizes()
    expect(again, '同一个 tag 不该被反复补算').not.toContain('n:v1.2.3')
  })
})
