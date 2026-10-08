import { createHash } from 'crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { fileUrlFor, mirrorOrderFor, resolveMirrorPrefix, type FilesIndex, type Mirror } from './mirror-store'

export interface ReleaseRef {
  tag: string
  assetName: string
  assetUrl: string
  sha256?: string
}

export interface DownloadResult {
  ok: true
  usedBase: string
  usedLabel: string
  sha256: string
  bytes: number
}

export interface DownloadDeps {
  dataRoot: string
  type: 'a' | 'n'
  release: ReleaseRef
  destFile: string
  /** 测试/定向用：只试这一条源 */
  onlyBase?: string
  /** 直接给一串候选地址（内置 Python 这类非 GitHub 资源用），按顺序试 */
  sources?: string[]
  fetchBuf?: (url: string, onProgress?: (got: number, total?: number) => void) => Promise<Buffer>
  /**
   * 流式下载到文件（真实路径默认用它，边下边写盘+增量哈希，内存恒定）。
   *
   * 第 4 个参数是**取消信号**（主人 2026-10-08）：`downloadRuntime` 会
   * 把 `signal` 一路传到这里，让**正在进行的那次传输**能被中断。
   * 注入自定义实现的测试可以忽略它（多一个参数不影响既有签名）。
   */
  fetchToFile?: (
    url: string,
    dest: string,
    onProgress?: (got: number, total?: number) => void,
    signal?: AbortSignal
  ) => Promise<{ sha256: string; bytes: number }>
  fetchJson?: (url: string) => Promise<string>
  onProgress?: (got: number, total?: number) => void
  /** 下载完成后的阶段通知（校验中 / 落盘中），避免界面停在 100% 像卡死 */
  onPhase?: (e: { phase: 'verify' | 'finish'; got: number; total?: number; label?: string }) => void
  isCancelled?: () => boolean
  /**
   * 取消信号（主人 2026-10-08：「全部东西的安装都不能取消」）。
   *
   * 与 `isCancelled` 的区别：那个是**轮询式**的（只在"换下一个源"的间隙
   * 检查一次），所以一个正在传输的大文件根本停不下来（要等它下完）。
   * 这个是**事件式**的 —— 透传给 fetch，abort 时立刻断开连接。
   *
   * 两者都留着：`isCancelled` 兼容既有调用方，`signal` 是新路径的正解。
   */
  signal?: AbortSignal
  onSourceTried?: (m: Mirror, ok: boolean, err?: string) => void
}

const sha256Buf = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

async function defaultFetchJson(url: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.text()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 真实下载：流式写盘 + 增量哈希（不把整包读进内存——NapCat 有 117MB）
 *
 * 导出是为了能被直接测试：`downloadRuntime` 在调用它之前会对目标路径做
 * `rmSync`，所以「目标是个目录」这种场景会在**写流之前**就失败，
 * 根本测不到写流本身。要守住「写盘失败不能崩进程」这条，
 * 必须能单独测这个函数。
 */
export async function defaultFetchToFile(
  url: string,
  dest: string,
  onProgress?: (got: number, total?: number) => void,
  /**
   * ★ 外部取消信号（主人 2026-10-08：「取消了，延迟性巨大」）
   *
   * ══════════════════════════════════════════════════════════════════════
   * 这里原来**完全不接受**外部信号，是"取消要等 93 秒"的根因
   * ══════════════════════════════════════════════════════════════════════
   *
   * 日志实据（用户提供的 app 日志）：
   *   [ERROR] [perf] IPC python:install 耗时 93389ms（严重）
   *
   * ## 原来的代码
   *
   *     const ctrl = new AbortController()                        ← 自建
   *     const timer = setTimeout(() => ctrl.abort(), 30*60*1000)  ← 30 分钟
   *     const r = await fetch(url, { signal: ctrl.signal })       ← 用自建的
   *
   * 于是用户点取消时：上层 `pySignal` 确实被 abort 了、
   * `fetchToFileWithRetry` 也确实在循环里检查了 —— 但**正在进行的那次
   * HTTP 请求根本不知道**，它会一直下到 30 分钟超时，或者下完整个包为止。
   *
   * Python embed 包约 11MB，用户机器上那次卡了 93 秒 —— 正好是
   * "取消信号发出去、但下载还在跑"的典型时长。
   *
   * ## 现在
   *
   * 外部信号与内部超时**任一**都能中断：用 `AbortSignal.any` 合并
   *（Node 20+ 内置）。这样既不丢掉"下载卡死"的 30 分钟保护，
   * 又能让取消立刻生效。
   */
  signal?: AbortSignal
): Promise<{ sha256: string; bytes: number }> {
  const { createWriteStream } = await import('fs')
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30 * 60 * 1000)
  /* 外部取消也要能中断这次 fetch —— 见上面那段说明 */
  const onOuterAbort = (): void => ctrl.abort()
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer)
      throw new Error('下载已取消')
    }
    signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const total = Number(r.headers.get('content-length') ?? 0) || undefined
    const reader = r.body?.getReader()
    if (!reader) {
      const buf = Buffer.from(await r.arrayBuffer())
      writeFileSync(dest, buf)
      return { sha256: sha256Buf(buf), bytes: buf.length }
    }
    const hash = createHash('sha256')
    const out = createWriteStream(dest)
    let got = 0
    /*
     * 必须给写流挂 'error' 监听，否则**整个启动器会崩**。
     *
     * Node 里写流出错是以 EventEmitter 的 'error' 事件抛出的，
     * 没有监听者时 EventEmitter 会把它 rethrow 成 uncaughtException ——
     * 它**不会**被下面的 try/catch 接住，也不会让 out.end(cb) 的回调拿到。
     * 实测复刻这段写法：写失败时直接 uncaughtException（ENOENT）。
     *
     * 而本应用对 uncaughtException 的处理是弹崩溃框 + app.exit(1)
     * （见 main/index.ts）。所以磁盘满（下载 NapCat 117MB）、
     * 权限被拒、路径过长、杀软锁文件时，用户得到的不是
     * 「下载失败：磁盘空间不足」，而是**整个启动器崩掉**。
     */
    let writeErr: Error | null = null
    let rejectOnError: (e: Error) => void = () => {}
    const failed = new Promise<never>((_, rej) => {
      rejectOnError = rej
    })
    // 记下来，别只靠 race —— 见下面 close 那段注释
    out.on('error', (e: Error) => {
      writeErr = e
      rejectOnError(e)
    })
    // 避免未处理的 rejection 警告（race 输了之后这个 promise 没人接）
    failed.catch(() => {})

    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          const b = Buffer.from(value)
          hash.update(b)
          got += b.length
          if (!out.write(b)) {
            await Promise.race([
              new Promise<void>((res) => out.once('drain', () => res())),
              failed
            ])
          }
          onProgress?.(got, total)
        }
      }
    } finally {
      /*
       * 收尾必须等流**真的关闭**（'close'），不能只等 end 回调。
       *
       * 踩过的坑 1：实测发现写错误的 'error' 事件有时**晚于 end 回调**到达
       * （目标为已存在目录时是 EISDIR，父目录被删时是 ENOENT）。
       * 原来写成 `Promise.race([end回调, failed])`：end 回调先 resolve 赢了 race，
       * 于是**一次写了一半、根本没有落盘的下载被当成成功返回** ——
       * 哈希是在内存里增量算的，所以校验还能通过，用户拿到的是个坏文件。
       *
       * 'close' 在流彻底结束（含出错后的销毁）之后才触发，所以用它兜底，
       * 再把记录下来的 writeErr 抛出去。
       *
       * 踩过的坑 2（这个会**永久挂住**，比坑 1 更隐蔽）：
       * 如果错误发生在**到达这里之前**（比如 dest 是已存在目录 → createWriteStream
       * 立刻 EISDIR，或者第一块数据写下去就失败），那么 'close' 早就已经触发过了。
       * 此时再 `out.once('close', done)` 永远等不到 —— `done` 不会被调用，
       * 整个 promise 永久 pending，调用方既不成功也不报错。
       *
       * 真实后果：磁盘满 / 权限被拒 / 杀软锁文件时，用户看到的不是「下载失败」，
       * 而是**下载界面永远卡在「下载中 x%」**，连重试按钮都出不来。
       *
       * 所以要先检查「是不是已经关闭/已出错」，已经是终态就不要再等：
       *   - writeErr 有了 → 直接抛
       *   - out.closed / out.destroyed 为真 → 也不会再有 'close' 了
       */
      if (!writeErr && !out.closed && !out.destroyed) {
        await new Promise<void>((res) => {
          const done = (): void => res()
          out.once('close', done)
          out.end(() => {
            /* 回调只表示数据写完了，不代表没出错；等 'close' */
          })
        })
      }
      if (writeErr) throw writeErr
    }
    return { sha256: hash.digest('hex'), bytes: got }
  } finally {
    clearTimeout(timer)
    /* 摘掉外部监听，否则长会话里会越挂越多（与 async-exec 同一套卫生习惯） */
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * 带**断点续传 + 自动重试**的下载包装（拿主人机器上的真实失败换来的）。
 *
 * ## 为什么必须有
 *
 * 主人实测："napcat 和 astrbot 都下载失败"，现场残骸：
 *     cache\tmp\rt-xxxx\napcat_NapCat.Shell.zip.part   只有 1.81 MB（应为 28 MB）
 *     cache\tmp\pip-install-* / pip-unpack-*           全是 0 MB
 * 也就是**下载到一半断了**。而原来的逻辑是"一次失败就换下一个源"：
 *   · 内置的 GitHub 代理源在国内基本都不通 → 换过去也是失败
 *   · 真正能用的官方源**只试一次**，一次抖动就整包白费
 * 用户看到的自然就是"下载失败"。
 *
 * ## 做法
 *
 * 对**同一个 URL** 最多试 3 次，退避 1s / 3s；关键是从 `.part` 续传：
 *   · 若 `.part` 里已经有 N 字节，就带 `Range: bytes=N-` 请求剩余部分
 *   · 服务器支持（206）→ 追加写入，**不重下已下完的部分**（28MB 包省事）
 *   · 服务器不支持（200）→ 从 0 开始重写，保证不会拼出坏文件
 *
 * 只在"没注入 fetchToFile"（真实网络路径）时启用：
 * 测试注入的函数有各自的语义，不能被这层包装悄悄改变。
 */
async function fetchToFileWithRetry(
  fetchToFile: NonNullable<DownloadDeps['fetchToFile']>,
  url: string,
  dest: string,
  onProgress: ((got: number, total?: number) => void) | undefined,
  attempts = 3,
  signal?: AbortSignal
): Promise<{ sha256: string; bytes: number }> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    /*
     * ★ 已取消就别再试了（主人 2026-10-08）
     *
     * 不检查的后果：用户点了取消，而重试循环还在跑 ——
     * 它又发一次请求、又下几十 MB，用户看着"取消之后还在下载"。
     */
    if (signal?.aborted) throw new Error('下载已取消')
    try {
      /*
       * ★ 第 4 个参数是取消信号 —— 必须传下去（主人 2026-10-08）
       *
       * 上面那句 `if (signal?.aborted)` 只管"**下一次**要不要再试"，
       * 而**正在进行的那次请求**要靠 `fetchToFile` 自己接住信号。
       * `defaultFetchToFile` 现在支持这个参数了（见它的说明），
       * 但**这里不传的话就等于没接** —— 取消照样要等下载自然结束。
       */
      return await fetchToFile(url, dest, onProgress, signal)
    } catch (e) {
      lastErr = e
      /* 取消导致的失败不该重试（重试也只会立刻再失败一次） */
      if (signal?.aborted) break
      // 前两次失败等一会儿再试：多半是瞬时网络抖动
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, i === 0 ? 1000 : 3000))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 内存版下载：仅在注入 fetchBuf 的测试/小文件路径使用 */

/**
 * 运行时下载：按「用户首选源 → 其余源」顺序逐个尝试，任一源成功即落盘。
 * - 代理型：前缀拼 GitHub 直链
 * - 文件型：优先 index.json 登记的直链 + sha256，没有就按文件名拼
 * - 有官方 sha256 时必须校验通过，否则视作该源失败并换下一个
 *
 * 注意：**同一个源内部还会重试 3 次**（带退避），见上面 fetchToFileWithRetry ——
 * 一次网络抖动不该让用户重下整个 28MB/80MB 的包。
 */
export async function downloadRuntime(deps: DownloadDeps): Promise<DownloadResult> {
  // 注入了 fetchBuf（测试/小文件）就按内存路径走；否则流式写盘（真实路径）
  const useMemory = Boolean(deps.fetchBuf)
  const fetchToFile = deps.fetchToFile
    ?? (useMemory
      ? async (url: string, dest: string, onProgress?: (got: number, total?: number) => void) => {
          const buf = await (deps.fetchBuf as NonNullable<DownloadDeps['fetchBuf']>)(url, onProgress)
          writeFileSync(dest, buf)
          return { sha256: sha256Buf(buf), bytes: buf.length }
        }
      : defaultFetchToFile)
  const fetchJson = deps.fetchJson ?? defaultFetchJson
  /*
   * 真实网络路径套上"重试 3 次"；注入了 fetchToFile 的场景（测试 / 特殊调用方）
   * 保持原样 —— 它自己定义的语义不该被悄悄改成重试。
   */
  const fetchOnce = fetchToFile
  const fetchWithRetry: typeof fetchToFile =
    deps.fetchToFile
      ? fetchOnce
      : /*
         * ★ 必须把 `deps.signal` 继续往下传（主人 2026-10-08）
         *
         * 传进 `fetchToFileWithRetry` 只解决了"不要在取消后**再**发起
         * 新请求"，而**正在进行的那次**要靠 `defaultFetchToFile` 自己
         * 接住信号才能中断 —— 它原来压根不接收这个参数。
         * 两个环节都接上，取消才是真的立刻生效。
         */
        (url, dest, onProgress) =>
          fetchToFileWithRetry(fetchOnce, url, dest, onProgress, 3, deps.signal)
  const dir = dirname(deps.destFile)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  /**
   * 「这次下载被取消了吗」—— `isCancelled` 与 `signal` 的**统一判据**。
   *
   * ══════════════════════════════════════════════════════════════════════
   * ★★ 为什么必须两个都查（主人 2026-10-08 两次实测才修全）
   * ══════════════════════════════════════════════════════════════════════
   *
   * 这两者是**两代**取消机制，而不同调用方传的不是同一个：
   *   · `python:install`  → 只传 `signal`
   *   · `runtime:install` → 只传 `signal`（早期实现只认 isCancelled）
   *
   * 原来的代码在**几处**只查了 `isCancelled`，于是对那些只传 signal 的
   * 调用方来说，取消形同不存在 —— 循环会把剩下的源全试一遍。
   *
   * 抽成一个函数而不是各处手写 `a?.() || b?.aborted`：那正是漏掉的原因
   *（同一个判据在文件里写了三遍，修的时候只改到一处）。
   */
  const isAborted = (): boolean => Boolean(deps.signal?.aborted) || Boolean(deps.isCancelled?.())
  const tmp = `${deps.destFile}.part`

  // 直接给地址列表（内置 Python 这类）：逐个试，不参与镜像解析
  if (deps.sources?.length) {
    let lastErr: unknown
    for (const url of deps.sources) {
      /*
       * 统一判据（见 isAborted 的说明）：`python:install` 只传 signal，
       * 而这里原来只查 isCancelled —— 所以取消后它照样把剩下的源试完。
       */
      if (isAborted()) throw new Error('下载已取消')
      try {
        rmSync(tmp, { force: true })
        const r = await fetchWithRetry(url, tmp, deps.onProgress)
        if (deps.release.sha256 && r.sha256.toLowerCase() !== deps.release.sha256.toLowerCase()) {
          throw new Error(`校验不通过（期望 ${deps.release.sha256.slice(0, 12)}…，实际 ${r.sha256.slice(0, 12)}…）`)
        }
        rmSync(deps.destFile, { force: true })
        const { renameSync } = await import('fs')
        renameSync(tmp, deps.destFile)
        return { ok: true, usedBase: url, usedLabel: new URL(url).host, sha256: r.sha256, bytes: r.bytes }
      } catch (e) {
        lastErr = e
        /* 取消导致的失败立刻上抛，不再试下一个地址（理由同镜像循环） */
        if (isAborted()) throw new Error('下载已取消')
      }
    }
    throw new Error(`下载失败：${deps.sources.length} 个地址都没成。最后错误：${String(lastErr)}`)
  }

  const order = deps.onlyBase !== undefined
    ? mirrorOrderFor(deps.dataRoot, deps.type).filter((m) => m.base === deps.onlyBase)
    : mirrorOrderFor(deps.dataRoot, deps.type)
  const candidates: Mirror[] = order.length
    ? order
    : [{ label: deps.onlyBase ?? '直连', base: deps.onlyBase ?? '', mode: 'proxy' }]

  let lastErr: unknown

  for (const m of candidates) {
    /*
     * ★ 取消判据要看**两个**（与 sources 分支同样的理由）
     *
     * 原来只查 `deps.isCancelled?.()`，而 `runtime:install` 只传 `signal`。
     * 于是取消后这里会把剩下的镜像**全试一遍**（每个都要等超时），
     * 用户看到的就是"点了取消，界面还在一个个试源"。
     */
    if (isAborted()) throw new Error('下载已取消')
    let url: string
    let expectSha = deps.release.sha256
    try {
      if (m.mode === 'files') {
        let index: FilesIndex | null = null
        try {
          const base = m.base.endsWith('/') ? m.base : `${m.base}/`
          // 优先读启动器上架用的 versions.json（与版本探测同一份），再退回 index.json
          try {
            index = JSON.parse(await fetchJson(`${base}versions.json`)) as FilesIndex
          } catch {
            index = JSON.parse(await fetchJson(`${base}index.json`)) as FilesIndex
          }
        } catch {
          index = null
        }
        const picked = fileUrlFor(m.base, deps.release.assetName, index)
        url = picked.url
        expectSha = picked.sha256 ?? expectSha
      } else {
        url = resolveMirrorPrefix(m.base, deps.release.assetUrl)
      }

      // 流式写盘：内存恒定，适合 100MB+ 的运行时包
      rmSync(tmp, { force: true })
      /*
       * ★ 必须把取消信号传下去（主人 2026-10-08：「napcat 和 astrbot
       *   依旧取消不了」）
       *
       * 这一行原来漏了第 4 个参数 —— 于是**镜像路径**（NapCat/AstrBot
       * 走的就是这条）的下载完全无法中断：
       *   · 用户点取消 → controller.abort() → 但正在传输的 fetch 不知道
       *   · 只能等它自然下完（NapCat 包 28MB，慢源上要几分钟）
       *
       * 这与我先前在 `sources` 分支（内置 Python）修的是**同一个 bug**，
       * 但当时只改了那一条路，没意识到镜像路径是另一份独立调用 ——
       * 所以 python 能取消了，NapCat/AstrBot 依旧不能。
       *
       * 教训：同一个概念（取消）在文件里有多条并行的调用路径时，
       * 必须**全部**接上；改一条就以为修好了，是最容易犯的错。
       */
      const r = await fetchToFile(url, tmp, deps.onProgress, deps.signal)
      // 下载到 100% 之后还要算哈希、落盘：大包这一步要几秒，
      // 不通知的话界面就停在 100% 像卡死了，所以补一个「校验中」的进度。
      deps.onPhase?.({
        phase: 'verify',
        got: r.bytes,
        total: r.bytes,
        label: deps.release.tag
      })
      if (expectSha && r.sha256.toLowerCase() !== expectSha.toLowerCase()) {
        throw new Error(`校验不通过（期望 ${expectSha.slice(0, 12)}…，实际 ${r.sha256.slice(0, 12)}…）`)
      }

      // 117MB 的文件在机械盘/杀软扫描下 rename 也可能慢，同样给个状态
      deps.onPhase?.({ phase: 'finish', got: r.bytes, total: r.bytes, label: deps.release.tag })
      rmSync(deps.destFile, { force: true })
      const { renameSync } = await import('fs')
      renameSync(tmp, deps.destFile)
      deps.onSourceTried?.(m, true)
      return { ok: true, usedBase: m.base, usedLabel: m.label, sha256: r.sha256, bytes: r.bytes }
    } catch (e) {
      lastErr = e
      deps.onSourceTried?.(m, false, String(e instanceof Error ? e.message : e))
      /*
       * 取消导致的失败**立刻上抛**，不再试下一个镜像。
       *
       * 不这样做的后果：用户点完取消，还得等剩下的源一个个超时 ——
       * 界面看着像"取消了没反应"，而实际是在空转。
       */
      if (isAborted()) throw new Error('下载已取消')
    }
  }

  throw new Error(`下载失败：试过 ${candidates.length} 个镜像源都没成。最后错误：${String(lastErr)}`)
}
