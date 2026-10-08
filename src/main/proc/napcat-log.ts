import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

/**
 * NapCat 运行日志的收集。
 *
 * 为什么不能用「读子进程 stdout」那一套：
 * NapCat 是被**注入进 QQ 进程**跑的（NapCatWinBootMain.exe 把 napcat.mjs 挂进 QQ）。
 * 我们 spawn 的那个注入器进程本身没什么输出，真正的 NapCat 运行时活在 QQ 进程里，
 * 它的 stdout 属于 QQ，根本不经过我们的管道。
 * 实机证据（我们收到的全部内容就这么几行）：
 *   [02:05:01.836][out] Administrator mode detected.
 *   [02:06:19.657][err] ^C
 * 后面的版本号、WebUI Token、二维码、登录结果一个都没有 —— 全在 QQ 那边丢掉了。
 *
 * 所以改走 NapCat 自己的 WebUI 日志接口（从 napcat.mjs 的路由表里确认存在）：
 *   GET /GetLogList       列出可读的日志文件
 *   GET /GetLog?file=...  读某个文件
 *   GET /GetLogRealTime   实时日志（轮询增量）
 * 鉴权用 Authorization: Bearer <token>（我们固定注入 114514）。
 *
 * 另一个实机踩到的坑：**编码**。
 * 日志里出现过 `锟斤拷止锟斤拷锟斤拷锟斤拷(Y/N)?` —— 这是 NapCatWinBootMain.exe
 * 在中文 Windows（代码页 936）上输出 GBK，而我们按 UTF-8 解码的典型乱码。
 * 所以下面的解码会先按 UTF-8 试，发现替换字符就回退到 GBK。
 */

export interface NapcatLogDeps {
  /** 实例端口（NapCat 的 WebUI 就监听它） */
  port: number
  /** WebUI Token（我们固定注入的那个） */
  token: string
  /** 取 URL，返回状态和原始字节（要自己解编码，所以不能只要 text） */
  fetchBytes?: (url: string, headers: Record<string, string>) => Promise<{ status: number; body: Buffer }>
  timeoutMs?: number
}

/**
 * 按「先 UTF-8、不行再 GBK」解字节。
 *
 * 判据是 UTF-8 解码后有没有出现 U+FFFD（替换字符）——有就说明不是合法 UTF-8，
 * 大概率是中文 Windows 上的 GBK 输出。这不是猜：实机日志里的
 * 「锟斤拷」正是 GBK 字节被当 UTF-8 解的产物。
 */
export function decodeSmart(buf: Buffer): string {
  const asUtf8 = buf.toString('utf8')
  if (!asUtf8.includes('\uFFFD')) return asUtf8
  try {
    // Node 内置支持 gbk 解码（iconv 在 full-icu 构建里可用）
    return new TextDecoder('gbk').decode(buf)
  } catch {
    // 环境不支持 gbk 就退回 UTF-8 结果，至少别丢内容
    return asUtf8
  }
}

/** 调 WebUI 接口，带上 token */
async function call(
  deps: NapcatLogDeps,
  path: string,
  init: { method: 'GET' | 'POST'; body?: string } = { method: 'GET' }
): Promise<unknown> {
  const base = `http://127.0.0.1:${deps.port}`
  const url = `${base}${path}`
  const headers: Record<string, string> = {
    Authorization: `Bearer ${deps.token}`,
    'Content-Type': 'application/json'
  }
  const fetchBytes =
    deps.fetchBytes ??
    (async (u: string, h: Record<string, string>) => {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), deps.timeoutMs ?? 5000)
      try {
        const r = await fetch(u, { method: init.method, headers: h, body: init.body, signal: ctrl.signal })
        return { status: r.status, body: Buffer.from(await r.arrayBuffer()) }
      } finally {
        clearTimeout(t)
      }
    })

  const r = await fetchBytes(url, headers)
  if (r.status >= 400) throw new Error(`${path} 返回 HTTP ${r.status}`)
  const text = decodeSmart(r.body)
  try {
    return JSON.parse(text)
  } catch {
    // 有的接口直接返回纯文本日志
    return text
  }
}

/** 从 WebUI 响应里把日志文本挖出来（不同接口包装不一样） */
function pickText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['data', 'text', 'log', 'content', 'message']) {
      const inner = o[k]
      if (typeof inner === 'string') return inner
      // { data: { text } } 这种再挖一层
      if (inner && typeof inner === 'object') {
        const t = pickText(inner)
        if (t) return t
      }
    }
  }
  return ''
}

export interface NapcatLogCollector {
  /** 把当前日志（增量）追加到目标文件；返回写入的字符数 */
  flush: () => Promise<number>
  /** 停止轮询 */
  stop: () => void
}

/**
 * 起一个轮询器：定期把 NapCat 的实时日志追加到我们的实例日志文件。
 *
 * 为什么用轮询而不是一次读完：NapCat 的日志是持续增长的，
 * 用户要的是「跟着看」；一次性读完只能拿到启动那一刻的。
 *
 * intervalMs 默认 3 秒：够及时，又不会把 WebUI 打得太频繁
 * （它和用户自己开的面板共用同一个服务）。
 */
export function createNapcatLogCollector(deps: NapcatLogDeps & {
  logFile: string
  intervalMs?: number
  /** 测试注入定时器 */
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (h: unknown) => void
}): NapcatLogCollector {
  let last = ''
  let stopped = false
  let timer: unknown

  const flush = async (): Promise<number> => {
    if (stopped) return 0
    let text = ''
    try {
      text = pickText(await call(deps, '/GetLogRealTime'))
      if (!text) text = pickText(await call(deps, '/GetLog'))
    } catch {
      // WebUI 还没起来 / 服务没就绪：下一轮再试，不报错打扰用户
      return 0
    }
    if (!text) return 0

    /*
     * 增量：新内容通常是在旧内容后面追加。
     * 但如果 NapCat 轮转了日志，新内容可能和旧的不再有前缀关系 ——
     * 那时就把整段当新内容写进去（宁可重复也不能丢）。
     */
    let delta = ''
    if (text.startsWith(last)) {
      delta = text.slice(last.length)
    } else if (text !== last) {
      delta = text
    }
    last = text
    if (!delta.trim()) return 0

    try {
      mkdirSync(dirname(deps.logFile), { recursive: true })
      const stamp = new Date().toISOString().slice(11, 19)
      appendFileSync(
        deps.logFile,
        delta
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .map((l) => `[${stamp}][napcat] ${l}\n`)
          .join(''),
        'utf8'
      )
      return delta.length
    } catch {
      return 0
    }
  }

  const setI = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const clearI = deps.clearInterval ?? ((h) => clearInterval(h as NodeJS.Timeout))
  timer = setI(() => void flush(), deps.intervalMs ?? 3000)

  return {
    flush,
    stop: () => {
      stopped = true
      if (timer !== undefined) clearI(timer)
      timer = undefined
    }
  }
}
