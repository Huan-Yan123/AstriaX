import { appendFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'

/**
 * 操作审计：**用户和软件做的任何事都留一条痕**。
 *
 * 与 app-<日期>.log 的分工：
 *   - app 日志 = 给「排查故障」看的，什么进度、重试、探测失败全往里倒
 *   - 审计日志 = 给「查谁干了什么」看的，只记**动作**：启动/停止/改配置/删实例/备份…
 *
 * 为什么值得单独一条轨：用户跑机器人时最常见的疑问是
 * 「我什么时候改过端口」「怎么突然自己停了」「谁把实例删了」——
 * 这些翻 app 日志要在一堆噪声里捞，而审计轨一行一条、grep 就能回答。
 *
 * 格式（刻意固定，便于 grep / 导出 / 将来做界面）：
 *   [2026-09-13 10:20:30] [用户] instance.start  NapCat 实例  成功  :: 端口 6200
 *   [时间]                [谁]   动作            对象        结果   细节
 */

export type AuditActor = 'user' | 'system' | 'instance'

export interface AuditEntry {
  /** 谁做的：用户点的 / 软件自动的 / 某个实例内部发生的 */
  actor: AuditActor
  /** 动作标识，用点分命名，如 instance.start、config.set、backup.auto */
  action: string
  /** 作用对象：实例名、版本号、配置项等（人能认出的东西，不是 id） */
  target: string
  result: 'ok' | 'fail'
  /** 补充信息：端口、原因、旧值新值等（会压成一行） */
  detail?: string
}

export interface AuditLog {
  record: (e: AuditEntry) => void
  /** 某天的审计文件路径（没有就返回理论路径） */
  fileFor: (date: string) => string
  /** 读取某天（缺省今天）的审计文本，给界面展示 */
  read: (date?: string) => string
}

const ACTOR_LABEL: Record<AuditActor, string> = {
  user: '用户',
  system: '软件',
  instance: '实例'
}

export function createAuditLog(deps: {
  dataRoot: string
  /** 测试注入固定时间 */
  now?: () => Date
  /** 测试注入目录创建（模拟失败用） */
  ensureDir?: (dir: string) => void
  /** 测试注入追加写（模拟失败用） */
  append?: (file: string, text: string) => void
}): AuditLog {
  const now = deps.now ?? (() => new Date())
  const ensureDir = deps.ensureDir ?? ((d: string) => mkdirSync(d, { recursive: true }))
  const append = deps.append ?? ((f: string, t: string) => appendFileSync(f, t, 'utf8'))
  const logsDir = join(deps.dataRoot, 'logs')

  /** 本地日期 YYYY-MM-DD（用本地时区：用户看的是自己那天的日志） */
  const dayOf = (d: Date): string => {
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  /** 本地时间 YYYY-MM-DD HH:mm:ss */
  const stampOf = (d: Date): string => {
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${dayOf(d)} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  /**
   * 审计日期只可能是 `YYYY-MM-DD` —— 按这个形状**白名单**校验。
   *
   * 为什么必须有这一步：`fileFor(date)` 拼的是
   *     join(logsDir, `audit-${date}.log`)
   * 而 `date` 来自渲染层（IPC `audit:read`）。不校验的话
   *     date = "..\\..\\..\\Windows\\win"
   * 会拼出 logs 目录**之外**的路径，`read()` 里的 readFileSync
   * 就成了任意文件读取 —— 况且这是**管理员权限**进程（NapCat 注入 QQ
   * 需要提权），一个读原语也值得认真对待。
   *
   * 更隐蔽的一层：`fileFor` 同时是**写路径**（record 用它 appendFileSync）。
   * 今天 record 用的是自己算出来的日期，但只要哪天有人把外部日期传进来，
   * 同一处缺陷立刻升级成**任意写**。所以在 fileFor 这一层拦，
   * 读写两条路一起收口。
   *
   * 用白名单正则而不是"查 .. 和分隔符"：白名单天然排除所有
   * 奇怪形状（控制字符、盘符、UNC、混合分隔符），不会漏。
   */
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

  const assertDate = (date: string): string => {
    if (!DATE_RE.test(date)) {
      throw new Error(`审计日期格式不对：${date}（应为 YYYY-MM-DD）`)
    }
    return date
  }

  const fileFor = (date: string): string => join(logsDir, `audit-${assertDate(date)}.log`)

  return {
    fileFor,

    record(e) {
      try {
        const d = now()
        ensureDir(logsDir)
        /*
         * 明细压成一行：审计的约定是「一条记录占一行」，
         * 换了行就破坏了 grep / 逐行解析，也容易把栈信息混进来把文件搅乱。
         * 换行和制表符统一换成空格。
         */
        const detail = (e.detail ?? '').replace(/[\r\n\t]+/g, ' ').trim()
        const parts = [
          `[${stampOf(d)}]`,
          `[${ACTOR_LABEL[e.actor]}]`,
          e.action,
          e.target,
          e.result === 'ok' ? '成功' : '失败'
        ]
        let line = parts.join('  ')
        if (detail) line += `  :: ${detail}`
        append(fileFor(dayOf(d)), line + '\n')
      } catch {
        /*
         * 审计是**旁路**：写不进去也不能让调用方崩。
         * 一次磁盘满/权限问题不该把「启动实例」这种主流程带崩。
         */
      }
    },

    read(date) {
      const d = date ?? dayOf(now())
      /*
       * 非法日期一律当"那天没有审计"返回空串，**不抛错**。
       *
       * 读接口是给界面轮询/切页用的：抛错会让设置页整个白屏，
       * 而"读不到"本身就是这个问题的正确语义。写路径（record → fileFor）
       * 那边不 catch，脏日期会直接暴露出来。
       */
      if (!DATE_RE.test(d)) return ''
      const f = fileFor(d)
      try {
        return existsSync(f) ? readFileSync(f, 'utf8') : ''
      } catch {
        return ''
      }
    }
  }
}

/** 列出已有哪些天的审计（给界面做日期切换用），新的在前 */
export function listAuditDays(deps: { dataRoot: string }): string[] {
  try {
    const dir = join(deps.dataRoot, 'logs')
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => /^audit-\d{4}-\d{2}-\d{2}\.log$/.test(f))
      .map((f) => f.replace(/^audit-|\.log$/g, ''))
      .sort((a, b) => (a < b ? 1 : -1))
  } catch {
    return []
  }
}
