/*
 * 读实例日志文件 —— **只读需要的那部分，绝不整个读进来**。
 *
 * ============================================================================
 * 为什么需要这个（真实卡顿来源）
 * ============================================================================
 *
 * 实例日志是**追加写、永不截断**的：NapCat 的 stdout、AstrBot 的运行日志
 * 会一直往 `<dataRoot>\logs\instances\<id>.log` 里堆。一个跑了几天的实例
 * 轻松上到几十上百 MB。
 *
 * 而「看日志」（`instance:log`）原来是这样读的：
 *
 *     const raw = readFileSync(f, 'utf8')       // ← 整个文件进内存
 *     return raw.split('\n').slice(-500)        // ← 只为了最后 500 行
 *
 * 读 300MB 只为拿最后 500 行，而且是在**主进程**里同步读 ——
 * 所有 IPC 都得排队，界面表现为「点一下看日志，整个软件卡住好几秒」。
 *
 * 同一个仓库里 `creds/creds.ts` 早就写对了（大文件只读头 512KB + 尾 256KB），
 * 只是 `instance:log` 没有复用它。这里把那套做法提出来共用。
 *
 * ============================================================================
 * 「只看本次运行的日志」—— 判据是**启动时记下的字节偏移**
 * ============================================================================
 *
 * 主人 2026-09-27 的两点要求：
 *   「翻翻日志功能改成只显示实例这次运行的日志」
 *   「为啥不是通过实例启动来判定」
 *
 * ## 走弯路的过程（写下来免得再犯）
 *
 *   ① 第一版：往日志里写我们自己的分隔线 `========== 启动于 … ==========`
 *      → 主人否了：「不需要分割线，只需要只显示这次运行的日志」——
 *        那行混在正文里对读日志的人是噪音（贴给别人看时更没有意义）
 *   ② 第二版：找 AstrBot 自己打印的 `Welcome to AstrBot CLI!`
 *      → **仍在猜文本**：换程序、改文案、用户手改日志，判据就失效
 *   ③ 现在（主人指的路）：**按实例启动来判定**
 *
 * ## 为什么偏移是对的判据
 *
 * 启动是我们发起的 —— 那一刻日志文件有多长，我们**完全知道**。
 * `instance:start` 成功后会把这个长度记进实例记录（`lastLogOffset`），
 * 读日志时从那之后开始。不猜、不解析、不受时区/格式影响。
 *
 * 历史日志**照旧留在文件里**（"上次为什么崩"是最值钱的信息），
 * 只是界面默认不再显示它。
 */
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from 'fs'
import { join } from 'path'

/** 读头部多少字节（覆盖「首次启动」那段关键信息） */
const HEAD_BYTES = 512 * 1024
/** 读尾部多少字节（覆盖「刚刚发生了什么」） */
const TAIL_BYTES = 256 * 1024

export interface LogSnippet {
  /** 日志文本（大文件时是「头 + 尾」，中间缺失） */
  text: string
  /** 是否因为文件太大而只取了头尾（中间有缺口） */
  truncated: boolean
  /** 文件总字节数（不存在时 0） */
  size: number
}

/**
 * 读一个日志文件的关键部分。
 *
 * 不抛异常：读不到就返回空（调用方按「没有日志」处理即可）。
 * 日志读失败不该让「看日志」这个功能整个报错 ——
 * 那才是最需要日志的时刻。
 */
export function readLogSnippet(file: string): LogSnippet {
  try {
    if (!existsSync(file)) return { text: '', truncated: false, size: 0 }
    const size = statSync(file).size
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      return { text: readFileSync(file, 'utf8'), truncated: false, size }
    }

    const fd = openSync(file, 'r')
    try {
      const head = Buffer.alloc(HEAD_BYTES)
      const tail = Buffer.alloc(TAIL_BYTES)
      const nHead = readSync(fd, head, 0, HEAD_BYTES, 0)
      const nTail = readSync(fd, tail, 0, TAIL_BYTES, size - TAIL_BYTES)
      const text =
        head.subarray(0, nHead).toString('utf8') + tail.subarray(0, nTail).toString('utf8')
      return { text, truncated: true, size }
    } finally {
      closeSync(fd)
    }
  } catch {
    return { text: '', truncated: false, size: 0 }
  }
}

/**
 * 某个实例的日志文件路径（一处定义，免得各处自己拼）。
 *
 * ## 为什么在这里也做一次形状校验
 *
 * 实例 ID 的正常形状是 `<a|n>_<10位十六进制>`（见 instance-repo.ts，
 * `${INSTANCE_DIR_PREFIX[p.type]}${randomBytes(5).toString('hex')}`）。
 *
 * 调用方目前都先 `repo.get(id)` 查过记录才拼路径，所以脏 ID 进不来。
 * 但这是**调用方**的性质，不是这个函数的性质 —— 它是个导出的公开函数，
 * 将来任何一个"顺手拼一下日志路径"的地方都可能忘了前置查询。
 * 而拼错路径的后果是可读任意文件（`readLogSnippet` 会去 open 它），
 * 在管理员权限进程里不值得赌。
 *
 * 校验失败**不抛错**，返回一个不可能存在的路径：这个函数是纯路径拼接，
 * 调用方（看日志）在文件不存在时本来就按"没有日志"处理，
 * 保持"不抛错"的契约能让它安全地被任何地方调用。
 * 抛错则会让一个查询接口把设置页/实例页拖白屏。
 */
export function instanceLogFile(dataRoot: string, id: string): string {
  const logsDir = join(dataRoot, 'logs', 'instances')
  const s = typeof id === 'string' ? id.trim() : ''
  // 允许字母数字下划线连字符点（实例 ID 实际只用前三种），但拒绝任何
  // 能表达目录结构或跳转的形状
  if (!s || s.length > 80 || /[/\\:]/.test(s) || s.startsWith('.')) {
    // 返回一个同目录下必然不存在的名字，而不是拼出调用方给的字符串
    return join(logsDir, '__invalid-instance-id__.log')
  }
  return join(logsDir, `${s}.log`)
}

/**
 * 从某个字节偏移读文件（「只看本次运行」用）。
 *
 * 与 `readLogSnippet` 一样不抛错：读不到就返回空串。
 *
 * ## 两个上限
 *
 *   · 偏移超过文件大小 → 返回空串（调用方会退回"从头读"）——
 *     这发生在"用户清空过日志"或"记的偏移属于另一个文件"时
 *   · 单次最多读 8MB —— 一次运行一般几百 KB；真超过说明这次跑了很久，
 *     而界面只显示最后 500 行，读多了纯浪费
 */
export function readFromOffset(file: string, offset: number): string {
  try {
    if (!existsSync(file)) return ''
    const size = statSync(file).size
    if (!Number.isFinite(offset) || offset <= 0 || offset > size) return ''
    const MAX = 8 * 1024 * 1024
    const start = Math.max(offset, size - MAX)
    const len = size - start
    if (len <= 0) return ''
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(len)
      const n = readSync(fd, buf, 0, len, start)
      return buf.subarray(0, n).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/**
 * 取日志的最后 n 行（用于「看日志」面板）。
 *
 * 大文件时先按头+尾截取再切，所以拿到的「最后 n 行」永远是**真实的最后 n 行**
 * （尾段就是文件的末尾）—— 只是如果 n 特别大，可能切到拼接的接缝处。
 * 界面只显示 500 行，远小于 256KB，所以不会碰到接缝。
 *
 * ★ `opts.fromOffset`（本次运行判据）：从**这个字节偏移**开始读。
 *   由调用方从实例记录里取（`rec.lastLogOffset`，见 ipc.ts 的 instance:log）。
 *
 *   偏移无效时（没有、为 0、超过文件大小）**退回"从头读"** ——
 *   宁可多给历史，也不能给空：日志是用户唯一的线索。
 */
export function readLogTail(
  file: string,
  lines: number,
  opts: { fromOffset?: number } = {}
): { text: string; truncated: boolean; bootMarked: boolean } {
  /*
   * 先试"只看本次运行"这条路。
   *
   * 它是**默认**行为（主人要求"只显示这次运行的"），
   * 而"显示全部"只在偏移不可用时兜底。
   */
  const off = opts.fromOffset
  if (typeof off === 'number' && off > 0) {
    const runText = readFromOffset(file, off)
    if (runText) {
      const runLines = runText.split(/\r?\n/)
      /* 去掉末尾空串（文件必然以换行结尾） */
      if (runLines.length > 1 && runLines[runLines.length - 1] === '') runLines.pop()
      const picked = runLines.length > lines ? runLines.slice(-lines) : runLines
      return { text: picked.join('\n'), truncated: false, bootMarked: true }
    }
    /*
     * 走到这里说明偏移无效（日志被清空过、或文件换了）——
     * 静默退回下面的"全部"路径。不做提示：那是用户自己的操作，
     * 而给他完整日志比给一个"读不到"的错误有用得多。
     */
  }

  const snip = readLogSnippet(file)
  const all = snip.text.split(/\r?\n/)
  /*
   * 去掉末尾那个空串。
   *
   * 写日志的代码是 `appendFileSync(file, line + '\n')` —— 所以文件**必然**
   * 以换行结尾，`split` 出来的最后一个元素一定是 `''`。
   * 不处理的话：用户点「看日志」看到的最后永远是一个空行；
   * 而且如果按「最后 N 行」取，实际只会拿到 N-1 行真实内容
   * （那个空串占了一个名额）。
   * 只在确实为空时弹掉一个，不影响文件中间或结尾真有内容的行。
   */
  if (all.length > 1 && all[all.length - 1] === '') all.pop()
  const picked = all.length > lines ? all.slice(-lines) : all
  return { text: picked.join('\n'), truncated: snip.truncated, bootMarked: false }
}
